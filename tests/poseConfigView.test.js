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
    f.app.widgets.selectTab('tab-pose-channels');
    assert.equal(f.get('pose-overlay-parameters-matrix').hidden, false);
    f.change('pose-overlay-fixed-matrix-0', 'invalid');
    assert.equal(widget.settings.overlay.fixed.matrix[0], 1);
    assert.match(f.get('pose-overlay-parameters-matrix-error').textContent, /数值/);
    f.change('pose-overlay-fixed-matrix-0', '2');
    assert.equal(widget.settings.overlay.fixed.matrix[0], 2);
    assert.equal(f.get('pose-overlay-parameters-matrix-error').textContent, '');
    f.change('pose-overlay-sources-matrix-0', 'channels');
    assert.equal(f.get('pose-overlay-fixed-matrix-0').parentElement.hidden, true);
    assert.equal(f.get('pose-overlay-bindings-matrix-0').parentElement.hidden, false);
    assert.equal(f.get('pose-overlay-fixed-matrix-1').parentElement.hidden, false);
});

test('mixed overlay inspector edits apply live without changing another pose or discarding inactive values', async t => {
    const f = bootApplication(); t.after(() => f.app.dispose());
    const a = f.app.widgets.create({ type: 'pose' }), b = f.app.widgets.create({ type: 'pose', settings: { bindings: { euler: [0, 0, 0] } } });
    f.change('pose-overlay-enabled', true);
    f.app.widgets.selectTab('tab-pose-channels');
    f.change('pose-overlay-fixed-euler-0', String(Math.PI / 2));
    f.change('pose-overlay-sources-euler-1', 'channels');
    f.change('pose-overlay-bindings-euler-1', '0');
    const groups = f.get('tab-pose-display').children.filter(group => group.classList.contains('control-group'));
    assert.ok(groups.findIndex(group => group.id === 'pose-overlay-settings') > groups.findIndex(group => group.id === 'pose-camera-settings'));
    assert.equal(f.get('pose-overlay-bindings-euler-1').closest('#tab-pose-channels')?.id, 'tab-pose-channels');
    f.app.serialAdapter.onDataCallback(Uint8Array.of(0xAB, 0, 0, 0, 0)); await f.tick();
    assert.equal(b.view.target.valid, true);
    const result = f.S.PoseMath.apply(b.view.target.matrix, [1, 0, 0]);
    result.forEach((value, index) => assert.ok(Math.abs(value - [0, 1, 0][index]) < 1e-8));
    assert.equal(a.settings.overlay.enabled, false);
    f.change('pose-overlay-sources-euler-0', 'channels');
    assert.equal(b.settings.overlay.fixed.euler[0], Math.PI / 2);
    f.change('pose-overlay-sources-euler-0', 'fixed');
    assert.equal(f.get('pose-overlay-fixed-euler-0').value, String(Math.PI / 2));
    f.app.applyConfig(f.app.getConfig()); await f.settle(); f.app.widgets.activate(b.id);
    assert.equal(f.get('pose-overlay-sources-euler-1').value, 'channels');
    assert.equal(f.get('pose-overlay-bindings-euler-1').value, '0');
});

