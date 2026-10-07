const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const historyModule = fs.existsSync(path.join(__dirname, '../captureHistory.js'))
    ? require('../captureHistory') : {};

function history(options) {
    assert.equal(typeof historyModule.CaptureHistory, 'function');
    return new historyModule.CaptureHistory(options);
}

test('capture archive owns original bytes and trims by absolute offsets within chunks', () => {
    const capture = history({ maxBytes: 5 });
    const bytes = Uint8Array.of(1, 2, 3);
    capture.append(bytes, { timestamp: 1000, arrival: 5, order: 7 });
    bytes[0] = 99;
    capture.append(Uint8Array.of(4, 5, 6, 7), { timestamp: 900, arrival: 10, order: 8 });
    assert.equal(capture.byteLength, 5);
    assert.equal(capture.startByte, 2);
    assert.equal(capture.endByte, 7);
    const chunks = capture.snapshot();
    assert.deepEqual(chunks.map(chunk => [...chunk.bytes]), [[3], [4, 5, 6, 7]]);
    assert.equal(chunks[0].timestamp, 1000);
    chunks[0].bytes[0] = 88;
    assert.equal(capture.snapshot()[0].bytes[0], 3);
    capture.pruneBefore(4);
    assert.deepEqual(capture.snapshot().map(chunk => [...chunk.bytes]), [[5, 6, 7]]);
    assert.equal(capture.snapshot()[0].startByte, 4);
    capture.clear();
    assert.equal(capture.byteLength, 0);
    assert.equal(capture.endByte, 0);
});

test('idle replay preserves real reception gaps and first-byte times despite wall clock changes', async () => {
    const capture = history();
    for (const [bytes, arrival, timestamp, order] of [
        [[1], 0, 1000, 1], [[2], 8, 1008, 2], [[3], 20, 800, 3]
    ]) capture.append(Uint8Array.from(bytes), { arrival, timestamp, order });
    const result = await historyModule.replayCaptureHistory(capture,
        { captureMode: 'hex', channelsCount: 1, idleGapSeconds: 0.01 }, 10);
    assert.deepEqual(Array.from({ length: result.frames.length }, (_, i) => [...result.frames.rawBytesAt(i)]), [[1, 2], [3]]);
    assert.equal(result.frames.frameAt(0).timestamp, 1000);
    assert.equal(result.frames.frameAt(1).timestamp, 800);
    assert.equal(result.frames.frameAt(1).order, 3);
    assert.equal(result.frames.frameAt(1).byteOffset, 2);
    assert.equal(result.frameCount, 2);
    assert.equal(result.pendingBytes, 0);
});

test('replay reframes archived bytes repeatedly without pruning on a changed interpretation', async () => {
    const capture = history();
    capture.append(Uint8Array.of(65, 13), { timestamp: 1000, arrival: 0, order: 2 });
    capture.append(Uint8Array.of(10, 66, 13, 10, 67), { timestamp: 1005, arrival: 5, order: 4 });
    const result = await historyModule.replayCaptureHistory(capture,
        { captureMode: 'text', channelsCount: 1, textBoundary: 'crlf', textEncoding: 'utf-8', idleGapSeconds: 0.01 }, 2);
    assert.equal(result.frameCount, 3);
    assert.deepEqual([...result.frames.frameAt(1).bytes], [67]);
    assert.equal(result.frames.frameAt(1).incomplete, true);
    assert.equal(capture.byteLength, 7);
    const second = await historyModule.replayCaptureHistory(capture,
        { captureMode: 'hex', channelsCount: 1, idleGapSeconds: 0.01 }, 10);
    assert.deepEqual([...second.frames.frameAt(0).bytes], [65, 13, 10, 66, 13, 10, 67]);
});

