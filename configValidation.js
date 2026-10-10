const validationLimits = typeof module !== 'undefined'
    ? require('./projectLimits').PROJECT_LIMITS : globalThis.SerialPlotter.Limits;
const validationByteUtils = typeof module !== 'undefined'
    ? require('./byteUtils').ByteUtils : globalThis.SerialPlotter.ByteUtils;
const validationMonitorDisplay = typeof module !== 'undefined'
    ? require('./monitorDisplay') : globalThis.SerialPlotter.MonitorDisplay;

function parseIntInRange(value, min, max, label) {
    const text = String(value).trim();
    const number = Number(text);
    if (!/^\d+$/.test(text) || !Number.isSafeInteger(number) || number < min || number > max)
        throw new RangeError(`${label}需为 ${min}–${max} 的整数`);
    return number;
}

function parsePort(value) {
    return parseIntInRange(value, validationLimits.minPort, validationLimits.maxPort, '端口');
}

function validHex(value) {
    try { return validationByteUtils.hexToBytes(value || '').length > 0; }
    catch (_) { return false; }
}

function yRangeError(min, max, logarithmic = false) {
    if (String(min).trim() === '' || String(max).trim() === '' ||
        !Number.isFinite(Number(min)) || !Number.isFinite(Number(max)))
        return 'Y 轴范围必须为有限数值';
    if (logarithmic && Number(min) < 0)
        return '对数纵轴的自定义最小值不能小于 0';
    if (logarithmic && !(Number(max) > 0))
        return '对数纵轴的自定义最大值必须为正数';
    if (!(Number(max) > Number(min))) return 'Y 轴最大值必须大于最小值';
    return '';
}

function normalizeYConfig(config, context = config) {
    const normalized = {
        plotYMinTime: config.plotYMinTime ?? config.plotYMin ?? '-1',
        plotYMaxTime: config.plotYMaxTime ?? config.plotYMax ?? '1',
        plotYMinFreq: config.plotYMinFreq ?? '0.001',
        plotYMaxFreq: config.plotYMaxFreq ?? '1',
        plotYScaleModeTime: config.plotYScaleModeTime ?? config.plotYScaleMode ?? 'auto',
        plotYScaleModeFreq: config.plotYScaleModeFreq ?? config.plotYScaleMode ?? 'auto'
    };
    // Older versions shared one strategy and allowed invalid bounds in the hidden plot.
    if (config.plotYScaleModeTime === undefined && config.plotYScaleModeFreq === undefined) {
        const hiddenTime = context.plotViewMode === 'frequency';
        const suffix = hiddenTime ? 'Time' : 'Freq';
        const error = yRangeError(normalized[`plotYMin${suffix}`], normalized[`plotYMax${suffix}`],
            !hiddenTime && context.plotFreqYScale === 'log');
        if (error && normalized[`plotYScaleMode${suffix}`] === 'manual')
            normalized[`plotYScaleMode${suffix}`] = 'auto';
    }
    return normalized;
}

