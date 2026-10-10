const test = require('node:test');
const assert = require('node:assert/strict');

test('resuming capture clears navigation and makes every retained widget follow latest', async t => {
    const f = bootApplication(); t.after(() => f.app.dispose());
    const wave = f.app.widgets.create({ type: 'wave' });
    const spectrum = f.app.widgets.create({ type: 'wave', settings: { plotViewMode: 'frequency' } });
    const bytes = f.app.widgets.create({ type: 'byte', settings: { captureMode: 'number' } });
    const hex = f.app.widgets.create({ type: 'byte' });
    for (let i = 0; i < 10; i++) f.app.serialAdapter.onDataCallback(Uint8Array.of(0xAB, 0, 0, 128, 63));
    await f.settle(); f.click('btn-pause');
    f.app.tools._jumpAll(wave.source.frames.rawByteOffsetAt(3), true);
    f.app.tools.matches = [{ startByte: wave.source.frames.rawByteOffsetAt(3),
        endByte: wave.source.frames.rawByteOffsetAt(3) + 5 }];
    f.app.tools.currentMatch = 0; f.app.tools._publish();
    assert.equal(wave.view.vp.time.autoFollow, false);
    assert.notEqual(wave.view.navigationMarkers.timeOrder, null);
    assert.equal(bytes.view.followTail, false);
    f.get('nav-jump-status').textContent = '已定位第 4 帧';
    f.click('btn-pause'); await f.tick();
    assert.equal(f.app.service.paused, false);
    assert.equal(f.app.tools.matches.length, 0);
    assert.equal(f.get('nav-jump-status').textContent, '');
    for (const widget of [wave, spectrum]) {
        assert.equal(widget.view.vp.time.autoFollow, true);
        assert.equal(widget.view.navigationMarkers.timeOrder, null);
        assert.equal(widget.view.navigationMarkers.matches.length, 0);
    }
    for (const widget of [bytes, hex]) {
        assert.equal(widget.view.followTail, true);
        assert.equal(widget.view.cursorOrder, null);
        assert.equal(widget.view.cursorByteOffset, null);
    }
    f.app.serialAdapter.onDataCallback(Uint8Array.of(0xAB, 0, 0, 0, 64)); await f.tick();
    assert.equal(wave.source.frames.length, 11, 'resuming must preserve retained history');
    assert.equal(wave.source.frames.getValue(0, 10), 2);
});
const { bootApplication } = require('./helpers/widgetAppHarness');

test('inspector deletion waits for confirmation, cancellation preserves the widget, and confirmed deletion keeps capture', t => {
    const f = bootApplication(); t.after(() => f.app.dispose());
    const widget = f.app.widgets.create({ type: 'wave', title: '待确认的波形' });
    const source = widget.source;
    f.app.service.receive(Uint8Array.of(0xAB, 0, 0, 0x80, 0x3F), { timestamp: 100 });
    f.click('widget-delete');
    assert.equal(f.app.widgets.widgets.has(widget.id), true);
    assert.equal(f.get('widget-delete-dialog').open, true);
    assert.ok(f.get('widget-delete-message').textContent.includes(widget.title));
    f.app.service.receive(Uint8Array.of(0xAB, 0, 0, 0, 0x40), { timestamp: 101 });
    assert.equal(source.frames.length, 2, 'confirmation must not pause incoming capture');
    f.click('widget-delete-cancel');
    assert.equal(f.app.widgets.widgets.has(widget.id), true);
    assert.equal(f.get('widget-delete-dialog').open, false);
    f.click('widget-delete'); f.click('widget-delete-confirm');
    assert.equal(f.app.widgets.widgets.has(widget.id), false);
    assert.equal(f.app.workspace.entries.has(widget.id), false);
    assert.equal(f.get('widget-delete-dialog').open, false);
    assert.equal(f.app.service.numericSource, source);
    assert.equal(source.frames.length, 2);
    assert.equal(source.frames.getValue(0, 1), 2);
});