test('numeric replay retains the arrival of split float frames and exposes errors separately', async () => {
    const capture = history();
    capture.append(Uint8Array.of(0, 0), { timestamp: 1000, arrival: 0, order: 1 });
    capture.append(Uint8Array.of(128, 63, 42), { timestamp: 1005, arrival: 5, order: 2 });
    const result = await historyModule.replayCaptureHistory(capture,
        { captureMode: 'number', enableHeader: false, enableFooter: false, channelsCount: 1, dataType: 'float32' }, 10);
    assert.equal(result.frames.getValue(0, 0), 1);
    assert.equal(result.frames.timestampAt(0), 1000);
    assert.equal(result.frames.frameAt(0).byteOffset, 0);
    assert.equal(result.frames.frameAt(0).endByte, 4);
    assert.equal(result.errors.length, 1);
    assert.equal(result.errors[0].type, 'incomplete');
    assert.equal(result.errors[0].byteOffset, 4);
    assert.deepEqual([...result.errors[0].bytes], [42]);
});

test('large single chunks yield progress and can be cancelled before completing replay', async () => {
    const capture = history();
    capture.append(new Uint8Array(100000), { timestamp: 1000, arrival: 0 });
    const progress = [];
    let yields = 0;
    const result = await historyModule.replayCaptureHistory(capture,
        { captureMode: 'number', enableHeader: false, enableFooter: false, channelsCount: 1, dataType: 'uint8' }, 100,
        { maxSliceBytes: 1000, onProgress: state => progress.push(state.processedBytes),
            yieldControl: async () => { yields++; }, isCancelled: () => yields >= 2 });
    assert.equal(result.cancelled, true);
    assert.equal(yields, 2);
    assert.ok(result.processedBytes > 0 && result.processedBytes < 100000);
    assert.ok(progress.length >= 2);
    assert.equal(capture.byteLength, 100000);
});

test('unflushed replay returns a usable parser with pending bytes and no replay timers', async () => {
    const capture = history();
    capture.append(Uint8Array.of(65), { timestamp: 1000, arrival: 0 });
    const result = await historyModule.replayCaptureHistory(capture,
        { captureMode: 'text', textBoundary: 'lf', channelsCount: 1 }, 10, { flushPending: false });
    assert.equal(result.frames.length, 0);
    assert.equal(result.pendingBytes, 1);
    result.parser.appendData(Uint8Array.of(10), { timestamp: 1010, arrival: 10, byteOffset: 1, order: 2 });
    assert.deepEqual([...result.frames.frameAt(0).bytes], [65, 10]);
});

test('replay catches receive chunks appended during yields and streams each byte once', async () => {
    const capture = history();
    capture.append(Uint8Array.of(65, 10, 66, 10), { timestamp: 1000, arrival: 0, order: 3 });
    const streamed = [];
    let appended = false;
    const result = await historyModule.replayCaptureHistory(capture,
        { captureMode: 'text', channelsCount: 1, textBoundary: 'lf' }, 10,
        { onBytes: bytes => streamed.push(...bytes), yieldControl: async () => {
            if (!appended) {
                appended = true;
                capture.append(Uint8Array.of(67, 10), { timestamp: 1010, arrival: 10, order: 5 });
            }
        } });
    assert.deepEqual(streamed, [65, 10, 66, 10, 67, 10]);
    assert.equal(result.endByte, capture.endByte);
    assert.deepEqual(Array.from({ length: result.frames.length }, (_, i) => result.frames.orderAt(i)), [3, 3.5, 5]);
    assert.equal(result.frames.timestampAt(2), 1010);
});

test('clearing the original capture invalidates an in-flight replay', async () => {
    const capture = history();
    capture.append(new Uint8Array(100));
    const result = await historyModule.replayCaptureHistory(capture,
        { captureMode: 'number', channelsCount: 1, dataType: 'uint8', enableHeader: false }, 10,
        { maxSliceBytes: 10, yieldControl: async () => capture.clear() });
    assert.equal(result.cancelled, true);
    assert.equal(result.processedBytes, 10);
});

test('streaming replay observers cannot mutate the original capture or decoded data', async () => {
    const capture = history();
    capture.append(Uint8Array.of(7), { timestamp: 1000, arrival: 0 });
    const result = await historyModule.replayCaptureHistory(capture,
        { captureMode: 'number', channelsCount: 1, dataType: 'uint8', enableHeader: false }, 10,
        { onBytes: bytes => { bytes[0] = 99; } });
    assert.equal(capture.snapshot()[0].bytes[0], 7);
    assert.equal(result.frames.getValue(0, 0), 7);
});

