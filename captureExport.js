/** Export retained RX/TX records in chronological order without display wrapping. */
const captureExportBytes = typeof module !== 'undefined'
    ? require('./byteUtils').ByteUtils : globalThis.SerialPlotter.ByteUtils;
const captureExportCodec = typeof module !== 'undefined'
    ? require('./textCodec') : globalThis.SerialPlotter.TextCodec;

function* captureRecords(rx, tx, direction) {
    const sources = [
        { frames: rx, kind: 'rx', count: direction === 'tx' ? 0 : rx.length, position: 0 },
        { frames: tx, kind: 'tx', count: direction === 'rx' ? 0 : tx.length, position: 0 }
    ];
    for (const source of sources) source.firstOrder = source.frames.orderAt(0);
    while (sources.some(source => source.position < source.count)) {
        for (const source of sources)
            if (source.count && source.frames.orderAt(0) !== source.firstOrder)
                throw new Error('导出期间记录已被覆盖或变化，请暂停采集后重试');
        const [left, right] = sources;
        const source = left.position >= left.count ? right : right.position >= right.count ? left
            : left.frames.orderAt(left.position) <= right.frames.orderAt(right.position) ? left : right;
        const frame = source.frames.frameAt(source.position++);
        yield { ...frame, kind: source.kind };
    }
}

function recordPrefix(record, options) {
    return `${options.timestamps ? `[${record.time}] ` : ''}${options.markers ? `${record.kind.toUpperCase()} ` : ''}`;
}

function* captureExportChunks(rx, tx, options = {}) {
    const { format = 'hex-text', direction = 'rx', encoding = 'utf-8' } = options;
    if (!['binary', 'hex-text', 'text'].includes(format)) throw new Error('导出格式无效');
    if (!['rx', 'tx', 'both'].includes(direction)) throw new Error('导出范围无效');
    const records = captureRecords(rx, tx, direction);
    if (format !== 'text') {
        for (const record of records) yield format === 'binary' ? record.bytes
            : recordPrefix(record, options) + captureExportBytes.bytesToHex(record.bytes) + '\r\n';
        return;
    }
    const decoders = Object.fromEntries([['rx', rx], ['tx', tx]].map(([kind, frames]) =>
        [kind, new captureExportCodec.MappedTextDecoder(encoding, { byteOffset: frames.rawByteOffsetAt(0) ?? 0 })]));
    const owners = new Map(), queue = [];
    let position = 0, queueStart = 0;
    const consume = tokens => {
        for (const token of tokens) owners.get(token.startFrame).parts.push(token.invalid ? token.exportDisplay : token.text);
    };
    function* readyRows(final = false) {
        const pendingStart = final ? Infinity : Math.min(...Object.values(decoders)
            .map(decoder => decoder.pending[0]?.frame ?? Infinity));
        while (queueStart < queue.length && queue[queueStart].index < pendingStart) {
            const record = queue[queueStart++];
            const text = record.parts.join('');
            yield options.timestamps || options.markers
                ? recordPrefix(record, options) + text + (/[\r\n]$/.test(text) ? '' : '\r\n') : text;
            owners.delete(record.index);
        }
        if (queueStart >= 1024) { queue.splice(0, queueStart); queueStart = 0; }
    }
    for (const record of records) {
        const owner = { ...record, bytes: undefined, index: position++, parts: [] };
        owners.set(owner.index, owner);
        queue.push(owner);
        consume(decoders[record.kind].write(record.bytes, owner.index));
        yield* readyRows();
    }
    for (const decoder of Object.values(decoders)) consume(decoder.flush());
    yield* readyRows(true);
}

async function writeCaptureExport(rx, tx, options, writable, onProgress = () => {}) {
    const encoder = new TextEncoder();
    let count = 0;
    for (const chunk of captureExportChunks(rx, tx, options)) {
        await writable.write(typeof chunk === 'string' ? encoder.encode(chunk) : chunk);
        if (++count % 256 === 0) {
            onProgress(count);
            await new Promise(resolve => setTimeout(resolve, 0));
        }
    }
    onProgress(count);
}

if (typeof module !== 'undefined') module.exports = { captureExportChunks, writeCaptureExport };
globalThis.SerialPlotter ??= {};
Object.assign(globalThis.SerialPlotter, { captureExportChunks, writeCaptureExport });