test('close button and global Delete use the same confirmation and Escape cancels it', t => {
    const f = bootApplication(); t.after(() => f.app.dispose());
    const first = f.app.widgets.create({ type: 'wave' }), second = f.app.widgets.create({ type: 'byte' });
    first.element.querySelector('.widget-close').click();
    assert.equal(f.app.widgets.widgets.has(first.id), true);
    assert.equal(f.get('widget-delete-dialog').open, true);
    f.get('widget-delete-dialog').dispatchEvent({ type: 'cancel' });
    assert.equal(f.app.widgets.widgets.has(first.id), true);
    assert.equal(f.get('widget-delete-dialog').open, false);
    f.app.workspace.activate(second.id);
    f.document.dispatchEvent({ type: 'keydown', key: 'Delete' });
    assert.equal(f.app.widgets.widgets.has(second.id), true);
    assert.equal(f.get('widget-delete-dialog').open, true);
    f.click('widget-delete-confirm');
    assert.equal(f.app.widgets.widgets.has(second.id), false);
    assert.equal(f.app.widgets.widgets.has(first.id), true);
});

test('confirmation cannot switch its target and stale or disposed deletion requests cannot remove another widget', t => {
    const f = bootApplication(); t.after(() => f.app.dispose());
    const first = f.app.widgets.create({ type: 'wave' }), second = f.app.widgets.create({ type: 'byte' });
    f.app.widgets.requestRemove(first.id);
    f.app.widgets.requestRemove(second.id);
    f.app.widgets.activate(second.id);
    f.click('widget-delete-confirm');
    assert.equal(f.app.widgets.widgets.has(first.id), false);
    assert.equal(f.app.widgets.widgets.has(second.id), true);
    f.app.widgets.requestRemove(second.id);
    f.get('widget-delete-dialog').dispatchEvent({ type: 'close' });
    assert.equal(f.app.widgets.pendingDeleteId, second.id, 'a queued close from an old dialog cannot cancel a new request');
    f.app.widgets.remove(second.id);
    assert.equal(f.get('widget-delete-dialog').open, false);
    const third = f.app.widgets.create({ type: 'wave' });
    f.click('widget-delete-confirm');
    assert.equal(f.app.widgets.widgets.has(third.id), true);
    f.app.dispose();
    assert.equal(f.app.widgets.requestRemove(third.id), false);
});

test('workspace shortcuts do not intercept title editing and Ctrl A works after keyboard focus', t => {
    const f = bootApplication(); t.after(() => f.app.dispose());
    const first = f.app.widgets.create({ type: 'wave' }), second = f.app.widgets.create({ type: 'byte' });
    f.get('workspace-viewport').dispatchEvent({ type: 'pointerenter' });
    f.document.dispatchEvent({ type: 'keydown', key: 'a', ctrlKey: true, target: f.get('widget-title') });
    assert.notEqual(f.app.workspace.selectedIds.size, 2);
    f.document.dispatchEvent({ type: 'keydown', key: 'Delete', target: f.get('widget-title') });
    assert.notEqual(f.get('widget-delete-dialog').open, true);
    f.get('workspace-viewport').dispatchEvent({ type: 'pointerleave' });
    f.document.activeElement = first.refs['waveform-drag-handle'];
    f.document.dispatchEvent({ type: 'keydown', key: 'a', ctrlKey: true, target: first.refs['waveform-drag-handle'] });
    assert.deepEqual(Array.from(f.app.workspace.selectedIds), [first.id, second.id]);
    assert.equal(f.app.workspace.activeId, second.id);
});

test('leaving the title editor commits to the original widget without Enter', t => {
    const f = bootApplication(); t.after(() => f.app.dispose());
    const first = f.app.widgets.create({ type: 'wave' });
    const second = f.app.widgets.create({ type: 'byte' });
    f.app.widgets.activate(first.id);
    f.get('widget-title').value = '新的波形名称';
    f.get('widget-title').dispatchEvent({ type: 'pointerleave' });
    assert.equal(first.title, '新的波形名称');
    f.get('widget-title').value = '离开时保存';
    f.app.widgets.activate(second.id);
    assert.equal(first.title, '离开时保存');
    assert.notEqual(second.title, '离开时保存');
    f.get('widget-title').value = ' ';
    f.get('widget-title').dispatchEvent({ type: 'blur' });
    assert.equal(f.get('widget-title').value, second.title);
});