test('pending-tail policy is evaluated after yields so pause and disconnect flush the rebuilt parser', async () => {
    const capture = history();
    capture.append(Uint8Array.of(65), { timestamp: 1000, arrival: 0 });
    let paused = false;
    const result = await historyModule.replayCaptureHistory(capture,
        { captureMode: 'text', channelsCount: 1, textBoundary: 'lf' }, 10,
        { flushPending: () => paused, yieldControl: async () => { paused = true; } });
    assert.equal(result.pendingBytes, 0);
    assert.equal(result.frames.frameAt(0).incomplete, true);

    const live = await historyModule.replayCaptureHistory(capture,
        { captureMode: 'text', channelsCount: 1, textBoundary: 'lf' }, 10,
        { flushPending: () => false });
    assert.equal(live.pendingBytes, 1);
    assert.equal(live.frames.length, 0);
});

test('numeric replay honors archived pause boundaries instead of joining disconnected partial frames', async () => {
    const capture = history();
    capture.append(Uint8Array.of(0, 0), { timestamp: 1000, arrival: 0, order: 1 });
    assert.equal(typeof capture.markBoundary, 'function');
    capture.markBoundary();
    capture.append(Uint8Array.of(0, 0, 128, 63), { timestamp: 1010, arrival: 10, order: 2 });
    const boundaries = [];
    const result = await historyModule.replayCaptureHistory(capture,
        { captureMode: 'number', channelsCount: 1, dataType: 'uint32', enableHeader: false }, 10,
        { onBoundary: checkpoint => boundaries.push(checkpoint.byteOffset) });
    assert.equal(result.frames.length, 1);
    assert.equal(result.frames.getValue(0, 0), 1065353216);
    assert.equal(result.frames.frameAt(0).byteOffset, 2);
    assert.deepEqual(result.errors.map(record => [record.type, ...record.bytes]), [['incomplete', 0, 0]]);
    assert.deepEqual(boundaries, [2]);
});

test('raw replay checkpoints flush newline tails and deduplicate repeated pause or disconnect events', async () => {
    const capture = history();
    capture.append(Uint8Array.of(65), { timestamp: 1000, arrival: 0, order: 1 });
    capture.markBoundary(); capture.markBoundary();
    capture.append(Uint8Array.of(66, 10), { timestamp: 1010, arrival: 10, order: 2 });
    const boundaries = [];
    const result = await historyModule.replayCaptureHistory(capture,
        { captureMode: 'text', channelsCount: 1, textBoundary: 'lf' }, 10,
        { onBoundary: checkpoint => boundaries.push(checkpoint.byteOffset), flushPending: false });
    assert.deepEqual(Array.from({ length: result.frames.length }, (_, i) => [...result.frames.rawBytesAt(i)]), [[65], [66, 10]]);
    assert.equal(result.frames.frameAt(0).incomplete, true);
    assert.equal(result.frames.frameAt(1).incomplete, false);
    assert.deepEqual(boundaries, [1]);
    capture.pruneBefore(2);
    const replayedBoundaries = [];
    await historyModule.replayCaptureHistory(capture,
        { captureMode: 'text', channelsCount: 1, textBoundary: 'lf' }, 10,
        { onBoundary: checkpoint => replayedBoundaries.push(checkpoint.byteOffset) });
    assert.deepEqual(replayedBoundaries, []);
});

test('checkpoints added during replay yields flush pending bytes before new arrivals', async () => {
    const capture = history();
    capture.append(Uint8Array.of(65), { timestamp: 1000, arrival: 0, order: 1 });
    let marked = false;
    const events = [];
    const result = await historyModule.replayCaptureHistory(capture,
        { captureMode: 'text', channelsCount: 1, textBoundary: 'lf' }, 10,
        { flushPending: false, onBytes: bytes => events.push([...bytes]),
            onBoundary: checkpoint => events.push(checkpoint.byteOffset), yieldControl: async () => {
                if (!marked) {
                    marked = true; capture.markBoundary();
                    capture.append(Uint8Array.of(66, 10), { timestamp: 1010, arrival: 10, order: 2 });
                }
            } });
    assert.deepEqual(events, [[65], 1, [66, 10]]);
    assert.deepEqual(Array.from({ length: result.frames.length }, (_, i) => [...result.frames.rawBytesAt(i)]), [[65], [66, 10]]);
    const onlyTail = history();
    onlyTail.append(Uint8Array.of(67));
    const tail = await historyModule.replayCaptureHistory(onlyTail,
        { captureMode: 'text', channelsCount: 1, textBoundary: 'lf' }, 10,
        { flushPending: false, yieldControl: async () => onlyTail.markBoundary() });
    assert.equal(tail.pendingBytes, 0);
    assert.equal(tail.frames.frameAt(0).incomplete, true);
});

