const test = require('node:test');
const assert = require('node:assert/strict');
const { PoseMath: M } = require('../poseMath');
const I = [1, 0, 0, 0, 1, 0, 0, 0, 1];
const close = (a, b, epsilon = 1e-9) => {
    assert.equal(a.length, b.length);
    a.forEach((v, i) => assert.ok(Math.abs(v - b[i]) < epsilon, `${i}: ${v} != ${b[i]}`));
};
const euler = (v, order = 'YPR', rotation = 'intrinsic', unit = 'radians') => M.fromEuler(v, { order, rotation, unit });

test('Euler identity and signed axis rotations use right handed active column vectors', () => {
    close(euler([0, 0, 0]).matrix, I);
    for (const sign of [-1, 1]) {
        close(M.apply(euler([sign * Math.PI / 2, 0, 0]).matrix, [1, 0, 0]), [0, sign, 0]);
        close(M.apply(euler([0, sign * Math.PI / 2, 0]).matrix, [1, 0, 0]), [0, 0, -sign]);
        close(M.apply(euler([0, 0, sign * Math.PI / 2]).matrix, [0, 1, 0]), [0, 0, sign]);
    }
    close(euler([90, 0, 0], 'YPR', 'intrinsic', 'degrees').matrix, euler([Math.PI / 2, 0, 0]).matrix);
});
test('all six intrinsic orders equal reverse extrinsic orders with unchanged named angles', () => {
    for (const order of ['YPR', 'YRP', 'PYR', 'PRY', 'RYP', 'RPY']) {
        const a = euler([0.7, -0.4, 0.2], order).matrix;
        close(a, euler([0.7, -0.4, 0.2], [...order].reverse().join(''), 'extrinsic').matrix);
        close(M.multiply(a, M.transpose(a)), I);
    }
    assert.notDeepEqual(euler([0.7, -0.4, 0.2]).matrix, euler([0.7, -0.4, 0.2], 'RPY').matrix);
    assert.equal(euler([NaN, 0, 0]).valid, false);
});
test('Hamilton quaternions preserve sign equivalence and both component orders', () => {
    const q = [Math.SQRT1_2, 0, 0, Math.SQRT1_2];
    const decode = (v, order = 'wxyz', normalize = true) => M.fromQuaternion(v, { order, normalize });
    close(decode(q).matrix, euler([Math.PI / 2, 0, 0]).matrix);
    close(decode(q.map(v => -v)).matrix, decode(q).matrix);
    close(decode([0, 0, q[3], q[0]], 'xyzw').matrix, decode(q).matrix);
    for (const scale of [1e300, 1e-300]) close(decode(q.map(v => v * scale)).matrix, decode(q).matrix);
    for (const values of [[0, 0, 0, 0], [NaN, 0, 0, 1], [Infinity, 0, 0, 1]]) assert.equal(decode(values).valid, false);
    assert.equal(decode([2, 0, 0, 0], 'wxyz', false).valid, false);
    assert.equal(decode(q, 'wxyz', false).valid, true);
});
test('matrix orthogonalization removes scale and shear while rejecting singular and reflected inputs', () => {
    const decode = (v, orthonormalize = true) => M.fromMatrix(v, { orthonormalize });
    const r = euler([0.7, -0.4, 0.2]).matrix;
    for (const scale of [2, 1e300, 1e-300]) close(decode(r.map(v => v * scale)).matrix, r);
    const shear = decode([1, 1, 0, 0, 1, 0, 0, 0, 1]).matrix;
    close(shear, euler([-Math.atan(0.5), 0, 0]).matrix);
    close(M.multiply(shear, M.transpose(shear)), I);
    for (const v of [Array(9).fill(0), [1, 0, 0, 1, 0, 0, 0, 0, 1], [-1, 0, 0, 0, 1, 0, 0, 0, 1],
        [NaN, 0, 0, 0, 1, 0, 0, 0, 1]]) assert.equal(decode(v).valid, false);
    assert.equal(decode(r, false).valid, true);
    assert.equal(decode(r.map(v => v * 2), false).valid, false);
});
test('overlay multiplication order differs and inverse orientation transposes', () => {
    const r = euler([Math.PI / 2, 0, 0]).matrix, a = euler([0, Math.PI / 2, 0]).matrix;
    close(M.apply(M.compose(r, a, 'overlay-first'), [1, 0, 0]), [0, 0, -1]);
    close(M.apply(M.compose(r, a, 'input-first'), [1, 0, 0]), [0, 1, 0]);
    close(M.apply(M.transpose(r), [1, 0, 0]), [0, -1, 0]);
});
test('display bases keep axis orientation and handedness separate from rotation validity', () => {
    close(M.displayBasis({ x: 'forward', y: 'left', hand: 'right' }), I);
    const left = M.displayBasis({ x: 'forward', y: 'left', hand: 'left' });
    close(left, [1, 0, 0, 0, 1, 0, 0, 0, -1]);
    assert.equal(M.fromMatrix(left, { orthonormalize: true }).valid, false);
    assert.throws(() => M.displayBasis({ x: 'forward', y: 'backward', hand: 'right' }), /共线/);
});
