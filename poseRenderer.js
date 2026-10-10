/** Cube and coordinate axes rendered with an orthographic camera. */
(function (root) {
    const M = typeof module !== 'undefined' ? require('./poseMath').PoseMath : root.SerialPlotter.PoseMath;
    const dot = (a, b) => a.reduce((sum, v, i) => sum + v * b[i], 0);
    const scale = (v, factor) => v.map(x => x * factor);
    function buildScene(settings, pose) {
        const matrix = pose?.valid && pose.matrix?.length === 9 && pose.matrix.every(Number.isFinite) ? pose.matrix : null;
        const faces = [], axes = [];
        if (matrix && settings.cubeVisible) {
            const definitions = [['前', '#ff0000', 0, 1], ['后', '#ff8c00', 0, -1], ['左', '#ffffff', 1, 1],
                ['右', '#ffff00', 1, -1], ['上', '#0000ff', 2, 1], ['下', '#00ff00', 2, -1]];
            for (const [name, color, axis, sign] of definitions) {
                const normal = [0, 0, 0]; normal[axis] = sign;
                const other = [0, 1, 2].filter(i => i !== axis);
                const vertices = [[-1, -1], [1, -1], [1, 1], [-1, 1]].map(pair => {
                    const v = [0, 0, 0]; v[axis] = sign * 0.5;
                    other.forEach((i, k) => { v[i] = pair[k] * 0.5; }); return M.apply(matrix, v);
                });
                faces.push({ name, color, normal: M.apply(matrix, normal), vertices });
            }
        }
        for (const frame of ['odom', 'body']) {
            if (!settings.axes[frame].visible || frame === 'body' && !matrix) continue;
            let basis = M.displayBasis(settings.axes[frame]);
            if (frame === 'body') basis = M.multiply(matrix, basis);
            for (let i = 0; i < 3; i++) {
                const direction = [basis[i], basis[i + 3], basis[i + 6]];
                axes.push({ frame, label: 'XYZ'[i], color: frame === 'odom' ? ['#800000', '#008000', '#000080'][i] : ['#ff0000', '#00ff00', '#0000ff'][i],
                    end: scale(direction, frame === 'odom' ? 1.6 : 1.2) });
            }
        }
        return { faces, axes, matrix: settings.cubeVisible ? matrix : null };
    }
    function occluded(point, direction, inverse) {
        if (!inverse) return false;
        const p = M.apply(inverse, point), d = M.apply(inverse, direction);
        let enter = -Infinity, exit = Infinity;
        for (let i = 0; i < 3; i++) {
            if (Math.abs(d[i]) < 1e-12) { if (Math.abs(p[i]) > 0.5) return false; continue; }
            const a = (-0.5 - p[i]) / d[i], b = (0.5 - p[i]) / d[i];
            enter = Math.max(enter, Math.min(a, b)); exit = Math.min(exit, Math.max(a, b));
        }
        return exit > Math.max(enter, 1e-6);
    }
    function projectScene(scene, camera, width, height) {
        const { azimuth: a, elevation: e } = camera;
        const direction = [Math.cos(e) * Math.cos(a), Math.cos(e) * Math.sin(a), Math.sin(e)];
        const right = [-Math.sin(a), Math.cos(a), 0], up = [-Math.sin(e) * Math.cos(a), -Math.sin(e) * Math.sin(a), Math.cos(e)];
        const factor = Math.max(1, Math.min(width, height)) * 0.24 * camera.scale;
        const point = v => [width / 2 + dot(v, right) * factor, height / 2 - dot(v, up) * factor];
        const faces = scene.faces.filter(face => dot(face.normal, direction) > 1e-10)
            .map(face => ({ ...face, points: face.vertices.map(point), depth: face.vertices.reduce((sum, v) => sum + dot(v, direction), 0) / 4 }))
            .sort((a, b) => a.depth - b.depth);
        const inverse = scene.matrix ? M.transpose(scene.matrix) : null;
        const axes = scene.axes.map(axis => {
            const segments = [];
            for (let i = 0; i < 40; i++) segments.push({ points: [point(scale(axis.end, i / 40)), point(scale(axis.end, (i + 1) / 40))],
                hidden: occluded(scale(axis.end, (i + 0.5) / 40), direction, inverse) });
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
            ctx.fillStyle = face.color; ctx.fill(); ctx.strokeStyle = '#59616c'; ctx.lineWidth = 1; ctx.stroke();
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
            const label = `${axis.frame} ${axis.label}`;
            ctx.strokeStyle = '#e0e0e0'; ctx.lineWidth = 3; ctx.strokeText(label, ...axis.labelPoint);
            ctx.fillStyle = axis.color; ctx.fillText(label, ...axis.labelPoint);
        }
        return projected;
    }
    const PoseRenderer = { buildScene, projectScene, draw };
    root.SerialPlotter ??= {}; root.SerialPlotter.PoseRenderer = PoseRenderer;
    if (typeof module !== 'undefined') module.exports = { PoseRenderer };
})(globalThis);
