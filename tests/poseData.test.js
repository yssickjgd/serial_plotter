const test = require('node:test');
const assert = require('node:assert/strict');
const { FrameBuffer } = require('../frameBuffer');
const { ComputedFrames } = require('../computedFrames');
const { PoseConfig: C } = require('../poseConfig');
const { PoseData: D } = require('../poseData');
const { PoseMath: M } = require('../poseMath');
const close = (a, b) => a.forEach((v, i) => assert.ok(Math.abs(v - b[i]) < 1e-8));
function fixture() {
    const frames = new FrameBuffer(3, 3), settings = C.defaults();
    settings.bindings.euler = [0, 1, 2];
    frames.append([0, 0, 0], Uint8Array.of(1, 2), '', 1, 1000, { byteOffset: 10 });
    frames.append([Math.PI / 2, 0, 0], Uint8Array.of(3, 4), '', 2, 1001, { byteOffset: 12 });
    return { frames, settings };
}
test('pose reads one retained frame and its byte/time metadata without mutating history', () => {
    const { frames, settings } = fixture(), version = frames.version;
    const p = D.read(frames, 1, settings);
    assert.equal(p.valid, true); assert.equal(p.startByte, 12); assert.equal(p.endByte, 14);
    assert.equal(p.timestamp, 1001); assert.equal(p.order, 2);
    close(M.apply(p.matrix, [1, 0, 0]), [0, 1, 0]);
    assert.equal(frames.length, 2); assert.equal(frames.version, version);
    const inverse = C.normalize(settings); inverse.inputDirection = 'odom-to-body';
    close(M.apply(D.read(frames, 1, inverse).matrix, [1, 0, 0]), [0, -1, 0]);
});
test('fixed and channel overlays use the same source frame and respect multiplication order', () => {
    const { frames, settings } = fixture();
    settings.overlay.enabled = true; settings.overlay.fixed.euler = [0, Math.PI / 2, 0];
    close(M.apply(D.read(frames, 1, settings).matrix, [1, 0, 0]), [0, 1, 0]);
    settings.overlay.order = 'overlay-first';
    close(M.apply(D.read(frames, 1, settings).matrix, [1, 0, 0]), [0, 0, -1]);
    settings.overlay.source = 'channels'; settings.overlay.bindings.euler = [1, 0, 2];
    close(M.apply(D.read(frames, 1, settings).matrix, [1, 0, 0]), [0, 0, -1]);
});

test('mixed Euler overlay reads only channel-backed components from the selected historical frame', () => {
    const { frames } = fixture(), version = frames.version;
    const settings = C.normalize({ bindings: { euler: [1, 1, 1] }, overlay: { enabled: true,
        sources: { euler: ['fixed', 'channels', 'fixed'] },
        fixed: { euler: [Math.PI / 2, 0, 0] }, bindings: { euler: [null, 0, null] } } });
    const pose = D.read(frames, 1, settings);
    assert.equal(pose.valid, true); assert.equal(pose.order, 2);
    close(M.apply(pose.matrix, [1, 0, 0]), [0, 0, -1]);
    close(M.apply(pose.matrix, [0, 1, 0]), [-1, 0, 0]);
    close(M.apply(D.read(frames, 0, settings).matrix, [1, 0, 0]), [0, 1, 0]);
    assert.equal(frames.version, version);
    settings.overlay.bindings.euler[1] = null;
    assert.match(D.read(frames, 1, settings).reason, /pitch.*未绑定/);
    settings.overlay.bindings.euler[1] = 0;
    frames.append([NaN, 0, 0], Uint8Array.of(5), '', 3, 1002, { byteOffset: 14 });
    assert.match(D.read(frames, 2, settings).reason, /pitch.*CH01.*无效/);
});

test('quaternion and matrix overlays support independent fixed and channel values', () => {
    const frames = new FrameBuffer(3, 2);
    frames.append([Math.SQRT1_2, NaN, 0], Uint8Array.of(1), '', 1, 1000, { byteOffset: 0 });
    frames.append([-1, NaN, 0], Uint8Array.of(2), '', 2, 1001, { byteOffset: 1 });
    const settings = C.normalize({ bindings: { euler: [2, 2, 2] }, overlay: { enabled: true, representation: 'quaternion',
        sources: { quaternion: ['fixed', 'fixed', 'fixed', 'channels'],
            matrix: ['fixed', 'channels', 'fixed', 'fixed', 'fixed', 'fixed', 'fixed', 'fixed', 'fixed'] },
        fixed: { quaternion: [Math.SQRT1_2, 0, 0, 0], matrix: [0, 0, 0, 1, 0, 0, 0, 0, 1] },
        bindings: { quaternion: [1, 1, 1, 0], matrix: [1, 0, 1, 1, 1, 1, 1, 1, 1] } } });
    const quaternion = D.read(frames, 0, settings);
    assert.equal(quaternion.valid, true);
    close(M.apply(quaternion.matrix, [1, 0, 0]), [0, 1, 0]);
    settings.overlay.representation = 'matrix';
    const matrix = D.read(frames, 1, settings);
    assert.equal(matrix.valid, true);
    close(M.apply(matrix.matrix, [1, 0, 0]), [0, 1, 0]);
});
test('missing bindings, nonfinite components and overwritten indices report invalid target metadata', () => {
    const { frames, settings } = fixture(); settings.bindings.euler[0] = null;
    assert.match(D.read(frames, 1, settings).reason, /yaw/);
    settings.bindings.euler = [0, 1, 2];
    frames.append([NaN, 0, 0], Uint8Array.of(5), '', 3, 1002, { byteOffset: 14 });
    assert.match(D.read(frames, 2, settings).reason, /CH01/);
    assert.equal(D.read(frames, 3, settings).valid, false);
    frames.append([0, 0, 0], Uint8Array.of(6), '', 4, 1003, { byteOffset: 15 });
    assert.equal(D.read(frames, 0, settings).order, 2);
    frames.clear(); assert.equal(D.read(frames, 0, settings).valid, false);
});
test('computed scalars are bindable while constant arrays and systems are not', () => {
    const raw = new FrameBuffer(3, 10), frames = new ComputedFrames(raw, [
        { number: 4, type: 'formula', expression: 'CH01+CH02' },
        { number: 5, type: 'constant', expression: '[0]=1' }]);
    const settings = C.defaults(); settings.bindings.euler = [3, 1, 2];
    frames.append([0, Math.PI / 2, 0], Uint8Array.of(1), '', 1, 1000, { byteOffset: 0 });
    assert.equal(D.read(frames, 0, settings).valid, true);
    settings.bindings.euler[0] = 4;
    assert.equal(D.read(frames, 0, settings).valid, false);
    settings.bindings.euler[0] = 3; settings.overlay.enabled = true; settings.overlay.source = 'channels';
    assert.equal(D.read(frames, 0, settings).valid, false);
    frames.dispose();
});
