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

function formatCsvExportRow(row, time, channelSettings, read) {
    const fields = [row];
    if (time !== undefined) fields.push(Number.isFinite(time) ? new Date(time).toISOString() : '');
    for (let channel = 0; channel < channelSettings.length; channel++) {
        const value = transformForExport(read(channel), channelSettings[channel]);
        fields.push(Number.isFinite(value) ? value : '');
    }
    return fields.join(',') + '\r\n';
}

function csvHeader(channels, timestamps) {
    return ['Index', ...(timestamps ? ['Timestamp'] : []), ...channels.map(channel => csvFieldForExport(channel.name))]
        .join(',') + '\r\n';
}

async function* frameCsvChunksInWorkers(frames, channels, pool, options = {}, rowsPerChunk = 1024) {
    const indices = csvChannelIndices(channels, options), count = frames.length;
    if (frames.rawMode || !count || !indices.length) return;
    const { timestamps, onProgress, check } = options;
    const channelSettings = indices.map(index => channels[index]);
    const size = Math.max(1, Math.min(rowsPerChunk, Math.floor(32768 / indices.length)));
    const firstOrder = frames.orderAt(0);
    function* tasks() {
        for (let start = 0; start < count; start += size) {
            if (frames.orderAt(0) !== firstOrder) throw new Error('导出期间最早帧已被覆盖，请暂停采集后重试');
            const rows = Math.min(size, count - start), values = new Float64Array(rows * indices.length);
            const times = timestamps ? new Float64Array(rows) : null;
            for (let row = 0, slot = 0; row < rows; row++) {
                if (times) times[row] = frames.timestampAt(start + row);
                for (const channel of indices) values[slot++] = frames.getValue(channel, start + row);
            }
            yield { kind: 'csv-export', values, times, start, rows, channelSettings };
        }
    }
    onProgress?.(0, count);
    yield csvHeader(channelSettings, timestamps);
    for await (const { task, result } of pool.runOrderedTasks(tasks(), { check })) {
        yield result;
        onProgress?.(task.start + task.rows, count);
    }
}

function* frameCsvChunks(frames, channels, rowsPerChunk = 1024, options = {}) {
    if (frames.rawMode || !channels.length || !frames.length) return;
    const indices = csvChannelIndices(channels, options);
    if (!indices.length) return;
    const { timestamps = false, onProgress } = options, count = frames.length;
    onProgress?.(0, count);
    const selected = indices.map(index => channels[index]);
    yield csvHeader(selected, timestamps);
    const firstOrder = frames.orderAt(0);
    for (let start = 0; start < count; start += rowsPerChunk) {
        if (frames.orderAt(0) !== firstOrder)
            throw new Error('导出期间最早帧已被覆盖，请暂停采集后重试');
        const lines = [];
        for (let row = start; row < Math.min(count, start + rowsPerChunk); row++) {
            lines.push(formatCsvExportRow(row, timestamps ? frames.timestampAt(row) ?? NaN : undefined, selected,
                index => frames.getValue(indices[index], row)));
        }
        yield lines.join('');
        onProgress?.(Math.min(count, start + rowsPerChunk), count);
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

if (typeof module !== 'undefined') module.exports = { exportFrameCsv, frameCsvChunks, writeFrameCsv,
    frameCsvChunksInWorkers, formatCsvExportRow };
globalThis.SerialPlotter ??= {};
globalThis.SerialPlotter.exportFrameCsv = exportFrameCsv;
globalThis.SerialPlotter.frameCsvChunks = frameCsvChunks;
Object.assign(globalThis.SerialPlotter, { writeFrameCsv, frameCsvChunksInWorkers, formatCsvExportRow });