test('new spectra default to Hz log, decibels ten, DC removal, and unwrapped radians', t => {
    const f = bootApplication(); t.after(() => f.app.dispose());
    for (const plotViewMode of ['frequency', 'phase']) {
        const wave = f.app.widgets.create({ type: 'wave', settings: { plotViewMode } });
        assert.equal(f.get('plot-freq-x-scale').value, 'hz-log');
        assert.equal(wave.view.removeDcForFft, true);
        assert.equal(wave.view.phaseUnit, 'radians');
        assert.equal(wave.view.phaseUnwrap, true);
        assert.equal(wave.view.magnitudeUnit, 'db');
        assert.equal(wave.view.dbFactor, 10);
    }
});

test('text parsing rules are shared while modes and display settings remain independent', async t => {
    const f = bootApplication(); t.after(() => f.app.dispose());
    const first = f.app.widgets.create({ type: 'byte', settings: { captureMode: 'text' } });
    const second = f.app.widgets.create({ type: 'byte', settings: { captureMode: 'hex' } });
    const wave = f.app.widgets.create({ type: 'wave' });
    f.app.widgets.activate(first.id);
    f.change('text-encoding', 'gbk'); f.change('text-boundary', 'crlf'); await f.settle();
    assert.equal(first.settings.textEncoding, 'gbk');
    assert.equal(second.settings.textEncoding, 'gbk');
    assert.equal(second.settings.captureMode, 'hex');
    assert.equal(second.source, f.app.service.baseSource);
    f.app.widgets.activate(second.id); f.change('capture-mode', 'text'); await f.settle();
    assert.equal(second.source, first.source);
    f.change('export-format', 'text');
    assert.equal(f.get('export-encoding').value, 'gbk');
    assert.equal(f.get('export-text-boundary').value, 'crlf');
    f.change('export-encoding', 'ascii');
    f.app.widgets.activate(wave.id);
    assert.equal(f.get('export-encoding').value, 'ascii');
    f.change('export-follow-text', true);
    assert.equal(f.get('export-encoding').value, 'gbk');
    assert.equal(f.get('export-text-boundary').value, 'crlf');
    const restored = bootApplication(f.app.getConfig()); t.after(() => restored.app.dispose());
    assert.equal(restored.app.widgets.widgets.get(first.id).settings.textBoundary, 'crlf');
    assert.equal(restored.app.widgets.widgets.get(second.id).settings.textEncoding, 'gbk');
});

test('invalid byte widget settings cannot change shared text parsing rules', t => {
    const f = bootApplication(); t.after(() => f.app.dispose());
    const byte = f.app.widgets.create({ type: 'byte', settings: { captureMode: 'text' } });
    const source = byte.source;
    assert.throws(() => f.app.widgets.create({ type: 'byte', settings: {
        captureMode: 'invalid', textEncoding: 'gbk', textBoundary: 'crlf'
    } }));
    assert.equal(f.app.widgets.globals.textEncoding, 'utf-8');
    assert.equal(f.app.widgets.globals.textBoundary, 'idle');
    assert.equal(byte.source, source);
});

