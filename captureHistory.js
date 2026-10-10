/** Original receive chunks, kept independently of their current frame interpretation. */
const historyDependencies = typeof module !== 'undefined'
    ? { ...require('./dataParser'), ...require('./rawFrameParser'), ...require('./frameBuffer') }
    : globalThis.SerialPlotter;
const captureHistoryStates = new WeakMap();
const captureHistoryErrorCallbacks = new WeakSet();

class CaptureHistory {
    constructor({ maxBytes = Infinity } = {}) {
        if (maxBytes !== Infinity && (!Number.isSafeInteger(maxBytes) || maxBytes < 1))
            throw new RangeError('Capture byte limit must be a positive integer');
        this.maxBytes = maxBytes;
        captureHistoryStates.set(this, { chunks: [], head: 0, boundaries: [], boundaryHead: 0,
            startByte: 0, endByte: 0, streamStartByte: 0, currentStreamStartByte: 0, revision: 0, generation: 0 });
    }

    get byteLength() { const state = captureHistoryStates.get(this); return state.endByte - state.startByte; }
    get startByte() { return captureHistoryStates.get(this).startByte; }
    get endByte() { return captureHistoryStates.get(this).endByte; }
    get revision() { return captureHistoryStates.get(this).revision; }
    get streamStartByte() { return captureHistoryStates.get(this).streamStartByte; }

    append(bytes, { timestamp = Date.now(), arrival = performance.now(), order = 0 } = {}) {
        if (!(bytes instanceof Uint8Array)) bytes = new Uint8Array(bytes);
        const state = captureHistoryStates.get(this);
        const startByte = state.endByte, endByte = startByte + bytes.length;
        const metadata = { timestamp, arrival, order, startByte, byteOffset: startByte, endByte,
            streamStartByte: state.currentStreamStartByte,
            sourceStartByte: startByte, sourceEndByte: endByte };
        if (!bytes.length) return metadata;
        state.chunks.push({ ...metadata, bytes: bytes.slice() });
        state.endByte = endByte;
        state.revision++;
        if (this.byteLength > this.maxBytes) this.pruneBefore(endByte - this.maxBytes);
        return metadata;
    }

    /** Pause and disconnect terminate the current stream segment without dropping its bytes. */
    markBoundary() {
        const state = captureHistoryStates.get(this);
        const checkpoint = state.boundaries.at(-1);
        if (checkpoint?.byteOffset === state.endByte) return { ...checkpoint };
        const next = { byteOffset: state.endByte };
        state.currentStreamStartByte = state.endByte;
        if (state.startByte === state.endByte) state.streamStartByte = state.endByte;
        state.boundaries.push(next); state.revision++;
        return { ...next };
    }

    pruneBefore(byteOffset) {
        const state = captureHistoryStates.get(this);
        const target = Math.min(state.endByte, Math.max(state.startByte, Math.floor(byteOffset)));
        if (!Number.isFinite(target) || target === state.startByte) return;
        while (state.head < state.chunks.length && state.chunks[state.head].endByte <= target) {
            state.chunks[state.head++] = null;
        }
        if (state.head < state.chunks.length) {
            const first = state.chunks[state.head];
            if (first.startByte < target) {
                let suffix = first.bytes.subarray(target - first.startByte);
                // Compact only after halving storage; repeated single-byte eviction remains linear.
                if (suffix.length <= suffix.buffer.byteLength / 2) suffix = suffix.slice();
                state.chunks[state.head] = { ...first, startByte: target, byteOffset: target, bytes: suffix };
            }
        }
        state.startByte = target;
        while (state.boundaryHead < state.boundaries.length &&
            state.boundaries[state.boundaryHead].byteOffset < target)
            state.streamStartByte = state.boundaries[state.boundaryHead++].byteOffset;
        if (state.boundaries[state.boundaryHead]?.byteOffset === target) state.streamStartByte = target;
        if (state.boundaryHead > 1024 || state.boundaryHead === state.boundaries.length) {
            state.boundaries = state.boundaries.slice(state.boundaryHead); state.boundaryHead = 0;
        }
        state.revision++;
        if (state.head > 1024 || state.head === state.chunks.length) {
            state.chunks = state.chunks.slice(state.head); state.head = 0;
        }
    }

