/** Export-only interpretations stream from retained bytes without changing acquisition. */
const exportParseApi = typeof module !== 'undefined' ? {
    ...require('./dataParser'), ...require('./rawFrameParser'), ...require('./channelOperations'),
    ...require('./plotMath'), TextCodec: require('./textCodec')
} : globalThis.SerialPlotter;
const EXPORT_NUMERIC_FIELDS = Object.freeze(['dataType', 'endianness', 'channelsCount',
    'enableHeader', 'headerHex', 'enableFooter', 'footerHex', 'enableChecksum']);

async function* reparsedFrames(frames, rules, { numeric = false, check = () => {}, onProgress = () => {},
    yieldControl = () => new Promise(resolve => setTimeout(resolve, 0)) } = {}) {
    if (!numeric && rules.boundary === 'records') {
        const count = frames.length;
        for (let index = 0; index < count; index++) {
            check(); yield frames.frameAt(index);
            if (index % 128 === 127) { onProgress(index, count); await yieldControl(); check(); }
        }
        onProgress(count, count); return;
    }
    const parser = numeric ? new exportParseApi.DataParser() : new exportParseApi.RawFrameParser();
    parser.setFormat(numeric ? { ...rules, isLittleEndian: rules.endianness !== 'big' } :
        { ...rules, idleGapSeconds: 0.001 });
    parser.suspendTimers = true;
    let queue = [], previousEnd, work = 0;
    if (numeric) parser.onFrameParsed = (samples, time, bytes, timestamp, metadata) =>
        queue.push({ ...metadata, samples, time, bytes, timestamp });
    else parser.onFrameParsed = (bytes, time, timestamp, metadata) => queue.push({ ...metadata, bytes, time, timestamp });
    const count = frames.length;
    try {
        for (let index = 0; index < count; index++) {
            check();
            const frame = frames.frameAt(index);
            if (previousEnd !== undefined && frame.byteOffset !== previousEnd) {
                parser.flushPending(); parser.reset();
                yield* queue; queue = [];
            }
            for (let start = 0; start < frame.bytes.length; start += 8192) {
                const part = frame.bytes.subarray(start, start + 8192);
                parser.appendData(part, { ...frame, arrival: frame.timestamp, byteOffset: frame.byteOffset + start,
                    sourceStartByte: frame.byteOffset, sourceEndByte: frame.endByte });
                yield* queue; queue = [];
                if ((work += part.length) >= 32768) {
                    work = 0; onProgress(index, count); await yieldControl(); check();
                }
            }
            previousEnd = frame.endByte;
            if (frame.streamEnded) {
                parser.flushPending(); parser.reset(); yield* queue; queue = [];
            }
        }
        parser.flushPending(); yield* queue;
        onProgress(count, count);
    } finally { parser.reset(); }
}

async function* reparsedCsvChunks(frames, rules, channels, options, context = {}) {
    const count = Number(rules.channelsCount);
    const engine = new exportParseApi.ChannelOperations(count, context.definitions ?? []);
    const indices = options.channelIndices;
    yield ['Index', ...(options.timestamps ? ['Timestamp'] : []),
        ...indices.map(index => exportParseApi.csvField(channels[index].name))].join(',') + '\r\n';
    let row = 0, lines = [];
    for await (const frame of reparsedFrames(frames, rules, { ...context, numeric: true })) {
        const values = engine.push(frame.samples), fields = [row++];
        if (options.timestamps) fields.push(Number.isFinite(frame.timestamp) ? new Date(frame.timestamp).toISOString() : '');
        for (const index of indices) fields.push(Number.isFinite(values[index]) ? values[index] : '');
        lines.push(fields.join(','));
        if (lines.length >= 1024) {
            yield lines.join('\r\n') + '\r\n'; lines = [];
            await (context.yieldControl ?? (() => new Promise(resolve => setTimeout(resolve, 0))))();
            context.check?.();
        }
    }
    if (!row) throw new Error('按当前导出帧参数未解析到有效数值帧，请检查记录范围和帧解析配置');
    if (lines.length) yield lines.join('\r\n') + '\r\n';
}

