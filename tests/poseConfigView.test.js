const test = require('node:test');
const assert = require('node:assert/strict');
const { bootApplication } = require('./helpers/widgetAppHarness');

test('two pose widgets share numeric acquisition while their settings, inspector and history remain independent', async t => {
    const f = bootApplication(); t.after(() => f.app.dispose());
    f.change('channels-count', '3'); await f.settle();
    const a = f.app.widgets.create({ type: 'pose' }), b = f.app.widgets.create({ type: 'pose' });
    assert.equal(a.source, b.source); assert.equal(a.source, f.app.service.numericSource);
    assert.equal(f.get('tab-pose-display').hidden, false);
    assert.equal(f.get('tab-monitor-config').hidden, true);
    assert.equal(f.get('tab-waveform-config').hidden, true);
    f.app.widgets.selectTab('tab-pose-frame');
    assert.ok(f.get('data-type').closest('#tab-pose-frame'));
    assert.equal(f.get('rebuild-history-pose').checked, true);
    f.change('rebuild-history-pose', false); assert.equal(f.get('rebuild-history-byte').checked, false);
    f.change('pose-bindings-euler-0', '0'); f.change('pose-bindings-euler-1', '1'); f.change('pose-bindings-euler-2', '2');
    f.change('pose-euler-unit', 'degrees');
    assert.equal(b.settings.euler.unit, 'degrees'); assert.equal(a.settings.euler.unit, 'radians');
    const bytes = new Uint8Array(13); bytes[0] = 0xAB;
    new DataView(bytes.buffer).setFloat32(1, 90, true);
    f.app.serialAdapter.onDataCallback(bytes); await f.tick();
    assert.equal(a.source.frames.length, 1);
    assert.equal(b.view.target.valid, true); assert.equal(a.view.target.valid, false);
    assert.equal(b.refs['stat-plot-fps'].textContent.includes('FPS'), true);
    const config = f.app.getConfig();
    f.app.applyConfig(config); await f.settle();
    assert.equal(f.app.widgets.widgets.get(b.id).settings.euler.unit, 'degrees');
});
test('pose controls hide inactive groups, reject bad fixed values and keep previous valid settings', t => {
    const f = bootApplication(); t.after(() => f.app.dispose());
    const widget = f.app.widgets.create({ type: 'pose' });
    assert.equal(f.get('pose-input-quaternion').hidden, true);
    f.change('pose-representation', 'quaternion');
    assert.equal(f.get('pose-input-quaternion').hidden, false);
    assert.equal(f.get('pose-input-euler').hidden, true);
    f.change('pose-overlay-enabled', true); f.change('pose-overlay-representation', 'matrix');
    assert.equal(f.get('pose-overlay-fixed-matrix').hidden, false);
    f.change('pose-overlay-fixed-matrix-0', 'invalid');
    assert.equal(widget.settings.overlay.fixed.matrix[0], 1);
    assert.match(f.get('pose-overlay-error').textContent, /数值/);
    f.change('pose-overlay-fixed-matrix-0', '2');
    assert.equal(widget.settings.overlay.fixed.matrix[0], 2);
    assert.equal(f.get('pose-overlay-error').textContent, '');
    f.change('pose-overlay-source', 'channels');
    assert.equal(f.get('pose-overlay-fixed-matrix').hidden, true);
    assert.equal(f.get('pose-overlay-bindings-matrix').hidden, false);
});
test('pose binding identity follows channel reorder/delete and invalid imports leave the application intact', async t => {
    const f = bootApplication(); t.after(() => f.app.dispose());
    await f.app.widgets.updateChannelDefinition({ number: 2, type: 'formula', expression: 'CH01+1' });
    await f.app.widgets.updateChannelDefinition({ number: 3, type: 'formula', expression: 'CH01+2' });
    const widget = f.app.widgets.create({ type: 'pose', settings: { bindings: { euler: [0, 1, 2] },
        overlay: { bindings: { quaternion: [2, 1, 0, null] } } } });
    await f.app.widgets.moveChannel(2, 3);
    assert.deepEqual(Array.from(widget.settings.bindings.euler), [0, 2, 1]);
    assert.deepEqual(Array.from(widget.settings.overlay.bindings.quaternion), [1, 2, 0, null]);
    await f.app.widgets.removeChannel(2);
    assert.deepEqual(Array.from(widget.settings.bindings.euler), [0, 1, null]);
    const bad = f.app.getConfig(); bad.widgets[0].settings.bindings.euler[0] = 99;
    assert.throws(() => f.app.applyConfig(bad));
    assert.equal(f.app.widgets.widgets.get(widget.id), widget);
});

test('clearing pose history before another receive discards old orientation and shared capacity/settings remain usable', async t => {
    const f = bootApplication(); t.after(() => f.app.dispose());
    const widget = f.app.widgets.create({ type: 'pose', settings: { bindings: { euler: [0, 0, 0] } } });
    f.app.serialAdapter.onDataCallback(Uint8Array.of(0xAB, 0, 0, 128, 63)); await f.tick();
    assert.equal(widget.view.lastValid.valid, true);
    f.click('btn-clear');
    f.app.serialAdapter.onDataCallback(Uint8Array.of(0xAB, 0, 0, 192, 127)); await f.tick();
    assert.equal(widget.view.lastValid, null); assert.equal(widget.view.target.valid, false);
    f.change('channels-count', '2'); await f.settle();
    assert.equal(widget.source.frames.channelCount, 2);
    assert.equal(widget.view.frames, widget.source.frames);
    f.change('channels-count', '1'); await f.settle();
    assert.deepEqual(Array.from(widget.settings.bindings.euler), [0, 0, 0]);
});

test('asynchronous numeric channel shrink unbinds removed pose channels before inspector edits and configuration export', async t => {
    const f = bootApplication(); t.after(() => f.app.dispose());
    f.change('channels-count', '3'); await f.settle();
    const widget = f.app.widgets.create({ type: 'pose', settings: { bindings: { euler: [0, 1, 2] },
        overlay: { bindings: { quaternion: [2, 1, 0, null] } } } });
    const bytes = new Uint8Array(13); bytes[0] = 0xAB;
    f.app.serialAdapter.onDataCallback(bytes); await f.tick();
    f.change('channels-count', '1'); await f.settle();
    assert.equal(widget.source.frames.channelCount, 1);
    assert.deepEqual(Array.from(widget.settings.bindings.euler), [0, null, null]);
    assert.deepEqual(Array.from(widget.settings.overlay.bindings.quaternion), [null, null, 0, null]);
    f.change('pose-cubeVisible', false);
    assert.equal(widget.settings.cubeVisible, false);
    assert.doesNotThrow(() => f.app.applyConfig(f.app.getConfig())); await f.settle();
    f.change('channels-count', '3'); await f.settle();
    assert.deepEqual(Array.from(f.app.widgets.widgets.get(widget.id).settings.bindings.euler), [0, null, null]);
});
