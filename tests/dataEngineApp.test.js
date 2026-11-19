const test = require('node:test');
const assert = require('node:assert/strict');
const { bootApplication } = require('./helpers/widgetAppHarness');

function fixture(t) { const f = bootApplication(); t.after(() => f.app.dispose()); return f; }
function protocol() {
    return { id: 'position', endian: 'little', framing: { header: [170], fixedLength: 4 },
        command: { offset: 1, type: 'uint8' }, payloadOffset: 2,
        messages: [{ id: 'x', name: '位置', command: 1, fields: [{ name: 'value', type: 'int16' }] },
            { id: 'y', name: '温度', command: 2, fields: [{ name: 'value', type: 'int16' }] }] };
}

test('raw idle interval and parser timeout are separate drafts with independent live effects', async t => {
    const f=fixture(t);
    assert.ok(f.get('engine-idle-timeout'));
    assert.equal(f.get('engine-idle-timeout').value,'50');
    f.change('engine-idle-timeout','5');
    assert.equal(f.app.dataEngine.config.idleTimeouts.Data_Array,50);
    f.change('engine-raw-idle-timeout','15');
    f.change('engine-mode','Raw_Data');assert.equal(f.get('engine-residual-timeout-settings').hidden,true);
    f.change('engine-raw-idle-timeout','0');
    f.change('engine-mode','Self_Defined_Frame');assert.equal(f.get('engine-idle-timeout').value,'50');
    f.change('engine-idle-timeout','20');
    f.change('engine-mode','Data_Array');assert.equal(f.get('engine-idle-timeout').value,'5');
    assert.equal(f.get('engine-raw-idle-timeout').value,'15');
    assert.ok(f.get('max-raw-frame-bytes').closest('#engine-raw-records'));
    await f.app.engineView.apply();
    assert.equal(f.app.dataEngine.config.idleTimeouts.Data_Array,5);
    assert.equal(f.app.service.baseSource.parser.idleGapSeconds,.015);
    assert.equal(f.app.getConfig().dataEngine.rawIdleTimeouts.Raw_Data,0);
    const numeric = f.app.service.numericSource, raw = f.app.service.baseSource;
    f.app.serialAdapter.onDataCallback(Uint8Array.of(171, 0, 0, 128, 63));
    const numericGeneration = numeric.generation;
    f.change('rebuild-history', false);
    f.change('engine-raw-idle-timeout','25'); await f.app.engineView.apply();
    assert.equal(numeric.generation, numericGeneration);
    assert.equal(numeric.frames.length, 1);
    const rawGeneration = raw.generation;
    f.change('engine-idle-timeout','8'); await f.app.engineView.apply();
    assert.equal(raw.generation, rawGeneration);
    assert.equal(raw.parser.idleGapSeconds,.025);
    const saved=f.app.getConfig(), restored=bootApplication(saved);t.after(()=>restored.app.dispose());
    assert.equal(restored.get('engine-idle-timeout').value,'8');
    restored.change('engine-mode','Raw_Data');assert.equal(restored.get('engine-raw-idle-timeout').value,'0');
    f.change('engine-idle-timeout','-1');await assert.rejects(f.app.engineView.apply(),/残帧/);
    assert.equal(f.app.dataEngine.config.idleTimeouts.Data_Array,8);
});