test('axis name switches independently update the active pose widget and saved configuration', async t => {
    const f = bootApplication(); t.after(() => f.app.dispose());
    const a = f.app.widgets.create({ type: 'pose' }), b = f.app.widgets.create({ type: 'pose' });
    for (const frame of ['odom', 'body']) {
        assert.equal(f.get(`pose-axes-${frame}-visible`).checked, true);
        const names = f.get(`pose-axes-${frame}-showLabels`);
        assert.ok(names, 'each coordinate frame needs its own name visibility switch');
        assert.equal(names.checked, false);
    }
    f.change('pose-axes-odom-showLabels', true);
    assert.equal(b.settings.axes.odom.showLabels, true);
    assert.equal(b.settings.axes.body.showLabels, false);
    assert.equal(a.settings.axes.odom.showLabels, false);
    f.app.applyConfig(f.app.getConfig()); await f.settle();
    f.app.widgets.activate(b.id);
    assert.equal(f.get('pose-axes-odom-showLabels').checked, true);
    assert.equal(f.get('pose-axes-body-showLabels').checked, false);
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

test('pose axis controls select Z direction independently and prevent nonorthogonal choices', t => {
    const f = bootApplication(); t.after(() => f.app.dispose());
    const widget = f.app.widgets.create({ type: 'pose' });
    const z = f.get('pose-axes-odom-z');
    assert.ok(z, 'odom must have an editable Z direction');
    assert.equal(z.tagName, 'SELECT');
    assert.equal(z.value, 'up');
    assert.deepEqual(z.options.filter(option => !option.disabled).map(option => option.value), ['up', 'down']);
    assert.equal(f.get('pose-axes-odom-hand'), null);
    f.change('pose-axes-odom-z', 'down');
    const scene = f.context.SerialPlotter.PoseRenderer.buildScene(widget.settings,
        { valid: true, matrix: f.context.SerialPlotter.PoseMath.identity() });
    assert.equal(scene.axes.find(axis => axis.frame === 'odom' && axis.label === 'Z').end[2], -2.4);
    assert.equal(scene.axes.find(axis => axis.frame === 'body' && axis.label === 'Z').end[2], 2);
    f.change('pose-axes-odom-x', 'up');
    assert.equal(z.value, 'forward');
    assert.deepEqual(z.options.filter(option => !option.disabled).map(option => option.value), ['forward', 'backward']);
    const previous = JSON.stringify(widget.settings);
    f.change('pose-axes-odom-z', 'left');
    assert.match(f.get('pose-axes-odom-error').textContent, /垂直/);
    assert.equal(JSON.stringify(widget.settings), previous);
});

test('legacy left handed axes display their existing Z direction and survive configuration roundtrip', async t => {
    const f = bootApplication(); t.after(() => f.app.dispose());
    const widget = f.app.widgets.create({ type: 'pose', settings: { axes: {
        odom: { x: 'left', y: 'up', hand: 'left' }, body: { hand: 'left' }
    } } });
    assert.ok(f.get('pose-axes-odom-z'), 'legacy axes must expose Z direction');
    assert.equal(f.get('pose-axes-odom-z').value, 'backward');
    assert.equal(f.get('pose-axes-body-z').value, 'down');
    f.change('pose-axes-body-z', 'up');
    const saved = f.app.getConfig();
    f.app.applyConfig(saved); await f.settle();
    f.app.widgets.activate(widget.id);
    assert.equal(f.get('pose-axes-odom-z').value, 'backward');
    assert.equal(f.get('pose-axes-body-z').value, 'up');
});

test('pose display groups are peers and camera controls edit only vector components without normalizing other inputs', t => {
    const f = bootApplication(); t.after(() => f.app.dispose());
    const widget = f.app.widgets.create({ type: 'pose' });
    const display = f.get('tab-pose-display');
    assert.ok(display.querySelectorAll('.control-group').every(group => group.parentNode === display));
    for (const id of ['pose-camera-azimuth', 'pose-camera-elevation', 'pose-camera-scale']) assert.equal(f.get(id), null);
    const x = f.get('pose-camera-direction-0'); assert.ok(x, 'camera must expose X/Y/Z direction inputs');
    for (let i = 0; i < 3; i++) f.change(`pose-camera-direction-${i}`, String(i + 1));
    assert.deepEqual(Array.from(widget.settings.camera.direction), [1, 2, 3]);
    f.change('pose-camera-direction-0', '0'); f.change('pose-camera-direction-1', '0');
    assert.deepEqual(Array.from(widget.settings.camera.direction), [0, 0, 3]);
    f.change('pose-camera-direction-2', '0');
    assert.match(f.get('pose-camera-error').textContent, /零/);
    assert.deepEqual(Array.from(widget.settings.camera.direction), [0, 0, 3]);
    f.change('pose-camera-direction-2', '-1');
    assert.equal(f.get('pose-camera-error').textContent, '');
    assert.deepEqual(Array.from(widget.settings.camera.direction), [0, 0, -1]);
    f.change('pose-overlay-enabled', true); f.change('pose-overlay-representation', 'matrix');
    assert.equal(f.get('pose-overlay-parameters-matrix').hidden, false);
    assert.ok(display.querySelectorAll('.control-group').every(group => group.parentNode === display));
});
