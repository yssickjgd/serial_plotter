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
