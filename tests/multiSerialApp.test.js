const test = require('node:test');
const assert = require('node:assert/strict');
const { bootArrayApplication: bootApplication } = require('./helpers/widgetAppHarness');

function saveSerialConfig(f) { f.click('engine-apply'); }
function addSerial(f, fields = {}) {
    if (!f.get('serial-config-dialog').open) f.click('serial-manager-open');
    f.click('serial-source-add');
    for (const [id, value] of Object.entries(fields)) f.change(id, value);
    saveSerialConfig(f);
}

test('single-source fixed-rate waves can choose samples and restore the selection without changing the source clock', t => {
    const setup = bootApplication(); t.after(() => setup.app.dispose());
    const legacy = setup.app.getConfig();
    legacy.workspaceChannels.timebases.primary = { mode: 'fixed', sampleRate: 1000 };
    legacy.widgets = [{ id: 'wave-legacy', type: 'wave', title: '旧波形', settings: { plotTimeXUnit: 'samples' } }];
    const f = bootApplication(legacy); t.after(() => f.app.dispose());
    f.app.widgets.activate('wave-legacy');
    const wave = f.app.widgets.active, axis = f.get('plot-time-x-unit');
    assert.equal(axis.value, 's', 'legacy fixed-rate waves keep seconds by default');
    assert.equal(axis.disabled, false);

    f.change('plot-time-x-unit', 'samples');
    assert.equal(wave.view.timeXUnit, 'samples');
    assert.equal(wave.view.sampleRateHz, 1000);
    assert.equal(f.app.getConfig().workspaceChannels.timebases.primary.mode, 'fixed');

    const restored = bootApplication(JSON.parse(JSON.stringify(f.app.getConfig())));
    t.after(() => restored.app.dispose());
    restored.app.widgets.activate(wave.id);
    assert.equal(restored.get('plot-time-x-unit').value, 'samples');
    assert.equal(restored.app.widgets.active.view.timeXUnit, 'samples');

    f.click('workspace-channel-auto-map');
    f.change('widget-connection-source', 'workspace');
    assert.equal(axis.disabled, true);
    assert.equal(axis.value, 's');
    assert.equal(wave.view.timeXUnit, 's');
    f.change('widget-connection-source', 'primary');
    assert.equal(axis.disabled, false);
    assert.equal(axis.value, 'samples');
    f.change('plot-time-x-unit', 's');
    assert.equal(wave.view.timeXUnit, 's');
});

async function waitForConnectionButton(f, id) {
    const button = f.get(id);
    for (let attempt = 0; button.disabled && attempt < 10; attempt++) await f.tick(1);
    assert.equal(button.disabled, false, id + ' becomes available');
}

async function chooseSerial(f, prefix = 'serial-primary') {
    f.click(prefix + '-bind');
    await waitForConnectionButton(f, prefix + '-connect');
}

function makePort() {
    let read;
    const port = {
        opened: null, closed: 0, openCount: 0,
        open: async options => { port.opened = options; port.openCount++; },
        close: async () => { port.closed++; },
        readable: { getReader: () => ({
            read: () => new Promise(resolve => { read = resolve; }),
            cancel: async () => read?.({ done: true }),
            releaseLock() {}
        }) },
        receive: bytes => read({ value: Uint8Array.from(bytes) })
    };
    return port;
}

test('additional serial connections keep independent raw histories and can export the selected source', async t => {
    const f = bootApplication(); t.after(() => f.app.dispose());
    const primary = makePort(), secondary = makePort(), ports = [primary, secondary];
    f.context.navigator.serial = { requestPort: async () => ports.shift() };
    f.click('serial-manager-open');
    f.selectConnection('primary'); f.change('serial-baud', '2000000'); saveSerialConfig(f);
    await chooseSerial(f);
    addSerial(f, { 'serial-config-name': '第二路', 'serial-baud': '460800' });
    await chooseSerial(f, 'serial-2');
    assert.equal(primary.opened.baudRate, 2000000);
    assert.equal(secondary.opened.baudRate, 460800);
    f.selectConnection('primary');
    assert.equal(f.get('serial-baud').disabled, true);
    assert.equal(f.get('serial-config-save'), null);
    assert.equal(f.get('serial-config-offset').disabled, true);
    assert.equal(f.get('serial-config-reset'), null);

    primary.receive([0xa1, 0xa2]);
    secondary.receive([0xb1, 0xb2]);
    await f.tick(1);
    await f.tick(55);
    f.click('serial-2-connect'); await f.tick(1); await f.tick(1);
    assert.equal(primary.closed, 0);
    assert.equal(secondary.closed, 1);
    assert.equal(f.app.service.history.endByte, 2);
    assert.equal(f.app.serialSources.get('serial-2').capture.history.endByte, 2);
    assert.match(f.get('serial-2-status').textContent, /已断开.*RX 2 B/);
    assert.deepEqual(f.get('export-source').options.slice(0, 2).map(option => [option.value, option.textContent]),
        [['base', '主串口 · 原始记录'], ['serial-2', '第二路 · 原始记录']]);

    f.change('export-source', 'serial-2');
    f.change('export-format', 'binary');
    assert.equal(await f.app.exportData(), true);
    assert.deepEqual([...new Uint8Array(await f.blobs.at(-1).arrayBuffer())], [0xb1, 0xb2]);
    f.change('export-source', 'base');
    assert.equal(await f.app.exportData(), true);
    assert.deepEqual([...new Uint8Array(await f.blobs.at(-1).arrayBuffer())], [0xa1, 0xa2]);

    const config = f.app.getConfig();
    const restored = bootApplication(config); t.after(() => restored.app.dispose());
    restored.selectConnection('serial-2');
    assert.equal(restored.get('serial-config-name').value, '第二路');
    assert.equal(restored.get('serial-baud').value, '460800');
    assert.equal(restored.app.serialSources.get('serial-2').capture.history.endByte, 0);
    f.click('btn-clear'); await f.tick(1);
    assert.equal(f.app.serialSources.get('serial-2').capture.history.endByte, 0);
});

test('serial source settings validate atomically and removing a disconnected source preserves the shared capture pool', t => {
    const f = bootApplication(); t.after(() => f.app.dispose());
    addSerial(f);
    const source = f.app.serialSources.get('serial-2');
    const primaryPool = f.app.service.workerPool;
    assert.equal(source.capture.workerPool, primaryPool);
    assert.equal(source.capture.memory.limitBytes + f.app.service.memory.limitBytes, 8192 * 1048576);
    assert.equal(source.capture.dataEngine.mode, 'Raw_Data');
    const config = f.app.getConfig();
    config.serialSources.entries.push({ ...config.serialSources.entries[0] });
    assert.throws(() => f.app.applyConfig(config), /接收来源编号重复/);
    assert.equal(f.app.serialSources.get('serial-2'), source);
    f.selectConnection('primary'); f.change('conn-type', 'udp'); saveSerialConfig(f);
    assert.ok(f.get('serial-source-add').closest('#serial-config-dialog'));
    assert.equal(f.get('serial-primary-bind').hidden, true);
    assert.equal(f.get('serial-primary-connect').disabled, false);
    f.click('serial-2-remove');
    assert.equal(f.app.serialSources.size, 0);
    assert.equal(source.capture.disposed, true);
    assert.equal(primaryPool.disposed, false);
    assert.equal(f.app.service.memory.limitBytes, 8192 * 1048576);
    f.selectConnection('primary'); f.change('conn-type', 'serial'); saveSerialConfig(f);
    addSerial(f);
    const next = f.app.serialSources.get('serial-3');
    assert.ok(next);
    next.capture.receive(Uint8Array.of(0, 0, 128, 63, 0, 0, 128, 127));
    assert.equal(next.capture.numericSource.frames.length, 0);
});

