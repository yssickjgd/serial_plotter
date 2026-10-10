const test = require('node:test');
const assert = require('node:assert/strict');
const { bootApplication } = require('./helpers/widgetAppHarness');

test('P toggles global capture once per press and follows the same pause state as the button', t => {
    const f = bootApplication(); t.after(() => f.app.dispose());
    const widget = f.app.widgets.create({ type: 'wave' });
    const press = (key, extra = {}) => f.document.dispatchEvent({ type: 'keydown', key, target: widget.element, ...extra });
    press('p');
    assert.equal(f.app.service.paused, true);
    assert.equal(widget.view.isPaused, true);
    assert.equal(f.get('btn-pause').textContent, '恢复捕获');
    press('p', { repeat: true });
    assert.equal(f.app.service.paused, true, 'holding P must not toggle repeatedly');
    press('P');
    assert.equal(f.app.service.paused, false);
    assert.equal(widget.view.isPaused, false);
    f.click('btn-pause');
    press('p');
    assert.equal(f.app.service.paused, false);
});

test('capture shortcut ignores editing composition browser shortcuts and detaches on disposal', () => {
    const f = bootApplication();
    for (const target of [f.get('send-input'), f.get('widget-title'), f.get('plot-window-points'), f.get('plot-view-mode')]) {
        f.document.dispatchEvent({ type: 'keydown', key: 'p', target });
        assert.equal(f.app.service.paused, false);
    }
    const editable = f.document.createElement('div'); editable.isContentEditable = true;
    f.document.dispatchEvent({ type: 'keydown', key: 'p', target: editable });
    assert.equal(f.app.service.paused, false);
    for (const extra of [{ ctrlKey: true }, { altKey: true }, { metaKey: true }, { isComposing: true }, { defaultPrevented: true }]) {
        f.document.dispatchEvent({ type: 'keydown', key: 'p', target: f.document.body, ...extra });
        assert.equal(f.app.service.paused, false);
    }
    f.app.dispose();
    f.document.dispatchEvent({ type: 'keydown', key: 'p', target: f.document.body });
    assert.equal(f.app.service.paused, false);
});
const { GLOBAL_DEFAULTS } = require('../widgetConfig');
const config = widgets => ({ version: 2, global: { ...GLOBAL_DEFAULTS, dataType: 'uint8', enableHeader: false },
    widgets, workspace: { step: 10, rects: {} }, nextNumber: 10 });
const wave = id => ({ id, type: 'wave', title: id, settings: {} });
const bytes = (id, settings = {}) => ({ id, type: 'byte', title: id, settings: { captureMode: 'hex', ...settings } });
function boot(t, state) { const f = bootApplication(state); t.after(() => f.app?.dispose()); return f; }

test('wave axes use shared arrival-based sampling rate instead of a jittering statistics timer', async t => {
    const f = boot(t, config([wave('w1'), wave('w2'), bytes('b1', { captureMode: 'number' })]));
    const s = f.app.service, first = f.app.widgets.widgets.get('w1').view;
    for (let i = 0; i <= 200; i++) s.receive(new Uint8Array(10), { arrival: i * 10 });
    await f.tick(2100);
    assert.equal(first.sampleRateHz, 1000);
    for (let i = 201; i <= 300; i++) s.receive(new Uint8Array(10), { arrival: i * 10 });
    await f.tick(980);
    assert.equal(first.sampleRateHz, 1000);
    assert.equal(f.app.widgets.widgets.get('w2').view.sampleRateHz, 1000);
    assert.equal(f.app.widgets.widgets.get('b1').refs['stat-fps-value'].textContent, '1020 f/s',
        'the receive-rate statistic retains its live one-second meaning');
    f.click('btn-pause'); await f.tick(10000);
    assert.equal(first.sampleRateHz, 1000);
});

