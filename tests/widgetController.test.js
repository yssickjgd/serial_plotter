const test = require('node:test');
const assert = require('node:assert/strict');

test('resuming capture clears navigation and makes every retained widget follow latest', async t => {
    const f = bootApplication(); t.after(() => f.app.dispose());
    const wave = f.app.widgets.create({ type: 'wave' });
    const spectrum = f.app.widgets.create({ type: 'wave', settings: { plotViewMode: 'frequency' } });
    const bytes = f.app.widgets.create({ type: 'byte', settings: { captureMode: 'number' } });
    const hex = f.app.widgets.create({ type: 'byte' });
    const frame = Uint8Array.of(0, 0, 128, 63, 0, 0, 128, 127);
    for (let i = 0; i < 10; i++) f.app.serialAdapter.onDataCallback(frame);
    await f.settle(); f.click('btn-pause');
    const startByte = wave.source.frames.rawByteOffsetAt(3);
    f.app.tools._jumpAll(startByte, true);
    f.app.tools.matches = [{ startByte, endByte: startByte + frame.length }];
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
    f.app.serialAdapter.onDataCallback(Uint8Array.of(0, 0, 0, 64, 0, 0, 128, 127)); await f.tick();
    assert.equal(wave.source.frames.length, 11, 'resuming must preserve retained history');
    assert.equal(wave.source.frames.getValue(0, 10), 2);
});
const { bootArrayApplication: bootApplication } = require('./helpers/widgetAppHarness');

test('axis display precision is editable and survives configuration round trips per widget', async t => {
    const f = bootApplication(); t.after(() => f.app.dispose());
    const widgets = f.app.widgets;
    const make = (type, x, y) => {
        const w = widgets.create({ type });
        const field = (axis, key) => f.get(type === 'wave'
            ? 'plot-' + axis + '-' + key.replace(/[A-Z]/g, letter => '-' + letter.toLowerCase())
            : type + '-' + axis + key[0].toUpperCase() + key.slice(1));
        const change = (axis, key, value) => {
            const input = field(axis, key);
            assert.ok(input, type + ' ' + axis + ' ' + key);
            input.value = value; input.dispatchEvent({ type: 'change' });
        };
        change('x', 'significantDigits', x);
        change('x', 'numberNotation', 'plain');
        change('y', 'precisionMode', 'decimal');
        change('y', 'decimalPlaces', y);
        change('y', 'numberNotation', 'scientific');
        assert.deepEqual([w.settings.xSignificantDigits, w.settings.yDecimalPlaces], [x, y]);
        change('y', 'precisionMode', 'significant');
        assert.ok(!field('y', 'significantDigits').parentElement.hidden);
        change('y', 'precisionMode', 'decimal');
        assert.equal(field('y', 'decimalPlaces').value, String(y));
        return w.id;
    };
    const ids = [make('wave', 4, 9), make('xy', 3, 7), make('histogram', 5, 2)];
    const config = JSON.parse(JSON.stringify(f.app.getConfig()));
    f.app.applyConfig(config); await f.settle();
    assert.deepEqual(ids.map(id => {
        const { xSignificantDigits, xNumberNotation, yPrecisionMode, yDecimalPlaces, yNumberNotation } = widgets.widgets.get(id).settings;
        return [xSignificantDigits, xNumberNotation, yPrecisionMode, yDecimalPlaces, yNumberNotation];
    }), [[4, 'plain', 'decimal', 9, 'scientific'], [3, 'plain', 'decimal', 7, 'scientific'], [5, 'plain', 'decimal', 2, 'scientific']]);
    const { validateWorkspaceConfig } = f.S.WidgetConfig;
    config.widgets.find(widget => widget.type === 'wave').settings.ySignificantDigits = 16;
    assert.throws(() => validateWorkspaceConfig(config), /有效数字位数/);
});

