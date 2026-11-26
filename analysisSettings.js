/** Settings shared by the analysis inspectors, workspace files and plot views. */
(function (root) {
    const S = root.SerialPlotter ??= {};
    const limits = typeof module !== 'undefined' ? require('./projectLimits').PROJECT_LIMITS : S.Limits;
    const fftWindows = typeof module !== 'undefined' ? require('./spectrum').FFT_WINDOWS : S.FFT_WINDOWS;
    const { normalizeAxisNumberSettings } = typeof module !== 'undefined' ? require('./plotMath') : S;
    const maxBins = limits.maxPlotWindowPoints;
    const colors = limits.defaultChannelColors;
    const maxFftOverlap = 75;
    function spectrumSegmentSize(windowPoints, overlap) {
        let size = 8;
        for (let next = 2 * size; next <= windowPoints; next *= 2) {
            const hop = next - Math.floor(next * overlap / 100);
            if (next + hop > windowPoints) break;
            size = next;
        }
        return size;
    }
    function spectrumYRangeKey(settings) {
        return settings.viewMode === 'gain' && settings.gainUnit.startsWith('db') ? 'gainDbY' : settings.viewMode + 'Y';
    }

    function requireValue(ok, message) {
        if (!ok) throw new Error(message);
    }
    function object(value) {
        requireValue(value !== null && typeof value === 'object' && !Array.isArray(value), '分析设置必须为对象');
    }
    function choice(value, choices, label) {
        requireValue(choices.includes(value), label + '无效');
        return value;
    }
    function flag(value) {
        requireValue(typeof value === 'boolean', '开关值必须为布尔值');
        return value;
    }
    function channel(value) {
        requireValue(value === null || Number.isInteger(value) && value >= 0 && value < limits.maxTotalChannels, '通道编号超出范围');
        return value;
    }
    function range(min, max, label) {
        requireValue(Number.isFinite(min) && Number.isFinite(max) && min < max, label + '需要两个递增的有限数值');
    }
    function equalEdges(min, max, count) {
        range(min, max, '等宽区间');
        requireValue(Number.isInteger(count) && count >= 1 && count <= maxBins, '区间数必须是 1 至 ' + maxBins + ' 的整数');
        const span = max - min, result = [min];
        const exactStep = Number.isSafeInteger(min) && Number.isSafeInteger(max) && Number.isSafeInteger(span) && span % count === 0
            ? span / count : 0;
        for (let i = 1; i < count; i++) {
            const t = i / count;
            const edge = exactStep ? min + exactStep * i :
                Number.isFinite(span) ? min + span * t : min * (1 - t) + max * t;
            requireValue(edge > result[i - 1] && edge < max, '相邻区间边界重合，请减少区间数或扩大范围');
            result.push(edge);
        }
        result.push(max);
        return result;
    }
    function legacyClosure(sides, length, edges) {
        if (sides === undefined) return undefined;
        requireValue(Array.isArray(sides) && sides.length === length, '旧区间边界归属配置无效');
        let finiteCount = 0, allLeft = true;
        for (let i = 0; i < length; i++) {
            choice(sides[i], ['left', 'right'], '边界归属');
            if (edges && !Number.isFinite(Number(edges[i]))) continue;
            finiteCount++;
            if (sides[i] !== 'left') allLeft = false;
        }
        return finiteCount && allLeft ? 'rightClosed' : 'leftClosed';
    }
    function normalizeXY({ pairs = [{}], viewMode = 'trajectory', traceMode = 'both', equalAspect = true,
        xAuto = true, yAuto = true, xMin = -1, xMax = 1, yMin = -1, yMax = 1,
        gainUnit = 'ratio', gainYAuto = true, gainYMin = 0, gainYMax = 2,
        gainDbYAuto = true, gainDbYMin = -40, gainDbYMax = 20,
        freqXScale = 'hz-linear', phaseUnit = 'radians', phaseUnwrap = true, phaseYAuto = true,
        phaseYMin = phaseUnit === 'radians' ? -Math.PI : -180, phaseYMax = phaseUnit === 'radians' ? Math.PI : 180,
        coherenceYAuto = false, coherenceYMin = 0, coherenceYMax = 1,
        fftOverlap = 50, fftWindow = 'hann', fftRemoveDc = true, ...settings }) {
        requireValue(Array.isArray(pairs) && pairs.length >= 1 && pairs.length <= limits.maxTotalChannels, 'XY 通道组数量无效');
        const groups = Array.from(pairs, (item, i) => {
            object(item);
            const { x = 0, y = 1, visible = true, color = colors[i % colors.length] } = item;
            requireValue(typeof color === 'string' && /^#[0-9a-f]{6}$/i.test(color), '轨迹颜色需要六位十六进制色值');
            return { x: channel(x), y: channel(y), color, visible: flag(visible) };
        });
        range(xMin, xMax, 'X 轴范围'); range(yMin, yMax, 'Y 轴范围');
        range(gainYMin, gainYMax, '幅度比纵轴范围');
        requireValue(gainUnit !== 'ratio-log' || gainYAuto || gainYMin >= 0, '对数纵轴的自定义最小值不能小于 0');
        range(gainDbYMin, gainDbYMax, '分贝增益纵轴范围');
        range(phaseYMin, phaseYMax, '相位差纵轴范围');
        range(coherenceYMin, coherenceYMax, '相干度纵轴范围');
        requireValue(Number.isInteger(fftOverlap) && fftOverlap >= 0 && fftOverlap <= maxFftOverlap,
            '分段重叠率必须是 0 至 ' + maxFftOverlap + ' 的整数');
        return { pairs: groups, viewMode: choice(viewMode, ['trajectory', 'gain', 'phase', 'coherence'], '视图模式'),
            traceMode: choice(traceMode, ['line', 'points', 'both'], '轨迹样式'),
            equalAspect: flag(equalAspect), xAuto: flag(xAuto), yAuto: flag(yAuto), xMin, xMax, yMin, yMax,
            ...normalizeAxisNumberSettings(settings),
            gainUnit: choice(gainUnit, ['ratio', 'ratio-log', 'db10', 'db'], '幅度比纵轴刻度'),
            gainYAuto: flag(gainYAuto), gainYMin, gainYMax,
            gainDbYAuto: flag(gainDbYAuto), gainDbYMin, gainDbYMax,
            freqXScale: choice(freqXScale, ['hz-linear', 'hz-log', 'bins-linear', 'bins-log'], '频率坐标'),
            phaseUnit: choice(phaseUnit, ['degrees', 'radians'], '相位单位'), phaseUnwrap: flag(phaseUnwrap),
            phaseYAuto: flag(phaseYAuto), phaseYMin, phaseYMax,
            coherenceYAuto: flag(coherenceYAuto), coherenceYMin, coherenceYMax,
            fftOverlap,
            fftWindow: choice(fftWindow, fftWindows, 'FFT 窗函数'), fftRemoveDc: flag(fftRemoveDc) };
    }
    function normalizeHistogram({ channel: index = 0, color = '#ffffff', mode = 'fixed', scale = 'count', match = 'exact', tieBreak = 'lower', values = [0, 1],
        min = 0, max = 1, count = 10, edges = [0, 1], closure, yRange = 'auto',
        yPercentMin = 0, yPercentMax = 100, yCountMin = null, yCountMax = null,
        equalSides, edgeSides, underflow = false, overflow = false, ...settings }) {
        equalEdges(min, max, count);
        requireValue(typeof color === 'string' && /^#[0-9a-f]{6}$/i.test(color), '柱形颜色需要六位十六进制色值');
        requireValue(Array.isArray(values) && values.length >= 1 && values.length <= maxBins &&
            Array.from(values).every(Number.isFinite) && new Set(values).size === values.length, '固定值应为互不重复的有限数值，最多 ' + maxBins + ' 项');
        requireValue(Array.isArray(edges) && edges.length >= 2 && edges.length <= maxBins + 1, '边界列表需要 2 至 ' + (maxBins + 1) + ' 项');
        const bounds = Array.from(edges, (edge, i) => {
            if (i === 0 && (edge === -Infinity || edge === '-Infinity')) return '-Infinity';
            if (i === edges.length - 1 && (edge === Infinity || edge === 'Infinity')) return 'Infinity';
            requireValue(Number.isFinite(edge), '仅首末边界可以使用相应的负无穷或正无穷');
            return edge;
        });
        requireValue(bounds.every((edge, i) => i === 0 || Number(edge) > Number(bounds[i - 1])), '区间边界必须严格递增');
        const oldEqual = legacyClosure(equalSides, count + 1);
        const oldEdges = legacyClosure(edgeSides, bounds.length, bounds);
        const legacy = mode === 'edges' ? oldEdges ?? oldEqual : oldEqual ?? oldEdges;
        range(yPercentMin, yPercentMax, '百分比 Y 轴范围');
        if (yCountMin !== null || yCountMax !== null) range(yCountMin, yCountMax, '频数 Y 轴范围');
        return { channel: channel(index), color, mode: choice(mode, ['fixed', 'equal', 'edges'], '分组方式'),
            scale: choice(scale, ['count', 'percent'], '纵轴单位'), values: [...values],
            match: choice(match, ['exact', 'nearest'], '匹配方式'), tieBreak: choice(tieBreak, ['lower', 'higher'], '等距时取值'),
            min, max, count, edges: bounds,
            closure: choice(closure === undefined ? legacy ?? 'leftClosed' : closure, ['leftClosed', 'rightClosed'], '区间开闭'),
            yRange: choice(yRange === 'fixed' ? 'manual' : yRange, ['auto', 'manual'], 'Y 轴策略'),
            yPercentMin, yPercentMax, yCountMin, yCountMax,
            ...normalizeAxisNumberSettings(settings),
            underflow: flag(underflow), overflow: flag(overflow) };
    }
    function histogramYBounds(settings, windowPoints) {
        return settings.scale === 'percent' ? [settings.yPercentMin, settings.yPercentMax] :
            [settings.yCountMin ?? 0, settings.yCountMax ?? windowPoints];
    }
    function normalize(type, settings = {}) {
        object(settings);
        if (type === 'xy') return normalizeXY(settings);
        if (type === 'histogram') return normalizeHistogram(settings);
        throw new Error('未知的分析控件类型');
    }
    S.AnalysisSettings = { normalize, equalEdges, spectrumSegmentSize, spectrumYRangeKey, maxFftOverlap, histogramYBounds };
    if (typeof module !== 'undefined') module.exports = { AnalysisSettings: S.AnalysisSettings };
})(globalThis);