test('empty workspaces configure explicit parsing drafts and applying is the only live rule change', async t => {
    const f = fixture(t);
    assert.equal(f.app.widgets.widgets.size, 0);
    f.get('data-engine').querySelector('[data-tab="engine-channels"]').click();
    assert.equal(f.get('engine-channels').hidden, false); assert.equal(f.get('engine-parsing').hidden, true);
    f.get('data-engine').querySelector('[data-tab="engine-parsing"]').click();
    assert.ok(f.get('data-type').closest('#data-engine'));
    assert.equal(f.get('tab-waveform-frame'), null);
    f.change('data-type', 'int16');
    assert.equal(f.app.service.numericSource.format.dataType, 'float32');
    assert.match(f.get('engine-status').textContent, /草稿/);
    await f.app.engineView.apply();
    f.app.service.receive(Uint8Array.of(171, 0x34, 0x12));
    assert.equal(f.app.service.numericSource.frames.getValue(0, 0), 0x1234);
    const wave = f.app.widgets.create({ type: 'wave' });
    assert.equal(wave.view.maxDrawFps, null);
    assert.equal(wave.source.frames.getValue(0, 0), 0x1234);
    assert.equal(f.app.getConfig().dataEngine.array.dataType, 'int16');
});

test('23-to-25 array cutover shifts the same channels and keeps both wire widths in history', async t => {
    const f = fixture(t), { service, dataEngine, widgets, engineView } = f.app;
    const frame = (count, first) => {
        const bytes = new Uint8Array(count * 4 + 1), view = new DataView(bytes.buffer);
        bytes[0] = 0xab;
        for (let i = 0; i < count; i++) view.setFloat32(1 + 4 * i, first + i, true);
        return bytes;
    };
    f.change('channels-count', '23');
    await engineView.apply();
    await widgets.updateChannelDefinition({ id: 'total', number: 24, type: 'formula', expression: 'CH1+CH2' });
    await widgets.updateChannelDefinition({ id: 'calibrated', number: 25, type: 'formula', expression: 'CH24+CH3' });
    widgets.setChannelName(23, 'Sum');
    widgets.setChannelColor(23, '#654321');
    const wave = widgets.create({ type: 'wave' });
    widgets.setChannelVisible(23, true);
    const pose = widgets.create({ type: 'pose', settings: { bindings: { euler: [23, 24, 1] } } });
    const byte = widgets.create({ type: 'byte', settings: { captureMode: 'hex' } });
    const old = frame(23, 1), otherOld = frame(23, 51), next = frame(25, 101);
    service.receive(old); service.receive(otherOld);
    const tail = Uint8Array.of(0xab, 0x12);
    service.receive(tail);
    engineView.channels.drafts.set('calibrated', { ...widgets.globals.channelDefinitions[1], expression: 'CH24+' });
    const numeric = service.numericSource, history = numeric.frames;
    assert.equal(history.length, 2);
    assert.equal(history.getValue(23, 0), 3);

    f.change('channels-count', '25');
    const originalNewParser = service._newParser;
    service._newParser = function(format, offset) {
        if (format.captureMode === 'number' && Number(format.channelsCount) === 25)
            throw new Error('模拟解析器初始化失败');
        return originalNewParser.call(this, format, offset);
    };
    try {
        await assert.rejects(engineView.apply(), /模拟解析器初始化失败/);
    } finally { service._newParser = originalNewParser; }
    assert.equal(widgets.globals.channelsCount, '23');
    assert.equal(dataEngine.config.array.channelsCount, '23');
    assert.equal(numeric.parser.channelsCount, 23);
    assert.equal(numeric.parser.writeOffset - numeric.parser.readOffset, tail.length);
    assert.equal(history.length, 2);
    assert.equal(widgets.getChannelRegistry().get('total').number, 24);
    assert.equal(pose.settings.bindings.euler[0], 23);

    const applying = engineView.apply();
    await f.settle();
    await applying;
    assert.equal(numeric.parser.channelsCount, 25);
    assert.equal(dataEngine.config.array.channelsCount, '25');
    assert.equal(widgets.getChannelRegistry().get('total').number, 26);
    assert.equal(widgets.getChannelRegistry().get('calibrated').number, 27);
    assert.equal(widgets.getChannelRegistry().get(24).name, 'CH00024');
    assert.equal(widgets.getChannelRegistry().get('total').name, 'Sum');
    assert.equal(widgets.globals.channelColors[25], '#654321');
    assert.equal(wave.view.getChannelMeta()[25].visible, true);
    assert.deepEqual([...pose.settings.bindings.euler], [25, 26, 1]);
    assert.equal(widgets.globals.channelDefinitions[1].expression, 'CH00026+CH00003');
    assert.equal(engineView.channels.drafts.get('calibrated').expression, 'CH00026+');
    assert.equal(numeric.errors.at(-1).type, 'incomplete');
    assert.deepEqual([...numeric.errors.at(-1).bytes], [...tail]);
    assert.equal(numeric.frames, history);
    assert.equal(history.length, 2);
    assert.ok(Number.isNaN(history.getValue(23, 0)));
    assert.ok(Number.isNaN(history.getValue(24, 0)));
    assert.equal(history.getValue(25, 0), 3);
    assert.equal(history.getValue(26, 0), 6);

    service.receive(next.subarray(0, 37));
    service.receive(next.subarray(37));
    assert.deepEqual(Array.from({ length: history.length }, (_, i) => history.rawBytesAt(i).length), [93, 93, 101]);
    const rawLengths = source => Array.from({ length: source.frames.length }, (_, i) => source.frames.rawBytesAt(i).length);
    assert.deepEqual(rawLengths(byte.source), [93, 93, 2, 101]);
    assert.equal(history.getValue(23, 2), 124);
    assert.equal(history.getValue(24, 2), 125);
    assert.equal(history.getValue(26, 2), 306);
    f.change('engine-idle-timeout', '75');
    f.change('engine-raw-idle-timeout', '80');
    await engineView.apply();
    await service.setMaxRawFrameBytes(2048);
    const text = widgets.create({ type: 'byte', settings: { captureMode: 'text' } });
    assert.equal(text.source, byte.source);
    assert.deepEqual(rawLengths(text.source), [93, 93, 2, 101]);
    assert.deepEqual(rawLengths(numeric), [93, 93, 101]);
    const saved = JSON.parse(JSON.stringify(f.app.getConfig()));
    assert.equal(f.S.WidgetConfig.validateWorkspaceConfig(saved).dataEngine.array.channelsCount, '25');
});