test('wave trace style defaults to both and restores each widget selection across data sources', t => {
    const f = bootApplication(); t.after(() => f.app.dispose());
    const native = f.app.widgets.create({ type: 'wave' });
    assert.equal(native.view.traceMode, 'both');
    f.change('plot-trace-mode', 'line');
    f.click('workspace-channel-auto-map');
    const globalWave = f.app.widgets.create({ type: 'wave', settings: { connectionSource: 'workspace' } });
    f.change('plot-trace-mode', 'points');
    assert.equal(globalWave.view.traceMode, 'points');
    f.app.widgets.activate(native.id);
    assert.equal(f.get('plot-trace-mode').value, 'line');
    const config = f.app.getConfig(), restored = bootApplication(config);
    t.after(() => restored.app.dispose());
    assert.equal(restored.app.widgets.widgets.get(native.id).view.traceMode, 'line');
    assert.equal(restored.app.widgets.widgets.get(globalWave.id).view.traceMode, 'points');
    config.widgets[0].settings.plotTraceMode = 'invalid';
    assert.throws(() => require('../widgetConfig').validateWorkspaceConfig(config), /轨迹样式/);
});

test('byte logs keep following across the native scroll events from entering and leaving title focus', async t => {
    const f = bootApplication(); t.after(() => f.app.dispose());
    const { workspace, widgets, service } = f.app;
    const byte = widgets.create({ type: 'byte', settings: { captureMode: 'hex' } });
    const { view } = byte, log = byte.refs['data-log'], title = byte.refs['monitor-header'];
    const append = value => { service.receive(Uint8Array.of(value)); service.endStream(); };
    workspace.setZoom(0.39);
    for (let i = 0; i < 80; i++) append(i);
    await f.settle();
    assert.ok(log.scrollTop > 100, 'the live log has room for the browser to adjust its scroll position');

    // Native layout zoom can reconcile the old scroll offset before dispatching scroll and resize callbacks.
    let zoom = workspace.surface.style.zoom;
    Object.defineProperty(workspace.surface.style, 'zoom', {
        get: () => zoom,
        set(value) {
            if (value !== zoom) log.scrollTop -= 60;
            zoom = value;
        }
    });
    const changeFocus = () => {
        title.dispatchEvent({ type: 'dblclick' });
        log.dispatchEvent({ type: 'scroll' });
        log.dispatchEvent({ type: 'scrollend' });
    };
    for (const [focused, value, expected] of [[true, 0xCD, /CD/], [false, 0xEF, /EF/]]) {
        changeFocus();
        assert.equal(Boolean(workspace.focusState), focused);
        assert.equal(view.followTail, true);
        append(value); await f.tick();
        assert.match(view.spacer.children.at(-1).children[1].textContent, expected);
        assert.equal(log.scrollTop, log.scrollHeight - log.clientHeight);
    }
    assert.equal(workspace.zoom, 0.39);

    log.scrollTop -= 120;
    log.dispatchEvent({ type: 'scroll' });
    log.dispatchEvent({ type: 'scrollend' });
    assert.equal(view.followTail, false);
    const order = view.anchor.order;
    changeFocus();
    assert.equal(view.followTail, false);
    assert.equal(view.anchor.order, order);
});

test('amplitude and phase widgets share one FFT and deleting a subscriber preserves the other result', async t => {
    const f = bootApplication(); t.after(() => f.app.dispose());
    const amplitude = f.app.widgets.create({ type: 'wave', settings: { plotViewMode: 'frequency' } });
    const phase = f.app.widgets.create({ type: 'wave', settings: { plotViewMode: 'phase' } });
    for (let i = 0; i < 64; i++) f.app.service.receive(Uint8Array.of(0, 0, 128, 63, 0, 0, 128, 127));
    await f.settle();
    const pool = f.app.service.workerPool;
    const run = pool.runTask.bind(pool);
    let fftJobs = 0;
    pool.runTask = task => { if (task.kind === 'fft') fftJobs++; return run(task); };
    for (const widget of [amplitude, phase]) {
        widget.view.fftWorkerPool = pool;
        widget.view.setChannelVisible(0, true);
        widget.view.draw();
    }
    assert.equal(fftJobs, 1, 'two views of one numeric snapshot must dispatch only one FFT');
    await f.tick(10);
    amplitude.view.draw(); phase.view.draw();
    assert.equal(amplitude.view._fftCache.get(0), phase.view._fftCache.get(0));
    assert.equal(fftJobs, 1);
    f.app.service.receive(Uint8Array.of(0, 0, 0, 64, 0, 0, 128, 127));
    for (const widget of [amplitude, phase]) { widget.view._fftAt -= 200; widget.view.draw(); }
    assert.equal(fftJobs, 2);
    const before = phase.view.completedSpectrumDraws;
    f.app.widgets.remove(amplitude.id);
    await f.tick(10); phase.view.draw();
    assert.ok(phase.view.completedSpectrumDraws > before);
    assert.equal(pool.disposed, false, 'removing one view cannot destroy the shared compute pool');
});