test('serial data engines and widget input bindings isolate parsing and export per connection', async t => {
    const f = bootApplication(); t.after(() => f.app.dispose());
    const engine = f.get('data-engine');
    assert.ok(f.get('connection-engine-content').contains(engine));
    assert.equal(f.get('sidebar').contains(engine), false);
    assert.equal(f.get('engine-splitter'), null);
    assert.equal(f.get('engine-connection-source'), null);
    f.click('serial-manager-open'); f.selectConnection('primary', 'engine-parsing');
    f.change('chk-header', false); f.change('chk-footer', false); f.change('data-type', 'uint8');
    await f.app.engineView.apply();
    f.click('connection-engine-back');
    addSerial(f);
    const secondary = f.app.serialSources.get('serial-2');
    f.selectConnection('serial-2', 'engine-parsing');
    assert.ok(f.app.engineView.engine === secondary.capture.dataEngine);
    engine.querySelector('[data-tab="engine-raw-records"]').click();
    f.change('engine-raw-idle-timeout', '75');
    await f.app.engineView.apply();
    assert.equal(Number(secondary.capture.dataEngine.config.rawIdleTimeouts.Raw_Data), 75);
    assert.equal(Number(f.app.dataEngine.config.rawIdleTimeouts.Raw_Data), 50);
    f.click('connection-engine-back');
    assert.ok(f.get('connection-engine-content').contains(engine));
    assert.equal(f.get('connection-engine-panel').hidden, false);
    assert.equal(f.get('engine-communication').hidden, false);
    assert.equal(f.get('serial-manager-panel').hidden, false);
    assert.equal(f.document.activeElement.id, 'engine-tab-communication');
    f.selectConnection('serial-2', 'engine-parsing');
    assert.equal(f.get('engine-applied-mode').textContent, 'Raw_Data');
    f.change('engine-mode', 'Data_Array'); f.change('chk-header', false);
    f.change('data-type', 'uint16'); f.change('channels-count', '2');
    await f.app.engineView.apply();
    assert.equal(f.app.dataEngine.config.array.dataType, 'uint8');
    assert.equal(secondary.capture.dataEngine.config.array.dataType, 'uint16');
    f.click('connection-engine-back'); f.click('serial-manager-close');
    const mainWave = f.app.widgets.create({ type: 'wave' });
    const secondWave = f.app.widgets.create({ type: 'wave' });
    f.change('widget-connection-source', 'serial-2');
    f.app.widgets.setChannelVisible(1, true);
    const byte = f.app.widgets.create({ type: 'byte' });
    f.change('widget-connection-source', 'serial-2');
    f.change('capture-mode', 'engine');

    f.app.service.receive(Uint8Array.of(33));
    secondary.capture.receive(Uint8Array.of(0x34, 0x12, 0x78, 0x56));
    await f.settle();
    assert.equal(mainWave.source.frames.getValue(0, 0), 33);
    assert.equal(secondWave.source.frames.getValue(0, 0), 0x1234);
    assert.equal(secondWave.source.frames.getValue(1, 0), 0x5678);
    assert.equal(byte.source, secondWave.source);

    f.app.widgets.activate(secondWave.id);
    f.change('widget-export-format', 'csv');
    assert.equal(await f.app.exportWidgetData(), true);
    assert.match(await f.blobs.at(-1).text(), /22136/);

    const restored = bootApplication(f.app.getConfig()); t.after(() => restored.app.dispose());
    const restoredWave = restored.app.widgets.widgets.get(secondWave.id);
    assert.equal(restoredWave.settings.connectionSource, 'serial-2');
    assert.equal(restored.app.serialSources.get('serial-2').capture.dataEngine.config.array.channelsCount, '2');
});

test('secondary channel management edits and remaps its own catalog and persists definitions', async t => {
    const f = bootApplication(); t.after(() => f.app.dispose());
    addSerial(f);
    const capture = f.app.serialSources.get('serial-2').capture;
    f.selectConnection('serial-2', 'engine-parsing');
    f.change('engine-mode', 'Data_Array'); f.change('chk-header', false); f.change('chk-footer', false); f.change('data-type', 'uint8');
    await f.app.engineView.apply();
    const engine = f.get('data-engine'), channelPanel = f.get('engine-channel-panel');
    engine.querySelector('[data-tab="engine-channels"]').click();
    assert.equal(channelPanel.hidden, false);
    const row = number => f.app.engineView.channels.list.children.find(item => item.dataset.channelNumber === String(number));
    const input = (number, role) => row(number).querySelector(`[data-role="${role}"]`);
    input(1, 'channel-name').value = 'temperature';
    input(1, 'channel-name').dispatchEvent({ type: 'change' });
    input(1, 'channel-color').value = '#123456';
    input(1, 'channel-color').dispatchEvent({ type: 'input' });
    saveSerialConfig(f);
    assert.equal(f.app.dataEngine.globals.channelNames[0], 'CH00001');
    assert.equal(capture.dataEngine.globals.channelNames[0], 'temperature');
    assert.equal(capture.dataEngine.globals.channelColors[0], '#123456');

    assert.equal(channelPanel.querySelector('[data-role="engine-channel-add"]').hidden, true);
    f.app.widgets.addChannel('formula', capture);
    await f.app.widgets.updateChannelDefinition({ ...capture.dataEngine.globals.channelDefinitions[0], expression: 'temperature * 2' }, {}, capture);
    await f.tick(10);
    capture.receive(Uint8Array.of(7));
    assert.equal(capture.numericSource.frames.getValue(1, 0), 14);
    const id = capture.dataEngine.globals.channelDefinitions[0].id;
    f.click('connection-engine-back'); f.click('serial-manager-close');
    const wave = f.app.widgets.create({ type: 'wave' });
    f.change('widget-connection-source', 'serial-2');
    f.app.widgets.setChannelVisible(1, true);

    f.click('serial-manager-open'); f.selectConnection('serial-2', 'engine-parsing');
    f.change('channels-count', '2'); await f.app.engineView.apply();
    assert.equal(capture.numericSource.frames.getValue(2, 0), 14);
    assert.equal(wave.view.getChannelMeta()[2].visible, true);
    capture.receive(Uint8Array.of(9, 4));
    assert.equal(capture.numericSource.frames.getValue(2, 1), 18);
    const config = f.app.getConfig();
    assert.equal(config.global.channelDefinitions.length, 0);
    const restored = bootApplication(config); t.after(() => restored.app.dispose());
    const copy = restored.app.serialSources.get('serial-2').capture;
    assert.equal(copy.dataEngine.globals.channelDefinitions[0].id, id);
    assert.equal(copy.dataEngine.globals.channelDefinitions[0].number, 3);
    assert.equal(copy.dataEngine.globals.channelColors[0], '#123456');
    copy.receive(Uint8Array.of(5, 2));
    assert.equal(copy.numericSource.frames.getValue(2, 0), 10);
});

test('global channel mapping packs two transports and exposes the same synchronized wave and CSV source', async t => {
    const f = bootApplication(); t.after(() => f.app.dispose());
    const updatePrimary = async () => {
        f.change('chk-header', false); f.change('chk-footer', false); f.change('data-type', 'uint8'); await f.app.engineView.apply();
    };
    await updatePrimary();
    f.click('workspace-channel-auto-map');
    const workspace = f.app.workspaceChannels, controller = f.app.widgets;
    assert.deepEqual(Array.from(workspace.mappings, entry => entry.sourceId), ['primary']);
    const derived = controller.addChannel('formula', workspace);
    await controller.updateChannelDefinition({ ...workspace.dataEngine.globals.channelDefinitions[0], expression: 'CH1 * 2' }, {}, workspace);
    assert.equal(derived, 2);
    const wave = controller.create({ type: 'wave', settings: { connectionSource: 'workspace' } });
    controller.setChannelVisible(1, true);

    addSerial(f, { 'conn-type': 'udp', 'net-port': '9051' });
    const secondary = f.app.serialSources.get('serial-2').capture;
    f.selectConnection('serial-2', 'engine-parsing');
    f.change('engine-mode', 'Data_Array'); f.change('chk-header', false); f.change('chk-footer', false); f.change('data-type', 'uint8');
    await f.app.engineView.apply();
    f.click('connection-engine-back'); f.click('serial-manager-close');
    f.click('workspace-channel-auto-map');
    assert.deepEqual(Array.from(workspace.mappings, entry => entry.sourceId), ['primary', 'serial-2']);
    assert.equal(workspace.dataEngine.globals.channelDefinitions[0].number, 3);
    assert.equal(wave.view.getChannelMeta()[2].visible, true);
    f.change('max-points', '1000');
    controller.setPlotWindowPoints('5000');
    assert.equal(workspace.capacity, 5000);
    assert.equal(secondary.capacity, 5000);
    controller.setChannelVisible(0, true); controller.setChannelVisible(1, true);
    await controller.updateChannelDefinition({ ...workspace.dataEngine.globals.channelDefinitions[0], expression: 'CH1 - CH2' }, {}, workspace);
    f.app.service.receive(Uint8Array.of(23), { timestamp: 1000 });
    secondary.receive(Uint8Array.of(9), { timestamp: 1000 });
    await f.tick(10);
    const frames = wave.source.frames;
    assert.equal(frames.getValue(0, 0), 23);
    assert.equal(frames.getValue(1, 0), 9);
    assert.equal(frames.getValue(2, 0), 14);
    f.change('widget-export-format', 'csv');
    assert.equal(await f.app.exportWidgetData(), true);
    assert.match(await f.blobs.at(-1).text(), /23,9,14/);
    const rawHistory = [f.app.service, secondary].map(capture => [capture.history.endByte, capture.epoch]);
    f.click('serial-manager-open'); f.selectConnection('serial-2');
    f.change('serial-config-offset', '-2'); saveSerialConfig(f);
    assert.equal(wave.source.frames.getValue(2, 0), 14, 'previous synchronized data remains visible while recalculating');
    assert.deepEqual([f.app.service, secondary].map(capture => [capture.history.endByte, capture.epoch]), rawHistory);
    await f.tick(100);
    assert.equal(wave.source.frames.timestampAt(0), 998);
    assert.equal(wave.source.frames.getValue(2, 2), 14);
    f.click('serial-manager-close'); f.click('btn-pause');
    f.click('serial-manager-open'); f.selectConnection('serial-2');
    f.change('serial-config-offset', '2'); saveSerialConfig(f);
    assert.equal(wave.source.frames.getValue(2, 2), 14, 'the communications dialog also preserves the displayed history');
    await f.tick(100);
    assert.equal(wave.source.frames.timestampAt(0), 1000);
    assert.equal(wave.source.frames.getValue(2, 2), 14);
    assert.equal(f.app.service.paused, true);
    assert.equal(secondary.paused, true);
    assert.deepEqual([f.app.service, secondary].map(capture => [capture.history.endByte, capture.epoch]), rawHistory);
    const titleRow = wave.refs['waveform-drag-handle'];
    assert.equal(titleRow.querySelector('.widget-alignment-status')?.textContent, '全局通道 · 近似对齐');
    assert.equal(wave.engineNotice.hidden, true);
    const restored = bootApplication(f.app.getConfig()); t.after(() => restored.app.dispose());
    assert.equal(restored.app.widgets.widgets.get(wave.id).settings.connectionSource, 'workspace');
    assert.equal(restored.app.workspaceChannels.dataEngine.globals.channelDefinitions[0].number, 3);
});

