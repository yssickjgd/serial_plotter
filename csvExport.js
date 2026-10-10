/** Export every retained frame without using the plot's display decimation. */
const csvFieldForExport = typeof module !== 'undefined'
    ? require('./plotMath').csvField : globalThis.SerialPlotter.csvField;
const transformForExport = typeof module !== 'undefined'
    ? require('./channelTransform').transformChannelValue : globalThis.SerialPlotter.transformChannelValue;

function csvChannelIndices(channels, { channelIndices = null } = {}) {
    if (channelIndices === null) return channels.flatMap((channel, index) => channel.signal === false ? [] : [index]);
    if (!Array.isArray(channelIndices) || channelIndices.some(index =>
        !Number.isInteger(index) || index < 0 || index >= channels.length))
        throw new RangeError('CSV 通道选择无效');
    return [...new Set(channelIndices)].filter(index => channels[index].signal !== false).sort((a, b) => a - b);
}

function* frameCsvChunks(frames, channels, rowsPerChunk = 1024, options = {}) {
    if (frames.rawMode || !channels.length || !frames.length) return;
    const indices = csvChannelIndices(channels, options);
    if (!indices.length) return;
    const { timestamps = false } = options;
    yield ['Index', ...(timestamps ? ['Timestamp'] : []),
        ...indices.map(index => csvFieldForExport(channels[index].name))].join(',') + '\r\n';
    const count = frames.length;
    const firstOrder = frames.orderAt(0);
    for (let start = 0; start < count; start += rowsPerChunk) {
        if (frames.orderAt(0) !== firstOrder)
            throw new Error('导出期间最早帧已被覆盖，请暂停采集后重试');
        const lines = [];
        for (let row = start; row < Math.min(count, start + rowsPerChunk); row++) {
            const fields = [row];
            if (timestamps) {
                const time = frames.timestampAt(row);
                fields.push(Number.isFinite(time) ? new Date(time).toISOString() : '');
            }
            for (const channel of indices) {
                const value = transformForExport(frames.getValue(channel, row), channels[channel]);
                fields.push(Number.isFinite(value) ? value : '');
            }
            lines.push(fields.join(','));
        }
        yield lines.join('\r\n') + '\r\n';
    }
}

function exportFrameCsv(frames, channels, options = {}) {
    if (frames.rawMode || !channels.length || !frames.length || !csvChannelIndices(channels, options).length) return null;
    return [...frameCsvChunks(frames, channels, 1024, options)].join('');
}

async function writeFrameCsv(frames, channels, writable, onProgress = () => {}, options = {}) {
    if (frames.rawMode || !channels.length || !frames.length || !csvChannelIndices(channels, options).length) return false;
    const encoder = new TextEncoder();
    await writable.write(encoder.encode('\uFEFF'));
    let chunk = 0;
    for (const text of frameCsvChunks(frames, channels, 1024, options)) {
        await writable.write(encoder.encode(text));
        if (++chunk % 16 === 0) {
            onProgress(Math.min(frames.length, (chunk - 1) * 1024), frames.length);
            await new Promise(resolve => setTimeout(resolve, 0));
        }
    }
    onProgress(frames.length, frames.length);
    return true;
}

if (typeof module !== 'undefined') module.exports = { exportFrameCsv, frameCsvChunks, writeFrameCsv };
globalThis.SerialPlotter ??= {};
globalThis.SerialPlotter.exportFrameCsv = exportFrameCsv;
globalThis.SerialPlotter.writeFrameCsv = writeFrameCsv;