test('a fresh page has no widgets while persistent acquisition continues', async t => {
    const f = boot(t);
    assert.equal(f.app.widgets.widgets.size, 0);
    assert.equal(f.get('workspace-empty').hidden, false);
    f.app.serialAdapter.onDataCallback(Uint8Array.of(0xab, 0, 0, 128, 63));
    await f.tick();
    assert.equal(f.app.service.numericSource.frames.length, 1);
    assert.equal(f.app.service.baseSource.frames.length, 1);
    assert.equal(f.app.service.stats.rxBytes, 5);
    assert.equal(f.writes, 0, 'bootstrap must not overwrite missing or existing stored settings');
});

test('disposing during serial selection prevents a late connection and retains detached callbacks', async t => {
    const f = boot(t);
    let release, opened = 0;
    f.context.navigator.serial = { requestPort: () => new Promise(resolve => { release = resolve; }) };
    f.click('btn-connect');
    f.app.dispose();
    release({ open: async () => { opened++; }, close: async () => {} });
    for (let i = 0; i < 30; i++) await Promise.resolve();
    assert.equal(opened, 0);
    assert.equal(f.app.serialAdapter.port, null);
    assert.equal(f.app.serialAdapter.onConnectStatusChange, null);
    assert.equal(f.app.serialAdapter._connected, false);
});

test('legacy settings migrate to two independent views without losing channel transforms', t => {
    const f = boot(t, { dataType: 'uint8', enableHeader: false, channelsCount: '1',
        captureMode: 'hex', channels: [{ name: 'Voltage', visible: true, gainEnabled: true, gain: 2 }] });
    assert.equal(f.app.widgets.widgets.size, 2);
    assert.equal(f.app.getConfig().version, 2);
    assert.equal(f.app.widgets.widgets.get('wave-1').view.getChannelMeta()[0].gain, 2);
    assert.equal(f.app.getConfig().global.channelNames[0], 'Voltage');
    assert.equal(f.writes, 0);
});

test('multiple waves and byte monitors share parsers without multiplying physical RX', async t => {
    const f = boot(t, config([wave('w1'), wave('w2'), bytes('b1'), bytes('b2')]));
    f.app.serialAdapter.onDataCallback(Uint8Array.of(10, 20, 30));
    await f.tick();
    const widgets = f.app.widgets.widgets;
    assert.equal(widgets.get('w1').view.frames, widgets.get('w2').view.frames);
    assert.equal(widgets.get('b1').source, widgets.get('b2').source);
    assert.equal(widgets.get('w1').view.frames.length, 3);
    assert.equal(widgets.get('b1').view.frames.length, 1);
    assert.equal(f.app.service.stats.rxBytes, 3);
    f.app.widgets.remove('w1'); f.app.widgets.remove('w2');
    f.app.serialAdapter.onDataCallback(Uint8Array.of(40));
    assert.equal(f.app.service.numericSource.frames.length, 4);
});

test('global pause and clear update every view and preserve pause state', async t => {
    const f = boot(t, config([wave('w1'), bytes('b1')]));
    f.app.serialAdapter.onDataCallback(Uint8Array.of(1, 2));
    f.click('btn-pause');
    assert.equal(f.app.service.paused, true);
    assert.equal(f.app.widgets.widgets.get('w1').view.isPaused, true);
    f.app.serialAdapter.onDataCallback(Uint8Array.of(3));
    assert.equal(f.app.service.numericSource.frames.length, 2);
    assert.equal(f.app.service.stats.rxBytes, 3);
    f.click('btn-clear');
    assert.equal(f.app.service.paused, true);
    assert.equal(f.app.service.numericSource.frames.length, 0);
    assert.equal(f.app.service.baseSource.frames.length, 0);
    assert.equal(f.app.service.stats.rxBytes, 0);
    f.click('btn-pause');
    f.app.serialAdapter.onDataCallback(Uint8Array.of(4));
    assert.equal(f.app.service.numericSource.frames.length, 1);
});

test('configuration import validates atomically and saves a complete versioned workspace', async t => {
    const f = boot(t, config([wave('w1')]));
    const before = JSON.stringify(f.app.getConfig());
    const bad = f.app.getConfig(); bad.global.maxPoints = '-1';
    assert.throws(() => f.app.applyConfig(bad));
    assert.equal(JSON.stringify(f.app.getConfig()), before);
    f.app.widgets.create({ type: 'byte', title: 'extra' });
    await f.tick(200);
    const stored = JSON.parse(f.storage.get('serialplot_v3_config'));
    assert.equal(stored.version, 2);
    assert.equal(stored.widgets.length, 2);
    assert.equal(Object.keys(stored.workspace.rects).length, 2);
});