test('global waveforms receive aligned batches while painting is deferred and another widget is active', async t => {
    const f = bootApplication(); t.after(() => f.app.dispose());
    addSerial(f);
    f.selectConnection('serial-2', 'engine-parsing');
    f.change('engine-mode', 'Data_Array');
    await f.app.engineView.apply();
    f.click('serial-manager-close');
    f.click('workspace-channel-auto-map');
    const workspace = f.app.workspaceChannels, widgets = f.app.widgets;
    assert.deepEqual(Array.from(workspace.mappings, entry => entry.sourceId), ['primary', 'serial-2']);
    const wave = widgets.create({ type: 'wave', settings: { connectionSource: 'workspace' } });
    widgets.setChannelVisible(0, true); widgets.setChannelVisible(1, true);
    const other = widgets.create({ type: 'byte' });
    await f.tick(10);
    assert.equal(widgets.active, other);

    // Hold repaint callbacks while letting the ordinary capture and timer callbacks run.
    const deferred = new Map(f.rafs);
    f.rafs.clear();
    const requestFrame = f.context.requestAnimationFrame, cancelFrame = f.context.cancelAnimationFrame;
    f.context.requestAnimationFrame = callback => {
        const id = requestFrame(callback);
        f.rafs.delete(id);
        deferred.set(id, callback);
        return id;
    };
    f.context.cancelAnimationFrame = id => { deferred.delete(id); cancelFrame(id); };
    const wire = value => {
        const bytes = Uint8Array.of(0, 0, 0, 0, 0, 0, 128, 127);
        new DataView(bytes.buffer).setFloat32(0, value, true);
        return bytes;
    };
    const now = Date.now() - 30, incoming = [f.app.service, f.app.serialSources.get('serial-2').capture];
    const before = wave.view.completedDraws;
    try {
        for (const [i, value] of [1, 10].entries()) {
            incoming[i].receive(wire(value), { timestamp: now - 5 });
            incoming[i].receive(wire(value * 2), { timestamp: now });
        }
        await f.tick(10);
        assert.equal(wave.view.completedDraws, before);
        assert.equal(workspace.numericSource.frames.liveTimeBounds(1000)?.last, now,
            'capture alignment must run before the next paint');
        assert.deepEqual([0, 1].map(channel =>
            workspace.numericSource.frames.rawTraceAt(channel, 0, 1, { first: now, last: now }).values.at(-1)), [2, 20]);
    } finally {
        f.context.requestAnimationFrame = requestFrame;
        f.context.cancelAnimationFrame = cancelFrame;
        for (const [id, callback] of deferred) f.rafs.set(id, callback);
    }
    await f.tick(10);
    assert.ok(wave.view.completedDraws > before);
    assert.equal(widgets.active, other);
});

test('zoomed live workspace follows both native traces while the synchronous grid is waiting', async t => {
    const f = bootApplication();
    t.after(() => f.app.dispose());
    addSerial(f);
    f.selectConnection('serial-2', 'engine-parsing');
    f.change('engine-mode', 'Data_Array');
    await f.app.engineView.apply();
    f.click('serial-manager-close');
    f.click('workspace-channel-auto-map');
    const widgets = f.app.widgets, workspace = f.app.workspaceChannels;
    const { view } = widgets.create({ type: 'wave', settings: { connectionSource: 'workspace' } });
    widgets.setChannelVisible(0, true);
    widgets.setChannelVisible(1, true);
    widgets.setPlotWindowPoints(64);
    const events = (start, count) => Array.from({ length: count }, (_, i) => ({
        time: 1000 + start + i, values: [[0, start + i], [1, -(start + i)]], origin: {}
    }));
    workspace.ingest(events(0, 200));
    view.draw();
    view.canvas.dispatchEvent({ type: 'wheel', clientX: 220, clientY: 120, deltaY: -120 });
    view.draw();
    const zoomed = { ...view._drawState.aligned };
    assert.ok(zoomed.last - zoomed.first < 63, 'wheel narrows the 64-sample window');
    assert.ok(zoomed.last < 1199, 'zoom around the pointer leaves an offset from latest');
    const gridCount = workspace.numericSource.frames.length;
    workspace.ingest(events(200, 12), true, 1199);
    assert.equal(workspace.numericSource.frames.length, gridCount);
    view.draw();
    assert.equal(view._drawState.aligned.first, zoomed.first + 12);
    assert.equal(view._drawState.aligned.last, zoomed.last + 12);
    const series = view._timeSeriesCache.series;
    assert.equal(series.length, 2);
    const time = Math.floor(zoomed.last + 12);
    for (const { channelIndex, times, rawValues } of series) {
        const index = times.indexOf(time);
        assert.ok(index >= 0, 'the newly visible native sample is in the drawn trace');
        assert.equal(rawValues[index], channelIndex === 0 ? time - 1000 : 1000 - time);
    }
});

test('source timebase settings update retained samples atomically and survive configuration reload', async t => {
    const f = bootApplication(); t.after(() => f.app.dispose());
    f.change('chk-header', false); f.change('chk-footer', false);
    f.change('data-type', 'uint8'); f.change('channels-count', '2');
    await f.app.engineView.apply();
    f.click('workspace-channel-auto-map');
    const service = f.app.service, combined = f.app.workspaceChannels;
    const wave = f.app.widgets.create({ type: 'wave', settings: { connectionSource: 'workspace' } });
    service.receive(Uint8Array.of(10, 50, 11, 51, 13, 53), { timestamp: 1000 });
    await f.tick(100);
    const previous = wave.source.frames;
    assert.deepEqual(Array.from(previous.rawTraceAt(0, 0, previous.length).times), [1000, 1000, 1000]);
    const raw = [service.history.endByte, service.epoch, service.numericSource.frames.length];
    f.click('serial-manager-open'); f.selectConnection('primary');
    f.change('channel-timebase-mode', 'fixed');
    f.change('channel-timebase-rate', '1000');
    const single = f.app.widgets.create({ type: 'wave' });
    saveSerialConfig(f);
    assert.equal(wave.source.frames, previous);
    await f.tick(100);
    const frames = wave.source.frames;
    assert.notEqual(frames, previous);
    const trace = frames.rawTraceAt(0, 0, frames.length);
    assert.deepEqual(Array.from(trace.times), [1000, 1001, 1002]);
    assert.equal(frames.getValue(0, 2), 13);
    assert.equal(single.view.timeXUnit, 's');
    assert.equal(single.view.sampleRateHz, 1000);
    assert.deepEqual([service.history.endByte, service.epoch, service.numericSource.frames.length], raw);
    const config = f.app.getConfig(), restored = bootApplication(config);
    t.after(() => restored.app.dispose());
    assert.equal(restored.get('channel-timebase-mode').value, 'fixed');
    assert.equal(restored.app.getConfig().workspaceChannels.timebases.primary.sampleRate, 1000);
    f.change('channel-timebase-rate', '0');
    saveSerialConfig(f);
    assert.match(f.get('channel-alignment-status').textContent, /采样率/);
    assert.equal(combined.timebases.primary.sampleRate, 1000);
});

test('changing a timebase without rebuilding preserves the time of already received frames', async t => {
    const f = bootApplication(); t.after(() => f.app.dispose());
    f.change('chk-header', false); f.change('chk-footer', false);
    f.change('data-type', 'uint8'); f.change('channels-count', '1');
    await f.app.engineView.apply();
    f.click('workspace-channel-auto-map');
    const { service, workspaceChannels } = f.app;
    service.receive(Uint8Array.of(10, 11), { timestamp: 1000 });
    await f.tick(100);
    const history = workspaceChannels.numericSource.frames;
    const single = f.app.widgets.create({ type: 'wave', settings: { plotTimeXUnit: 's', plotTimeXUnitExplicit: true } });
    assert.equal(single.view.timeXUnit, 's');
    const trace = () => Array.from(history.rawTraceAt(0, 0, history.length).times);
    assert.deepEqual(trace(), [1000, 1000]);
    f.selectConnection();
    f.change('rebuild-history', false); saveSerialConfig(f);
    f.click('serial-manager-close');
    service.receive(Uint8Array.of(12, 13), { timestamp: 1005 });
    f.change('sidebar-timebase-mode', 'fixed');
    f.get('sidebar-time-alignment-group').dispatchEvent({ type: 'pointerleave' });
    service.receive(Uint8Array.of(14, 15), { timestamp: 1010 });
    await f.tick(100);
    assert.equal(workspaceChannels.numericSource.frames, history);
    assert.deepEqual(trace(), [1000, 1000, 1005, 1005, 1010, 1011]);
    assert.deepEqual(Array.from({ length: 6 }, (_, index) => single.view.timeProjection.timestampAt(index)),
        [0, 0, 5, 5, 6, 7]);
    assert.equal(single.view.sampleRateHz, 1000);
});

