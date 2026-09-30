const validationLimits = typeof module !== 'undefined'
    ? require('./projectLimits').PROJECT_LIMITS : globalThis.SerialPlotter.Limits;
const validationByteUtils = typeof module !== 'undefined'
    ? require('./byteUtils').ByteUtils : globalThis.SerialPlotter.ByteUtils;

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

function validateConfig(config) {
    if (!config || typeof config !== 'object' || Array.isArray(config)) throw new Error('配置必须是 JSON 对象');
    const options = {
        connType: [['serial', 'tcp-client', 'tcp-server', 'udp'], '连接模式'],
        dataType: [['int8', 'uint8', 'int16', 'uint16', 'int32', 'uint32', 'int64', 'uint64', 'float32', 'float64'], '数据类型'],
        endianness: [['little', 'big'], '字节序'],
        plotViewMode: [['time', 'frequency'], '绘图模式'],
        plotYScaleMode: [['auto', 'manual'], 'Y 轴策略']
    };
    for (const [key, [allowed, label]] of Object.entries(options)) {
        if (config[key] !== undefined && !allowed.includes(config[key])) throw new Error(`${label}无效`);
    }
    if (config.channelsCount !== undefined)
        parseIntInRange(config.channelsCount, validationLimits.minChannels, validationLimits.maxChannels, '通道数');
    if (config.maxPoints !== undefined)
        parseIntInRange(config.maxPoints, validationLimits.minPoints, validationLimits.maxPoints, '采样点数');
    if (config.serialBaud !== undefined)
        parseIntInRange(config.serialBaud, 1, Number.MAX_SAFE_INTEGER, '波特率');
    for (const key of ['enableHeader', 'enableFooter', 'enableChecksum', 'plotFftRemoveDc']) {
        if (config[key] !== undefined && typeof config[key] !== 'boolean')
            throw new Error(`${key} 必须是布尔值`);
    }
    if (config.netPort !== undefined && config.netPort !== '') parsePort(config.netPort);
    if (config.netLocalPort !== undefined && config.netLocalPort !== '') parsePort(config.netLocalPort);
    if (config.enableHeader === true && !validHex(config.headerHex)) throw new Error('帧头 Hex 无效');
    if (config.enableFooter === true && !validHex(config.footerHex)) throw new Error('帧尾 Hex 无效');
    if (config.channels !== undefined && (!Array.isArray(config.channels) ||
        config.channels.some(ch => !ch || typeof ch !== 'object' ||
            (ch.name !== undefined && typeof ch.name !== 'string') ||
            (ch.color !== undefined && !/^#[0-9a-f]{6}$/i.test(ch.color)) ||
            (ch.visible !== undefined && typeof ch.visible !== 'boolean'))))
        throw new Error('通道配置无效');
    for (const key of ['plotYMin', 'plotYMax', 'plotYMinTime', 'plotYMaxTime', 'plotYMinFreq', 'plotYMaxFreq']) {
        if (config[key] !== undefined && config[key] !== '' && !Number.isFinite(Number(config[key])))
            throw new Error(`${key} 必须是有效数值`);
    }
    return config;
}

if (typeof module !== 'undefined') module.exports = { parseIntInRange, parsePort, validateConfig };
globalThis.SerialPlotter ??= {};
Object.assign(globalThis.SerialPlotter, { parseIntInRange, parsePort, validateConfig });