test('export source is independent from activation and missing byte sources require reselection', async t => {
    const f = boot(t, config([wave('w1'), wave('w2'), bytes('b1', { captureMode: 'text', textBoundary: 'lf' })]));
    f.app.serialAdapter.onDataCallback(Uint8Array.of(4)); f.app.service.pause(true); await f.tick();
    f.change('export-format', 'csv');
    assert.equal(f.get('btn-export').disabled, false);
    f.app.widgets.activate('w1');
    f.app.widgets.activate('w2');
    assert.equal(f.get('export-source').value, 'numeric');
    f.change('export-format', 'binary'); f.change('export-source', 'b1'); f.app.widgets.remove('b1');
    assert.equal(f.get('export-source').value, '');
    assert.equal(f.get('btn-export').disabled, true);
    f.app.widgets.activate('w1');
    assert.equal(f.get('btn-export').disabled, true);
    f.change('export-source', 'numeric');
    f.change('export-format', 'hex-text');
    assert.equal(f.get('export-source').value, 'numeric');
    assert.equal(f.get('export-format').options.find(option => option.value === 'csv').disabled, false);
});

test('CSV exports use shared values regardless of active wave calibration and include UTF8 BOM', async t => {
    const f = boot(t, config([wave('w1'), wave('w2')]));
    const widget = f.app.widgets.widgets.get('w1');
    Object.assign(widget.settings.channels[0], { gainEnabled: true, gain: 2, offsetEnabled: true, offset: 3 });
    f.app.widgets.applySettings(widget);
    f.app.serialAdapter.onDataCallback(Uint8Array.of(4));
    f.app.widgets.activate('w2');
    assert.equal(await f.app.exportData(), true);
    f.app.widgets.activate('w1');
    assert.equal(await f.app.exportData(), true);
    assert.match(await f.blobs[0].text(), /0,4/);
    assert.match(await f.blobs[1].text(), /0,4/);
    assert.deepEqual([...new Uint8Array(await f.blobs[0].arrayBuffer()).subarray(0, 3)], [239, 187, 191]);
});

test('source and per-view draw rate statistics return to zero when idle', async t => {
    const f = boot(t, config([wave('w1'), bytes('b1')]));
    await f.tick();
    f.app.serialAdapter.onDataCallback(Uint8Array.of(1, 2)); await f.tick();
    const widget = f.app.widgets.widgets.get('w1');
    assert.match(widget.refs['stat-plot-fps'].textContent, /[1-9].*FPS/);
    assert.equal(widget.view.sampleRateHz, 0, 'a single received packet cannot establish the sample clock');
    await f.tick(); await f.tick();
    assert.match(widget.refs['stat-plot-fps'].textContent, /0 FPS/);
    assert.equal(f.app.widgets.widgets.get('b1').refs['stat-fps-value'].textContent, '0 f/s');
});

test('application disposal stops timers and removes views without saving an empty layout', async t => {
    const f = boot(t, config([wave('w1'), bytes('b1')]));
    await f.tick();
    const before = f.storage.get('serialplot_v3_config');
    f.app.dispose(); f.app.dispose();
    assert.equal(f.app.service.disposed, true);
    assert.equal(f.app.widgets.widgets.size, 0);
    assert.equal(f.intervals.size, 0);
    assert.equal(f.rafs.size, 0);
    assert.equal(f.storage.get('serialplot_v3_config'), before);
});