test('raw mode preserves receive history without sampled values or widget parsing editors', async t => {
    const f = fixture(t), wave = f.app.widgets.create({ type: 'wave' });
    f.change('engine-mode', 'Raw_Data'); await f.app.engineView.apply();
    f.app.service.receive(Uint8Array.of(171, 0, 0, 128, 63)); f.app.service.endStream();
    const byte = f.app.widgets.create({ type: 'byte', settings: { captureMode: 'engine' } });
    assert.equal(wave.source.frames.length, 0);
    assert.equal(byte.source, f.app.service.baseSource);
    assert.equal(byte.view.mode, 'hex');
    assert.equal(f.app.service.history.byteLength, 5);
    assert.equal(byte.source.frames.rawBytesAt(0).length, 5);
});

test('custom engine exposes structured records, separate message sequences and synchronized numeric output', async t => {
    const f = fixture(t); f.app.widgets.ensureRawChannels(2);
    const settings = f.app.dataEngine.serialize();
    Object.assign(settings, { mode: 'Self_Defined_Frame', protocols: [protocol()], protocolId: 'position',
        mappings: [{ channel: 0, messageId: 'x', path: 'value' }, { channel: 1, messageId: 'y', path: 'value' }] });
    await f.app.dataEngine.apply(settings, { rebuild: false }); f.app.widgets.rebindEngineSources();
    const byte = f.app.widgets.create({ type: 'byte', settings: { captureMode: 'engine' } });
    const x = f.app.widgets.create({ type: 'wave', settings: { engineSource: 'message:x' } });
    const y = f.app.widgets.create({ type: 'wave', settings: { engineSource: 'message:y' } });
    f.app.service.receive(Uint8Array.of(170, 1, 7, 0), { timestamp: 10000, arrival: 1000 });
    f.app.service.receive(Uint8Array.of(170, 2, 8, 0), { timestamp: 10002, arrival: 1002 });
    assert.equal(byte.view.mode, 'protocol');
    assert.equal(byte.source.frames.length, 2);
    assert.equal(x.source.frames.length, 1); assert.equal(y.source.frames.length, 1);
    assert.equal(x.source.frames.getValue(0, 0), 7); assert.equal(y.source.frames.getValue(1, 0), 8);
    assert.equal(f.app.dataEngine.syncSource.frames.getValue(0, 0), 7);
    assert.equal(f.app.dataEngine.syncSource.frames.getValue(1, 2), 8);
    assert.ok(f.get('widget-engine-source').options.length >= 3);
    const pose = f.app.widgets.create({ type: 'pose', settings: { engineSource: 'message:x', bindings: { euler: [0, 0, 0] } } });
    f.change('pose-cubeVisible', false);
    assert.equal(pose.settings.engineSource, 'message:x'); assert.equal(pose.source, x.source);
    const restored = f.app.getConfig();
    assert.equal(restored.dataEngine.protocolId, 'position');
    assert.equal(restored.widgets.find(w => w.id === x.id).settings.engineSource, 'message:x');
});