test('byte widgets fix idle framing to one millisecond including legacy settings and mode switches', async t => {
    const f = bootApplication(); t.after(() => f.app.dispose());
    const byte = f.app.widgets.create({ type: 'byte', settings: { captureMode: 'hex', idleGapSeconds: '0.01' } });
    await f.settle();
    assert.equal(byte.settings.idleGapSeconds, '0.001');
    assert.equal(byte.source.format.idleGapSeconds, 0.001);
    assert.equal(byte.source, f.app.service.baseSource);
    assert.ok(!f.document.getElementById('idle-gap-seconds'));
    f.app.serialAdapter.onDataCallback(Uint8Array.of(65));
    await f.tick(2);
    f.app.serialAdapter.onDataCallback(Uint8Array.of(66));
    f.app.service.endStream();
    assert.equal(byte.source.frames.length, 2, 'a two-millisecond gap must separate records');
    f.change('capture-mode', 'text');
    assert.equal(byte.source.format.idleGapSeconds, 0.001);
    f.change('text-boundary', 'crlf');
    assert.equal(byte.source.format.textBoundary, 'crlf');
    f.change('text-boundary', 'idle');
    assert.equal(byte.source, f.app.service.baseSource);
    const restored = bootApplication(f.app.getConfig()); t.after(() => restored.app.dispose());
    assert.equal(restored.app.widgets.widgets.get(byte.id).source.format.idleGapSeconds, 0.001);
});

test('byte-only numeric channel names update global settings and tool labels', async t => {
    const f = bootApplication(); t.after(() => f.app.dispose());
    const byte = f.app.widgets.create({ type: 'byte', settings: { captureMode: 'number' } });
    await f.settle(); f.app.service.paused = true; f.app.tools.syncSources({ sourceId: byte.id, referenceId: byte.id });
    const row = f.get('monitor-channel-list').children[0];
    const input = row.children.find(child => child.type === 'text');
    assert.ok(input, 'a byte-only workspace must expose shared name editing');
    input.value = '温度'; input.dispatchEvent({ type: 'change' });
    assert.equal(f.app.getConfig().global.channelNames[0], '温度');
    assert.match(f.get('monitor-search-channel-options').textContent, /温度/);
    const wave = f.app.widgets.create({ type: 'wave' });
    assert.equal(wave.view.getChannelMeta()[0].name, '温度');
});

test('creating after restoring a colliding nextNumber allocates another stable identity', t => {
    const f = bootApplication(); t.after(() => f.app.dispose());
    f.app.widgets.create({ id: 'wave-1', type: 'wave' }); f.app.widgets.nextNumber = 1;
    const created = f.app.widgets.create({ type: 'wave' });
    assert.equal(created.id, 'wave-2');
    assert.equal(f.app.widgets.widgets.size, 2);
});

test('direct creation rejects reserved source identities without modifying the workspace', t => {
    const f = bootApplication(); t.after(() => f.app.dispose());
    for (const id of ['numeric', 'base']) assert.throws(() => f.app.widgets.create({ id, type: 'wave' }), /编号/);
    assert.equal(f.app.widgets.widgets.size, 0);
});

test('byte numeric framing shows shared rules inline and preserves them when switching widgets or modes', async t => {
    const f = bootApplication(); t.after(() => f.app.dispose());
    const first = f.app.widgets.create({ type: 'byte', settings: { captureMode: 'number' } });
    f.app.widgets.selectTab('tab-byte-frame');
    assert.equal(f.get('tab-waveform-frame').hidden, true);
    assert.ok(f.get('data-type').closest('#tab-byte-frame'));
    assert.ok(!f.document.getElementById('open-numeric-format'));
    f.change('data-type', 'uint16'); await f.settle();
    assert.equal(f.app.getConfig().global.dataType, 'uint16');
    assert.equal(f.get('tab-byte-frame').hidden, false);
    const wave = f.app.widgets.create({ type: 'wave' });
    assert.ok(f.get('data-type').closest('#tab-waveform-frame'));
    assert.equal(f.get('data-type').value, 'uint16');
    const hex = f.app.widgets.create({ type: 'byte' });
    f.app.widgets.selectTab('tab-byte-frame');
    assert.equal(f.get('frame-raw-settings').hidden, true);
    assert.equal(f.get('byte-numeric-settings').hidden, true);
    f.change('capture-mode', 'text');
    assert.equal(f.get('frame-raw-settings').hidden, false);
    f.change('capture-mode', 'number');
    assert.ok(f.get('data-type').closest('#tab-byte-frame'));
    assert.equal(f.get('byte-numeric-settings').hidden, false);
    f.app.workspace.activate(first.id);
    assert.equal(f.get('tab-waveform-frame').hidden, true);
    assert.ok(f.get('data-type').closest('#tab-byte-frame'));
    assert.equal(first.source, wave.source);
    assert.equal(hex.source, wave.source);
    f.get('workspace-surface').dispatchEvent({ type: 'pointerdown', button: 0 });
    assert.equal(f.get('widget-selection-prompt').hidden, false);
});

