/** Recount archived text with bounded byte jobs and decoder-safe parallel partitions. */
const textHistoryCodec = typeof module !== 'undefined'
    ? require('./textCodec') : globalThis.SerialPlotter.TextCodec;

// UTF-8 and legacy cuts precede a byte that cannot continue an earlier character.
// UTF-16 cuts follow a complete unit other than a leading surrogate.
function textHistorySafeCut(bytes, encoding, byteOffset, orphanAllowed) {
    if (encoding === 'ascii' || encoding === 'windows-1252') return bytes.length;
    let cut = 0;
    if (encoding.startsWith('utf-16')) {
        let index = byteOffset % 2 === 0 ? 0 : 1;
        if (index && bytes.length && orphanAllowed) cut = 1;
        for (; index + 1 < bytes.length; index += 2) {
            const word = encoding === 'utf-16le'
                ? bytes[index] | bytes[index + 1] << 8 : bytes[index] << 8 | bytes[index + 1];
            if (word < 0xd800 || word > 0xdbff) cut = index + 2;
        }
    } else {
        const controlLimit = encoding === 'gb18030' ? 0x30 : 0x40;
        for (let index = 1; index < bytes.length; index++) {
            const byte = bytes[index];
            if (encoding === 'utf-8' ? byte < 0x80 || byte > 0xbf
                : byte < controlLimit || byte === 0x7f) cut = index;
        }
    }
    return cut;
}

async function countCaptureText(history, format, pool, {
    startByte = history.startByte, endByte = history.endByte, isCancelled = () => false,
    onProgress = () => {}, flushPending = true, maxBatchBytes = 131072
} = {}) {
    if (!Number.isSafeInteger(maxBatchBytes) || maxBatchBytes < 1)
        throw new RangeError('Text count batch size must be a positive integer');
    const { TextCharacterCounter, normalizeTextEncoding } = textHistoryCodec;
    const encoding = normalizeTextEncoding(typeof format === 'string' ? format : format.textEncoding || 'utf-8');
    const origin = history.streamStartByte ?? startByte;
    const counter = new TextCharacterCounter(encoding, { byteOffset: startByte - origin });
    const totalBytes = endByte - startByte;
    const yieldControl = () => new Promise(resolve => globalThis.setTimeout(resolve, 0));
    let processedBytes = 0, workBytes = 0, workStarted = performance.now();
    let yieldByteLimit = maxBatchBytes;
    const progress = () => onProgress({ processedBytes, totalBytes, byteOffset: startByte + processedBytes });
    const yieldIfNeeded = async () => {
        if (workBytes >= yieldByteLimit || performance.now() - workStarted >= 8) {
            await yieldControl();
            workBytes = 0; workStarted = performance.now();
        }
    };
    if (isCancelled()) return null;
    const spans = history.readRange(startByte, endByte, { maxSliceBytes: 65536 });

    if (!pool?.available) {
        let streamOrigin = origin;
        for (const span of spans) {
            if (isCancelled()) return null;
            if (span.streamStartByte !== streamOrigin) {
                counter.flush();
                counter.decoder = new TextCharacterCounter(encoding,
                    { byteOffset: span.byteOffset - span.streamStartByte }).decoder;
                streamOrigin = span.streamStartByte;
            }
            for (let offset = 0; offset < span.bytes.length; offset += 1024) {
                if (isCancelled()) return null;
                const bytes = span.bytes.subarray(offset, offset + 1024);
                counter.write(bytes);
                processedBytes += bytes.length; workBytes += bytes.length;
                await yieldIfNeeded();
            }
            if (span.streamEnded) {
                counter.flush();
                counter.decoder = new TextCharacterCounter(encoding).decoder;
                streamOrigin = span.endByte;
            }
            progress();
        }
        if (isCancelled()) return null;
        if (typeof flushPending === 'function' ? flushPending() : flushPending) counter.flush();
        progress();
        return counter;
    }

    const budget = Math.max(1, Math.floor(pool.maxWorkers || 1));
    yieldByteLimit = Math.max(65536, maxBatchBytes * budget);
    const jobs = [];
    const buffer = new Uint8Array(maxBatchBytes);
    let length = 0, batchStart = startByte, streamOrigin = origin;
    let predecessor = null, finalState = null, finalOffset = startByte - origin;
    const reduceNext = async () => {
        const job = jobs.shift(), result = await job.promise;
        if (isCancelled() || !result) return false;
        counter.total += result.total; counter.failed += result.failed;
        processedBytes += job.byteLength;
        progress();
        return true;
    };
    const submit = async (count, flush) => {
        while (jobs.length >= budget) if (!await reduceNext()) return false;
        if (isCancelled()) return false;
        const bytes = buffer.slice(0, count), byteOffset = batchStart - streamOrigin;
        const previous = predecessor;
        const promise = (async () => {
            const state = previous ? await previous : null;
            if (isCancelled()) return null;
            const task = { kind: 'text-count', bytes, encoding, byteOffset,
                pending: state?.pending ?? null, flush };
            if (state) task.orphanByte = state.orphanByte;
            return pool.runTask(task);
        })();
        // A cancelled reconstruction may leave already running jobs behind.
        promise.catch(() => {});
        jobs.push({ promise, byteLength: count });
        predecessor = flush ? null : promise;
        finalState = promise; finalOffset = byteOffset + count;
        buffer.copyWithin(0, count, length);
        length -= count; batchStart += count;
        return true;
    };
    const finishStream = async () => {
        if ((length || predecessor) && !await submit(length, true)) return false;
        predecessor = null;
        finalState = null; finalOffset = 0;
        return true;
    };
    for (const span of spans) {
        if (isCancelled()) return null;
        if (span.streamStartByte !== streamOrigin) {
            if (!await finishStream()) return null;
            streamOrigin = span.streamStartByte;
            batchStart = span.byteOffset;
            finalOffset = span.byteOffset - streamOrigin;
        }
        for (let offset = 0; offset < span.bytes.length;) {
            if (isCancelled()) return null;
            if (!length) batchStart = span.byteOffset + offset;
            const count = Math.min(maxBatchBytes - length, span.bytes.length - offset);
            buffer.set(span.bytes.subarray(offset, offset + count), length);
            offset += count; length += count; workBytes += count;
            if (length === maxBatchBytes) {
                const cut = textHistorySafeCut(buffer, encoding, batchStart - streamOrigin, !predecessor);
                if (!await submit(cut || length, Boolean(cut))) return null;
            }
            await yieldIfNeeded();
        }
        if (span.streamEnded) {
            if (!await finishStream()) return null;
            streamOrigin = span.endByte; batchStart = span.endByte;
        }
    }
    if (isCancelled()) return null;
    // A live pause or resume can occur while the final job is running. Defer that
    // policy to handoff; only the at-most-three pending bytes need local decoding.
    const flush = typeof flushPending === 'function' ? false : flushPending;
    if (length || predecessor && flush) {
        if (!await submit(length, Boolean(flush))) return null;
    }
    while (jobs.length) if (!await reduceNext()) return null;
    if (isCancelled()) return null;
    counter.decoder = new TextCharacterCounter(encoding, { byteOffset: finalOffset }).decoder;
    if (finalState) {
        const state = await finalState;
        counter.decoder.pending = state.pending.map(entry => ({ ...entry }));
        counter.decoder.orphanByte = state.orphanByte;
    }
    if (typeof flushPending === 'function' && flushPending()) counter.flush();
    progress();
    return counter;
}

if (typeof module !== 'undefined') module.exports = { countCaptureText };
globalThis.SerialPlotter ??= {};
globalThis.SerialPlotter.countCaptureText = countCaptureText;