test('incrementally pruning one large chunk copies a linear amount of backing bytes', () => {
    const capture = history();
    const originalSlice = Uint8Array.prototype.slice;
    let copiedBytes = 0;
    Uint8Array.prototype.slice = function(...args) {
        const result = originalSlice.apply(this, args);
        copiedBytes += result.length;
        return result;
    };
    try {
        capture.append(new Uint8Array(20000));
        for (let byteOffset = 1; byteOffset < 20000; byteOffset++) capture.pruneBefore(byteOffset);
        assert.equal(capture.byteLength, 1);
        assert.ok(copiedBytes < 40000, `partial pruning copied ${copiedBytes} bytes`);
        assert.equal(capture.snapshot()[0].startByte, 19999);
    } finally { Uint8Array.prototype.slice = originalSlice; }
});

test('replay resets partial frames when bounded archive eviction skips past its cursor', async () => {
    const capture = history({ maxBytes: 4 });
    capture.append(Uint8Array.of(1, 2, 3, 4), { timestamp: 1000, arrival: 0, order: 1 });
    let appended = false;
    const gaps = [];
    const result = await historyModule.replayCaptureHistory(capture,
        { captureMode: 'number', channelsCount: 1, dataType: 'uint32', enableHeader: false }, 10,
        { maxSliceBytes: 1, onGap: checkpoint => gaps.push(checkpoint.byteOffset),
            yieldControl: async () => {
                if (!appended) {
                    appended = true;
                    capture.append(Uint8Array.of(5, 6, 7, 8), { timestamp: 1010, arrival: 10, order: 2 });
                }
            } });
    assert.equal(result.frames.length, 1);
    assert.equal(result.frames.getValue(0, 0), 0x08070605);
    assert.deepEqual([...result.frames.rawBytesAt(0)], [5, 6, 7, 8]);
    assert.equal(result.frames.frameAt(0).byteOffset, 4);
    assert.deepEqual(result.errors, []);
    assert.deepEqual(gaps, [4]);
});

test('replay gap resets previously decoded frames and errors together with observer byte state', async () => {
    const capture = history({ maxBytes: 6 });
    capture.append(Uint8Array.of(1, 0xEE, 2, 3, 4, 5), { timestamp: 1000, arrival: 0, order: 1 });
    let appended = false;
    const observed = [];
    const result = await historyModule.replayCaptureHistory(capture,
        { captureMode: 'number', channelsCount: 1, dataType: 'uint8', enableHeader: false,
            enableFooter: true, footerHex: 'EE' }, 10,
        { maxSliceBytes: 4, onBytes: bytes => observed.push(...bytes), onGap: () => { observed.length = 0; },
            yieldControl: async () => {
                if (!appended) {
                    appended = true;
                    capture.append(Uint8Array.of(6, 0xEE, 7, 0xEE, 8, 0xEE),
                        { timestamp: 1010, arrival: 10, order: 2 });
                }
            } });
    assert.deepEqual(result.frames.channelSlice(0), [6, 7, 8]);
    assert.equal(result.frameCount, 3);
    assert.equal(result.failCount, 0);
    assert.deepEqual(result.errors, []);
    assert.deepEqual(observed, [6, 0xEE, 7, 0xEE, 8, 0xEE]);
});