test('cross-connection time navigation uses timestamps and applies a signed millisecond offset', async t => {
    const f = bootApplication(); t.after(() => f.app.dispose());
    f.change('chk-header', false); f.change('chk-footer', false); f.change('data-type', 'uint8'); await f.app.engineView.apply();
    addSerial(f);
    const second = f.app.serialSources.get('serial-2');
    f.selectConnection('serial-2', 'engine-parsing');
    f.change('engine-mode', 'Data_Array'); f.change('chk-header', false); f.change('chk-footer', false); f.change('data-type', 'uint8');
    await f.app.engineView.apply();
    f.click('connection-engine-back'); f.click('serial-manager-close');
    const a = f.app.widgets.create({ type: 'wave' }), b = f.app.widgets.create({ type: 'wave' });
    f.change('widget-connection-source', 'serial-2');
    f.app.service.receive(Uint8Array.of(1), { timestamp: 1000 });
    f.app.service.receive(Uint8Array.of(2), { timestamp: 1004 });
    second.capture.receive(Uint8Array.of(4), { timestamp: 2000 });
    second.capture.receive(Uint8Array.of(5), { timestamp: 2004 });
    await f.settle();
    f.app.widgets.activate(a.id); f.click('btn-pause');
    f.change('nav-jump-mode', 'relative'); f.change('nav-jump-relative', '.004');
    assert.equal(f.app.tools.jumpToTime(), true);
    assert.equal(b.view.navigationMarkers.timeOrder, null);
    assert.match(f.get('nav-jump-status').textContent, /超出保留范围/);
    f.click('serial-manager-open'); f.selectConnection('primary');
    assert.equal(f.get('serial-config-offset').disabled, true);
    f.selectConnection('serial-2');
    assert.equal(f.get('serial-config-offset').disabled, false);
    f.change('serial-config-offset', '-1000.5'); saveSerialConfig(f);
    assert.match(f.get('channel-alignment-status').textContent, /整数/);
    assert.equal(second.settings.timeOffsetMs, 0);
    f.change('serial-config-offset', '-1000'); saveSerialConfig(f);
    f.click('serial-manager-close');
    assert.equal(f.app.tools.jumpToTime(), true);
    assert.equal(b.view.navigationMarkers.timeOrder, b.source.frames.orderAt(1));
    assert.equal(f.app.getConfig().serialSources.entries[0].timeOffsetMs, -1000);
    f.click('serial-manager-open'); f.selectConnection('serial-2');
    assert.equal(f.get('serial-config-offset').value, '-1000');
    f.change('serial-config-offset', '-999'); saveSerialConfig(f);
    const restored = bootApplication(f.app.getConfig()); t.after(() => restored.app.dispose());
    restored.click('serial-manager-open'); restored.selectConnection('serial-2');
    assert.equal(restored.get('serial-config-offset').value, '-999');
});

test('serial and multiple network sources connect, receive and send independently', async t => {
    const f = bootApplication(); t.after(() => f.app.dispose());
    const port = makePort(), sockets = [];
    f.context.navigator.serial = { requestPort: async () => port, getPorts: async () => [port] };
    f.context.WebSocket = class {
        static OPEN = 1;
        static CLOSING = 2;
        constructor(url) {
            this.readyState = 0; this.sent = [];
            if (url.endsWith('/serial')) queueMicrotask(() => this.onerror());
            else sockets.push(this);
        }
        send(value) { this.sent.push(value); }
        close() { this.readyState = this.constructor.CLOSING; }
        open() { this.readyState = this.constructor.OPEN; this.onopen(); }
        receive(data) { this.onmessage({ data }); }
    };

    f.click('serial-manager-open');
    await chooseSerial(f);
    addSerial(f, { 'serial-config-name': 'TCP source', 'conn-type': 'tcp-client', 'net-port': '9001' });
    addSerial(f, { 'serial-config-name': 'UDP source', 'conn-type': 'udp', 'net-port': '9002', 'net-local': '9003' });
    assert.equal(f.get('serial-2-bind').hidden, true);
    assert.equal(f.get('serial-3-bind').hidden, true);
    f.click('serial-manager-close');

    f.click('btn-connect'); await f.tick(1);
    assert.equal(sockets.length, 2);
    for (const socket of sockets) socket.open();
    assert.deepEqual(sockets.map(socket => JSON.parse(socket.sent[0])), [
        { cmd: 'connect', mode: 'tcp-client', host: '127.0.0.1', port: 9001 },
        { cmd: 'connect', mode: 'udp', host: '127.0.0.1', port: 9002, localPort: 9003 }
    ]);
    sockets[0].receive('{"event":"connected"}');
    sockets[1].receive('{"event":"listening"}');
    await f.tick(1);
    assert.match(f.get('connection-status').textContent, /3\s*\/\s*3/);
    port.receive([11]);
    sockets[0].receive(Uint8Array.of(22, 23).buffer);
    sockets[1].receive(Uint8Array.of(33, 34, 35).buffer);
    await f.tick(1);
    const tcp = f.app.serialSources.get('serial-2'), udp = f.app.serialSources.get('serial-3');
    assert.equal(f.app.service.history.endByte, 1);
    assert.equal(tcp.capture.history.endByte, 2);
    assert.equal(udp.capture.history.endByte, 3);

    f.change('send-connection-source', 'serial-3'); f.change('send-input', 'AB');
    f.click('btn-send'); await f.tick(1);
    assert.deepEqual([...sockets[1].sent[1]], [0xab]);
    assert.equal(sockets[0].sent.length, 1);
    assert.equal(tcp.capture.txFrames.length, 0);
    assert.deepEqual([...udp.capture.txFrames.rawBytesAt(0)], [0xab]);

    f.click('serial-manager-open'); f.click('serial-3-connect'); await f.tick(1);
    assert.equal(udp.connected, false);
    assert.equal(tcp.connected, true);
    assert.equal(port.closed, 0);
    const config = f.app.getConfig();
    const restored = bootApplication(config); t.after(() => restored.app.dispose());
    assert.equal(restored.app.serialSources.get('serial-2').settings.mode, 'tcp-client');
    restored.click('serial-manager-open'); restored.selectConnection('serial-3');
    assert.equal(restored.get('conn-type').value, 'udp');
    assert.equal(restored.get('net-local').value, '9003');
    const byte = f.app.widgets.create({ type: 'byte' });
    f.change('widget-connection-source', 'serial-3');
    f.selectConnection('serial-3'); f.change('conn-type', 'tcp-server');
    assert.equal(f.get('wrap-net-host').hidden, true);
    assert.equal(f.get('wrap-local-port').hidden, true);
    f.change('net-port', '0'); saveSerialConfig(f);
    assert.match(f.get('serial-config-error').textContent, /端口/);
    assert.equal(udp.settings.mode, 'tcp-server');
    assert.equal(udp.settings.port, '9002');
    f.change('net-port', '9004'); saveSerialConfig(f);
    assert.equal(udp.settings.mode, 'tcp-server');
    assert.ok(byte.capture === udp.capture);
    assert.equal(udp.capture.history.endByte, 3);
    f.click('serial-manager-close'); f.click('serial-disconnect-all'); await f.tick(1);
    assert.match(f.get('connection-status').textContent, /0\s*\/\s*3/);

    await f.tick(1);
    assert.equal(f.get('btn-connect').disabled, false);
    delete f.context.navigator.serial;
    f.click('btn-connect'); await f.tick(1);
    assert.equal(sockets.length, 4);
    sockets[2].open(); sockets[3].open();
    assert.deepEqual(JSON.parse(sockets[3].sent[0]), { cmd: 'connect', mode: 'tcp-server', port: 9004, localPort: 9004 });
    sockets[2].receive('{"event":"error","msg":"offline"}');
    sockets[3].receive('{"event":"listening"}');
    await f.tick(1);
    assert.match(f.get('connection-status').textContent, /1\s*\/\s*3/);
    assert.match(f.get('serial-2-status').textContent, /offline/);
    assert.equal(udp.connected, true);
});