test('the global sender writes once and shares successful and failed TX records across byte widgets', async t => {
    const f = boot(t, config([bytes('b1'), bytes('b2')]));
    const sent = [];
    f.app.serialAdapter.send = async value => { sent.push([...value]); };
    f.app.serialAdapter.onConnectStatusChange(true);
    f.get('send-input').value = '41 42';
    assert.equal(await f.app.sendController.sendOnce(), true);
    assert.deepEqual(sent, [[65, 66]]);
    assert.equal(f.app.service.stats.txBytes, 2);
    assert.equal(f.app.service.txFrames.length, 1);
    for (const widget of f.app.widgets.widgets.values()) {
        widget.view.render();
        assert.equal(widget.view.lastRows.filter(row => row.kind === 'tx').length, 1);
        assert.equal(widget.view.extras.length, 0);
    }
    f.app.serialAdapter.send = async () => { throw new Error('device unavailable'); };
    assert.equal(await f.app.sendController.sendOnce(), false);
    for (const widget of f.app.widgets.widgets.values()) assert.equal(widget.view.extras.at(-1).kind, 'tx-error');
    assert.equal(f.app.service.stats.txBytes, 2);
    assert.equal(f.app.service.txFrames.length, 1);
});

test('byte buffer export combines chronological RX and shared TX without changing bytes', async t => {
    const f = boot(t, config([bytes('b1')]));
    f.app.serialAdapter.onDataCallback(Uint8Array.of(65, 66)); await f.tick();
    f.app.sendController.onSent(Uint8Array.of(67));
    f.change('export-format', 'binary'); f.change('export-source', 'base'); f.change('export-direction', 'both');
    assert.equal(await f.app.exportData(), true);
    assert.deepEqual([...new Uint8Array(await f.blobs[0].arrayBuffer())], [65, 66, 67]);
    f.change('export-format', 'text'); f.change('export-encoding', 'ascii');
    f.change('export-direction', 'both');
    f.change('export-timestamps', false); f.change('export-markers', false);
    assert.equal(await f.app.exportData(), true);
    assert.equal(await f.blobs[1].text(), 'ABC');
});

test('changing one byte parser rebuilds that source while other views continue receiving', async t => {
    const f = boot(t, config([wave('w1'), bytes('b1'), bytes('b2')]));
    f.app.serialAdapter.onDataCallback(Uint8Array.of(65, 10, 66, 10)); await f.tick();
    const before = f.app.widgets.widgets.get('b2').source;
    f.app.widgets.activate('b1'); f.change('capture-mode', 'text'); f.change('text-boundary', 'lf');
    await f.settle();
    const changed = f.app.widgets.widgets.get('b1').source;
    assert.notEqual(changed, before);
    assert.equal(f.app.widgets.widgets.get('b2').source, before);
    assert.equal(changed.frames.length, 2);
    f.app.serialAdapter.onDataCallback(Uint8Array.of(67, 10)); await f.tick();
    assert.equal(changed.frames.length, 3);
    assert.equal(f.app.service.numericSource.frames.length, 6);
    assert.equal(f.app.service.stats.rxBytes, 6);
});

test('shared numeric rule changes preserve raw bytes and do not report replay as a new sample rate', async t => {
    const f = boot(t, config([wave('w1'), bytes('b1')]));
    f.app.serialAdapter.onDataCallback(Uint8Array.of(1, 2, 3, 4)); await f.tick();
    f.app.widgets.activate('w1'); f.change('data-type', 'uint16'); await f.settle();
    assert.deepEqual(Array.from(f.app.service.numericSource.frames.channelSlice(0)), [513, 1027]);
    assert.deepEqual(Array.from(f.app.service.baseSource.frames.rawBytesAt(0)), [1, 2, 3, 4]);
    assert.equal(f.app.service.stats.rxBytes, 4);
    assert.equal(f.get('history-rebuild-progress').hidden, true);
});

