/** Independent pose settings; bindings refer to shared scalar channel indices. */
(function (root) {
    const M = typeof module !== 'undefined' ? require('./poseMath').PoseMath : root.SerialPlotter.PoseMath;
    const defaults = () => ({
        representation: 'euler', inputDirection: 'body-to-odom',
        euler: { order: 'YPR', rotation: 'intrinsic', unit: 'radians' },
        quaternion: { order: 'wxyz', normalize: true }, matrix: { orthonormalize: true },
        bindings: { euler: Array(3).fill(null), quaternion: Array(4).fill(null), matrix: Array(9).fill(null) },
        overlay: { enabled: false, representation: 'euler', source: 'fixed', order: 'input-first',
            euler: { order: 'YPR', rotation: 'intrinsic', unit: 'radians' },
            quaternion: { order: 'wxyz', normalize: true }, matrix: { orthonormalize: true },
            fixed: { euler: [0, 0, 0], quaternion: [1, 0, 0, 0], matrix: M.identity() },
            bindings: { euler: Array(3).fill(null), quaternion: Array(4).fill(null), matrix: Array(9).fill(null) } },
        axes: { odom: { x: 'forward', y: 'left', hand: 'right', visible: true },
            body: { x: 'forward', y: 'left', hand: 'right', visible: true } },
        cubeVisible: true, camera: { azimuth: Math.PI / 4, elevation: Math.PI / 6, scale: 1 }
    });
    function merge(template, input, path = '位姿') {
        if (Array.isArray(template)) {
            const value = input === undefined ? template : input;
            if (!Array.isArray(value) || value.length !== template.length) throw new Error(`${path} 分量数量无效`);
            return [...value];
        }
        if (template && typeof template === 'object') {
            if (input !== undefined && (!input || typeof input !== 'object' || Array.isArray(input))) throw new Error(`${path} 配置无效`);
            return Object.fromEntries(Object.entries(template).map(([key, value]) => [key, merge(value, input?.[key], `${path}.${key}`)]));
        }
        return input === undefined ? template : input;
    }
    function normalize(input = {}, { channelCount = Infinity, isSignal = () => true } = {}) {
        const s = merge(defaults(), input);
        const choice = (value, values, name) => { if (!values.includes(value)) throw new Error(`${name} 选项无效`); };
        const bool = (value, name) => { if (typeof value !== 'boolean') throw new Error(`${name} 启用值无效`); };
        const representation = t => {
            choice(t.representation, ['euler', 'quaternion', 'matrix'], '姿态表示');
            choice(t.euler.order, ['YPR', 'YRP', 'PYR', 'PRY', 'RYP', 'RPY'], 'Euler 顺序');
            choice(t.euler.rotation, ['intrinsic', 'extrinsic'], '旋转轴');
            choice(t.euler.unit, ['radians', 'degrees'], '角度单位');
            choice(t.quaternion.order, ['wxyz', 'xyzw'], '四元数顺序');
            bool(t.quaternion.normalize, '四元数归一化'); bool(t.matrix.orthonormalize, '矩阵正交化');
            for (const values of Object.values(t.bindings)) for (const index of values)
                if (index !== null && (!Number.isInteger(index) || index < 0 || index >= channelCount || !isSignal(index)))
                    throw new Error('位姿来源通道必须是范围内的标量通道');
        };
        representation(s); representation(s.overlay);
        choice(s.inputDirection, ['body-to-odom', 'odom-to-body'], '输入方向');
        bool(s.overlay.enabled, '叠加旋转');
        choice(s.overlay.source, ['fixed', 'channels'], '叠加来源');
        choice(s.overlay.order, ['input-first', 'overlay-first'], '叠加顺序');
        for (const values of Object.values(s.overlay.fixed)) if (!values.every(Number.isFinite)) throw new Error('固定旋转参数必须是有限数');
        for (const axis of Object.values(s.axes)) { M.displayBasis(axis); bool(axis.visible, '坐标轴显示'); }
        bool(s.cubeVisible, '机体显示');
        if (!Object.values(s.camera).every(Number.isFinite) || Math.abs(s.camera.elevation) > 89 * Math.PI / 180 ||
            s.camera.scale < 0.25 || s.camera.scale > 4) throw new Error('观察视角或倍率超出范围');
        return s;
    }
    function remapBindings(input, numberMap) {
        const s = normalize(input);
        for (const group of [s.bindings, s.overlay.bindings]) for (const key of Object.keys(group))
            group[key] = group[key].map(index => index === null ? null : Number.isInteger(numberMap.get(index + 1)) ? numberMap.get(index + 1) - 1 : null);
        return s;
    }
    const boundChannels = s => [...new Set([...s.bindings[s.representation],
        ...(s.overlay.enabled && s.overlay.source === 'channels' ? s.overlay.bindings[s.overlay.representation] : [])].filter(index => index !== null))];
    const PoseConfig = { defaults, normalize, remapBindings, boundChannels };
    root.SerialPlotter ??= {}; root.SerialPlotter.PoseConfig = PoseConfig;
    if (typeof module !== 'undefined') module.exports = { PoseConfig };
})(globalThis);