test('regular sends target the selected physical connection and retain its own TX bytes', async t => {
    const f = bootApplication(); t.after(() => f.app.dispose());
    const primary = makePort(), secondary = makePort(), ports = [primary, secondary], sent = [[], []];
    ports.forEach((port, index) => {
        port.writable = { getWriter: () => ({ write: async bytes => sent[index].push([...bytes]), releaseLock() {} }) };
    });
    f.context.navigator.serial = { requestPort: async () => ports.shift() };
    f.click('serial-manager-open');
    await chooseSerial(f);
    addSerial(f); await chooseSerial(f, 'serial-2');
    f.change('send-connection-source', 'serial-2'); f.change('send-input', 'AB CD');
    f.change('send-interval', '1');
    f.click('btn-send'); await f.tick(1);
    assert.deepEqual(sent, [[], [[0xab, 0xcd]]]);
    assert.equal(f.app.service.txFrames.length, 0);
    const target = f.app.serialSources.get('serial-2').capture;
    assert.deepEqual([...target.txFrames.rawBytesAt(0)], [0xab, 0xcd]);
    f.change('send-connection-source', 'primary'); await f.tick(2000);
    assert.deepEqual(sent, [[], [[0xab, 0xcd]]]);
    f.change('send-interval', '0'); f.click('btn-send'); await f.tick(1);
    assert.deepEqual(sent, [[[0xab, 0xcd]], [[0xab, 0xcd]]]);

    f.change('export-source', 'serial-2'); f.change('export-format', 'binary');
    f.change('export-direction', 'tx');
    assert.equal(await f.app.exportData(), true);
    assert.deepEqual([...new Uint8Array(await f.blobs.at(-1).arrayBuffer())], [0xab, 0xcd]);
});

test('a secondary custom protocol decodes and exports its own fields without changing primary rules', async t => {
    const original = bootApplication(); t.after(() => original.app.dispose());
    addSerial(original);
    const config = original.app.getConfig(), source = config.serialSources.entries[0];
    const schema = { id: 'secondary-protocol', endian: 'little',
        framing: { header: [170], fixedLength: 4 }, command: { offset: 1, type: 'uint8' }, payloadOffset: 2,
        messages: [{ id: 'data', name: '温度', command: 1, fields: [{ name: 'temperature', type: 'int16' }] }] };
    Object.assign(source.engine, { mode: 'Self_Defined_Frame', protocols: [schema], protocolId: schema.id,
        mappings: [{ protocolId: schema.id, messageId: 'data', path: 'temperature', channel: 0 }] });
    const f = bootApplication(config); t.after(() => f.app.dispose());
    const secondary = f.app.serialSources.get('serial-2').capture;
    const byte = f.app.widgets.create({ type: 'byte', settings: { captureMode: 'engine', connectionSource: 'serial-2' } });
    secondary.receive(Uint8Array.of(170, 1, 0x4c, 0x04));
    await f.tick(20);
    assert.equal(byte.source.kind, 'protocol');
    assert.equal(byte.source.frames.length, 1);
    assert.equal(f.app.service.numericSource.frames.length, 0);
    f.change('widget-export-format', 'engine-text');
    assert.equal(await f.app.exportWidgetData(), true);
    assert.match(await f.blobs.at(-1).text(), /temperature=1100/);
    f.click('workspace-channel-auto-map');
    await f.tick(30);
    const capture = f.app.workspaceChannels;
    const index = capture.mappings.findIndex(entry => entry.sourceId === 'serial-2');
    assert.ok(index >= 0);
    const frames = capture.numericSource.frames;
    assert.equal(frames.getValue(index, 0), 1100);
    assert.equal(frames.provenanceAt(index, 0).sourceId, 'serial-2');
    f.change('send-connection-source', 'serial-2');
    assert.equal(f.app.protocolSession.getProtocol(schema.id)?.id, schema.id);
    f.change('send-connection-source', 'primary');
    assert.equal(f.app.protocolSession.getProtocol(schema.id), undefined);
});

test('adding a source immediately shows its parameters in the communication tab', t => {
    const f = bootApplication(); t.after(() => f.app.dispose());
    f.click('serial-manager-open');
    f.click('serial-source-add');
    const source = f.app.serialSources.get('serial-2');
    assert.ok(source);
    assert.equal(source.connected, false);
    assert.equal(f.get('serial-config-form').closest('#engine-communication'), f.get('engine-communication'));
    assert.equal(f.get('serial-config-form').hidden, false);
    assert.equal(f.get('serial-2-engine'), null);
    assert.equal(f.get('serial-config-name').value, '来源 2');
    assert.equal(f.get('serial-source-nav').querySelector('[aria-current="true"]').getAttribute('aria-controls'), 'serial-2-details');
});

test('all five connection modes apply and save immediately without committing other fields', async t => {
    const f = bootApplication(); t.after(() => f.app.dispose());
    f.click('serial-manager-open');
    for (const id of ['primary', 'serial-2']) {
        if (id !== 'primary') f.click('serial-source-add');
        const savedMode = () => id === 'primary' ? f.app.getConfig().global.connType : f.app.serialSources.get(id).settings.mode;
        const prefix = id === 'primary' ? 'serial-primary' : id;
        f.change('serial-baud', '1250000');
        for (const mode of ['bridge-serial', 'tcp-client', 'tcp-server', 'udp', 'serial']) {
            f.change('conn-type', mode);
            assert.equal(savedMode(), mode);
            assert.equal(f.get(prefix + '-connect').disabled, false);
            assert.equal(f.get(prefix + '-bind').hidden, !['serial', 'bridge-serial'].includes(mode));
        }
        assert.equal(f.get('serial-baud').value, '1250000');
        assert.equal(id === 'primary' ? Number(f.app.getConfig().global.serialBaud) : f.app.serialSources.get(id).settings.baudRate, 115200);
    }
    f.change('conn-type', 'bridge-serial');
    await f.app.flushConfig();
    const saved = JSON.parse(f.storage.get('serialplot_v3_config'));
    assert.equal(saved.serialSources.entries[0].mode, 'bridge-serial');
    assert.equal(saved.serialSources.entries[0].baudRate, 115200);
    assert.match(f.get('serial-mode-help').textContent, /休眠/);
    assert.match(f.get('serial-mode-help').textContent, /start-bridge\.bat/);
    assert.match(f.get('serial-mode-help').textContent, /start-bridge\.sh/);
});

test('serial configuration is a draft until saved and connected ports keep their link settings', async t => {
    const f = bootApplication(); t.after(() => f.app.dispose());
    const port = makePort();
    let selections = 0;
    f.context.navigator.serial = { requestPort() { selections++; return Promise.resolve(port); } };
    const dialog = () => f.get('serial-config-dialog');

    f.click('serial-manager-open'); f.click('serial-source-add');
    assert.equal(dialog().open, true);
    assert.equal(f.app.serialSources.size, 1);
    assert.equal(f.app.getConfig().serialSources.nextNumber, 3);
    assert.equal(f.get('serial-baud').value, '115200');
    f.change('serial-baud', '460800');
    f.selectConnection('primary');
    assert.equal(f.get('serial-baud').value, '115200');
    f.selectConnection('serial-2');
    assert.equal(f.get('serial-baud').value, '460800');
    assert.equal(f.app.serialSources.get('serial-2').settings.baudRate, 115200);
    f.change('serial-baud', '0');
    saveSerialConfig(f);
    assert.equal(dialog().open, true);
    assert.match(f.get('serial-config-error').textContent, /Baud rate/);
    assert.equal(f.app.serialSources.get('serial-2').settings.baudRate, 115200);
    f.change('serial-baud', '1250000');
    f.change('serial-config-name', '第二路');
    saveSerialConfig(f);
    assert.equal(dialog().open, true);
    assert.equal(f.get('serial-config-form').hidden, false);
    assert.equal(f.app.serialSources.size, 1);
    assert.match(f.get('serial-config-status').textContent, /Bridge/);
    assert.equal(selections, 0);
    assert.match(f.get('serial-2-summary').textContent, /1,250,000.*8N1/);

    await chooseSerial(f, 'serial-2');
    assert.equal(port.opened.baudRate, 1250000);
    f.selectConnection('serial-2');
    assert.equal(f.get('serial-baud').disabled, true);
    assert.equal(f.get('serial-config-name').disabled, false);
    f.change('serial-baud', '1');
    f.change('serial-config-name', '采样串口');
    saveSerialConfig(f);
    f.change('serial-config-offset', '-4'); saveSerialConfig(f);
    const source = f.app.serialSources.get('serial-2');
    assert.equal(source.settings.name, '采样串口');
    assert.equal(source.settings.timeOffsetMs, -4);
    assert.equal(source.settings.baudRate, 1250000);
    assert.equal(source.connected, true);
    assert.equal(port.closed, 0);

    f.selectConnection('serial-2');
    f.change('serial-config-name', '待取消名称');
    f.click('serial-manager-close');
    assert.equal(source.settings.name, '采样串口');
});