test('search and default nearest reference follow the active widget without a placeholder option', async t => {
    const initial = config([wave('w1'), bytes('b1')]); initial.tools = { sourceId: 'b1', referenceId: 'w1' };
    const f = boot(t, initial);
    f.app.widgets.activate('b1');
    assert.equal(f.get('monitor-search-origin').value, 'b1');
    assert.ok(f.get('monitor-search-origin').options.every(option => option.value));
    f.app.serialAdapter.onDataCallback(Uint8Array.of(65, 66, 65)); await f.tick();
    assert.equal(f.get('monitor-search-nearest').disabled, true);
    f.click('btn-pause');
    f.get('monitor-search-query').value = '41';
    const pending = f.app.tools.requestSearch('nearest');
    await f.tick(); assert.equal(await pending, true);
    assert.equal(f.app.tools.matches.length, 2);
    assert.equal(f.app.widgets.widgets.get('b1').view.followTail, false);
    assert.equal(f.app.tools.sourceId, 'b1');
    f.app.widgets.activate('w1');
    assert.equal(f.app.tools.sourceId, 'w1');
    assert.equal(f.app.tools.matches.length, 0);
    assert.equal(f.app.tools.referenceId, 'w1');
    assert.equal(f.get('monitor-search-tolerance').hidden, false);
    f.app.widgets.remove('b1');
    assert.equal(f.app.tools.sourceId, 'w1');
    f.app.widgets.activate(null);
    assert.equal(f.app.tools.sourceId, null);
    assert.equal(f.get('monitor-search-nearest').disabled, true);
});

test('large streaming export aborts when the selected source changes while writing', async t => {
    const initial = config([wave('w1')]); initial.global.maxPoints = '60000';
    const f = boot(t, initial);
    f.app.serialAdapter.onDataCallback(new Uint8Array(50001).fill(7));
    f.app.widgets.activate('w1');
    let writes = 0, aborts = 0, closes = 0;
    f.window.showSaveFilePicker = async () => ({ async createWritable() { return {
        async write() { writes++; f.app.service.clear(); }, async abort() { aborts++; }, async close() { closes++; }
    }; } });
    assert.equal(await f.app.exportData(), false);
    assert.equal(writes, 1); assert.equal(aborts, 1); assert.equal(closes, 0);
    assert.match(f.get('export-source-status').textContent, /导出失败/);
});

test('invalid saved settings show an error without overwriting storage or creating partial widgets', async t => {
    const invalid = { ...config([wave('w1')]), widgets: [{ id: 'bad', type: 'unknown', title: 'bad' }] };
    const f = boot(t, invalid);
    assert.equal(f.app.widgets.widgets.size, 0);
    assert.equal(f.get('cfg-save-status').hidden, false);
    await f.tick(); assert.equal(f.writes, 0);
    assert.equal(f.storage.get('serialplot_v3_config'), JSON.stringify(invalid));
});

test('capacity changes clamp every wave window and text widgets show decoding failures', async t => {
    const f = boot(t, config([wave('w1'), wave('w2'), bytes('b1', { captureMode: 'text', textEncoding: 'ascii' })]));
    f.change('max-points', '50');
    for (const widget of f.app.widgets.widgets.values()) if (widget.type === 'wave') {
        assert.equal(widget.view.plotWindowPoints, 50); assert.equal(f.app.getConfig().global.plotWindowPoints, '50');
    }
    f.app.serialAdapter.onDataCallback(Uint8Array.of(65, 255)); f.app.service.endStream();
    await f.tick(); await f.tick();
    const widget = f.app.widgets.widgets.get('b1');
    assert.match(widget.refs['stat-fps-value'].textContent, /^\d+ f\/s$/);
    assert.equal(widget.refs['stat-fail-label'].textContent, '失败字符 / 总字符:');
    assert.equal(widget.refs['stat-fail-value'].textContent, '1 / 2 (50.0%)');
    assert.match(widget.refs['stat-rx-value'].textContent, /\(2 B\)/);
});

test('wave sampling frequency survives idle periods, pause, and rebuilding baselines', async t => {
    const f = boot(t, config([wave('w1')])), widget = f.app.widgets.widgets.get('w1');
    for (let i = 0; i <= 2; i++) f.app.service.receive(Uint8Array.of(1, 2, 3), { arrival: i * 1000 });
    await f.tick(2100);
    const rate = widget.view.sampleRateHz;
    assert.ok(rate > 0);
    await f.tick(); assert.equal(widget.view.sampleRateHz, rate);
    f.click('btn-pause'); await f.tick(); assert.equal(widget.view.sampleRateHz, rate);
    widget.source.generation++; await f.tick(); assert.equal(widget.view.sampleRateHz, rate);
    f.click('btn-clear'); assert.equal(widget.view.sampleRateHz, 0);
});