test('new byte views include retained TX and parser errors once after ready', async t => {
    const f = bootApplication(); t.after(() => f.app.dispose());
    f.app.service.appendTx(Uint8Array.of(42), 100);
    f.app.service.numericSource.errors.push({ kind: 'error', order: 10, bytes: Uint8Array.of(1), timestamp: 200 });
    const byte = f.app.widgets.create({ type: 'byte', settings: { captureMode: 'number' } });
    await f.settle();
    byte.view.render();
    assert.deepEqual(Array.from(byte.view.lastRows, row => row.kind), ['tx', 'error']);
    f.app.widgets._whenReady(byte); await f.settle();
    byte.view.render();
    assert.equal(byte.view.lastRows.length, 2);
    assert.equal(byte.view.extras.length, 0);
});

test('byte minimum height reserves four log lines after wrapped header and statistics', t => {
    const f = bootApplication(); t.after(() => f.app.dispose());
    const observers = [];
    f.context.ResizeObserver = class {
        constructor(callback) { this.callback = callback; this.targets = []; observers.push(this); }
        observe(target) { this.targets.push(target); }
        disconnect() { this.disconnected = true; }
    };
    const byte = f.app.widgets.create({ type: 'byte' }), entry = f.app.workspace.entries.get(byte.id);
    byte.refs['monitor-header'].offsetHeight = 42;
    byte.refs['monitor-stats'].offsetHeight = 130;
    f.app.widgets.resize(byte.id);
    assert.equal(entry.minHeight, 276);
    assert.ok(entry.rect.height >= 276);
    const observer = observers.find(item => item.targets.includes(byte.refs['monitor-stats']));
    assert.ok(observer.targets.includes(byte.refs['monitor-header']));
    byte.refs['monitor-stats'].offsetHeight = 152;
    observer.callback(); assert.equal(entry.minHeight, 298);
    let refreshes = 0; f.app.workspace.refresh = () => { refreshes++; };
    observer.callback(); assert.equal(refreshes, 0, 'unchanged dimensions must not cause a resize loop');
    f.app.widgets.remove(byte.id); assert.equal(observer.disconnected, true);
});

test('disposing widgets detaches shared inspector controls', () => {
    const f = bootApplication();
    const before = f.app.widgets.globals.endianness;
    f.app.dispose(); f.change('endianness', before === 'big' ? 'little' : 'big');
    assert.equal(f.app.widgets.globals.endianness, before);
});

test('two independently zoomed waves restore after a whole receive block and remain restored after ready', async t => {
    const { GLOBAL_DEFAULTS } = require('../widgetConfig');
    const f = bootApplication({ version: 2, global: { ...GLOBAL_DEFAULTS, dataType: 'uint8', enableHeader: false },
        widgets: [], workspace: { step: 10, rects: {} }, nextNumber: 1 });
    t.after(() => f.app.dispose());
    const a = f.app.widgets.create({ type: 'wave' }), b = f.app.widgets.create({ type: 'wave' });
    f.app.serialAdapter.onDataCallback(new Uint8Array(256)); await f.settle(); await f.tick();
    for (const [widget, count, offset] of [[a, 64, 64], [b, 32, 176]]) {
        Object.assign(widget.view.vp.time, { displayCount: count, scrollOffset: offset, autoFollow: false });
        widget.view._boxZoomY.time = { min: -2, max: count };
    }
    const saved = f.app.getConfig();
    for (const readyFirst of [false, true]) {
        const restored = bootApplication(saved); t.after(() => restored.app.dispose());
        if (readyFirst) await restored.settle();
        restored.app.serialAdapter.onDataCallback(new Uint8Array(256));
        await restored.settle(); await restored.tick();
        for (const [id, count, offset] of [[a.id, 64, 64], [b.id, 32, 176]]) {
            const widget = restored.app.widgets.widgets.get(id);
            assert.equal(widget.view.vp.time.displayCount, count, 'ready must not reset the saved zoom width');
            assert.equal(widget.view.vp.time.scrollOffset, offset, 'fraction must use the complete receive block');
            assert.equal(widget.view.vp.time.autoFollow, false);
            assert.equal(widget.view._boxZoomY.time.max, count);
            assert.equal(widget.pendingViewport, null);
        }
        await restored.tick();
        assert.equal(restored.app.widgets.widgets.get(a.id).view.vp.time.displayCount, 64);
    }
});