test('protocol mode previews Hex and idle text, prioritizes complete frames and replays unmatched bytes', async t => {
    const f = fixture(t);
    const engine = f.app.dataEngine;
    const schema = protocol();
    schema.framing.header = [65];
    schema.messages[0].command = 66;
    schema.messages[1].command = 67;
    const settings = { ...engine.serialize(), mode: 'Self_Defined_Frame', protocols: [schema], protocolId: schema.id };
    await engine.apply(settings, { rebuild: false });
    const byte = f.app.widgets.create({ type: 'byte', settings: { captureMode: 'engine' } });
    f.change('capture-mode', 'hex');
    const text = f.app.widgets.create({ type: 'byte', settings: { captureMode: 'text', textBoundary: 'idle' } });
    await f.settle();
    assert.equal(byte.source, text.source);
    const frames = byte.source.frames;
    const rows = () => Array.from({ length: frames.length }, (_, index) => [...frames.rawBytesAt(index)]);
    const first = [65, 66, 88, 89], second = [65, 67, 90, 87], noise = [33, 34], tail = [65, 66, 35];
    f.app.serialAdapter.onDataCallback(Uint8Array.of(...noise, ...first.slice(0, 2)));
    await f.tick(1);
    assert.equal(frames.length, 0);
    assert.match(byte.view.spacer.textContent, /21 22 41 42/);
    assert.match(text.view.spacer.textContent, /!"AB/);
    f.app.serialAdapter.onDataCallback(Uint8Array.of(...first.slice(2), ...second, ...tail));
    await f.tick(1);
    assert.equal(engine.recordsSource.frames.length, 2);
    assert.deepEqual(rows(), [noise, first, second]);
    assert.match(byte.view.spacer.textContent, /41 42 23/);
    assert.match(text.view.spacer.textContent, /AB#/);
    await f.tick(50);
    assert.deepEqual(rows(), [noise, first, second, tail]);
    assert.equal(byte.view.lastRows.length, 4, 'the committed record replaces the preview');
    assert.equal(text.view.lastRows.length, 4);
    f.app.service.endStream();
    const rematch = engine.apply({ ...settings, protocols: [{ ...schema, framing: { ...schema.framing, header: [68] } }] });
    await f.settle(); await rematch;
    assert.deepEqual(rows(), [[...noise, ...first, ...second, ...tail]]);
    const restored = engine.apply(settings);
    await f.settle(); await restored;
    assert.deepEqual(rows(), [noise, first, second, tail]);
});

test('array mode gives Hex the configured wire boundaries and replays unmatched bytes by idle', async t => {
    const f = fixture(t), engine = f.app.dataEngine;
    assert.equal(f.app.service.maxRawFrameBytes, 1024);
    const array = { ...engine.config.array, dataType: 'uint16', headerHex: 'AA 55',
        enableFooter: true, footerHex: '0D' };
    const settings = { ...engine.serialize(), array };
    await engine.apply(settings, { rebuild: false });
    const byte = f.app.widgets.create({ type: 'byte', settings: { captureMode: 'hex' } });
    const service = f.app.service, frames = byte.source.frames;
    const rows = () => Array.from({ length: frames.length }, (_, index) => [...frames.rawBytesAt(index)]);
    const first = [0xAA, 0x55, 0x0D, 0x11, 0x0D], second = [0xAA, 0x55, 2, 3, 0x0D];
    const noise = [0xAA, 0x55, 9, 9, 9], tail = [0xAA, 0x55, 4];
    f.app.serialAdapter.onDataCallback(Uint8Array.of(...noise, first[0]));
    await f.tick(1);
    f.app.serialAdapter.onDataCallback(Uint8Array.of(...first.slice(1), ...second, ...tail));
    await f.tick(1);
    assert.deepEqual(rows(), [noise, first, second]);
    assert.equal(service.numericSource.frames.length, 2);
    assert.ok(frames.timestampAt(1) < frames.timestampAt(2), 'a split frame keeps its first byte timestamp');
    await f.tick(50);
    assert.deepEqual(rows(), [noise, first, second, tail]);
    service.endStream();
    const rebuilt = engine.apply({ ...settings, array: { ...array, footerHex: '0E' } }, { rebuild: true });
    await f.settle(); await rebuilt;
    assert.deepEqual(rows(), [[...noise, ...first, ...second, ...tail]]);
    const restored = engine.apply(settings, { rebuild: true });
    await f.settle(); await restored;
    assert.deepEqual(rows(), [noise, first, second, tail]);
});

test('Hex has an independent boundary setting and text still shares its viewing rules', async t => {
    const f = fixture(t), controller = f.app.widgets, service = f.app.service;
    const hex = controller.create({ type: 'byte', settings: { captureMode: 'hex' } });
    const text = controller.create({ type: 'byte', settings: { captureMode: 'text', textBoundary: 'idle' } });
    assert.equal(f.get('text-boundary').options[0].textContent, '仅基本空闲断帧');
    assert.equal(f.get('text-boundary').options[1].textContent, '跟随数据引擎');
    assert.equal(text.source, hex.source);
    const hexSource = hex.source;
    f.change('text-boundary', 'idle-basic');
    await f.settle();
    assert.notEqual(text.source, hexSource);
    assert.equal(hex.source, hexSource);
    const basicHex = controller.create({ type: 'byte', settings: { captureMode: 'hex' } });
    assert.equal(f.get('hex-boundary').value, 'idle');
    assert.match(f.get('monitor-record-rule').textContent, /数组帧优先.*50 ms.*1024 B/);
    f.change('hex-boundary', 'idle-basic');
    assert.equal(basicHex.source, text.source);
    assert.match(f.get('monitor-record-rule').textContent, /仅基本空闲断帧.*50 ms.*1024 B/);
    f.change('max-raw-frame-bytes', '2048');
    assert.match(f.get('monitor-record-rule').textContent, /2048 B/);
    f.change('max-raw-frame-bytes', '63');
    assert.equal(f.get('engine-raw-limit-status').hidden, false);
    assert.match(f.get('monitor-record-rule').textContent, /2048 B/);
    assert.equal(f.app.getConfig().global.textBoundary, 'idle-basic');
    const payload = Uint8Array.of(0xab, 65, 66, 67, 68, 0xab, 69, 70, 71, 72);
    f.app.serialAdapter.onDataCallback(payload);
    await f.tick(1);
    assert.equal(hexSource.frames.length, 2);
    assert.equal(text.source.frames.length, 0);
    assert.match(text.view.spacer.textContent, /ABCD.*EFGH/);
    await f.tick(50);
    assert.equal(text.source.frames.length, 1);
    assert.deepEqual([...text.source.frames.rawBytesAt(0)], [...payload]);
    f.change('export-format', 'text');
    assert.equal(f.get('export-text-boundary').value, 'records');
    const saved = f.app.getConfig();
    assert.equal(saved.global.textBoundary, 'idle-basic');
    const loaded = bootApplication(saved);
    t.after(() => loaded.app.dispose());
    assert.notEqual(loaded.app.widgets.widgets.get(text.id).source, loaded.app.service.baseSource);
    assert.equal(loaded.app.widgets.widgets.get(basicHex.id).source, loaded.app.widgets.widgets.get(text.id).source);
    service.endStream();
    controller.activate(text.id);
    f.change('text-boundary', 'idle');
    await f.settle();
    assert.equal(text.source, hexSource);
    assert.equal(text.source.frames.length, 2);
});

test('channel names and formulas are global while widget selectors only change visibility', async t => {
    const f = fixture(t), controller = f.app.widgets;
    controller.setChannelName(0, '温度');
    const number = controller.addChannel('formula');
    await controller.updateChannelDefinition({ number, type: 'formula', expression: '温度+CH1' });
    assert.equal(controller.globals.channelDefinitions[0].expression, 'CH00001+CH00001');
    const id = controller.getChannelRegistry().get(number).id;
    controller.setChannelName(0, '温度C');
    assert.equal(controller.globals.channelDefinitions[0].expression, 'CH00001+CH00001');
    assert.equal(controller.getChannelRegistry().get(number).id, id);
    const a = controller.create({ type: 'wave' }), b = controller.create({ type: 'wave' });
    controller.setChannelVisible(0, true);
    assert.equal(b.view.channels[0].visible, true); assert.equal(a.view.channels[0].visible, false);
    assert.ok(f.get('channel-config-list').querySelector('[data-role="channel-name"]'));
    assert.equal(f.get('channel-config-list').querySelector('[data-role="channel-expression"]'), null);
    f.app.engineView.channels.refresh(); assert.match(f.get('engine-channel-panel').textContent, /CH00001/);
});

test('left engine split saves keyboard changes without overwriting them in short windows', () => {
    const f = bootApplication();
    try {
        f.get('engine-splitter').dispatchEvent({ type: 'keydown', key: 'ArrowUp' });
        assert.equal(f.app.getConfig().uiLayout.leftSplitRatio, .475);
        f.get('sidebar').clientHeight = 200; f.window.dispatchEvent({ type: 'resize' });
        assert.equal(f.app.getConfig().uiLayout.leftSplitRatio, .475);
        f.get('workspace-toggle-left').click();
        assert.equal(f.get('app-container').classList.contains('left-collapsed'), true);
    } finally { f.app.dispose(); }
});

test('channel management reserves five rows when possible and restores the preferred split after a short window', t => {
    const f = fixture(t), sidebar = f.get('sidebar'), engine = f.get('data-engine');
    sidebar.clientHeight = 800; sidebar.querySelector('.app-title').offsetHeight = 40;
    engine.getBoundingClientRect = () => ({ top: 100 });
    engine.children[0].offsetHeight = 32; engine.children[1].offsetHeight = 32;
    f.get('engine-channels').getBoundingClientRect = () => ({ top: 164 });
    f.app.engineView.channels.list.getBoundingClientRect = () => ({ top: 268 });
    f.window.getComputedStyle = node => ({ paddingBottom: node === f.get('engine-channels') ? '8px' : '0px' });
    engine.querySelector('[data-tab="engine-channels"]').click();
    const splitter = f.get('engine-splitter');
    splitter.dispatchEvent({ type: 'pointerdown', pointerId: 1, button: 0, clientY: 400 });
    splitter.dispatchEvent({ type: 'pointermove', pointerId: 1, clientY: 740 });
    splitter.dispatchEvent({ type: 'pointerup', pointerId: 1 });
    const upperHeight = () => parseFloat(sidebar.style['--sidebar-upper-height']);
    assert.ok(752 - upperHeight() >= 357, 'toolbar plus five complete 36px rows and border stay in the engine viewport');
    assert.equal(f.app.getConfig().uiLayout.leftSplitRatio, .85);
    sidebar.clientHeight = 240; f.window.dispatchEvent({ type: 'resize' });
    assert.ok(upperHeight() >= 0 && upperHeight() < 192);
    assert.equal(f.app.getConfig().uiLayout.leftSplitRatio, .85, 'temporary constraints do not overwrite the saved split');
    sidebar.clientHeight = 800; f.window.dispatchEvent({ type: 'resize' });
    assert.ok(752 - upperHeight() >= 357);
    const resizedHeight = upperHeight();
    engine.querySelector('[data-tab="engine-parsing"]').click();
    assert.equal(upperHeight(), resizedHeight, 'switching to parsing must keep the resized separator in place');
    f.window.dispatchEvent({ type: 'resize' });
    assert.equal(upperHeight(), resizedHeight, 'hidden channel controls still use the same height constraint');
    engine.querySelector('[data-tab="engine-channels"]').click();
    assert.equal(upperHeight(), resizedHeight);
});

test('causal synchronization lives in parsing and preserves its draft when irrelevant modes hide it', t => {
    const f = fixture(t), panel = f.get('engine-synchronization');
    assert.ok(panel.closest('#engine-parsing'), 'synchronization settings belong to the parsing panel');
    assert.equal(f.get('data-engine').querySelector('[data-tab="engine-synchronization"]'), null);
    assert.equal(panel.hidden, true);
    f.change('engine-mode', 'Self_Defined_Frame');
    assert.equal(panel.hidden, false);
    f.change('engine-sync-rate', '500');
    assert.equal(f.app.dataEngine.config.synchronization.sampleRate, 1000);
    assert.equal(f.app.getConfig().dataEngine.draft.synchronization.sampleRate, 500);
    f.change('engine-mode', 'Data_Array');
    assert.equal(panel.hidden, true);
    f.change('engine-mode', 'Self_Defined_Frame');
    assert.equal(panel.hidden, false); assert.equal(f.get('engine-sync-rate').value, '500');
});

test('new-field mapping stays a draft and applies after validating its future channel catalog', async t => {
    const f = fixture(t), view = f.app.engineView;
    view.draft.protocols = [protocol()]; view.draft.protocolId = 'position'; view.draft.mode = 'Self_Defined_Frame'; view.render();
    const form = f.get('engine-mappings').querySelector('.engine-mapping-form');
    form.querySelector('input').value = 'value';
    form.querySelectorAll('button')[1].click();
    assert.equal(f.app.getConfig().global.channelsCount, '1', 'draft mapping cannot clear or extend the live source');
    assert.equal(view.draft.mappings[0].channel, 1);
    const ready = view.apply(); await f.settle(); await ready; f.app.service.receive(Uint8Array.of(170, 1, 12, 0));
    assert.equal(f.app.getConfig().global.channelsCount, '2');
    assert.equal(f.app.dataEngine.outputs.get('message:x').frames.getValue(1, 0), 12);
});

test('memory-incompatible imports fail before replacing widgets, global settings or histories', t => {
    const f = fixture(t); f.app.widgets.create({ type: 'wave' });
    f.app.service.receive(Uint8Array.of(171, 0, 0, 128, 63));
    const before = JSON.stringify(f.app.getConfig()), config = f.app.getConfig();
    Object.assign(config.global, { captureMemoryMiB: 64, channelsCount: '130', channelNames: [], channelRecords: [],
        channelDefinitions: Array.from({ length: 130 }, (_, index) => ({ number: 131 + index, type: 'formula', expression: `CH${index + 1}[-65536]` })) });
    assert.throws(() => f.app.applyConfig(config), /内存预算/);
    assert.equal(JSON.stringify(f.app.getConfig()), before);
    assert.equal(f.app.service.numericSource.frames.getValue(0, 0), 1);
    const malformed = f.app.getConfig(); malformed.dataEngine.draft = {};
    assert.throws(() => f.app.applyConfig(malformed), /草稿/);
    assert.equal(JSON.stringify(f.app.getConfig()), before);
});

test('full configuration replacement reapplies definitions even when wire parsing rules match', async t => {
    const f = fixture(t), number = f.app.widgets.addChannel('formula'), config = f.app.getConfig();
    config.global.channelDefinitions[0].expression = 'CH1*3';
    f.app.applyConfig(config); await f.settle();
    f.app.service.receive(Uint8Array.of(171, 0, 0, 128, 63));
    assert.equal(f.app.service.numericSource.frames.getValue(number - 1, 0), 3);
});

test('regular structured sends and grouped commands use the applied protocol and common TX records', async t => {
    const f = fixture(t), settings = f.app.dataEngine.serialize();
    settings.protocols = [protocol()]; settings.protocolId = 'position';
    await f.app.dataEngine.apply(settings);
    f.app.regularProtocolView.setValue({ protocolId: 'position', messageId: 'x', fields: { value: 258 } });
    f.change('send-mode', 'protocol');
    assert.equal(f.get('send-input').hidden, true); assert.equal(f.get('protocol-send-panel').hidden, false);
    const sent = []; f.app.serialAdapter.send = async bytes => { sent.push([...bytes]); return true; };
    f.app.serialAdapter.onConnectStatusChange(true);
    assert.equal(await f.app.sendController.sendOnce(), true);
    assert.deepEqual(sent[0], [170, 1, 2, 1]);
    const id = f.app.commandLibrary.add('command');
    f.app.commandLibrary.update(id, { mode: 'protocol', protocol: { protocolId: 'position', messageId: 'y', fields: { value: -2 } } });
    assert.equal(await f.app.commandRunner.start(id), true);
    assert.deepEqual(sent[1], [170, 2, 254, 255]);
    assert.equal(f.app.service.txFrames.length, 2);
    const saved = f.app.getConfig(); assert.equal(saved.send.mode, 'protocol'); assert.equal(saved.send.protocol.messageId, 'x');
});

test('structured exports select the protocol record source and retain exact field values', async t => {
    const f = fixture(t), settings = f.app.dataEngine.serialize();
    Object.assign(settings, { mode: 'Self_Defined_Frame', protocols: [protocol()], protocolId: 'position',
        mappings: [{ channel: 0, messageId: 'x', path: 'value' }] });
    await f.app.dataEngine.apply(settings, { rebuild: false }); f.app.widgets.rebindEngineSources();
    f.app.service.receive(Uint8Array.of(170, 1, 7, 0));
    f.change('export-format', 'csv'); f.change('export-source', 'engine:records');
    assert.equal(f.get('wrap-export-numeric-parsing').hidden, true);
    assert.equal(f.get('export-channels-wrap').hidden, true);
    const pending = f.app.exportData(); for (let index = 0; index < 30; index++) await f.tick(10);
    assert.equal(await pending, true);
    const csv = await f.blobs.at(-1).text(); assert.match(csv, /MessageId/); assert.match(csv, /位置/); assert.match(csv, /,7\r\n/);
    f.change('export-source', 'engine:message:x');
    assert.equal(await f.app.exportData(), true);
    assert.match(await f.blobs.at(-1).text(), /0,7\r\n/);
    f.change('export-format', 'binary');
    assert.ok(!f.get('export-source').options.some(option => option.value === 'engine:message:x'));
    assert.ok(!f.get('export-source').options.some(option => option.value === 'numeric'));
});