test('per-buffer text options and CSV channel selection survive a configuration reload', t => {
    const initial = config([bytes('b1'), wave('w1')]); initial.global.channelsCount = '2';
    const f = boot(t, initial);
    f.change('export-format', 'text'); f.change('export-source', 'base');
    f.change('export-direction', 'both'); f.change('export-encoding', 'gb18030');
    f.get('export-timestamps').checked = false; f.get('export-markers').checked = true;
    const restored = boot(t, f.app.getConfig());
    assert.equal(restored.get('export-source').value, 'base');
    assert.equal(restored.get('export-format').value, 'text');
    assert.equal(restored.get('export-direction').value, 'both');
    assert.equal(restored.get('export-encoding').value, 'gb18030');
    assert.equal(restored.get('export-timestamps').checked, false);
    assert.equal(restored.get('export-markers').checked, true);
    f.change('export-source', 'numeric'); f.change('export-format', 'csv');
    const checkbox = f.get('export-channel-list').children[0].children[0];
    checkbox.checked = false; checkbox.dispatchEvent({ type: 'change' });
    const csv = boot(t, f.app.getConfig());
    assert.equal(csv.get('export-source').value, 'numeric');
    assert.deepEqual(Array.from(csv.app.getConfig().tools.exportProfiles.numeric.formats.csv.channelIndices), [1]);
});

test('network mode reveals its controls and connects with the requested remote and local ports', async t => {
    const f = boot(t, config([]));
    f.change('conn-type', 'udp');
    assert.equal(f.get('config-net').hidden, false);
    assert.notEqual(f.get('config-net').style.display, 'none');
    assert.notEqual(f.get('wrap-local-port').style.display, 'none');
    f.change('net-port', '9001'); f.change('net-local', '9002');
    let received;
    f.app.netAdapter.connect = async value => { received = value; f.app.netAdapter.onConnectStatusChange(true); };
    f.click('btn-connect'); await f.tick();
    assert.equal(received.mode, 'udp'); assert.equal(received.port, 9001); assert.equal(received.localPort, 9002);
    assert.equal(f.get('conn-type').disabled, true);
    f.click('btn-connect'); await f.tick();
    assert.equal(f.get('conn-type').disabled, false);
});

test('connection failures reenable controls and send repetition stops after disconnection', async t => {
    const f = boot(t, config([]));
    f.app.serialAdapter.connect = async () => { throw new Error('permission denied'); };
    f.click('btn-connect'); await f.tick();
    assert.match(f.get('connection-status').textContent, /permission denied/);
    assert.equal(f.get('btn-connect').disabled, false);
    f.app.serialAdapter.send = async () => {};
    f.app.serialAdapter.onConnectStatusChange(true);
    f.get('send-input').value = '41'; f.change('send-interval', '1');
    await f.app.sendController.handleClick();
    assert.notEqual(f.app.sendController.timer, null);
    f.app.serialAdapter.onConnectStatusChange(false);
    assert.equal(f.app.sendController.timer, null);
});

test('library add and drop create real views and saved grid steps apply on import', async t => {
    const f = boot(t, config([]));
    f.document.querySelector('[data-add-widget="wave"]').click();
    f.app.workspace.onDrop({ type: 'byte', rect: { x: 0, y: 320, width: 640, height: 300 } });
    assert.equal(f.app.widgets.widgets.size, 2);
    assert.equal(f.get('workspace-empty').hidden, true);
    const next = config([wave('restored')]); next.workspace.step = 40;
    f.app.applyConfig(next); await f.settle();
    assert.equal(f.app.workspace.step, 40);
    assert.equal(f.get('workspace-step').value, '40');
});