test('bulk connect opens bound serial ports without showing a picker and can disconnect all', async t => {
    const f = bootApplication(); t.after(() => f.app.dispose());
    const ports = [makePort(), makePort()], grants = [], requests = ports.slice();
    ports[0].getInfo = () => ({ usbVendorId: 0x0483, usbProductId: 0x5740 });
    ports[1].getInfo = () => ({ usbVendorId: 0x1a86, usbProductId: 0x55da });
    let selections = 0;
    f.context.navigator.serial = {
        requestPort() { selections++; const port = requests.shift(); grants.push(port); return Promise.resolve(port); },
        getPorts: async () => grants.slice()
    };
    f.click('btn-connect'); await f.tick(1);
    assert.equal(selections, 0);
    assert.equal(ports[0].opened, null);
    assert.match(f.get('connection-status').textContent, /绑定/);

    f.click('serial-manager-open');
    assert.equal(f.get('serial-config-dialog').open, true);
    assert.ok(f.get('serial-source-add').closest('#serial-config-dialog'));
    addSerial(f, { 'serial-baud': '1250000' });
    assert.equal(f.get('serial-config-dialog').open, true);
    assert.equal(f.get('serial-config-form').hidden, false);
    await chooseSerial(f);
    assert.equal(f.app.serialAdapter.port, ports[0]);
    assert.equal(ports[1].opened, null);
    await chooseSerial(f, 'serial-2');
    assert.equal(f.app.serialSources.get('serial-2').adapter.port, ports[1]);
    assert.equal(selections, 2);
    assert.deepEqual(ports.map(port => port.openCount), [1, 1]);
    assert.equal(ports[0].opened.baudRate, 115200);
    assert.equal(ports[1].opened.baudRate, 1250000);
    assert.match(f.get('connection-status').textContent, /2\s*\/\s*2/);

    f.click('serial-manager-close');
    f.click('serial-disconnect-all'); await waitForConnectionButton(f, 'btn-connect');
    assert.deepEqual(ports.map(port => port.closed), [1, 1]);
    f.click('btn-connect'); await waitForConnectionButton(f, 'serial-disconnect-all');
    assert.equal(selections, 2);
    assert.deepEqual(ports.map(port => port.openCount), [2, 2]);
    const config = f.app.getConfig();
    const restored = bootApplication(config); t.after(() => restored.app.dispose());
    restored.context.navigator.serial = { getPorts: async () => ports, requestPort() { throw new Error('unexpected picker'); } };
    await f.app.dispose();
    restored.click('btn-connect'); await restored.tick(1);
    assert.equal(restored.app.serialAdapter.port, ports[0]);
    assert.equal(restored.app.serialSources.get('serial-2').adapter.port, ports[1]);
});

test('cancelling the chooser or failing to open leaves the source ready for another attempt', async t => {
    const f = bootApplication(); t.after(() => f.app.dispose());
    const port = makePort(), open = port.open;
    port.getInfo = () => ({ usbVendorId: 1, usbProductId: 2 });
    let selections = 0, granted = false, opens = 0;
    f.context.navigator.serial = {
        async requestPort() {
            if (++selections === 1) throw Object.assign(new Error('picker cancelled'), { name: 'NotFoundError' });
            return port;
        },
        getPorts: async () => granted ? [port] : []
    };
    port.open = async options => {
        if (++opens === 1) throw Object.assign(new Error('端口已拔出'), { name: 'NotFoundError' });
        await open(options);
    };

    f.click('serial-manager-open');
    await chooseSerial(f);
    assert.equal(opens, 0);
    assert.deepEqual(Array.from(f.app.getConfig().serialSources.bindings), []);
    assert.doesNotMatch(f.get('serial-primary-status').textContent, /失败/);
    assert.equal(f.get('serial-primary-bind').disabled, false);

    await chooseSerial(f);
    assert.equal(opens, 1, 'connect uses the handle returned by the picker even before the grant list catches up');
    assert.equal(f.app.serialAdapter.port, null);
    assert.match(f.get('serial-primary-status').textContent, /连接失败.*端口已拔出/);
    assert.equal(f.app.getConfig().serialSources.bindings[0].usbProductId, 2);
    assert.equal(f.get('serial-primary-connect').disabled, false);
    granted = true;
    f.click('serial-primary-connect'); await f.tick(1);
    assert.equal(f.app.serialAdapter.port, port);
    assert.equal(opens, 2);
    assert.equal(selections, 2);
});

test('after reload a same-model serial binding never matches another source by list order', async t => {
    const f = bootApplication(); t.after(() => f.app.dispose());
    const ports = [makePort(), makePort()], requests = ports.slice();
    for (const port of ports) port.getInfo = () => ({ usbVendorId: 0x1a86, usbProductId: 0x55da });
    f.context.navigator.serial = { getPorts: async () => ports, requestPort: async () => requests.shift() };
    f.click('serial-manager-open'); addSerial(f);
    await chooseSerial(f);
    await chooseSerial(f, 'serial-2');
    const restored = bootApplication(f.app.getConfig()); t.after(() => restored.app.dispose());
    restored.context.navigator.serial = { getPorts: async () => [ports[1]], requestPort() { throw new Error('unexpected picker'); } };
    restored.click('btn-connect'); await restored.tick(1);
    assert.equal(restored.app.serialAdapter.port, null);
    assert.equal(restored.app.serialSources.get('serial-2').adapter.port, null);
    assert.equal(ports[1].openCount, 1, 'reload must leave the same-model port at its original open count');
    restored.click('serial-manager-open');
    assert.match(restored.get('serial-2-binding').textContent, /确认/);
});

test('bulk connection opens available sources even if another port is offline', async t => {
    const f = bootApplication(); t.after(() => f.app.dispose());
    addSerial(f);
    const config = f.app.getConfig();
    config.serialSources.bindings = [
        { id: 'primary', usbVendorId: 10, usbProductId: 11 },
        { id: 'serial-2', usbVendorId: 20, usbProductId: 21 }
    ];
    f.app.applyConfig(config);
    const primary = makePort(), secondary = makePort();
    primary.getInfo = () => ({ usbVendorId: 10, usbProductId: 11 });
    secondary.getInfo = () => ({ usbVendorId: 20, usbProductId: 21 });
    const grants = [primary];
    f.context.navigator.serial = { getPorts: async () => grants.slice(), requestPort() { throw new Error('unexpected picker'); } };
    f.click('serial-manager-close');
    f.click('btn-connect'); await f.tick(1);
    assert.equal(f.app.serialAdapter.port, primary);
    assert.equal(secondary.opened, null);
    assert.match(f.get('connection-status').textContent, /1\s*\/\s*2/);
    assert.match(f.get('serial-2-binding').textContent, /不在线/);
    grants.push(secondary);
    f.click('btn-connect'); await f.tick(1);
    assert.equal(f.app.serialSources.get('serial-2').adapter.port, secondary);
    assert.equal(primary.closed, 0);
    assert.match(f.get('connection-status').textContent, /2\s*\/\s*2/);
});

test('renaming the primary serial port updates the bound source labels and survives reload', async t => {
    const f = bootApplication(); t.after(() => f.app.dispose());
    addSerial(f);
    const port = makePort();
    f.context.navigator.serial = { requestPort: async () => port, getPorts: async () => [port] };
    await chooseSerial(f);
    f.selectConnection('primary');
    assert.equal(f.get('serial-config-name').value, '主串口');
    assert.equal(f.get('serial-config-name').disabled, false);
    assert.equal(f.get('serial-baud').disabled, true);

    f.change('serial-config-name', '   '); saveSerialConfig(f);
    assert.match(f.get('serial-config-error').textContent, /名称/);
    assert.equal(f.get('serial-primary-label').textContent, '主串口');
    f.change('serial-config-name', ' 主采样 '); saveSerialConfig(f);
    f.click('serial-manager-close');
    const widget = f.app.widgets.create({ type: 'wave' });
    assert.equal(widget.settings.connectionSource, 'primary');
    assert.equal(f.get('serial-primary-label').textContent, '主采样');
    for (const id of ['widget-connection-source', 'send-connection-source', 'export-source'])
        assert.match(f.get(id).options[0].textContent, /主采样/);
    f.click('serial-manager-open'); f.selectConnection('primary', 'engine-parsing');
    assert.match(f.get('serial-config-title').textContent, /主采样.*数据引擎/);
    assert.equal(f.app.serialAdapter.port, port);
    assert.equal(port.closed, 0);

    const restored = bootApplication(f.app.getConfig()); t.after(() => restored.app.dispose());
    assert.equal(restored.get('serial-primary-label').textContent, '主采样');
    assert.equal(restored.app.getConfig().global.serialBaud, '115200');
});

async function backloggedWorkspace(t) {
    const f = bootApplication();
    t.after(() => f.app.dispose());
    const useUint8 = async () => {
        f.change('engine-mode', 'Data_Array'); f.change('chk-header', false);
        f.change('chk-footer', false); f.change('data-type', 'uint8');
        await f.app.engineView.apply();
    };
    await useUint8();
    addSerial(f);
    f.selectConnection('serial-2', 'engine-parsing');
    await useUint8();
    f.click('serial-manager-close');
    f.change('max-points', '12000');
    f.click('workspace-channel-auto-map');
    const wave = f.app.widgets.create({ type: 'wave', settings: { connectionSource: 'workspace' } });
    f.app.widgets.setChannelVisible(1, true);
    const captures = [f.app.service, f.app.serialSources.get('serial-2').capture];
    const start = Date.now() - 20000;
    const feed = (batches, size, first) => {
        for (let n = 0; n < batches; n++) {
            const bytes = new Uint8Array(size).fill(n + 1);
            for (const capture of captures) capture.receive(bytes, { timestamp: start + first + 100 * n });
        }
    };
    feed(2, 25, 0);
    await f.tick(100);
    return { ...f, wave, captures, start, feed,
        pressP() { f.document.dispatchEvent({ type: 'keydown', key: 'p', target: f.document.body }); } };
}

