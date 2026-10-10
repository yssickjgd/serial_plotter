/** Aircraft mesh and coordinate axes rendered with an orthographic camera. */
(function (root) {
    const M = typeof module !== 'undefined' ? require('./poseMath').PoseMath : root.SerialPlotter.PoseMath;
    const model = typeof module !== 'undefined' ? require('./poseModelData').PoseModelData : root.SerialPlotter.PoseModelData;
    const dot = (a, b) => a.reduce((sum, v, i) => sum + v * b[i], 0);
    const scale = (v, factor) => v.map(x => x * factor);
    // Prepare mesh normals once, shared by all pose widgets; transform only when a view draws.
    const normals = model.triangles.map(indices => {
        const [a, b, c] = indices.map(index => model.vertices[index]);
        const u = b.map((value, i) => value - a[i]), v = c.map((value, i) => value - a[i]);
        const n = [u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]];
        return scale(n, 1 / (Math.hypot(...n) || 1));
    });
    function buildScene(settings, pose) {
        const matrix = pose?.valid && pose.matrix?.length === 9 && pose.matrix.every(Number.isFinite) ? pose.matrix : null;
        const faces = [], axes = [];
        if (matrix && settings.cubeVisible) {
            const vertices = model.vertices.map(vertex => M.apply(matrix, vertex));
            model.triangles.forEach((indices, i) => faces.push({ normal: M.apply(matrix, normals[i]),
                vertices: indices.map(index => vertices[index]) }));
        }
        for (const frame of ['odom', 'body']) {
            if (!settings.axes[frame].visible || frame === 'body' && !matrix) continue;
            let basis = M.displayBasis(settings.axes[frame]);
            if (frame === 'body') basis = M.multiply(matrix, basis);
            for (let i = 0; i < 3; i++) {
                const direction = [basis[i], basis[i + 3], basis[i + 6]];
                axes.push({ frame, label: 'XYZ'[i], showLabel: settings.axes[frame].showLabels === true,
                    color: frame === 'odom' ? ['#800000', '#008000', '#00ffff'][i] : ['#ff0000', '#00ff00', '#00ffff'][i],
                    end: scale(direction, frame === 'odom' ? 2.4 : 2) });
            }
        }
        return { faces, axes };
    }
    function occluded(point, depth, faces) {
        const [x, y] = point;
        for (const face of faces) {
            const { bounds, points: [a, b, c], denominator, depths } = face;
            if (x < bounds[0] || x > bounds[1] || y < bounds[2] || y > bounds[3] || Math.abs(denominator) < 1e-10) continue;
            const u = ((b[1] - c[1]) * (x - c[0]) + (c[0] - b[0]) * (y - c[1])) / denominator;
            const v = ((c[1] - a[1]) * (x - c[0]) + (a[0] - c[0]) * (y - c[1])) / denominator;
            if (u >= 0 && v >= 0 && u + v <= 1 && u * depths[0] + v * depths[1] + (1 - u - v) * depths[2] > depth + 1e-6) return true;
        }
        return false;
    }
    function projectScene(scene, camera, width, height) {
        const { azimuth: a, elevation: e } = M.cameraAngles(camera.direction);
        const direction = M.cameraDirection(a, e);
        const right = [-Math.sin(a), Math.cos(a), 0], up = [-Math.sin(e) * Math.cos(a), -Math.sin(e) * Math.sin(a), Math.cos(e)];
        const factor = Math.max(1, Math.min(width, height)) * 0.18 * camera.scale;
        const point = v => [width / 2 + dot(v, right) * factor, height / 2 - dot(v, up) * factor];
        const faces = scene.faces.filter(face => dot(face.normal, direction) > 1e-10)
            .map(face => {
                const points = face.vertices.map(point), depths = face.vertices.map(vertex => dot(vertex, direction));
                const [a, b, c] = points, intensity = 0.5 + 0.5 * dot(face.normal, direction);
                return { ...face, points, depths, depth: depths.reduce((sum, value) => sum + value, 0) / 3,
                    color: face.color ?? `rgb(${[195, 209, 223].map(value => Math.round(value * intensity)).join(',')})`,
                    bounds: [Math.min(...points.map(p => p[0])), Math.max(...points.map(p => p[0])),
                        Math.min(...points.map(p => p[1])), Math.max(...points.map(p => p[1]))],
                    denominator: (b[1] - c[1]) * (a[0] - c[0]) + (c[0] - b[0]) * (a[1] - c[1]) };
            })
            .sort((a, b) => a.depth - b.depth);
        const axes = scene.axes.map(axis => {
            const segments = [];
            for (let i = 0; i < 40; i++) {
                const middle = scale(axis.end, (i + 0.5) / 40);
                segments.push({ points: [point(scale(axis.end, i / 40)), point(scale(axis.end, (i + 1) / 40))],
                    hidden: occluded(point(middle), dot(middle, direction), faces) });
            }
            return { ...axis, points: [point([0, 0, 0]), point(axis.end)], segments,
                labelPoint: point(scale(axis.end, 1.1)), depth: dot(axis.end, direction) };
        }).sort((a, b) => a.depth - b.depth);
        return { faces, axes };
    }
    function draw(ctx, scene, camera, width, height) {
        ctx.clearRect(0, 0, width, height); ctx.fillStyle = '#101010'; ctx.fillRect(0, 0, width, height);
        const projected = projectScene(scene, camera, width, height);
        for (const face of projected.faces) {
            ctx.beginPath(); face.points.forEach((p, i) => i ? ctx.lineTo(...p) : ctx.moveTo(...p)); ctx.closePath();
            ctx.fillStyle = face.color; ctx.fill();
        }
        ctx.font = '12px Consolas, monospace'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
        for (const axis of projected.axes) {
            ctx.strokeStyle = axis.color; ctx.lineWidth = axis.frame === 'body' ? 2.5 : 2;
            let hidden = null;
            for (const segment of axis.segments) {
                if (segment.hidden !== hidden) {
                    if (hidden !== null) ctx.stroke();
                    hidden = segment.hidden;
                    ctx.setLineDash(hidden ? [3, 3] : []);
                    ctx.beginPath(); ctx.moveTo(...segment.points[0]);
                }
                ctx.lineTo(...segment.points[1]);
            }
            if (hidden !== null) ctx.stroke();
            ctx.setLineDash([]);
            if (axis.showLabel) {
                const label = `${axis.frame} ${axis.label}`;
                ctx.strokeStyle = '#e0e0e0'; ctx.lineWidth = 3; ctx.strokeText(label, ...axis.labelPoint);
                ctx.fillStyle = axis.color; ctx.fillText(label, ...axis.labelPoint);
            }
        }
        return projected;
    }
    const PoseRenderer = { buildScene, projectScene, draw };
    root.SerialPlotter ??= {}; root.SerialPlotter.PoseRenderer = PoseRenderer;
    if (typeof module !== 'undefined') module.exports = { PoseRenderer };
})(globalThis);
