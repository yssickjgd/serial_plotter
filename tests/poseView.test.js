const test = require('node:test');
const assert = require('node:assert/strict');
const { PoseView } = require('../poseView');
const { PoseConfig: C } = require('../poseConfig');
const { FrameBuffer } = require('../frameBuffer');
function fixture() {
    const callbacks = new Map(), listeners = new Map(); let next = 0, time = 0;
    const context = new Proxy({}, { get: (_, key) => key === 'measureText' ? () => ({ width: 20 }) : () => {} });
    const canvas = { clientWidth: 640, clientHeight: 300, width: 0, height: 0,
        getBoundingClientRect: () => ({ left: 0, top: 0, width: 640, height: 300 }), getContext: () => context,
        addEventListener(name, fn) { listeners.set(name, fn); }, removeEventListener(name) { listeners.delete(name); },
        setPointerCapture() {}, releasePointerCapture() {} };
    const settings = C.defaults(); settings.bindings.euler = [0, 1, 2];
    const frames = new FrameBuffer(3, 3), statusElement = { textContent: '', dataset: {} };
    const view = new PoseView(canvas, frames, { settings, statusElement, now: () => time,
        requestAnimationFrame: fn => { const id = ++next; callbacks.set(id, fn); return id; },
        cancelAnimationFrame: id => callbacks.delete(id) });
    const tick = ms => { time += ms; const pending = [...callbacks.values()]; callbacks.clear(); pending.forEach(fn => fn(time)); };
    const append = (v = 0) => { const order = frames.version + 1;
        frames.append([v, 0, 0], Uint8Array.of(order), '', order, 1000 + order, { byteOffset: order * 2 }); view.invalidateData(); };
    return { view, frames, canvas, callbacks, listeners, settings, statusElement, tick, append };
}
test('pose batches thousands of notices, draws at most 30 fps, and stops when static or invisible', () => {
    const f = fixture(); f.append();
    for (let i = 0; i < 5000; i++) f.view.invalidateData();
    assert.equal(f.callbacks.size, 1); f.tick(34);
    assert.equal(f.view.completedDraws, 1);
    f.append(); f.tick(10); assert.equal(f.view.completedDraws, 1);
    f.tick(24); assert.equal(f.view.completedDraws, 2);
    f.tick(100); assert.equal(f.callbacks.size, 0);
    f.view.setPaused(true); f.view.invalidateData(); f.tick(34);
    assert.equal(f.view.completedDraws, 2, 'identical state must not redraw');
    f.view.setVisible(false); f.append(); f.tick(100);
    assert.equal(f.view.completedDraws, 2);
    f.view.setVisible(true); f.tick(34); assert.equal(f.view.completedDraws, 3);
    f.view.dispose(); assert.equal(f.listeners.size, 0); assert.equal(f.callbacks.size, 0);
    f.view.dispose(); f.view.invalidateData(); assert.equal(f.callbacks.size, 0);
});
test('pose navigation is exact in retained byte spans and restores latest after overwrite', () => {
    const f = fixture(); f.append(0); f.append(1); f.append(2); f.tick(34);
    assert.equal(f.view.jumpToByteOffset(3), false, 'gap after frame must not invent a hit');
    assert.equal(f.view.jumpToByteOffset(2), true); f.tick(34);
    assert.equal(f.view.getReferenceByteOffset(), 2);
    f.append(3); f.tick(34);
    assert.equal(f.view.followTail, true);
    assert.equal(f.view.getReferenceByteOffset(), 8);
    f.view.jumpToFrame(0); f.view.followLatest(); f.tick(34);
    assert.equal(f.view.target.order, f.frames.orderAt(2));
    f.frames.clear(); f.view.invalidateData(); f.tick(34);
    assert.equal(f.view.lastValid, null); assert.match(f.statusElement.textContent, /无/);
    f.view.dispose();
});
test('invalid target retains a visibly stale pose with both timestamps and settings/resize rerasterize', () => {
    const f = fixture(); f.append(); f.tick(34); const valid = f.view.lastValid;
    f.append(NaN); f.tick(34);
    assert.equal(f.view.lastValid, valid); assert.equal(f.view.target.valid, false);
    assert.match(f.statusElement.textContent, /上一有效/);
    assert.match(f.statusElement.textContent, /01\.001/);
    assert.match(f.statusElement.textContent, /01\.002/);
    f.view.setPaused(true); const before = f.view.completedDraws;
    f.canvas.getBoundingClientRect = () => ({ left: 0, top: 0, width: 992, height: 465 });
    f.view.resize(); f.tick(34);
    assert.equal(f.canvas.width, 992); assert.equal(f.canvas.height, 465);
    assert.equal(f.view.completedDraws, before + 1);
    f.view.setSettings({ ...f.settings, cubeVisible: false }); f.tick(34);
    assert.equal(f.view.completedDraws, before + 2); f.view.dispose();
});
