/** Fixed-rate tables materialize only while exporting, retaining missing values and provenance. */
function* synchronizedCsvChunks(frames, channels, options = {}) {
    const field = value => /[",\r\n]/.test(String(value)) ? '"' + String(value).replace(/"/g, '""') + '"' : String(value);
    const indices = options.channelIndices ?? channels.map((_, index) => index), count = frames.length;
    const first = frames.timestampAt(0), columns = ['Index', ...(options.timestamps ? ['Timestamp'] : []), ...indices.flatMap(index =>
        options.syncStates ? [channels[index]?.name ?? `CH${String(index + 1).padStart(5, '0')}`, `Status:${index + 1}`, `SourceByte:${index + 1}`]
            : [channels[index]?.name ?? `CH${String(index + 1).padStart(5, '0')}`])];
    yield columns.map(field).join(',') + '\r\n';
    let rows = [];
    for (let index = 0; index < count; index++) {
        options.check?.();
        if (frames.timestampAt(0) !== first) throw new Error('导出期间同步表已被覆盖，请暂停后重试');
        const row = [index];
        if (options.timestamps) row.push(new Date(frames.timestampAt(index)).toISOString());
        for (const channel of indices) {
            const value = frames.getValue(channel, index); row.push(Number.isFinite(value) ? value : '');
            if (options.syncStates) row.push(frames.statusAt(channel, index), frames.provenanceAt(channel, index)?.byteOffset ?? '');
        }
        rows.push(row.map(field).join(','));
        if (rows.length === 1024) { yield rows.join('\r\n') + '\r\n'; rows = []; }
    }
    if (rows.length) yield rows.join('\r\n') + '\r\n';
}
globalThis.SerialPlotter ??= {}; globalThis.SerialPlotter.synchronizedCsvChunks = synchronizedCsvChunks;
if (typeof module !== 'undefined') module.exports = { synchronizedCsvChunks };
