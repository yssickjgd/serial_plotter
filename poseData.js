/** Read a pose atomically from one shared numeric frame, without changing history. */
(function (root) {
    const M = typeof module !== 'undefined' ? require('./poseMath').PoseMath : root.SerialPlotter.PoseMath;
    function componentLabels(settings) {
        if (settings.representation === 'euler') return ['yaw', 'pitch', 'roll'];
        if (settings.representation === 'quaternion') return [...settings.quaternion.order];
        return ['m11', 'm12', 'm13', 'm21', 'm22', 'm23', 'm31', 'm32', 'm33'];
    }
    function convert(values, settings) {
        if (settings.representation === 'euler') return M.fromEuler(values, settings.euler);
        if (settings.representation === 'quaternion') return M.fromQuaternion(values, settings.quaternion);
        return M.fromMatrix(values, settings.matrix);
    }
    function readComponents(frames, index, settings, prefix) {
        const values = [], labels = componentLabels(settings);
        for (const [i, channel] of settings.bindings[settings.representation].entries()) {
            if (channel === null) return { valid: false, reason: `${prefix}${labels[i]} 未绑定通道` };
            if (channel < 0 || channel >= frames.channelCount || frames.isSignal && !frames.isSignal(channel))
                return { valid: false, reason: `${prefix}${labels[i]} 来源不是有效标量通道` };
            const value = frames.getValue(channel, index);
            if (!Number.isFinite(value)) return { valid: false, reason: `${prefix}${labels[i]} CH${String(channel + 1).padStart(2, '0')} 数值无效` };
            values.push(value);
        }
        return convert(values, settings);
    }
    function read(frames, index, settings) {
        if (!frames || !Number.isInteger(index) || index < 0 || index >= frames.length) return { valid: false, reason: '无保留数据', index: -1 };
        const startByte = frames.rawByteOffsetAt(index), metadata = { index, order: frames.orderAt(index),
            timestamp: frames.timestampAt(index), startByte,
            endByte: frames.rawEndByteAt?.(index) ?? startByte + frames.rawBytesAt(index).length };
        const input = readComponents(frames, index, settings, '输入 ');
        if (!input.valid) return { ...metadata, ...input };
        let matrix = settings.inputDirection === 'odom-to-body' ? M.transpose(input.matrix) : input.matrix;
        if (settings.overlay.enabled) {
            const overlay = settings.overlay.source === 'fixed' ? convert(settings.overlay.fixed[settings.overlay.representation], settings.overlay)
                : readComponents(frames, index, settings.overlay, '叠加 ');
            if (!overlay.valid) return { ...metadata, valid: false, reason: `叠加旋转：${overlay.reason}` };
            matrix = M.compose(matrix, overlay.matrix, settings.overlay.order);
        }
        return { ...metadata, valid: true, matrix };
    }
    const PoseData = { read, componentLabels, convert };
    root.SerialPlotter ??= {}; root.SerialPlotter.PoseData = PoseData;
    if (typeof module !== 'undefined') module.exports = { PoseData };
})(globalThis);
