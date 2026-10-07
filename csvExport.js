/** Export every retained frame without using the plot's display decimation. */
const csvFieldForExport = typeof module !== 'undefined'
    ? require('./plotMath').csvField : globalThis.SerialPlotter.csvField;
const transformForExport = typeof module !== 'undefined'
    ? require('./channelTransform').transformChannelValue : globalThis.SerialPlotter.transformChannelValue;

function* frameCsvChunks(frames, channels, rowsPerChunk = 1024, { timestamps = false } = {}) {
    if (!channels.length || !frames.length) return;
    yield ['Index', ...(timestamps ? ['Timestamp'] : []), ...channels.map(ch => csvFieldForExport(ch.name))].join(',') + '\r\n';
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
            for (let channel = 0; channel < channels.length; channel++) {
                const value = transformForExport(frames.getValue(channel, row), channels[channel]);
                fields.push(Number.isFinite(value) ? value : '');
            }
            lines.push(fields.join(','));
        }
        yield lines.join('\r\n') + '\r\n';
    }
}

function exportFrameCsv(frames, channels, options = {}) {
    if (!channels.length || !frames.length) return null;
    return [...frameCsvChunks(frames, channels, 1024, options)].join('');
}

async function writeFrameCsv(frames, channels, writable, onProgress = () => {}, options = {}) {
    if (!channels.length || !frames.length) return false;
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