test('incremental numeric replay resumes pending frames and streams only newly received bytes', async () => {
    const capture = history();
    const format = { captureMode: 'number', channelsCount: 1, dataType: 'float32', enableHeader: false };
    capture.append(Uint8Array.of(0, 0), { timestamp: 1000, arrival: 0, order: 1 });
    const observed = [];
    const options = { flushPending: false, onBytes: bytes => observed.push(...bytes) };
    const first = await historyModule.replayCaptureHistory(capture, format, 10, options);
    capture.append(Uint8Array.of(128, 63), { timestamp: 1010, arrival: 10, order: 2 });
    const second = await historyModule.replayCaptureHistory(capture, format, 10, { ...options, previousResult: first });
    assert.equal(second.frames, first.frames);
    assert.equal(second.parser, first.parser);
    assert.deepEqual(observed, [0, 0, 128, 63]);
    assert.equal(second.frames.getValue(0, 0), 1);
    assert.equal(second.frames.timestampAt(0), 1000);
    assert.equal(second.frameCount, 1);
    assert.equal(second.revision, capture.revision);
});

test('incremental raw replay processes boundary-only revisions once and preserves split character bytes', async () => {
    const capture = history();
    const format = { captureMode: 'text', channelsCount: 1, textBoundary: 'lf', textEncoding: 'utf-8' };
    capture.append(Uint8Array.of(0xE4), { timestamp: 1000, arrival: 0, order: 1 });
    const boundaries = [];
    const options = { flushPending: false, onBoundary: checkpoint => boundaries.push(checkpoint.byteOffset) };
    const first = await historyModule.replayCaptureHistory(capture, format, 10, options);
    capture.markBoundary();
    const second = await historyModule.replayCaptureHistory(capture, format, 10, { ...options, previousResult: first });
    assert.equal(second.frames, first.frames);
    assert.equal(second.frames.frameAt(0).streamEnded, true);
    assert.equal(second.revision, capture.revision);
    assert.equal(second.lastBoundaryByte, 1);
    capture.append(Uint8Array.of(0xB8, 0xAD, 10), { timestamp: 1010, arrival: 10, order: 2 });
    const third = await historyModule.replayCaptureHistory(capture, format, 10, { ...options, previousResult: second });
    assert.deepEqual(boundaries, [1]);
    assert.deepEqual(Array.from({ length: third.frames.length }, (_, i) => [...third.frames.rawBytesAt(i)]),
        [[0xE4], [0xB8, 0xAD, 10]]);
    assert.equal(third.frames.streamStartByteAt(1), 1);
});

test('pruning preserves the current stream origin for UTF-16 framing after an odd global boundary', async () => {
    const capture = history();
    capture.append(Uint8Array.of(0xFF));
    capture.markBoundary();
    capture.append(Uint8Array.of(65, 0, 13, 0, 10, 0, 66, 0));
    capture.pruneBefore(3);
    assert.equal(capture.streamStartByte, 1);
    const result = await historyModule.replayCaptureHistory(capture,
        { captureMode: 'text', channelsCount: 1, textBoundary: 'crlf', textEncoding: 'utf-16le' }, 10);
    assert.deepEqual(Array.from({ length: result.frames.length }, (_, i) => [...result.frames.rawBytesAt(i)]),
        [[13, 0, 10, 0], [66, 0]]);
    assert.equal(result.frames.streamStartByteAt(0), 1);
});

test('a checkpoint ends an already emitted raw frame when no pending bytes remain', async () => {
    const capture = history();
    const format = { captureMode: 'text', channelsCount: 1, textBoundary: 'lf' };
    capture.append(Uint8Array.of(0xE4, 10));
    const first = await historyModule.replayCaptureHistory(capture, format, 10, { flushPending: false });
    assert.equal(first.pendingBytes, 0);
    assert.equal(first.frames.streamEndedAt(0), false);
    capture.markBoundary();
    const second = await historyModule.replayCaptureHistory(capture, format, 10,
        { flushPending: false, previousResult: first });
    assert.equal(second.frames.length, 1);
    assert.equal(second.frames.streamEndedAt(0), true);
});

