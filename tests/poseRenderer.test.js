const test = require('node:test');
const assert = require('node:assert/strict');
const { PoseRenderer: R } = require('../poseRenderer');
const { PoseConfig: C } = require('../poseConfig');
const { PoseMath: M } = require('../poseMath');
const identity = { valid: true, matrix: M.identity() };
test('aircraft mesh and body axes rotate together while odom remains fixed', () => {
    const s = C.defaults(), a = R.buildScene(s, identity);
    assert.equal(a.faces.length, 3892, 'use every triangle of model_plane.STL instead of the cube');
    const b = R.buildScene(s, M.fromEuler([Math.PI / 2, 0, 0]));
    assert.deepEqual(b.axes.filter(axis => axis.frame === 'odom'), a.axes.filter(axis => axis.frame === 'odom'));
    for (let i = 0; i < a.faces.length; i++) for (let j = 0; j < 3; j++) {
        const [x, y, z] = a.faces[i].vertices[j];
        const actual = b.faces[i].vertices[j];
        [-y, x, z].forEach((value, k) => assert.ok(Math.abs(actual[k] - value) < 1e-9));
    }
    const x = b.axes.find(axis => axis.frame === 'body' && axis.label === 'X');
    assert.ok(x.end[1] >= 2, 'body axis must extend past the aircraft');
    s.axes.body.hand = 'left';
    assert.equal(R.buildScene(s, identity).axes.find(axis => axis.frame === 'body' && axis.label === 'Z').end[2], -x.end[1]);
    s.cubeVisible = false;
    const hidden = R.buildScene(s, identity);
    assert.equal(hidden.faces.length, 0);
    assert.equal(hidden.axes.length, 6, 'hiding the model must retain both frames');
    assert.deepEqual(identity.matrix, M.identity());
});
test('aircraft projection fits the default view, orders visible surfaces and rejects invalid poses', () => {
    const s = C.defaults(), projected = R.projectScene(R.buildScene(s, identity), s.camera, 640, 300);
    assert.ok(projected.faces.length > 100);
    for (let i = 1; i < projected.faces.length; i++) assert.ok(projected.faces[i].depth >= projected.faces[i - 1].depth);
    for (const f of projected.faces) for (const point of f.points) assert.ok(point.every(Number.isFinite));
    for (const axis of projected.axes) for (const [x, y] of [...axis.points, axis.labelPoint]) {
        assert.ok(x >= 0 && x <= 640 && y >= 0 && y <= 300, 'longer axes and labels must fit');
    }
    const invalid = R.buildScene(s, { valid: false, matrix: Array(9).fill(NaN) });
    assert.equal(invalid.faces.length, 0);
    assert.ok(R.projectScene(invalid, s.camera, 100, 100).axes.every(axis => axis.points.flat().every(Number.isFinite)));
});

test('axis names are hidden by default and can be shown per frame without changing axis geometry', () => {
    const labels = [], ctx = {
        clearRect() {}, fillRect() {}, fill() {}, closePath() {}, strokeText() {},
        beginPath() {}, moveTo() {}, lineTo() {}, setLineDash() {}, stroke() {},
        fillText(text) { labels.push(text); }
    };
    const s = C.normalize({ axes: { odom: { visible: true }, body: { visible: true } } });
    const draw = () => { labels.length = 0; return R.draw(ctx, R.buildScene(s, identity), s.camera, 640, 300); };
    const original = draw();
    assert.equal(original.axes.length, 6);
    assert.deepEqual(labels, []);
    s.axes.odom.showLabels = true;
    const named = draw();
    assert.deepEqual(labels.sort(), ['odom X', 'odom Y', 'odom Z']);
    assert.deepEqual(named.axes.map(axis => axis.points), original.axes.map(axis => axis.points));
    s.axes.odom.showLabels = false; s.axes.body.showLabels = true;
    draw(); assert.deepEqual(labels.sort(), ['body X', 'body Y', 'body Z']);
    s.axes.body.visible = false;
    assert.equal(draw().axes.length, 3);
    assert.deepEqual(labels, []);
});

test('occluded axis strokes continue their dash pattern across adjoining short segments', () => {
    const strokes = []; let points = [], dash = [];
    const ctx = {
        clearRect() {}, fillRect() {}, fill() {}, closePath() {}, strokeText() {}, fillText() {},
        beginPath() { points = []; }, moveTo(...point) { points.push(point); }, lineTo(...point) { points.push(point); },
        setLineDash(value) { dash = value; }, stroke() { strokes.push({ points, dash }); }
    };
    const scene = { faces: [{ color: '#c3d1df', normal: [0, 0, 1], vertices: [[-1, -1, 0.5], [1, -1, 0.5], [0, 1, 0.5]] }],
        axes: [{ frame: 'body', end: [2, 0, 0], color: '#ff0000', label: 'X' }] };
    R.draw(ctx, scene, { direction: [0, 0, 1], scale: 1 }, 640, 300);
    const hidden = strokes.filter(stroke => stroke.dash.length);
    assert.ok(hidden.length > 0);
    assert.ok(hidden.every(stroke => stroke.points.length > 2), 'continuous occluded runs must share a path');
    assert.ok(hidden.every(stroke => Math.hypot(stroke.points.at(-1)[0] - stroke.points[0][0],
        stroke.points.at(-1)[1] - stroke.points[0][1]) > 6), 'a hidden run must span a full dash and gap');
});