test('workspace zoom saves and imports before placing widgets without explicit rectangles', async t => {
    const f = boot(t, config([wave('w1')]));
    f.app.workspace.setZoom(2);
    await f.tick(200);
    assert.equal(JSON.parse(f.storage.get('serialplot_v3_config')).workspace.zoom, 2);
    const next = config([wave('w2')]); next.workspace.zoom = 0.5;
    f.app.applyConfig(next); await f.settle();
    assert.equal(f.app.workspace.zoom, 0.5);
    assert.equal(f.get('workspace-zoom-percent').value, '50');
    f.change('workspace-zoom-percent', '155');
    assert.equal(f.app.workspace.zoom, 1.55);
    f.change('workspace-zoom-percent', '501');
    assert.equal(f.app.workspace.zoom, 1.55);
    assert.equal(f.get('workspace-zoom-percent').value, '155');
    const before = JSON.stringify(f.app.getConfig());
    const bad = f.app.getConfig(); bad.workspace.zoom = 0;
    assert.throws(() => f.app.applyConfig(bad));
    assert.equal(JSON.stringify(f.app.getConfig()), before);
    f.click('workspace-zoom-reset');
    assert.equal(f.app.workspace.zoom, 1);
});

test('zooming a paused workspace redraws its waveform at the new pixel density', t => {
    const f = boot(t, config([wave('w1')])), plotter = f.app.widgets.widgets.get('w1').view;
    plotter.canvas.parentElement.getBoundingClientRect = () => ({ width: 800 * f.app.workspace.zoom,
        height: 400 * f.app.workspace.zoom, left: 0, top: 0 });
    plotter.resize(); f.click('btn-pause');
    const width = plotter.canvas.width, draws = plotter.completedDraws;
    f.app.workspace.setZoom(2);
    assert.equal(plotter.canvas.width, width * 2);
    assert.ok(plotter.completedDraws > draws);
    assert.equal(plotter.width, width);
});

test('both sidebar resizers update their CSS width constraint and stop on pointer release', t => {
    const f = boot(t);
    for (const [handleId, panelId, variable, width, dx, expected] of [
        ['h-resizer', 'sidebar', '--sidebar-w', 268, 100, '368px'],
        ['right-resizer', 'channel-sidebar', '--channel-sidebar-w', 320, -100, '420px']
    ]) {
        f.get(panelId).clientWidth = width;
        f.get(handleId).dispatchEvent({ type: 'pointerdown', button: 0, pointerId: 7, clientX: 500 });
        f.document.dispatchEvent({ type: 'pointermove', pointerId: 8, clientX: 0 });
        assert.equal(f.get(panelId).style[variable], undefined);
        f.document.dispatchEvent({ type: 'pointermove', pointerId: 7, clientX: 500 + dx });
        assert.equal(f.get(panelId).style[variable], expected);
        f.document.dispatchEvent({ type: 'pointerup', pointerId: 7 });
        f.document.dispatchEvent({ type: 'pointermove', pointerId: 7, clientX: 900 });
        assert.equal(f.get(panelId).style[variable], expected);
    }
});

test('the global sender resizes upward while reserving workspace space and supports cancellation', t => {
    const f = boot(t), input = f.get('send-input'), handle = f.get('send-resizer');
    assert.ok(handle, 'the global sender needs its own separator');
    input.offsetHeight = 60; input.clientHeight = 60;
    f.get('main-display').clientHeight = 620;
    f.get('navigation-panel').clientHeight = 70;
    f.get('global-send').clientHeight = 150;
    f.get('monitor-workspace').clientHeight = 400;
    f.get('workspace-toolbar').offsetHeight = 28;
    handle.dispatchEvent({ type: 'pointerdown', button: 0, pointerId: 9, clientY: 600 });
    f.document.dispatchEvent({ type: 'pointermove', pointerId: 9, clientY: 400 });
    assert.equal(input.style.height, '260px');
    f.document.dispatchEvent({ type: 'pointermove', pointerId: 9, clientY: -1000 });
    assert.equal(input.style.height, '310px', 'leave the 150px workspace minimum available');
    f.document.dispatchEvent({ type: 'pointermove', pointerId: 9, clientY: 1000 });
    assert.equal(input.style.height, '60px', 'retain the original four-line minimum');
    f.document.dispatchEvent({ type: 'pointermove', pointerId: 9, clientY: 400 });
    f.document.dispatchEvent({ type: 'pointerup', pointerId: 8 });
    f.document.dispatchEvent({ type: 'pointercancel', pointerId: 9 });
    assert.equal(input.style.height, '60px');
    assert.equal(f.document.body.style.userSelect, undefined);
    input.clientHeight = 260; input.style.height = '260px';
    f.get('global-send').clientHeight = 350;
    f.get('main-display').clientHeight = 400;
    f.window.dispatchEvent({ type: 'resize' });
    assert.equal(input.style.height, '90px', 'a smaller window must account for all fixed toolbars, not overflowing flex children');
});

