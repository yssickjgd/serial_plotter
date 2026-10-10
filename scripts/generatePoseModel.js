/** Refresh the classic-script aircraft asset after editing model_plane.STL. Not needed to run the page. */
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const root = path.resolve(__dirname, '..');
const source = fs.readFileSync(path.join(root, 'model_plane.STL'));
const count = source.length >= 84 ? source.readUInt32LE(80) : 0;
if (!count || source.length !== 84 + count * 50) throw new Error('model_plane.STL must contain complete binary STL triangles');
const vertices = [], triangles = [], indices = new Map();
const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
for (let face = 0; face < count; face++) {
    const triangle = [];
    for (let vertex = 0; vertex < 3; vertex++) {
        const point = [0, 1, 2].map(axis => source.readFloatLE(84 + face * 50 + 12 + vertex * 12 + axis * 4));
        if (!point.every(Number.isFinite)) throw new Error('model_plane.STL contains nonfinite vertices');
        point.forEach((value, axis) => { min[axis] = Math.min(min[axis], value); max[axis] = Math.max(max[axis], value); });
        const key = point.join(',');
        if (!indices.has(key)) { indices.set(key, vertices.length); vertices.push(point); }
        triangle.push(indices.get(key));
    }
    triangles.push(triangle);
}
const center = min.map((value, axis) => (value + max[axis]) / 2);
const size = Math.max(...max.map((value, axis) => value - min[axis]));
if (!(size > 0)) throw new Error('model_plane.STL has zero size');
// This aircraft's nose is +Z, left wing +X, and up +Y. Rotate to body forward X / left Y / up Z.
const points = vertices.map(point => [2, 0, 1].map(axis => Number(((point[axis] - center[axis]) * 2 / size).toFixed(6))));
const rows = values => values.map(value => `        [${value.join(', ')}]`).join(',\n');
const output = `/** Generated from model_plane.STL by scripts/generatePoseModel.js; do not edit the mesh here. */
(function (root) {
    const PoseModelData = {
        source: 'model_plane.STL',
        sourceSha256: '${crypto.createHash('sha256').update(source).digest('hex')}',
        vertices: [
${rows(points)}
        ],
        triangles: [
${rows(triangles)}
        ]
    };
    root.SerialPlotter ??= {}; root.SerialPlotter.PoseModelData = PoseModelData;
    if (typeof module !== 'undefined') module.exports = { PoseModelData };
})(globalThis);
`;
fs.writeFileSync(path.join(root, 'poseModelData.js'), output);
process.stdout.write(`Aircraft asset: ${points.length} vertices, ${triangles.length} triangles\n`);