async function* reparsedTextChunks(rx, tx, options, context = {}) {
    const rules = { boundary: options.textBoundary, encoding: options.encoding };
    const inputs = [['rx', rx], ['tx', tx]].filter(([kind]) => options.direction === 'both' || options.direction === kind);
    const streams = inputs.map(([kind, frames]) => ({ kind, iterator: reparsedFrames(frames, rules, context)[Symbol.asyncIterator]() }));
    const decoders = Object.fromEntries(streams.map(({ kind }) => [kind, new exportParseApi.TextCodec.MappedTextDecoder(options.encoding)]));
    const resetNeeded = new Set(streams.map(stream => stream.kind)), expectedEnd = {};
    const owners = new Map(), queue = [];
    let serial = 0, queueStart = 0;
    const consume = tokens => { for (const token of tokens) owners.get(token.startFrame).parts.push(token.invalid ? token.exportDisplay : token.text); };
    function* ready(final = false) {
        const pending = final ? Infinity : Math.min(...Object.values(decoders).map(decoder => decoder.pending[0]?.frame ?? Infinity));
        while (queueStart < queue.length && queue[queueStart].index < pending) {
            const record = queue[queueStart++], text = record.parts.join(''); owners.delete(record.index);
            yield options.timestamps || options.markers ?
                `${options.timestamps ? `[${record.time}] ` : ''}${options.markers ? `${record.kind.toUpperCase()} ` : ''}${text}${/[\r\n]$/.test(text) ? '' : '\r\n'}` : text;
        }
        if (queueStart >= 1024) { queue.splice(0, queueStart); queueStart = 0; }
    }
    try {
        for (const stream of streams) stream.next = await stream.iterator.next();
        while (streams.some(stream => !stream.next.done)) {
            const stream = streams.filter(stream => !stream.next.done).sort((a, b) => a.next.value.order - b.next.value.order)[0];
            const record = { ...stream.next.value, kind: stream.kind, index: serial++, parts: [] };
            if (expectedEnd[stream.kind] !== undefined && expectedEnd[stream.kind] !== record.byteOffset) {
                consume(decoders[stream.kind].flush()); resetNeeded.add(stream.kind);
            }
            if (resetNeeded.delete(stream.kind)) decoders[stream.kind] = new exportParseApi.TextCodec.MappedTextDecoder(options.encoding,
                { byteOffset: (record.byteOffset ?? 0) - (record.streamStartByte ?? record.byteOffset ?? 0) });
            owners.set(record.index, record); queue.push(record);
            for (let start = 0; start < record.bytes.length; start += 8192) {
                consume(decoders[stream.kind].write(record.bytes.subarray(start, start + 8192), record.index));
                if (start && start % 32768 === 0) {
                    await (context.yieldControl ?? (() => new Promise(resolve => setTimeout(resolve, 0))))(); context.check?.();
                }
            }
            expectedEnd[stream.kind] = record.endByte;
            if (record.streamEnded) {
                consume(decoders[stream.kind].flush());
                resetNeeded.add(stream.kind);
            }
            yield* ready();
            stream.next = await stream.iterator.next();
        }
        for (const decoder of Object.values(decoders)) consume(decoder.flush());
        yield* ready(true);
    } finally { for (const stream of streams) await stream.iterator.return?.(); }
}

globalThis.SerialPlotter ??= {};
Object.assign(globalThis.SerialPlotter, { EXPORT_NUMERIC_FIELDS, reparsedFrames, reparsedCsvChunks, reparsedTextChunks });
if (typeof module !== 'undefined') module.exports = { EXPORT_NUMERIC_FIELDS, reparsedFrames, reparsedCsvChunks, reparsedTextChunks };