test('importing malformed JSON or overlapping rectangles never destroys the current view', async t => {
    const f = boot(t, config([wave('w1')]));
    const file = f.get('cfg-file-input');
    file.files = [{ text: async () => '{bad' }]; file.dispatchEvent({ type: 'change' }); await f.tick();
    assert.equal(f.app.widgets.widgets.size, 1);
    const bad = config([wave('x'), bytes('y')]);
    bad.workspace.rects = { x: { x: 0, y: 0, width: 300, height: 200 }, y: { x: 0, y: 0, width: 300, height: 200 } };
    file.files = [{ text: async () => JSON.stringify(bad) }]; file.dispatchEvent({ type: 'change' }); await f.tick();
    assert.equal(f.app.widgets.widgets.has('w1'), true);
    assert.equal(f.get('cfg-save-status').hidden, false);
});

test('time navigation uses selected source timestamps and rejects times outside its retained range', async t => {
    const initial = config([wave('w1'), bytes('b1')]); initial.tools = { sourceId: 'w1', referenceId: 'b1' };
    const f = boot(t, initial);
    f.app.widgets.activate('w1');
    f.app.service.receive(Uint8Array.of(1), { timestamp: 1000, arrival: 1 });
    f.app.service.receive(Uint8Array.of(2), { timestamp: 2000, arrival: 2 });
    f.click('btn-pause');
    f.change('nav-jump-mode', 'relative'); f.get('nav-jump-relative').value = '1';
    assert.equal(f.app.tools.jumpToTime(), true);
    assert.equal(f.app.widgets.widgets.get('w1').view.currentFrameIndex(), 1);
    f.get('nav-jump-relative').value = '20';
    assert.equal(f.app.tools.jumpToTime(), false);
    assert.equal(f.app.widgets.widgets.get('w1').view.currentFrameIndex(), 1);
});

test('a large export cancelled by source deletion at the file picker never opens a writable stream', async t => {
    const initial = config([bytes('b1', { captureMode: 'text', textBoundary: 'lf' })]); initial.global.maxPoints = '60000';
    const f = boot(t, initial);
    f.app.serialAdapter.onDataCallback(new Uint8Array(50001).fill(10));
    f.change('export-format', 'binary');
    f.change('export-source', 'b1');
    let opened = false;
    f.window.showSaveFilePicker = async () => {
        f.app.widgets.remove('b1');
        return { createWritable() { opened = true; } };
    };
    assert.equal(await f.app.exportData(), false);
    assert.equal(opened, false);
    assert.equal(f.get('export-source').value, '');
});

test('activating another wave does not cancel export of an independently selected buffer', async t => {
    const initial = config([wave('w1'), wave('w2')]); initial.global.maxPoints = '60000';
    const f = boot(t, initial);
    f.app.serialAdapter.onDataCallback(new Uint8Array(50001).fill(7));
    f.app.widgets.activate('w1');
    let writes = 0, aborts = 0, closes = 0;
    f.window.showSaveFilePicker = async () => ({ async createWritable() { return {
        async write() { writes++; f.app.widgets.activate('w2'); },
        async abort() { aborts++; }, async close() { closes++; }
    }; } });
    const pending = f.app.exportData();
    for (let i = 0; i < 100; i++) await f.tick(1);
    assert.equal(await pending, true);
    assert.ok(writes > 1); assert.equal(aborts, 0); assert.equal(closes, 1);
    assert.equal(f.get('export-source').value, 'numeric');
    assert.equal(f.get('btn-export').disabled, false);
    assert.equal(f.app.getConfig().tools.exportProfiles.numeric.format, 'csv');
});