    snapshot() {
        const state = captureHistoryStates.get(this);
        return state.chunks.slice(state.head).map(chunk => ({ ...chunk, bytes: chunk.bytes.slice() }));
    }

    /** Read-only views of a fixed range, without cloning the entire archive. */
    *readRange(startByte = this.startByte, endByte = this.endByte, { maxSliceBytes = 65536 } = {}) {
        if (!Number.isSafeInteger(maxSliceBytes) || maxSliceBytes < 1)
            throw new RangeError('History slice size must be a positive integer');
        const state = captureHistoryStates.get(this), generation = state.generation;
        const stop = Math.min(endByte, state.endByte);
        if (!Number.isSafeInteger(startByte) || !Number.isSafeInteger(stop) || startByte < state.startByte || startByte > stop)
            throw new RangeError('History range is no longer available');
        const boundaries = state.boundaries.slice(state.boundaryHead)
            .filter(checkpoint => checkpoint.byteOffset >= startByte && checkpoint.byteOffset <= stop);
        let cursor = startByte, index = state.head, boundary = 0;
        while (cursor <= stop) {
            if (generation !== state.generation || cursor < state.startByte)
                throw new Error('History changed while reading');
            if (boundaries[boundary]?.byteOffset === cursor) {
                yield { bytes: new Uint8Array(0), byteOffset: cursor, endByte: cursor,
                    streamStartByte: cursor, streamEnded: true };
                boundary++;
            }
            if (cursor === stop) break;
            while (index < state.chunks.length && state.chunks[index].endByte <= cursor) index++;
            const chunk = state.chunks[index];
            const next = Math.min(stop, chunk.endByte, cursor + maxSliceBytes,
                boundaries[boundary]?.byteOffset ?? Infinity);
            const streamEnded = next === boundaries[boundary]?.byteOffset;
            yield { bytes: chunk.bytes.subarray(cursor - chunk.startByte, next - chunk.startByte),
                byteOffset: cursor, endByte: next, streamStartByte: chunk.streamStartByte, streamEnded };
            cursor = next;
            if (streamEnded) boundary++;
        }
    }

    *[Symbol.iterator]() { yield* this.snapshot(); }

    clear() {
        const state = captureHistoryStates.get(this);
        state.chunks = []; state.head = 0; state.startByte = 0; state.endByte = 0;
        state.boundaries = []; state.boundaryHead = 0;
        state.streamStartByte = 0; state.currentStreamStartByte = 0;
        state.revision++; state.generation++;
    }
}

