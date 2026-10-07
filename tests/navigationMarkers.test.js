const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { FrameBuffer } = require('../frameBuffer');

test('time cursor and search results draw distinct vertical lines at retained samples', () => {
    const context = vm.createContext({});
    for (const file of ['projectLimits.js', 'plotter.js'])
        vm.runInContext(fs.readFileSync(require.resolve(`../${file}`), 'utf8'), context);
    const { Plotter } = context.SerialPlotter;
    const frames = new FrameBuffer(1, 10);
    for (let i = 0; i < 5; i++) frames.append([i], Uint8Array.of(i), `t${i}`, i);
    const strokes = [];
    let path = [];
    const ctx = {
        save() {}, restore() {},
        beginPath() { path = []; },
        moveTo(x) { path.push(x); },
        lineTo() {},
        stroke() { strokes.push({ color: this.strokeStyle, x: path.slice() }); }
    };
    const view = {
        ctx, frames, displayMode: 'time',
        navigationMarkers: {
            timeOrder: 2,
            matches: [{ startOrder: 1 }, { startOrder: 1 }, { startOrder: 3 }],
            currentMatch: 2
        }
    };
    Plotter.prototype._drawNavigationMarkers.call(view, 100, 50, 0, 5);
    assert.deepEqual(strokes.map(stroke => stroke.color), ['#745a00', '#5c90be', '#ff8c00']);
    assert.deepEqual(strokes.map(stroke => stroke.x.length), [1, 1, 1]);
    assert.ok(Math.abs(strokes[0].x[0] - 25) < 1);
    assert.ok(Math.abs(strokes[1].x[0] - 50) < 1);
    assert.ok(Math.abs(strokes[2].x[0] - 75) < 1);
    view.displayMode = 'frequency';
    Plotter.prototype._drawNavigationMarkers.call(view, 100, 50, 0, 5);
    assert.equal(strokes.length, 3);
});

test('dense search hits in one pixel are skipped without scanning each result', () => {
    const context = vm.createContext({});
    for (const file of ['projectLimits.js', 'plotter.js'])
        vm.runInContext(fs.readFileSync(require.resolve(`../${file}`), 'utf8'), context);
    const { Plotter } = context.SerialPlotter;
    const frames = new FrameBuffer(1, 10);
    for (let i = 0; i < 5; i++) frames.append([i], Uint8Array.of(i), `t${i}`, i);
    let lookups = 0, strokes = 0;
    const view = {
        displayMode: 'time',
        frames: {
            length: frames.length,
            orderAt: index => frames.orderAt(index),
            indexAtOrAfterOrder(order) { lookups++; return frames.indexAtOrAfterOrder(order); }
        },
        navigationMarkers: {
            timeOrder: null,
            matches: Array.from({ length: 10000 }, () => ({ startOrder: 2 })),
            currentMatch: -1
        },
        ctx: {
            save() {}, restore() {}, beginPath() {}, moveTo() {}, lineTo() {},
            stroke() { strokes++; }
        }
    };
    Plotter.prototype._drawNavigationMarkers.call(view, 100, 50, 0, 5);
    assert.equal(strokes, 1);
    assert.ok(lookups < 100);
});

test('custom search colors update shared waveform markers without changing data or match selection', () => {
    const context = vm.createContext({});
    for (const file of ['projectLimits.js', 'plotter.js'])
        vm.runInContext(fs.readFileSync(require.resolve(`../${file}`), 'utf8'), context);
    const { Plotter } = context.SerialPlotter;
    const frames = new FrameBuffer(1, 10);
    for (let i = 0; i < 5; i++) frames.append([i], Uint8Array.of(i), `t${i}`, i);
    const colors = [];
    let draws = 0;
    const view = {
        ctx: { save() {}, restore() {}, beginPath() {}, moveTo() {}, lineTo() {},
            stroke() { colors.push(this.strokeStyle); } },
        frames, displayMode: 'time', isPaused: true, isVisible: true,
        _markViewDirty() {}, draw() { draws++; },
        navigationMarkers: { timeOrder: null, matches: [{ startOrder: 1 }, { startOrder: 3 }], currentMatch: 1 }
    };
    Plotter.prototype.setNavigationColors.call(view, { match: '#112233', current: '#445566' });
    Plotter.prototype._drawNavigationMarkers.call(view, 100, 50, 0, 5);
    assert.deepEqual(colors, ['#112233', '#445566']);
    assert.equal(view.navigationMarkers.currentMatch, 1);
    assert.equal(draws, 1);
    assert.equal(frames.length, 5);
    assert.throws(() => Plotter.prototype.setNavigationColors.call(view, { match: 'invalid' }));
});