test('pausing under alignment backlog holds the waveform until one automatic final draw', async t => {
    const f = await backloggedWorkspace(t);
    const view = f.wave.view;
    f.feed(60, 50, 200);
    const previous = view._drawState.aligned.last, before = view.completedDraws;
    f.pressP();
    assert.ok(f.captures.every(capture => capture.paused));
    assert.match(f.get('history-rebuild-progress').textContent, /整理暂停前/);
    assert.equal(f.get('nav-jump-button').disabled, true);
    assert.equal(view._drawState.aligned.last, previous);
    view.canvas.dispatchEvent({ type: 'pointermove', clientX: 70, clientY: 60, buttons: 0 });
    assert.equal(view.completedDraws, before);
    const retained = f.captures.map(capture => capture.history.endByte);
    f.feed(1, 5, 6300);
    await f.tick(100);
    assert.deepEqual(f.captures.map(capture => capture.history.endByte), retained);
    assert.equal(view._drawState.aligned.last, f.start + 6100);
    assert.equal(view.completedDraws, before + 1);
    assert.doesNotMatch(f.get('history-rebuild-progress').textContent, /整理暂停前/);
    assert.equal(f.get('nav-jump-button').disabled, false);
    view.canvas.dispatchEvent({ type: 'pointermove', clientX: 120, clientY: 60, buttons: 0 });
    assert.equal(view._drawState.aligned.last, f.start + 6100);
});

test('pause catch-up preserves a historical viewport and can be interrupted by resume', async t => {
    const f = await backloggedWorkspace(t);
    const view = f.wave.view;
    view.setPlotWindowPoints(80);
    assert.equal(view.jumpToFrame(20), true);
    view.draw();
    const anchor = { ...view._drawState.aligned };
    f.feed(40, 50, 200);
    f.pressP();
    await f.tick(100);
    assert.deepEqual({ ...view._drawState.aligned }, anchor);
    assert.equal(view.vp.time.autoFollow, false);

    f.pressP();
    f.feed(25, 50, 4200);
    f.pressP();
    assert.match(f.get('history-rebuild-progress').textContent, /整理暂停前/);
    f.pressP();
    assert.ok(f.captures.every(capture => !capture.paused));
    assert.doesNotMatch(f.get('history-rebuild-progress').textContent, /整理暂停前/);
    f.feed(1, 50, 6800);
    await f.tick(100);
    assert.equal(view.vp.time.autoFollow, true);
    assert.equal(view._drawState.aligned.last, f.start + 6800);
});

test('foreground return wakes a deferred alignment timer without mouse input', async t => {
    const f = await backloggedWorkspace(t);
    f.feed(40, 50, 200);
    const deferred = [...f.timers.values()].find(timer => timer.fn.toString().includes('pumpWorkspaceChannels()'));
    assert.ok(deferred);
    deferred.due += 10000;
    f.document.hidden = false;
    f.document.dispatchEvent({ type: 'visibilitychange' });
    await f.tick(100);
    assert.equal(f.wave.view._drawState.aligned.last, f.start + 4100);
});

function changeVisibility(f, hidden) {
    f.document.hidden = hidden;
    f.document.dispatchEvent({ type: 'visibilitychange' });
}

test('visible-only capture belongs to the communication channel group and restores from configuration', async t => {
    const f = bootApplication(); t.after(() => f.app.dispose());
    const option = f.get('capture-visible-only');
    assert.ok(option, 'the communication panel offers a visible-only capture checkbox');
    assert.equal(option.closest('.control-group'), f.get('btn-connect').closest('.control-group'));
    assert.equal(option.checked, false);
    changeVisibility(f, true);
    f.app.serialAdapter.onDataCallback(Uint8Array.of(1));
    assert.equal(f.app.service.history.endByte, 1, 'background capture is the default');
    changeVisibility(f, false);
    f.change('capture-visible-only', true);
    const saved = JSON.parse(JSON.stringify(f.app.getConfig()));
    assert.equal(saved.global.captureVisibleOnly, true);

    const restored = bootApplication(saved, { hidden: true }); t.after(() => restored.app.dispose());
    assert.equal(restored.get('capture-visible-only').checked, true);
    restored.app.serialAdapter.onDataCallback(Uint8Array.of(2));
    assert.equal(restored.app.service.history.endByte, 1, 'the startup grace period permits brief background capture');
    await restored.tick(5000);
    restored.app.serialAdapter.onDataCallback(Uint8Array.of(9));
    assert.equal(restored.app.service.history.endByte, 1, 'an initially hidden page applies its saved option after the grace period');
    changeVisibility(restored, false);
    restored.app.serialAdapter.onDataCallback(Uint8Array.of(3));
    assert.equal(restored.app.service.history.endByte, 2);

    const legacy = JSON.parse(JSON.stringify(saved));
    delete legacy.global.captureVisibleOnly;
    restored.app.applyConfig(legacy);
    assert.equal(restored.get('capture-visible-only').checked, false);
    changeVisibility(restored, true);
    await restored.tick(5100);
    restored.app.serialAdapter.onDataCallback(Uint8Array.of(4));
    assert.equal(restored.app.service.history.snapshot().at(-1).bytes[0], 4);
});

test('visible-only capture skips hidden data for both sources and resumes with fresh complete frames', async t => {
    const f = await backloggedWorkspace(t);
    const secondary = f.app.serialSources.get('serial-2');
    const adapters = [f.app.serialAdapter, secondary.adapter];
    const previousBytes = f.captures.map(capture => capture.history.endByte);
    let now = f.start + 200;
    for (const capture of f.captures) capture.wallNow = () => now;
    f.change('capture-visible-only', true);
    f.window.dispatchEvent({ type: 'blur' });
    adapters.forEach(adapter => adapter.onDataCallback(Uint8Array.of(123)));
    assert.deepEqual(f.captures.map(capture => capture.history.endByte), previousBytes.map(length => length + 1),
        'a visible page continues to acquire even when another window has focus');

    changeVisibility(f, true);
    now += 4999;
    await f.tick(4999);
    adapters.forEach(adapter => adapter.onDataCallback(Uint8Array.of(124)));
    assert.deepEqual(f.captures.map(capture => capture.history.endByte), previousBytes.map(length => length + 2));
    now += 1;
    await f.tick(1);
    const initialFrames = f.captures.map(capture => capture.numericSource.frames.length);
    for (const adapter of adapters) adapter.onDataCallback(new Uint8Array(2500).fill(222));
    now += 1500;
    await f.tick(1500);
    assert.deepEqual(f.captures.map(capture => capture.numericSource.frames.length), initialFrames);
    assert.deepEqual(f.captures.map(capture => capture.history.endByte), previousBytes.map(length => length + 2));
    changeVisibility(f, false);
    now += 1;
    adapters.forEach((adapter, index) => adapter.onDataCallback(Uint8Array.of(130 + index)));
    await f.tick(100);
    for (const [index, capture] of f.captures.entries()) {
        const frames = capture.numericSource.frames;
        assert.equal(frames.length, initialFrames[index] + 1);
        assert.equal(frames.getValue(0, frames.length - 1), 130 + index);
        const events = f.wave.source.frames.events.get(index);
        assert.equal(events.at(-1).value, 130 + index, 'the global waveform resumes at the new sample');
        assert.equal(events.at(-1).origin.alignedTime, now - 1500, 'only the interval after the grace period is folded');
        assert.equal(events.some(entry => entry.value === 222), false);
    }

    f.pressP();
    changeVisibility(f, true);
    now += 5100;
    await f.tick(5100);
    changeVisibility(f, false);
    adapters.forEach(adapter => adapter.onDataCallback(Uint8Array.of(200)));
    assert.ok(f.captures.every(capture => capture.paused));
    assert.deepEqual(f.captures.map(capture => capture.history.endByte), previousBytes.map(length => length + 3));
    f.pressP();
    assert.ok(f.captures.every(capture => !capture.paused));
});