/** Replay bounded slices; stopByte can freeze a snapshot while reception continues. */
async function replayCaptureHistory(history, format, capacity, {
    onProgress = () => {}, onBytes = () => {}, onBoundary = () => {}, onGap = () => {}, isCancelled = () => false,
    yieldControl = () => new Promise(resolve => globalThis.setTimeout(resolve, 0)),
    maxSliceBytes = 16384, flushPending = true, resumeTimers = false, previousResult = null,
    stopByte = Infinity, startByte = history.startByte, preserveCallbacks = false, decodeBatch = null, assembleRawBatch = null,
    maxDecodeFrames = 2048, maxDecodeBytes = 131072, maxPendingDecodes = 1
} = {}) {
    if (!(history instanceof CaptureHistory)) throw new TypeError('Expected a CaptureHistory');
    if (!Number.isSafeInteger(maxSliceBytes) || maxSliceBytes < 1)
        throw new RangeError('Replay slice size must be a positive integer');
    for (const value of [maxDecodeFrames, maxDecodeBytes, maxPendingDecodes])
        if (!Number.isSafeInteger(value) || value < 1) throw new RangeError('Decode batch limits must be positive integers');
    const { DataParser, RawFrameParser, FrameBuffer } = historyDependencies;
    const numeric = (format.captureMode || 'number') === 'number';
    const frames = previousResult?.frames || new FrameBuffer(Number(format.channelsCount || 1), capacity);
    const parser = previousResult?.parser || (numeric ? new DataParser() : new RawFrameParser());
    if (!previousResult && numeric) parser.setFormat(format);
    else if (!previousResult) {
        frames.setRawMode(true);
        parser.setFormat({ boundary: format.captureMode === 'hex' ? 'idle' : (format.textBoundary || 'idle'),
            idleGapSeconds: Number(format.idleGapSeconds || 0.001), encoding: format.textEncoding || 'utf-8',
            maxFrameBytes: format.maxRawFrameBytes ?? format.maxFrameBytes ?? 1048576 });
        parser.suspendTimers = true;
    }
    if (!numeric) { parser.suspendTimers = true; parser._cancelTimer(); }
    const errors = previousResult?.errors || [];
    let errorHead = 0;
    const recordError = (type, time, bytes, metadata) => {
        errors.push({ type, time, bytes, ...metadata, kind: 'error' });
        if (errors.length - errorHead > capacity) errors[errorHead++] = null;
        if (errorHead > 1024) { errors.splice(0, errorHead); errorHead = 0; }
    };
    // Returned error lists are copies. Rebind our collector on catchup while preserving caller callbacks.
    if (!preserveCallbacks || captureHistoryErrorCallbacks.has(parser.onFrameError)) {
        parser.onFrameError = recordError;
        captureHistoryErrorCallbacks.add(recordError);
    }
    const batchedDecode = numeric && !!decodeBatch && !previousResult && !preserveCallbacks;
    const batchedRaw = format.captureMode === 'hex' && !!assembleRawBatch && !previousResult && !preserveCallbacks;
    const batchedFrames = batchedDecode || batchedRaw;
    let decodeRecords = [], decodeBytes = 0, pendingDecodes = [];
    const dispatchDecode = () => {
        if (!decodeRecords.length) return;
        const records = decodeRecords;
        const promise = Promise.resolve().then(() => (batchedRaw ? assembleRawBatch : decodeBatch)(records, format));
        promise.catch(() => {}); // Every queued result is consumed in order, including failures.
        pendingDecodes.push({ records, promise });
        decodeRecords = []; decodeBytes = 0;
    };
    if (!preserveCallbacks) {
        if (batchedDecode) {
            parser.decodeValues = false;
            parser.onFrameParsed = (_values, time, bytes, timestamp, metadata) => {
                decodeRecords.push({ time, bytes, timestamp, metadata }); decodeBytes += bytes.length;
                if (decodeRecords.length >= maxDecodeFrames || decodeBytes >= maxDecodeBytes) dispatchDecode();
            };
        } else if (numeric) parser.onFrameParsed = (values, time, bytes, timestamp, metadata) =>
            frames.append(values, bytes, time, metadata.order, timestamp, metadata);
        else parser.onFrameParsed = (bytes, time, timestamp, metadata) =>
            frames.appendRaw(bytes, time, metadata.order, timestamp, metadata);
        if (batchedRaw) parser.setFramePartsCallback((parts, time, timestamp, metadata) => {
            decodeRecords.push({ parts, time, timestamp, metadata });
            decodeBytes += metadata.endByte - metadata.byteOffset;
            if (decodeRecords.length >= maxDecodeFrames || decodeBytes >= maxDecodeBytes) dispatchDecode();
        });
    }
    const state = captureHistoryStates.get(history), generation = state.generation;
    const consumeDecoded = async keep => {
        while (pendingDecodes.length > keep) {
            const { records, promise } = pendingDecodes.shift();
            const values = await promise;
            if (isCancelled() || state.generation !== generation) return false;
            const channels = Number(format.channelsCount);
            const expected = batchedRaw ? records.reduce((total, record) =>
                total + record.metadata.endByte - record.metadata.byteOffset, 0) : records.length * channels;
            if (!values || values.length !== expected || batchedRaw && !(values instanceof Uint8Array))
                throw new Error('Decoded sample count or raw byte count does not match frames');
            let started = performance.now();
            let byteOffset = 0;
            for (let i = 0; i < records.length; i++) {
                const record = records[i], start = i * channels;
                if (batchedRaw) {
                    const end = byteOffset + record.metadata.endByte - record.metadata.byteOffset;
                    frames.appendRaw(values.subarray(byteOffset, end), record.time, record.metadata.order,
                        record.timestamp, record.metadata);
                    byteOffset = end;
                } else {
                    const samples = values.subarray ? values.subarray(start, start + channels) : values.slice(start, start + channels);
                    frames.append(samples, record.bytes, record.time, record.metadata.order, record.timestamp, record.metadata);
                }
                if (performance.now() - started >= 8) {
                    await yieldControl(); started = performance.now();
                    if (isCancelled() || state.generation !== generation) return false;
                }
            }
        }
        return true;
    };
    let cursor = previousResult?.endByte ?? Math.max(state.startByte, startByte),
        processedBytes = previousResult?.processedBytes || 0, cancelled = false;
    const targetEnd = () => Math.min(stopByte, state.endByte);
    const progress = () => onProgress({ processedBytes, totalBytes: processedBytes + targetEnd() - cursor,
        frameCount: parser.frameCount, byteOffset: cursor });
    let index = state.head;
    let batchBytes = 0, batchStarted = performance.now();
    let lastBoundaryByte = previousResult?.lastBoundaryByte ?? -Infinity;
    const nextBoundary = () => {
        let low = state.boundaryHead, high = state.boundaries.length;
        while (low < high) {
            const mid = Math.floor((low + high) / 2);
            if (state.boundaries[mid].byteOffset <= lastBoundaryByte) low = mid + 1;
            else high = mid;
        }
        return state.boundaries[low];
    };
    const flushStream = byteOffset => {
        parser.flushPending();
        const pendingFrame = batchedRaw && (decodeRecords.at(-1) || pendingDecodes.at(-1)?.records.at(-1));
        if (pendingFrame && pendingFrame.metadata.endByte <= byteOffset) {
            pendingFrame.metadata.streamEnded = true;
            return;
        }
        const last = frames.length - 1;
        if (!numeric && last >= 0 && frames.rawByteOffsetAt(last) + frames.rawBytesAt(last).length <= byteOffset)
            frames.markStreamEnded(last);
    };
    while (true) {
        if (isCancelled() || state.generation !== generation ||
            (previousResult?.generation !== undefined && previousResult.generation !== generation)) { cancelled = true; break; }
        // Pruning is permitted while replay yields; seek from the retained archive when needed.
        if (cursor < state.startByte) {
            cursor = state.startByte;
            parser.reset(); parser.frameCount = 0; parser.failCount = 0;
            frames.clear(); errors.length = 0; errorHead = 0;
            decodeRecords = []; decodeBytes = 0; pendingDecodes = [];
            index = state.head;
            batchBytes = 0; batchStarted = performance.now();
            onGap({ byteOffset: cursor });
        }
        let checkpoint = nextBoundary();
        while (checkpoint && checkpoint.byteOffset <= cursor) {
            flushStream(checkpoint.byteOffset);
            onBoundary({ ...checkpoint });
            lastBoundaryByte = checkpoint.byteOffset;
            checkpoint = nextBoundary();
        }
        if (cursor >= targetEnd()) break;
        if (!state.chunks[index] || state.chunks[index].endByte <= cursor || state.chunks[index].startByte > cursor) {
            index = state.head;
            while (index < state.chunks.length && state.chunks[index].endByte <= cursor) index++;
        }
        const chunk = state.chunks[index];
        if (!chunk) break;
        const length = Math.min(maxSliceBytes - batchBytes, chunk.endByte - cursor, targetEnd() - cursor,
            checkpoint ? checkpoint.byteOffset - cursor : Infinity);
        const bytes = chunk.bytes.subarray(cursor - chunk.startByte, cursor - chunk.startByte + length);
        const metadata = { timestamp: chunk.timestamp, arrival: chunk.arrival, order: chunk.order,
            streamStartByte: chunk.streamStartByte,
            byteOffset: cursor, sourceStartByte: chunk.sourceStartByte, sourceEndByte: chunk.sourceEndByte };
        onBytes(bytes.slice(), metadata);
        parser.appendData(bytes, metadata);
        cursor += length; processedBytes += length;
        batchBytes += length;
        if (cursor === chunk.endByte) index++;
        if (batchedFrames && pendingDecodes.length >= maxPendingDecodes &&
            !await consumeDecoded(maxPendingDecodes - 1)) { cancelled = true; break; }
        const atTarget = cursor === targetEnd();
        const timeBudgetReached = performance.now() - batchStarted >= 8;
        if (batchBytes >= maxSliceBytes || timeBudgetReached || atTarget) {
            progress();
            // Fill independent worker jobs until the time budget, keeping each input slice small.
            // Live catchup hands off in this turn rather than admitting another tail at the end.
            if (!(preserveCallbacks && atTarget) && (!batchedFrames || timeBudgetReached || atTarget)) {
                await yieldControl();
                batchStarted = performance.now();
            }
            batchBytes = 0;
        }
    }
    if (batchedFrames && !cancelled) {
        dispatchDecode();
        if (!await consumeDecoded(0)) cancelled = true;
    }
    if (batchedDecode) {
        parser.decodeValues = true;
        parser.onFrameParsed = (values, time, bytes, timestamp, metadata) =>
            frames.append(values, bytes, time, metadata.order, timestamp, metadata);
    }
    if (isCancelled() || state.generation !== generation) cancelled = true;
    // A paused snapshot can still have queued bytes before its real stream boundary.
    if (!cancelled && cursor >= state.endByte &&
        (typeof flushPending === 'function' ? flushPending() : flushPending)) flushStream(cursor);
    if (batchedRaw) {
        if (!cancelled) {
            dispatchDecode();
            if (!await consumeDecoded(0)) cancelled = true;
        }
        parser.setFramePartsCallback(null);
    }
    if (isCancelled() || state.generation !== generation) cancelled = true;
    // A pause/disconnect may arrive while the final worker job is outstanding. Apply its
    // boundary before acknowledging the current revision; later snapshot bytes stay for catchup.
    if (!cancelled) {
        let checkpoint = nextBoundary();
        while (checkpoint && checkpoint.byteOffset <= cursor) {
            flushStream(checkpoint.byteOffset);
            onBoundary({ ...checkpoint });
            lastBoundaryByte = checkpoint.byteOffset;
            checkpoint = nextBoundary();
        }
    }
    if (!numeric && !cancelled && resumeTimers) parser.resumeTimers();
    const revision = state.revision;
    progress();
    return { frames, parser, errors: errors.slice(errorHead), frameCount: parser.frameCount,
        failCount: parser.failCount, pendingBytes: numeric ? parser.writeOffset - parser.readOffset : parser.length,
        processedBytes, endByte: cursor, cancelled, revision, generation, lastBoundaryByte };
}

if (typeof module !== 'undefined') module.exports = { CaptureHistory, replayCaptureHistory };
globalThis.SerialPlotter ??= {};
globalThis.SerialPlotter.CaptureHistory = CaptureHistory;
globalThis.SerialPlotter.replayCaptureHistory = replayCaptureHistory;