function validateConfig(config) {
    if (!config || typeof config !== 'object' || Array.isArray(config)) throw new Error('配置必须是 JSON 对象');
    if (config.monitorDisplay !== undefined)
        validationMonitorDisplay.normalizeDisplayOptions(config.monitorDisplay);
    const options = {
        connType: [['serial', 'tcp-client', 'tcp-server', 'udp'], '连接模式'],
        captureMode: [['number', 'hex', 'text'], '采集格式'],
        textEncoding: [['utf-8', 'ascii', 'gbk', 'gb18030', 'big5', 'utf-16le',
            'utf-16be', 'shift_jis', 'windows-1252'], '文本字符集'],
        textBoundary: [['idle', 'cr', 'lf', 'crlf', 'lfcr'], '文本断帧'],
        serialData: [['7', '8'], '数据位'],
        serialStop: [['1', '2'], '停止位'],
        serialParity: [['none', 'even', 'odd'], '奇偶校验'],
        dataType: [['int8', 'uint8', 'int16', 'uint16', 'int32', 'uint32', 'int64', 'uint64', 'float32', 'float64'], '数据类型'],
        endianness: [['little', 'big'], '字节序'],
        plotViewMode: [['time', 'frequency', 'phase'], '绘图模式'],
        plotContent: [['samples', 'response'], '显示对象'],
        plotMagnitudeUnit: [['auto', 'amplitude', 'db'], '幅值单位'],
        plotDbFactor: [['10', '20'], 'dB 系数'],
        plotPhaseUnit: [['degrees', 'radians'], '相位单位'],
        plotYScaleModePhase: [['auto', 'manual'], '相频 Y 轴策略'],
        plotYScaleModeDb: [['auto', 'manual'], 'dB Y 轴策略'],
        plotYScaleMode: [['auto', 'manual'], 'Y 轴策略'],
        plotYScaleModeTime: [['auto', 'manual'], '时域 Y 轴策略'],
        plotYScaleModeFreq: [['auto', 'manual'], '频域 Y 轴策略'],
        plotTimeXUnit: [['samples', 's'], '时域横轴单位'],
        plotFreqXUnit: [['bins', 'hz'], '频域横轴单位'],
        plotFreqXScale: [['linear', 'log'], '频域横轴形式'],
        plotFreqYScale: [['linear', 'log'], '频域纵轴形式'],
        plotFftWindow: [['rectangular', 'hann', 'hamming', 'blackman', 'flatTop'], 'FFT 窗函数']
    };
    for (const [key, [allowed, label]] of Object.entries(options)) {
        if (config[key] !== undefined && !allowed.includes(config[key])) throw new Error(`${label}无效`);
    }
    if (config.channelsCount !== undefined)
        parseIntInRange(config.channelsCount, validationLimits.minChannels, validationLimits.maxChannels, '通道数');
    if (config.maxPoints !== undefined)
        parseIntInRange(config.maxPoints, validationLimits.minPoints, validationLimits.maxPoints, '采样点数');
    if (config.plotWindowPoints !== undefined) {
        const count = parseIntInRange(config.plotWindowPoints, validationLimits.minPoints,
            validationLimits.maxPlotWindowPoints, '波形监视台内采样点数');
        if (config.maxPoints !== undefined && count > Number(config.maxPoints))
            throw new RangeError('波形监视台内采样点数不能大于最大采样点数');
    }
    if (config.plotResponsePoints !== undefined)
        parseIntInRange(config.plotResponsePoints, 2, 65536, '系统响应采样点数');
    if (config.plotResponseSampleRate !== undefined && (String(config.plotResponseSampleRate).trim() === '' ||
        !Number.isFinite(Number(config.plotResponseSampleRate)) || Number(config.plotResponseSampleRate) < 0))
        throw new RangeError('系统响应采样率需为非负有限数值；0 表示未设置');
    if (config.serialBaud !== undefined)
        parseIntInRange(config.serialBaud, 1, Number.MAX_SAFE_INTEGER, '波特率');
    if (config.idleGapSeconds !== undefined &&
        (String(config.idleGapSeconds).trim() === '' || !Number.isFinite(Number(config.idleGapSeconds)) ||
            Number(config.idleGapSeconds) < 0.001 || Number(config.idleGapSeconds) * 1000 > 2147483647))
        throw new RangeError('空闲断帧间隔需为至少 0.001 s 的有限数值，且不超过计时器范围');
    for (const key of ['enableHeader', 'enableFooter', 'enableChecksum', 'plotFftRemoveDc', 'plotPhaseUnwrap', 'rebuildHistory']) {
        if (config[key] !== undefined && typeof config[key] !== 'boolean')
            throw new Error(`${key} 必须是布尔值`);
    }
    if (config.netPort !== undefined && config.netPort !== '') parsePort(config.netPort);
    if (config.netLocalPort !== undefined && config.netLocalPort !== '') parsePort(config.netLocalPort);
    if (config.enableHeader === true && !validHex(config.headerHex)) throw new Error('帧头 Hex 无效');
    if (config.enableFooter === true && !validHex(config.footerHex)) throw new Error('帧尾 Hex 无效');
    const validCalibration = value => value === undefined ||
        ((typeof value === 'number' || typeof value === 'string') &&
            String(value).trim() !== '' && Number.isFinite(Number(value)));
    if (config.channels !== undefined && (!Array.isArray(config.channels) ||
        config.channels.some(ch => !ch || typeof ch !== 'object' ||
            (ch.name !== undefined && typeof ch.name !== 'string') ||
            (ch.color !== undefined && !/^#[0-9a-f]{6}$/i.test(ch.color)) ||
            (ch.visible !== undefined && typeof ch.visible !== 'boolean') ||
            (ch.gainEnabled !== undefined && typeof ch.gainEnabled !== 'boolean') ||
            (ch.offsetEnabled !== undefined && typeof ch.offsetEnabled !== 'boolean') ||
            !validCalibration(ch.gain) || !validCalibration(ch.offset))))
        throw new Error('通道配置无效');
    for (const key of ['plotYMin', 'plotYMax', 'plotYMinTime', 'plotYMaxTime', 'plotYMinFreq', 'plotYMaxFreq',
        'plotYMinPhase', 'plotYMaxPhase', 'plotYMinDb', 'plotYMaxDb']) {
        if (config[key] !== undefined && config[key] !== '' && !Number.isFinite(Number(config[key])))
            throw new Error(`${key} 必须是有效数值`);
    }
    for (const suffix of ['Phase', 'Db']) if (config[`plotYScaleMode${suffix}`] === 'manual') {
        const error = yRangeError(config[`plotYMin${suffix}`], config[`plotYMax${suffix}`]);
        if (error) throw new Error(error);
    }
    const yConfig = normalizeYConfig(config);
    for (const [mode, strategy, min, max] of [
        ['时域', yConfig.plotYScaleModeTime, yConfig.plotYMinTime, yConfig.plotYMaxTime],
        ['频域', yConfig.plotYScaleModeFreq, yConfig.plotYMinFreq, yConfig.plotYMaxFreq]
    ]) {
        if (strategy !== 'manual') continue;
        const error = yRangeError(min, max, mode === '频域' && config.plotFreqYScale === 'log');
        if (error) throw new Error(`${mode}：${error}`);
    }
    return config;
}

if (typeof module !== 'undefined') module.exports = {
    parseIntInRange, parsePort, validateConfig, yRangeError, normalizeYConfig
};
globalThis.SerialPlotter ??= {};
Object.assign(globalThis.SerialPlotter, { parseIntInRange, parsePort, validateConfig, yRangeError, normalizeYConfig });
