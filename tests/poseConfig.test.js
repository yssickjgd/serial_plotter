const test = require('node:test');
const assert = require('node:assert/strict');
const { PoseConfig: C } = require('../poseConfig');
const { validateWorkspaceConfig, GLOBAL_DEFAULTS } = require('../widgetConfig');
const config = settings => ({ version: 2, global: { ...GLOBAL_DEFAULTS, channelsCount: '3' },
    widgets: [{ id: 'pose-1', type: 'pose', title: '位姿 1', settings }] });

test('pose defaults are deep copies and normalization preserves hidden representations', () => {
    const a = C.defaults(), b = C.defaults();
    assert.equal(a.representation, 'euler'); assert.equal(a.euler.rotation, 'intrinsic');
    assert.equal(a.overlay.enabled, false);
    a.bindings.euler[0] = 1; a.overlay.fixed.matrix[0] = 2;
    assert.equal(b.bindings.euler[0], null); assert.equal(b.overlay.fixed.matrix[0], 1);
    const normalized = C.normalize(a);
    assert.deepEqual(normalized, a); normalized.bindings.euler[0] = 2;
    assert.equal(a.bindings.euler[0], 1);
});
test('pose configuration rejects invalid enums, types, numbers, hidden arrays and scalar bindings', () => {
    for (const edit of [s => { s.euler.order = 'XYZ'; }, s => { s.overlay.enabled = 'false'; },
        s => { s.overlay.fixed.euler[0] = Infinity; }, s => { s.bindings.matrix = [null]; },
        s => { s.axes.body.y = 'backward'; }, s => { s.camera.elevation = Math.PI / 2; },
        s => { s.camera.scale = 5; }, s => { s.bindings.quaternion[0] = 9; },
        s => { s.overlay.bindings.euler[0] = 2; }]) {
        const settings = C.defaults(); edit(settings);
        assert.throws(() => C.normalize(settings, { channelCount: 3, isSignal: index => index < 2 }));
    }
});
test('pose bindings remap every hidden component by stable signal identity and clear deleted signals', () => {
    const s = C.defaults(); s.bindings.euler = [0, 3, 4]; s.bindings.matrix[8] = 4;
    s.overlay.bindings.quaternion = [3, 4, 5, null];
    const mapped = C.remapBindings(s, new Map([[1, 1], [4, 5], [5, 4], [6, null]]));
    assert.deepEqual(mapped.bindings.euler, [0, 4, 3]);
    assert.equal(mapped.bindings.matrix[8], 3);
    assert.deepEqual(mapped.overlay.bindings.quaternion, [4, 3, null, null]);
    assert.deepEqual(s.bindings.euler, [0, 3, 4]);
});
test('workspace roundtrip uses candidate scalar channel definitions for pose validation', () => {
    const s = C.defaults(); s.bindings.euler = [0, 1, 3];
    const input = config(s); input.global.channelDefinitions = [{ number: 4, type: 'formula', expression: 'CH01+CH02' }];
    const normalized = validateWorkspaceConfig(input);
    assert.deepEqual(normalized.widgets[0].settings, s);
    assert.deepEqual(validateWorkspaceConfig(JSON.parse(JSON.stringify(normalized))).widgets, normalized.widgets);
    input.global.channelDefinitions = [{ number: 4, type: 'constant', expression: '[0]=1' }];
    assert.throws(() => validateWorkspaceConfig(input));
    assert.equal(validateWorkspaceConfig({ ...config({}), widgets: [] }).widgets.length, 0);
});
