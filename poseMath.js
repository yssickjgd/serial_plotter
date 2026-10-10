/** Right handed active rotations, column vectors, row-major 3 × 3 matrices. */
(function (root) {
    const identity = () => [1, 0, 0, 0, 1, 0, 0, 0, 1];
    const finite = (values, size) => Array.isArray(values) && values.length === size && values.every(Number.isFinite);
    const invalid = reason => ({ valid: false, reason });
    function multiply(a, b) {
        const result = Array(9).fill(0);
        for (let row = 0; row < 3; row++) for (let col = 0; col < 3; col++)
            for (let k = 0; k < 3; k++) result[row * 3 + col] += a[row * 3 + k] * b[k * 3 + col];
        return result;
    }
    const transpose = a => [a[0], a[3], a[6], a[1], a[4], a[7], a[2], a[5], a[8]];
    const apply = (a, v) => [0, 1, 2].map(row => a[row * 3] * v[0] + a[row * 3 + 1] * v[1] + a[row * 3 + 2] * v[2]);
    const determinant = a => a[0] * (a[4] * a[8] - a[5] * a[7]) - a[1] * (a[3] * a[8] - a[5] * a[6]) + a[2] * (a[3] * a[7] - a[4] * a[6]);
    const residual = a => Math.max(...multiply(transpose(a), a).map((v, i) => Math.abs(v - identity()[i])), Math.abs(determinant(a) - 1));
    function fromEuler(values, { order = 'YPR', rotation = 'intrinsic', unit = 'radians' } = {}) {
        if (!finite(values, 3) || !['YPR', 'YRP', 'PYR', 'PRY', 'RYP', 'RPY'].includes(order) ||
            !['intrinsic', 'extrinsic'].includes(rotation) || !['radians', 'degrees'].includes(unit)) return invalid('Euler 角或旋转约定无效');
        const [y, p, r] = values.map(v => unit === 'degrees' ? v / 180 * Math.PI : v);
        const cy = Math.cos(y), sy = Math.sin(y), cp = Math.cos(p), sp = Math.sin(p), cr = Math.cos(r), sr = Math.sin(r);
        const atoms = { Y: [cy, -sy, 0, sy, cy, 0, 0, 0, 1], P: [cp, 0, sp, 0, 1, 0, -sp, 0, cp], R: [1, 0, 0, 0, cr, -sr, 0, sr, cr] };
        let matrix = identity();
        for (const key of order) matrix = rotation === 'intrinsic' ? multiply(matrix, atoms[key]) : multiply(atoms[key], matrix);
        return { valid: true, matrix };
    }
    function fromQuaternion(values, { order = 'wxyz', normalize = true } = {}) {
        if (!finite(values, 4) || !['wxyz', 'xyzw'].includes(order)) return invalid('四元数分量无效');
        const max = Math.max(...values.map(Math.abs));
        if (max === 0) return invalid('四元数不能全为零');
        const scaled = values.map(v => v / max), norm = Math.hypot(...scaled);
        if (!normalize && Math.abs(max * norm - 1) > 1e-6) return invalid('四元数未归一化');
        const q = normalize ? scaled.map(v => v / norm) : values;
        const [w, x, y, z] = order === 'wxyz' ? q : [q[3], q[0], q[1], q[2]];
        return { valid: true, matrix: [1 - 2 * (y * y + z * z), 2 * (x * y - z * w), 2 * (x * z + y * w),
            2 * (x * y + z * w), 1 - 2 * (x * x + z * z), 2 * (y * z - x * w),
            2 * (x * z - y * w), 2 * (y * z + x * w), 1 - 2 * (x * x + y * y)] };
    }
    function inverseTranspose(a) {
        const det = determinant(a);
        return [a[4] * a[8] - a[5] * a[7], a[5] * a[6] - a[3] * a[8], a[3] * a[7] - a[4] * a[6],
            a[2] * a[7] - a[1] * a[8], a[0] * a[8] - a[2] * a[6], a[1] * a[6] - a[0] * a[7],
            a[1] * a[5] - a[2] * a[4], a[2] * a[3] - a[0] * a[5], a[0] * a[4] - a[1] * a[3]].map(v => v / det);
    }
    function fromMatrix(values, { orthonormalize = true } = {}) {
        if (!finite(values, 9)) return invalid('旋转矩阵分量无效');
        const max = Math.max(...values.map(Math.abs));
        if (!max) return invalid('旋转矩阵不能全为零');
        let matrix = values.map(v => v / max);
        if (determinant(matrix) <= 1e-12) return invalid('旋转矩阵退化或包含反射');
        if (!orthonormalize) return residual(values) <= 1e-6 ? { valid: true, matrix: [...values] } : invalid('旋转矩阵未单位正交化');
        for (let i = 0; i < 32; i++) {
            const inverse = inverseTranspose(matrix);
            matrix = matrix.map((v, k) => (v + inverse[k]) / 2);
            if (!finite(matrix, 9)) return invalid('旋转矩阵正交化失败');
            if (residual(matrix) <= 1e-8) return { valid: true, matrix };
        }
        return invalid('旋转矩阵正交化未收敛');
    }
    const DIRECTIONS = { forward: [1, 0, 0], backward: [-1, 0, 0], left: [0, 1, 0], right: [0, -1, 0], up: [0, 0, 1], down: [0, 0, -1] };
    function displayBasis({ x, y, hand }) {
        const a = DIRECTIONS[x], b = DIRECTIONS[y];
        if (!a || !b || !['left', 'right'].includes(hand)) throw new Error('坐标轴朝向或手系无效');
        const cross = [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
        if (!cross.some(v => v !== 0)) throw new Error('X 与 Y 轴不可共线');
        const c = cross.map(v => hand === 'left' ? -v : v);
        return [a[0], b[0], c[0], a[1], b[1], c[1], a[2], b[2], c[2]];
    }
    function cameraAngles(vector) {
        if (!finite(vector, 3)) throw new Error('观察方位向量必须包含三个有限数值');
        const magnitude = Math.max(...vector.map(Math.abs));
        if (magnitude === 0) throw new Error('观察方位向量不能全为零');
        const [x, y, z] = vector.map(value => value / magnitude);
        return { azimuth: Math.atan2(y, x), elevation: Math.atan2(z, Math.hypot(x, y)) };
    }
    function cameraDirection(azimuth, elevation) {
        return [Math.cos(elevation) * Math.cos(azimuth), Math.cos(elevation) * Math.sin(azimuth), Math.sin(elevation)];
    }
    const PoseMath = { identity, multiply, transpose, apply, fromEuler, fromQuaternion, fromMatrix, displayBasis, cameraAngles, cameraDirection,
        compose: (input, overlay, order) => order === 'overlay-first' ? multiply(input, overlay) : multiply(overlay, input) };
    root.SerialPlotter ??= {}; root.SerialPlotter.PoseMath = PoseMath;
    if (typeof module !== 'undefined') module.exports = { PoseMath };
})(globalThis);