test('inspector deletion waits for confirmation, cancellation preserves the widget, and confirmed deletion keeps capture', t => {
    const f = bootApplication(); t.after(() => f.app.dispose());
    const widget = f.app.widgets.create({ type: 'wave', title: '待确认的波形' });
    const source = widget.source;
    f.app.service.receive(Uint8Array.of(0, 0, 0x80, 0x3F, 0, 0, 128, 127), { timestamp: 100 });
    f.click('widget-delete');
    assert.equal(f.app.widgets.widgets.has(widget.id), true);
    assert.equal(f.get('widget-delete-dialog').open, true);
    assert.ok(f.get('widget-delete-message').textContent.includes(widget.title));
    f.app.service.receive(Uint8Array.of(0, 0, 0, 0x40, 0, 0, 128, 127), { timestamp: 101 });
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

test('workspace scroll position autosaves and round-trips through startup and config export/import', async t => {
    const f = bootApplication(); t.after(() => f.app.dispose());
    const { workspace, widgets } = f.app;
    widgets.create({ type: 'wave', rect: { x: 1200, y: 900, width: 500, height: 400 } });
    workspace.setZoom(1.5);
    await f.app.flushConfig();
    workspace.viewport.scrollLeft = 725; workspace.viewport.scrollTop = 475;
    workspace.viewport.dispatchEvent({ type: 'scroll' });
    await f.tick(200);
    const saved = JSON.parse(f.storage.get('serialplot_v3_config'));
    assert.equal(saved.workspace.view?.scrollLeft, 725);
    assert.equal(saved.workspace.view.scrollTop, 475);
    f.click('btn-export-cfg');
    const exported = JSON.parse(await f.blobs.at(-1).text());
    assert.deepEqual(exported.workspace, saved.workspace);
    const reloaded = bootApplication(saved); t.after(() => reloaded.app.dispose());
    const restored = reloaded.app.workspace;
    const position = () => [restored.zoom, restored.viewport.scrollLeft, restored.viewport.scrollTop];
    assert.deepEqual(position(), [1.5, 725, 475]);
    restored.viewport.scrollLeft = 0; restored.viewport.scrollTop = 0;
    reloaded.app.applyConfig(exported);
    assert.deepEqual(position(), [1.5, 725, 475]);
});

test('a refresh before autosave restores the latest workspace view for the same layout', async t => {
    const sessionStorage = new Map();
    const f = bootApplication(null, { sessionStorage });
    const { workspace, widgets } = f.app;
    widgets.create({ type: 'wave', rect: { x: 1200, y: 900, width: 500, height: 400 } });
    await f.app.flushConfig();
    const previous = f.storage.get('serialplot_v3_config');
    workspace.setZoom(1.5);
    workspace.viewport.scrollLeft = 725;
    workspace.viewport.scrollTop = 475;
    f.window.dispatchEvent({ type: 'pagehide' });
    const reloaded = bootApplication(previous, { sessionStorage }); t.after(() => reloaded.app.dispose());
    const restored = reloaded.app.workspace;
    assert.deepEqual([restored.zoom, restored.viewport.scrollLeft, restored.viewport.scrollTop], [1.5, 725, 475]);
    assert.equal(sessionStorage.size, 0);
    assert.equal((await reloaded.app.flushConfig()).workspace.view.scrollLeft, 725);
});

test('workspace suppresses browser context menus and preserves the plot and workspace right-click actions', t => {
    const f = bootApplication(); t.after(() => f.app.dispose());
    const { workspace, widgets } = f.app;
    const wave = widgets.create({ type: 'wave' });
    let plotResets = 0;
    wave.view.followLatest = () => { plotResets++; };
    const rightClick = target => {
        let prevented = false;
        target.dispatchEvent({ type: 'contextmenu', bubbles: true, clientX: 50, clientY: 50,
            preventDefault() { prevented = true; } });
        return prevented;
    };
    workspace.setZoom(2);
    assert.equal(rightClick(wave.refs['waveform-drag-handle']), true);
    assert.equal(rightClick(wave.refs['plot-channel-stats']), true);
    assert.equal(rightClick(f.get('workspace-toolbar')), true);
    assert.equal(workspace.zoom, 2);
    assert.equal(plotResets, 0);
    assert.equal(rightClick(wave.view.canvas), true);
    assert.equal(plotResets, 1);
    assert.equal(rightClick(workspace.surface), true);
    assert.equal(workspace.zoom, 1);
    assert.equal(rightClick(f.get('widget-title')), false);
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

test('inspector names the selected widget type and updates its context after renaming', t => {
    const f = bootApplication(); t.after(() => f.app.dispose());
    assert.match(f.get('widget-selection-prompt').textContent, /选择/);
    const wave = f.app.widgets.create({ type: 'wave' });
    assert.equal(f.get('active-monitor-caption').textContent, wave.title);
    assert.equal(f.get('active-widget-type').textContent, '波形控件');
    f.get('widget-title').value = '主频分析';
    f.get('widget-title').dispatchEvent({ type: 'blur' });
    assert.equal(f.get('active-monitor-caption').textContent, '主频分析');
    const byte = f.app.widgets.create({ type: 'byte' });
    assert.equal(f.get('active-widget-type').textContent, '字节流控件');
    f.app.widgets.activate(null);
    assert.equal(f.get('active-widget-type').hidden, true);
    assert.equal(byte.title.startsWith('字节流'), true);
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
    f.change('widget-export-format', 'text');
    f.change('widget-export-output-encoding', 'ascii');
    f.app.widgets.activate(wave.id);
    assert.equal(f.get('widget-export-output-encoding').value, 'ascii');
    assert.equal(f.get('btn-widget-export').disabled, true);
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

test('byte widgets follow the engine idle timeout instead of legacy widget values through mode switches and reload', async t => {
    const f = bootApplication(); t.after(() => f.app.dispose());
    const byte = f.app.widgets.create({ type: 'byte', settings: { captureMode: 'hex', idleGapSeconds: '0.01' } });
    await f.settle();
    assert.equal(byte.settings.idleGapSeconds, '0.001');
    assert.equal(byte.source.format.idleGapSeconds, 0.05);
    assert.equal(byte.source, f.app.service.baseSource);
    assert.ok(!f.document.getElementById('idle-gap-seconds'));
    f.app.serialAdapter.onDataCallback(Uint8Array.of(65));
    await f.tick(2);
    f.app.serialAdapter.onDataCallback(Uint8Array.of(66));
    f.app.service.endStream();
    assert.equal(byte.source.frames.length, 1, 'a two-millisecond gap remains within the default fifty-millisecond timeout');
    assert.deepEqual([...byte.source.frames.rawBytesAt(0)], [65, 66]);
    f.change('capture-mode', 'text');
    assert.equal(byte.source.format.idleGapSeconds, 0.05);
    f.change('text-boundary', 'crlf');
    assert.equal(byte.source.format.textBoundary, 'crlf');
    f.change('text-boundary', 'idle');
    assert.equal(byte.source, f.app.service.baseSource);
    const restored = bootApplication(f.app.getConfig()); t.after(() => restored.app.dispose());
    assert.equal(restored.app.widgets.widgets.get(byte.id).source.format.idleGapSeconds, 0.05);
});

test('byte-only workspaces edit shared channel names in the persistent global engine', async t => {
    const f = bootApplication(); t.after(() => f.app.dispose());
    const byte = f.app.widgets.create({ type: 'byte', settings: { captureMode: 'engine' } });
    await f.settle(); f.app.service.paused = true; f.app.tools.syncSources({ referenceId: byte.id });
    f.selectConnection('primary', 'engine-channels');
    const input = f.app.engineView.channels.list.children[0].querySelector('[data-role="channel-name"]');
    input.value = '温度'; input.dispatchEvent({ type: 'change' }); f.click('engine-apply');
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

test('workspace analysis plots stay frozen throughout the pause drain and respect page visibility', t => {
    const f = bootApplication(); t.after(() => f.app.dispose());
    const { widgets } = f.app;
    const xy = widgets.create({ type: 'xy', settings: { connectionSource: 'workspace' } });
    const histogram = widgets.create({ type: 'histogram' });
    widgets.setWorkspacePresentationDeferred(true);
    assert.equal(xy.view.visible, false);
    assert.equal(histogram.view.visible, true);
    widgets.setCaptureHidden(true);
    widgets.setWorkspacePresentationDeferred(false);
    assert.equal(xy.view.visible, false);
    assert.equal(histogram.view.visible, false);
    widgets.setCaptureHidden(false);
    assert.equal(xy.view.visible, true);
    assert.equal(histogram.view.visible, true);
});

test('removing a formula unbinds its XY axis and histogram without reusing the next channel', async t => {
    const f = bootApplication(); t.after(() => f.app.dispose());
    const { widgets } = f.app;
    await widgets.updateChannelDefinition({ id: 'one', number: 2, type: 'formula', expression: 'CH1' });
    await widgets.updateChannelDefinition({ id: 'two', number: 3, type: 'formula', expression: 'CH1+2' });
    const xy = widgets.create({ type: 'xy', settings: { pairs: [{ x: 1, y: 2 }] } });
    const histogram = widgets.create({ type: 'histogram', settings: { channel: 1 } });
    await widgets.removeChannel(2);
    const reloaded = bootApplication(f.app.getConfig()); t.after(() => reloaded.app.dispose());
    const pair = reloaded.app.widgets.widgets.get(xy.id).settings.pairs[0];
    assert.equal(pair.x, null);
    assert.equal(pair.y, 1);
    assert.equal(reloaded.app.widgets.widgets.get(histogram.id).settings.channel, null);
});

test('direct creation rejects reserved source identities without modifying the workspace', t => {
    const f = bootApplication(); t.after(() => f.app.dispose());
    for (const id of ['numeric', 'base']) assert.throws(() => f.app.widgets.create({ id, type: 'wave' }), /编号/);
    assert.equal(f.app.widgets.widgets.size, 0);
});

test('widget selection and viewing mode cannot move or apply the global parsing draft', async t => {
    const f = bootApplication(); t.after(() => f.app.dispose());
    const first = f.app.widgets.create({ type: 'byte', settings: { captureMode: 'engine' } });
    f.change('data-type', 'uint16');
    const wave = f.app.widgets.create({ type: 'wave' });
    assert.ok(f.get('data-type').closest('#data-engine'));
    assert.equal(f.get('data-type').value, 'uint16');
    assert.equal(first.source.format.dataType, 'float32');
    await f.app.engineView.apply(); await f.settle();
    assert.equal(first.source.format.dataType, 'uint16');
    const hex = f.app.widgets.create({ type: 'byte' });
    f.change('capture-mode', 'text'); assert.equal(f.get('frame-raw-settings').hidden, false);
    f.change('capture-mode', 'engine'); assert.equal(f.get('frame-raw-settings').hidden, true);
    assert.ok(f.get('data-type').closest('#data-engine'));
    assert.equal(first.source, wave.source); assert.equal(hex.source, wave.source);
    assert.equal(f.get('tab-byte-frame'), null);
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
    const f = bootApplication({ version: 2, global: { ...GLOBAL_DEFAULTS, dataType: 'uint8', enableHeader: false, enableFooter: false },
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
    const f = bootApplication({ version: 2, global: { ...GLOBAL_DEFAULTS, dataType: 'uint8', enableHeader: false, enableFooter: false },
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