test('viewport restoration waits for the current ready promise and cancels queued work on removal or disposal', async t => {
    const f = bootApplication(); t.after(() => f.app.dispose());
    const source = f.app.service.numericSource;
    let finishOld;
    source.ready = new Promise(resolve => { finishOld = resolve; });
    const viewport = { time: { displayCount: 20, autoFollow: false, startFraction: 0.5, yZoom: null },
        frequency: { displayCount: 10, autoFollow: true, startFraction: 0, yZoom: null } };
    const first = f.app.widgets.create({ type: 'wave', settings: { viewport } });
    for (let i = 0; i < 100; i++) source.frames.append([i], Uint8Array.of(i), 't', i + 1);
    f.app.widgets.syncData(source); await f.tick();
    assert.ok(first.pendingViewport, 'a data callback must not overtake source readiness');
    source.ready = Promise.resolve(source);
    f.app.widgets.syncData(source); finishOld(source);
    for (let i = 0; i < 5; i++) await Promise.resolve();
    const queued = first.viewportFrame;
    assert.ok(f.rafs.has(queued));
    f.app.widgets.remove(first.id);
    assert.equal(f.rafs.has(queued), false);
    const second = f.app.widgets.create({ type: 'wave', settings: { viewport } });
    for (let i = 0; i < 5; i++) await Promise.resolve();
    const disposeFrame = second.viewportFrame;
    assert.ok(f.rafs.has(disposeFrame), 'existing history is restored after source readiness');
    f.app.dispose();
    assert.equal(f.rafs.has(disposeFrame), false);
});

test('user wheel zoom and thumb pan persist the viewport while capture alone never saves', async t => {
    const { GLOBAL_DEFAULTS } = require('../widgetConfig');
    const f = bootApplication({ version: 2, global: { ...GLOBAL_DEFAULTS, dataType: 'uint8', enableHeader: false },
        widgets: [], workspace: { step: 10, rects: {} }, nextNumber: 1 });
    t.after(() => f.app.dispose());
    const widget = f.app.widgets.create({ type: 'wave' }); await f.settle(); await f.tick(200);
    const before = f.writes;
    f.app.serialAdapter.onDataCallback(new Uint8Array(128)); await f.tick(200);
    assert.equal(f.writes, before, 'incoming samples must not schedule configuration saves');
    widget.view.canvas.dispatchEvent({ type: 'wheel', clientX: 200, clientY: 100, deltaY: -1 });
    await f.tick(200);
    const saved = () => JSON.parse(f.storage.get('serialplot_v3_config')).widgets[0].settings.viewport;
    assert.ok(saved().time.displayCount < 128);
    assert.equal(saved().time.displayCount, widget.view.vp.time.displayCount);
    const fraction = saved().time.startFraction;
    widget.refs['plot-scrollbar-thumb'].dispatchEvent({ type: 'mousedown', clientX: 0 });
    f.document.dispatchEvent({ type: 'mousemove', clientX: 300 });
    f.document.dispatchEvent({ type: 'mouseup' }); await f.tick(200);
    assert.notEqual(saved().time.startFraction, fraction);
    const afterPan = f.writes;
    f.app.serialAdapter.onDataCallback(new Uint8Array(128)); await f.tick(200);
    assert.equal(f.writes, afterPan);
});
