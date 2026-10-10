const test = require('node:test');
const assert = require('node:assert/strict');
const { PoseRenderer: R } = require('../poseRenderer');
const { PoseConfig: C } = require('../poseConfig');
const { PoseMath: M } = require('../poseMath');
const identity = { valid: true, matrix: M.identity() };
test('scene binds face colors and body axes to pose while odom remains fixed', () => {
    const s = C.defaults(), a = R.buildScene(s, identity);
    assert.deepEqual(a.faces.map(f => [f.name, f.color]), [['前', '#ff0000'], ['后', '#ff8c00'],
        ['左', '#ffffff'], ['右', '#ffff00'], ['上', '#0000ff'], ['下', '#00ff00']]);
    const b = R.buildScene(s, M.fromEuler([Math.PI / 2, 0, 0]));
    assert.deepEqual(b.axes.filter(axis => axis.frame === 'odom'), a.axes.filter(axis => axis.frame === 'odom'));
    const x = b.axes.find(axis => axis.frame === 'body' && axis.label === 'X');
    assert.ok(Math.abs(x.end[1] - 1.2) < 1e-9);
    s.axes.body.hand = 'left';
    assert.equal(R.buildScene(s, identity).axes.find(axis => axis.frame === 'body' && axis.label === 'Z').end[2], -1.2);
    assert.deepEqual(identity.matrix, M.identity());
});
test('orthographic projection shows front left upper faces, orders depth and rejects nonfinite geometry', () => {
    const s = C.defaults(), projected = R.projectScene(R.buildScene(s, identity), s.camera, 640, 300);
    assert.deepEqual(projected.faces.map(f => f.name).sort(), ['上', '前', '左'].sort());
    for (let i = 1; i < projected.faces.length; i++) assert.ok(projected.faces[i].depth >= projected.faces[i - 1].depth);
    for (const f of projected.faces) for (const point of f.points) assert.ok(point.every(Number.isFinite));
    const invalid = R.buildScene(s, { valid: false, matrix: Array(9).fill(NaN) });
    assert.equal(invalid.faces.length, 0);
    assert.ok(R.projectScene(invalid, s.camera, 100, 100).axes.every(axis => axis.points.flat().every(Number.isFinite)));
    assert.ok(projected.axes.some(axis => axis.segments.some(segment => segment.hidden)), 'cube occludes axis interiors');
});

test('occluded axis strokes continue their dash pattern across adjoining short segments', () => {
    const strokes = []; let points = [], dash = [];
    const ctx = {
        clearRect() {}, fillRect() {}, fill() {}, closePath() {}, strokeText() {}, fillText() {},
        beginPath() { points = []; }, moveTo(...point) { points.push(point); }, lineTo(...point) { points.push(point); },
        setLineDash(value) { dash = value; }, stroke() { strokes.push({ points, dash }); }
    };
    const s = C.defaults();
    R.draw(ctx, R.buildScene(s, identity), s.camera, 640, 300);
    const hidden = strokes.filter(stroke => stroke.dash.length);
    assert.ok(hidden.length > 0);
    assert.ok(hidden.every(stroke => stroke.points.length > 2), 'continuous occluded runs must share a path');
    assert.ok(hidden.every(stroke => Math.hypot(stroke.points.at(-1)[0] - stroke.points[0][0],
        stroke.points.at(-1)[1] - stroke.points[0][1]) > 6), 'a hidden run must span a full dash and gap');
});