test('visible-only capture leaves short switches untouched and cuts stale queues after throttled hidden timers', async t => {
    const f = bootApplication(); t.after(() => f.app.dispose());
    addSerial(f, { 'conn-type': 'udp' });
    const adapters = [f.app.serialAdapter, f.app.serialSources.get('serial-2').adapter];
    f.change('capture-visible-only', true);
    const observations = adapters.map(transport => {
        const grace = [], gates = [];
        let receiving = true;
        transport.setCaptureGrace = milliseconds => grace.push(milliseconds);
        transport.setCaptureVisible = visible => {
            if (receiving !== visible) gates.push(visible);
            receiving = visible;
        };
        return { grace, gates };
    });
    changeVisibility(f, true);
    for (const { grace } of observations) assert.deepEqual(grace, [5000], 'arm both transports as soon as the page hides');
    await f.tick(3000);
    changeVisibility(f, false);
    await f.tick(2500);
    for (const { grace, gates } of observations) {
        assert.deepEqual(grace, [5000, null], 'returning early cancels the transport grace period');
        assert.deepEqual(gates, [], 'a short absence leaves the original receive stream intact');
    }
    changeVisibility(f, true);
    f.advanceClockWithoutTasks(10000);
    for (const { gates } of observations) assert.deepEqual(gates, [], 'the simulated browser did not run the hidden timer');
    changeVisibility(f, false);
    for (const { grace, gates } of observations) {
        assert.deepEqual(gates, [false, true], 'foreground recovery resynchronizes the stream even when the timer never ran');
        assert.deepEqual(grace, [5000, null, 5000, null], 'both transports are ready for the next background transition');
    }
});

test('visible-only capture preserves an independent memory-pressure pause when the other source resumes', async t => {
    const f = bootApplication(); t.after(() => f.app.dispose());
    addSerial(f);
    const secondary = f.app.serialSources.get('serial-2');
    const check = secondary.capture.memory.beforeReceive;
    secondary.capture.memory.beforeReceive = () => false;
    secondary.adapter.onDataCallback(Uint8Array.of(1));
    secondary.capture.memory.beforeReceive = check;
    const reason = secondary.capture.memory.blockedReason;
    assert.ok(reason);
    assert.equal(secondary.capture.paused, true);
    assert.equal(f.app.service.paused, false);

    f.change('capture-visible-only', true);
    changeVisibility(f, true);
    await f.tick(5000);
    changeVisibility(f, false);
    assert.equal(secondary.capture.paused, true, 'automatic foreground recovery must preserve the memory-pressure pause');
    assert.equal(secondary.capture.memory.blockedReason, reason);
    f.app.serialAdapter.onDataCallback(Uint8Array.of(2));
    secondary.adapter.onDataCallback(Uint8Array.of(3));
    assert.equal(f.app.service.history.endByte, 1);
    assert.equal(secondary.capture.history.endByte, 0);
});

test('neither settings view shows the rapidly changing alignment backlog count', async t => {
    const f = await backloggedWorkspace(t);
    f.selectConnection('serial-2', 'engine-communication');
    f.feed(12, 50, 200);
    f.change('sidebar-sampling-source', 'serial-2');
    assert.doesNotMatch(f.get('sidebar-timebase-state').textContent, /待对齐/);
    assert.doesNotMatch(f.get('channel-timebase-state').textContent, /待对齐/);
});

test('source alignment reports unread frames evicted before the cursor caught up', async t => {
    const f = await backloggedWorkspace(t);
    f.change('max-points', '1000');
    f.feed(26, 100, 200);
    await f.tick(100);
    const workspace = f.app.workspaceChannels;
    assert.equal(workspace.cursors.get('primary').evictedUnread, 1600);
    assert.equal(workspace.cursors.get('serial-2').evictedUnread, 1600);
    for (const list of workspace.numericSource.frames.events.values())
        assert.ok(list.some(event => event.origin?.breakBefore), 'the retained suffix starts a new trace segment');
    assert.match(f.get('sidebar-timebase-state').textContent, /1[,， ]?600/);
    assert.match(f.get('channel-timebase-state').textContent, /1[,， ]?600/);
    assert.equal(workspace.numericSource.frames.liveTimeBounds(1000).last, f.start + 2700);
});

test('explicit Bridge mode binds and connects two independent serial sources', async t => {
    const f = bootApplication();
    t.after(() => f.app.dispose());
    const ports = ['COM3', 'COM518'].map((path, index) => ({ path, label: path, identity: String(index + 1).repeat(64) }));
    const opened = [];
    let nativePrompts = 0, bridgeStatus = { serial: true };
    const webPort = makePort();
    f.context.navigator.serial = { getPorts: async () => [webPort], requestPort: async () => { nativePrompts++; return webPort; } };
    f.S.BridgeSerialEngine = class {
        backend = 'bridge';
        static async probe() { return bridgeStatus; }
        static async ports(token) { assert.equal(token, 'test-access'); return ports; }
        onData(callback) { this.callback = callback; }
        onStatusChange(callback) { this.status = callback; }
        async connect(settings, binding, token) {
            assert.equal(token, 'test-access');
            if (!bridgeStatus?.serial) throw new Error('Bridge 串口不可用');
            this.binding = binding;
            opened.push([binding.path, settings.baudRate]);
            this.status(true);
        }
        async disconnect() { this.status(false); }
        async send() {}
        dispose() {}
    };
    f.click('serial-manager-open'); await f.tick();
    assert.match(f.get('serial-config-status').textContent, /Bridge 已运行/);
    await chooseSerial(f);
    assert.equal(nativePrompts, 1, 'Web mode uses the browser even when Bridge is running');
    f.click('serial-primary-connect'); await waitForConnectionButton(f, 'serial-primary-connect');
    f.change('conn-type', 'bridge-serial');
    assert.equal(f.get('serial-primary-bind').disabled, false);
    assert.equal(f.app.getConfig().global.connType, 'bridge-serial', f.get('engine-status').textContent);
    addSerial(f, { 'conn-type': 'bridge-serial', 'serial-baud': '1250000' });
    async function bind(id, path) {
        f.selectConnection(id);
        f.click(id === 'primary' ? 'serial-primary-bind' : id + '-bind');
        await f.tick();
        const chooser = f.get('bridge-serial-binding');
        assert.equal(chooser.tagName, 'DIALOG');
        assert.equal(chooser.open, true);
        assert.equal(chooser.closest('#serial-config-dialog'), null);
        assert.equal(f.get('serial-config-status').parentElement, f.get('serial-config-form'));
        f.change('bridge-serial-token', 'test-access');
        f.get('bridge-serial-token').dispatchEvent({ type: 'keydown', key: 'Enter' });
        await f.tick();
        assert.equal(f.get('bridge-serial-connect').disabled, true);
        f.change('bridge-serial-port', path);
        f.click('bridge-serial-connect'); await f.tick();
        assert.equal(chooser.open, false);
    }
    f.selectConnection('primary');
    f.click('serial-primary-bind');
    f.get('bridge-serial-binding').dispatchEvent({ type: 'cancel' });
    assert.equal(f.get('bridge-serial-binding').open, false);
    assert.equal(f.get('serial-config-dialog').open, true);
    await bind('primary', 'COM3');
    await bind('serial-2', 'COM518');
    assert.equal(nativePrompts, 1);
    assert.deepEqual(opened, [['COM3', 115200], ['COM518', 1250000]]);
    const config = f.app.getConfig();
    assert.deepEqual(Array.from(config.serialSources.bridgeBindings, binding => [binding.id, binding.path]),
        [['primary', 'COM3'], ['serial-2', 'COM518']]);
    assert.equal(JSON.stringify(config).includes('test-access'), false);
    assert.match(f.get('serial-2-summary').textContent, /Bridge.*COM518/);
    const secondary = f.app.serialSources.get('serial-2');
    secondary.adapter.callback(Uint8Array.of(5, 18));
    assert.equal(secondary.capture.history.endByte, 2);
    assert.equal(f.app.service.history.endByte, 0);
    assert.equal(await f.app.sendController.sendBytes(Uint8Array.of(0x5a)), true);
    assert.equal(f.app.service.stats.txBytes, 1);
    f.click('serial-2-connect'); await f.tick();
    assert.equal(secondary.connected, false);
    assert.match(f.get('serial-primary-status').textContent, /已连接/);
    f.change('conn-type', 'udp');
    assert.equal(f.S.WidgetConfig.validateWorkspaceConfig(f.app.getConfig()).serialSources.bridgeBindings[1].path, 'COM518');
    f.change('conn-type', 'bridge-serial');
    assert.equal(f.get('serial-2-bind').textContent, '重新绑定');
    f.click('btn-connect'); await f.tick();
    assert.equal(secondary.connected, true);
    assert.equal(opened.at(-1)[0], 'COM518');
    assert.equal(config.global.connType, 'bridge-serial');
    assert.equal(config.serialSources.entries[0].mode, 'bridge-serial');
    assert.equal(f.S.WidgetConfig.validateWorkspaceConfig(config).serialSources.bridgeBindings.length, 2);
    f.click('serial-manager-close');
    bridgeStatus = { serial: false };
    f.click('serial-manager-open'); await f.tick();
    assert.match(f.get('serial-config-status').textContent, /仅提供 TCP \/ UDP/);
    f.click('serial-manager-close');
    bridgeStatus = null;
    f.click('serial-manager-open'); await f.tick();
    assert.match(f.get('serial-config-status').textContent, /Bridge 未响应/);
    f.click('serial-2-connect'); await f.tick();
    f.click('serial-2-connect'); await f.tick();
    assert.match(f.get('serial-2-status').textContent, /Bridge 串口不可用/);
    assert.equal(secondary.connected, false);
    f.click('serial-2-bind'); await f.tick();
    assert.equal(nativePrompts, 1, 'Bridge mode never opens the Web Serial chooser');
});
