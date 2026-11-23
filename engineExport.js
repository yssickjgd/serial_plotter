const engineExportUtils = typeof module !== 'undefined'
    ? { ...require('./channelTransform'), ...require('./poseConfig'), ...require('./protocolRecords'), ...require('./byteUtils') }
    : globalThis.SerialPlotter;

/** Resolve the data and channels actually used by the active widget. */
function widgetExportSelection(widget, channelNames = [], engineMode) {
    if (!widget || engineMode === 'Raw_Data') return null;
    const { source, settings, type } = widget;
    if (type === 'byte' && settings.captureMode !== 'engine' ||
        type === 'wave' && settings.plotContent === 'response') return null;
    if (type === 'byte' && source.kind === 'protocol' && typeof source.decodeRecord === 'function')
        return { widget, source, fieldPaths: settings.protocolFieldPaths ?? null };
    if (!['wave', 'pose', 'byte'].includes(type) || source.kind !== 'numeric') return null;
    const { frames } = source;
    const visible = type === 'wave' ? new Set(settings.channels.flatMap((item, index) => item?.visible ? [index] : []))
        : type === 'pose' ? new Set(engineExportUtils.PoseConfig.boundChannels(settings)) : null;
    const hidden = type === 'byte' ? new Set(settings.monitorDisplay.numericHiddenChannels) : null;
    const channels = Array.from({ length: frames.channelCount }, (_, index) => ({
        name: channelNames[index] || engineExportUtils.formatChannelId(index),
        signal: frames.isSignal(index)
    }));
    const channelIndices = channels.flatMap((channel, index) =>
        channel.signal && (visible ? visible.has(index) : !hidden.has(index)) ? [index] : []);
    return { widget, source, channels, channelIndices };
}

/** Format parsed samples and protocol fields, retaining their original values. */
function* parsedTextChunks(selection, options = {}) {
    const { source, channelIndices, fieldPaths } = selection;
    const { frames } = source, count = frames.length;
    for (let index = 0; index < count; index++) {
        options.check?.();
        const timestamp = options.timestamps ? frames.timestampAt(index) : null;
        const time = !options.timestamps ? '' : Number.isFinite(timestamp) ? new Date(timestamp).toISOString() :
            frames.frameAt(index, { copyBytes: false })?.time;
        const prefix = (time ? `[${time}] ` : '') + (options.markers ? 'RX ' : '');
        if (source.kind === 'protocol') {
            const decoded = source.decodeRecord(index);
            if (!engineExportUtils.protocolRecordIsSuccessful(decoded)) continue;
            const record = engineExportUtils.unwrapProtocolRecord(decoded);
            const lines = engineExportUtils.protocolVisibleFields(record, { fieldPaths })
                .map(field => `${field.path}=${engineExportUtils.protocolValueText(field.value, field)}`);
            yield [prefix + engineExportUtils.protocolRecordSummary(record), ...lines].join('\r\n') + '\r\n';
        } else {
            const values = channelIndices.map(channel => {
                const value = frames.getValue(channel, index);
                return `${engineExportUtils.formatChannelId(channel)}=${Number.isFinite(value) ? value : ''}`;
            });
            yield prefix + values.join('  ') + '\r\n';
        }
    }
}

/** Reuse retained wire bytes, resolving provenance when the widget consumes derived records. */
async function* parsedByteChunks(selection, protocolSource, options = {}) {
    const { source, channelIndices } = selection, { frames } = source, count = frames.length;
    const yieldControl = options.yieldControl ?? (() => new Promise(resolve => setTimeout(resolve, 0)));
    const output = (buffer, index) => {
        const bytes = buffer.rawBytesAt(index);
        if (options.format === 'binary') return bytes;
        const time = options.timestamps ? buffer.frameAt(index, { copyBytes: false }).time : '';
        return (time ? `[${time}] ` : '') + (options.markers ? 'RX ' : '') +
            engineExportUtils.ByteUtils.bytesToHex(bytes) + '\r\n';
    };
    if (!protocolSource || source.kind === 'protocol') {
        for (let index = 0; index < count; index++) {
            options.check?.();
            if (source.kind !== 'protocol' || engineExportUtils.protocolRecordIsSuccessful(source.decodeRecord(index)))
                yield output(frames, index);
            if (index % 256 === 255) await yieldControl();
        }
        return;
    }
    const original = protocolSource.frames, originalCount = original.length;
    const marked = new Uint8Array(originalCount);
    const mark = order => {
        const index = original.indexAtOrAfterOrder(order);
        if (index >= 0 && index < originalCount && original.orderAt(index) === order) marked[index] = 1;
    };
    let work = 0;
    for (let index = 0; index < count; index++) {
        options.check?.();
        if (typeof frames.provenanceAt !== 'function') mark(frames.orderAt(index));
        else for (const channel of channelIndices) {
            if (Number.isFinite(frames.getValue(channel, index))) {
                const origin = frames.provenanceAt(channel, index, { allOrigins: true });
                if (origin?.truncated) throw new Error('所选通道的原帧追溯超出计算上限');
                for (const contribution of origin?.origins ?? (origin ? [origin] : [])) mark(contribution.order);
            }
            if (++work % 4096 === 0) { await yieldControl(); options.check?.(); }
        }
        if (index % 256 === 255) await yieldControl();
    }
    for (let index = 0; index < originalCount; index++) {
        options.check?.();
        if (marked[index] && engineExportUtils.protocolRecordIsSuccessful(protocolSource.decodeRecord(index))) yield output(original, index);
        if (index % 256 === 255) await yieldControl();
    }
}

/** Fixed-rate tables materialize only while exporting, retaining missing values and provenance. */
function* synchronizedCsvChunks(frames, channels, options = {}) {
    const field = value => /[",\r\n]/.test(String(value)) ? '"' + String(value).replace(/"/g, '""') + '"' : String(value);
    const indices = options.channelIndices ?? channels.map((_, index) => index), count = frames.length;
    const first = frames.timestampAt(0), columns = ['Index', ...(options.timestamps ? ['Timestamp'] : []), ...indices.flatMap(index =>
        options.syncStates ? [channels[index]?.name ?? `CH${String(index + 1).padStart(5, '0')}`, `Status:${index + 1}`, `SourceByte:${index + 1}`,
                ...(frames.multipleSources ? [`Source:${index + 1}`] : [])]
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
            if (options.syncStates) {
                const origin = frames.provenanceAt(channel, index);
                row.push(frames.statusAt(channel, index), origin?.byteOffset ?? '');
                if (frames.multipleSources) row.push(origin?.sourceId ?? '');
            }
        }
        rows.push(row.map(field).join(','));
        if (rows.length === 1024) { yield rows.join('\r\n') + '\r\n'; rows = []; }
    }
    if (rows.length) yield rows.join('\r\n') + '\r\n';
}
const EngineExportApi = { synchronizedCsvChunks, widgetExportSelection, parsedTextChunks, parsedByteChunks };
globalThis.SerialPlotter ??= {}; Object.assign(globalThis.SerialPlotter, EngineExportApi);
if (typeof module !== 'undefined') module.exports = EngineExportApi;