test('a fixed replay snapshot finishes while data arrives at every yield and resumes without duplicate frames', async () => {
    const capture = history();
    capture.append(Uint8Array.of(1, 2));
    const format = { captureMode: 'number', channelsCount: 1, dataType: 'uint8', enableHeader: false };
    let yields = 0;
    const first = await historyModule.replayCaptureHistory(capture, format, 10, {
        stopByte: capture.endByte, maxSliceBytes: 1, flushPending: false,
        yieldControl: async () => { capture.append(Uint8Array.of(3 + yields++)); }
    });
    assert.equal(yields, 2);
    assert.equal(first.endByte, 2);
    assert.deepEqual(first.frames.channelSlice(0), [1, 2]);
    const presented = [];
    first.parser.onFrameParsed = (values, time, bytes, timestamp, metadata) => {
        presented.push(values[0]);
        first.frames.append(values, bytes, time, metadata.order, timestamp, metadata);
    };
    const second = await historyModule.replayCaptureHistory(capture, format, 10, {
        previousResult: first, stopByte: capture.endByte, preserveCallbacks: true, flushPending: false
    });
    assert.deepEqual(presented, [3, 4]);
    assert.deepEqual(second.frames.channelSlice(0), [1, 2, 3, 4]);
    assert.equal(second.endByte, capture.endByte);
});

test('pausing after a snapshot keeps partial frames joined until the actual archived boundary', async () => {
    const capture = history();
    capture.append(Uint8Array.of(65));
    const format = { captureMode: 'text', channelsCount: 1, textBoundary: 'lf' };
    const first = await historyModule.replayCaptureHistory(capture, format, 10, {
        stopByte: capture.endByte, flushPending: true,
        yieldControl: async () => { capture.append(Uint8Array.of(66)); capture.markBoundary(); }
    });
    assert.equal(first.frames.length, 0);
    assert.equal(first.pendingBytes, 1);
    const second = await historyModule.replayCaptureHistory(capture, format, 10, {
        previousResult: first, stopByte: capture.endByte, flushPending: true
    });
    assert.equal(second.frames.length, 1);
    assert.deepEqual([...second.frames.rawBytesAt(0)], [65, 66]);
    assert.equal(second.frames.frameAt(0).streamEnded, true);
});

test('bounded history ranges split at stream boundaries and keep the original UTF-16 origin', () => {
    const capture = history();
    capture.append(Uint8Array.of(1, 2, 3)); capture.markBoundary();
    capture.append(Uint8Array.of(65, 0, 66, 0)); capture.markBoundary();
    capture.append(Uint8Array.of(9));
    assert.equal(typeof capture.readRange, 'function');
    const rows = [...capture.readRange(1, 7, { maxSliceBytes: 2 })];
    assert.deepEqual(rows.map(row => [row.byteOffset, row.endByte, row.streamStartByte, row.streamEnded, ...row.bytes]),
        [[1, 3, 0, true, 2, 3], [3, 5, 3, false, 65, 0], [5, 7, 3, true, 66, 0]]);
});

test('batched numeric replay joins asynchronous decoding in source order and returns a live parser', async () => {
    const capture = history();
    capture.append(Uint8Array.from({ length: 18 }, (_, i) => i + 1));
    const calls = [];
    const { decodeNumericPayload } = require('../numericCodec');
    const decodeBatch = async (records, format) => {
        calls.push(records.length);
        await new Promise(resolve => setTimeout(resolve, records[0].bytes[0] === 1 ? 10 : 0));
        const out = new Float64Array(records.length * format.channelsCount);
        records.forEach((record, i) => decodeNumericPayload(new DataView(record.bytes.buffer),
            format.dataType, true, format.channelsCount, out, i * format.channelsCount));
        return out;
    };
    const result = await historyModule.replayCaptureHistory(capture,
        { captureMode: 'number', channelsCount: 2, dataType: 'uint8', enableHeader: false }, 7,
        { stopByte: capture.endByte, decodeBatch, maxDecodeFrames: 2, maxPendingDecodes: 3, flushPending: false });
    assert.ok(calls.length > 1);
    assert.deepEqual(result.frames.channelSlice(0), [5, 7, 9, 11, 13, 15, 17]);
    assert.deepEqual(result.frames.channelSlice(1), [6, 8, 10, 12, 14, 16, 18]);
    assert.equal(result.parser.decodeValues, true);
    let liveValues;
    result.parser.onFrameParsed = values => { liveValues = values; };
    result.parser.appendData(Uint8Array.of(19, 20));
    assert.deepEqual(liveValues, [19, 20]);
});
