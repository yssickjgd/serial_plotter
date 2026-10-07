const test = require('node:test');
const assert = require('node:assert/strict');
const { TextCharacterCounter, CHARSETS } = require('../textCodec');

let countCaptureText;
try { ({ countCaptureText } = require('../textHistory')); }
catch (error) { if (error.code !== 'MODULE_NOT_FOUND') throw error; }

function historyFromStreams(streams, { startByte = 0, streamStartByte = 0, chunkSize = 13 } = {}) {
    const spans = [];
    let cursor = startByte, origin = streamStartByte;
    for (const { bytes, ended = false } of streams) {
        for (let offset = 0; offset < bytes.length; offset += chunkSize) {
            const length = Math.min(chunkSize, bytes.length - offset);
            spans.push({ bytes: bytes.subarray(offset, offset + length), byteOffset: cursor,
                endByte: cursor + length, streamStartByte: origin,
                streamEnded: ended && offset + length === bytes.length });
            cursor += length;
        }
        if (!bytes.length && ended) spans.push({ bytes, byteOffset: cursor, endByte: cursor,
            streamStartByte: origin, streamEnded: true });
        if (ended) origin = cursor;
    }
    return { startByte, endByte: cursor, streamStartByte,
        snapshot() { throw new Error('Counting must not clone the archive'); },
        *readRange(start, end, { maxSliceBytes }) {
            assert.equal(maxSliceBytes, 65536);
            for (const span of spans) {
                if (!span.bytes.length) {
                    if (span.byteOffset >= start && span.byteOffset <= end) yield span;
                    continue;
                }
                const from = Math.max(start, span.byteOffset), to = Math.min(end, span.endByte);
                for (let offset = from; offset < to; offset += maxSliceBytes) {
                    const next = Math.min(offset + maxSliceBytes, to);
                    yield { ...span, bytes: span.bytes.subarray(offset - span.byteOffset, next - span.byteOffset),
                        byteOffset: offset, endByte: next, streamEnded: span.streamEnded && next === span.endByte };
                }
            }
        } };
}

function localPool({ maxWorkers = 3, delay = () => 0, onTask = () => {} } = {}) {
    const stats = { active: 0, peak: 0, tasks: 0, largest: 0 };
    return { available: true, maxWorkers, stats,
        async runTask(task) {
            assert.equal(task.kind, 'text-count');
            assert.ok(task.bytes instanceof Uint8Array);
            assert.ok(task.pending === null || Array.isArray(task.pending));
            const index = stats.tasks++;
            stats.active++;
            stats.peak = Math.max(stats.peak, stats.active);
            stats.largest = Math.max(stats.largest, task.bytes.length);
            onTask(task, index);
            await new Promise(resolve => setTimeout(resolve, delay(index)));
            const counter = new TextCharacterCounter(task.encoding, { byteOffset: task.byteOffset });
            if (task.pending !== null) counter.decoder.pending = task.pending.map(entry => ({ ...entry }));
            if (task.orphanByte !== undefined) counter.decoder.orphanByte = task.orphanByte;
            counter.write(task.bytes);
            if (task.flush) counter.flush();
            stats.active--;
            return { total: counter.total, failed: counter.failed,
                pending: counter.decoder.pending.map(entry => ({ ...entry })), orphanByte: counter.decoder.orphanByte };
        } };
}

function serialCount(history, encoding, { startByte = history.startByte, endByte = history.endByte,
    flushPending = true } = {}) {
    const counter = new TextCharacterCounter(encoding, { byteOffset: startByte - history.streamStartByte });
    let origin = history.streamStartByte;
    for (const span of history.readRange(startByte, endByte, { maxSliceBytes: 65536 })) {
        if (span.streamStartByte !== origin) {
            counter.flush();
            counter.decoder = new TextCharacterCounter(encoding,
                { byteOffset: span.byteOffset - span.streamStartByte }).decoder;
            origin = span.streamStartByte;
        }
        counter.write(span.bytes);
        if (span.streamEnded) {
            counter.flush();
            counter.decoder = new TextCharacterCounter(encoding).decoder;
            origin = span.endByte;
        }
    }
    if (flushPending) counter.flush();
    return counter;
}

function assertCounter(actual, expected, label) {
    assert.ok(actual instanceof TextCharacterCounter, label);
    assert.deepEqual({ total: actual.total, failed: actual.failed },
        { total: expected.total, failed: expected.failed }, label);
    assert.deepEqual(actual.decoder.pending.map(entry => entry.value),
        expected.decoder.pending.map(entry => entry.value), `${label}: pending bytes`);
    assert.equal(actual.decoder.orphanByte, expected.decoder.orphanByte, `${label}: alignment`);
}

test('historical text counting returns a live counter with exact Unicode and failure counts', async () => {
    assert.equal(typeof countCaptureText, 'function');
    const history = historyFromStreams([{ bytes: Uint8Array.of(0xe4, 0xb8, 0xad, 0xf0, 0x9f, 0x98,
        0x80, 0, 0xff, 0x0d, 0x0a, 0x09, 0xe4, 0xb8) }], { chunkSize: 2 });
    const counter = await countCaptureText(history, { textEncoding: 'utf-8' }, localPool(),
        { flushPending: false, maxBatchBytes: 5 });
    assert.deepEqual({ total: counter.total, failed: counter.failed }, { total: 7, failed: 2 });
    assert.deepEqual(counter.write(Uint8Array.of(0xad)), { total: 8, failed: 2 });
});

test('worker partitions match serial decoding for arbitrary invalid bytes in every charset', async () => {
    assert.equal(typeof countCaptureText, 'function');
    let seed = 4127;
    const bytes = Uint8Array.from({ length: 4099 }, () => {
        seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
        return seed >>> 24;
    });
    for (const encoding of CHARSETS) {
        for (const flushPending of [false, true]) {
            const history = historyFromStreams([{ bytes }], { chunkSize: 17 });
            const pool = localPool();
            const actual = await countCaptureText(history, { textEncoding: encoding }, pool,
                { flushPending, maxBatchBytes: 127 });
            const expected = serialCount(history, encoding, { flushPending });
            assertCounter(actual, expected, `${encoding}/${flushPending}`);
            actual.write(Uint8Array.of(0x41, 0, 0xad));
            expected.write(Uint8Array.of(0x41, 0, 0xad));
            assertCounter(actual, expected, `${encoding} continued`);
            assert.ok(pool.stats.largest <= 127);
        }
    }
});

test('pause boundaries flush partial characters and reset UTF16 stream alignment', async () => {
    assert.equal(typeof countCaptureText, 'function');
    for (const encoding of CHARSETS) {
        const history = historyFromStreams([
            { bytes: Uint8Array.of(0x81, 0xe4, 0xb8), ended: true },
            { bytes: new Uint8Array(), ended: true },
            { bytes: Uint8Array.of(0xad, 0x3d, 0xd8, 0), ended: true },
            { bytes: Uint8Array.of(0x41, 0, 0xe4) }
        ], { chunkSize: 1 });
        const options = { flushPending: false, maxBatchBytes: 2 };
        assertCounter(await countCaptureText(history, { textEncoding: encoding }, localPool(), options),
            serialCount(history, encoding, options), encoding);
    }
});

test('retained odd UTF16 prefixes preserve the original stream origin after pruning', async () => {
    assert.equal(typeof countCaptureText, 'function');
    for (const encoding of ['utf-16le', 'utf-16be']) {
        const bytes = encoding === 'utf-16le'
            ? Uint8Array.of(0x4e, 0x3d, 0xd8, 0, 0xde, 0x41, 0, 0x3d, 0xd8, 0)
            : Uint8Array.of(0x2d, 0xd8, 0x3d, 0xde, 0, 0, 0x41, 0xd8, 0x3d, 0);
        const history = historyFromStreams([{ bytes }], { startByte: 7, streamStartByte: 2, chunkSize: 1 });
        const options = { flushPending: false, maxBatchBytes: 3 };
        const actual = await countCaptureText(history, { textEncoding: encoding }, localPool(), options);
        const expected = serialCount(history, encoding, options);
        assertCounter(actual, expected, encoding);
        const tail = encoding === 'utf-16le' ? Uint8Array.of(0xde) : Uint8Array.of(0xde);
        actual.write(tail); expected.write(tail);
        assertCounter(actual, expected, `${encoding} resumed`);
    }
});

test('UTF16 dependent jobs never mistake a split high surrogate for a pruned orphan byte', async () => {
    for (const encoding of ['utf-16le', 'utf-16be']) {
        const bytes = encoding === 'utf-16le'
            ? Uint8Array.of(0x3d, 0xd8, 0x3d, 0xd8, 0x3d, 0xd8, 0, 0xde)
            : Uint8Array.of(0xd8, 0x3d, 0xd8, 0x3d, 0xd8, 0x3d, 0xde, 0);
        for (const maxBatchBytes of [1, 3]) {
            const history = historyFromStreams([{ bytes }], { chunkSize: 1 });
            const counter = await countCaptureText(history, { textEncoding: encoding }, localPool(),
                { flushPending: false, maxBatchBytes });
            assert.deepEqual({ total: counter.total, failed: counter.failed }, { total: 3, failed: 2 },
                `${encoding}/${maxBatchBytes}`);
            assert.deepEqual(counter.decoder.pending, []);
        }
    }
});

test('legacy records without safe anchors use bounded dependent jobs without inventing failures', async () => {
    assert.equal(typeof countCaptureText, 'function');
    const samples = [
        ['gbk', [0xd6, 0xd0]], ['gb18030', [0x94, 0x39, 0xfc, 0x36]],
        ['big5', [0xa4, 0xa4]], ['shift_jis', [0x82, 0xa0]]
    ];
    for (const [encoding, unit] of samples) {
        const bytes = Uint8Array.from({ length: 12001 }, (_, index) => unit[index % unit.length]);
        const history = historyFromStreams([{ bytes }], { chunkSize: 89 });
        const pool = localPool();
        const options = { flushPending: false, maxBatchBytes: 251 };
        assertCounter(await countCaptureText(history, { textEncoding: encoding }, pool, options),
            serialCount(history, encoding, options), encoding);
        assert.ok(pool.stats.tasks > 40, encoding);
        assert.ok(pool.stats.largest <= 251, encoding);
    }
});

test('independent text ranges occupy the worker budget and reduce completed jobs in byte order', async () => {
    assert.equal(typeof countCaptureText, 'function');
    const history = historyFromStreams([{ bytes: new Uint8Array(8192).fill(0x41) }], { chunkSize: 8192 });
    const pool = localPool({ maxWorkers: 4, delay: index => index % 4 === 0 ? 8 : 0 });
    const progress = [];
    const actual = await countCaptureText(history, { textEncoding: 'ascii' }, pool,
        { maxBatchBytes: 256, onProgress: event => progress.push(event.processedBytes) });
    assert.deepEqual({ total: actual.total, failed: actual.failed }, { total: 8192, failed: 0 });
    assert.equal(pool.stats.peak, 4);
    assert.ok(progress.length > 1);
    assert.ok(progress.every((value, index) => index === 0 || value >= progress[index - 1]));
    assert.equal(progress.at(-1), 8192);
});

test('cancellation stops scheduling more work and discards its historical result', async () => {
    assert.equal(typeof countCaptureText, 'function');
    const history = historyFromStreams([{ bytes: new Uint8Array(65536).fill(0x41) }], { chunkSize: 65536 });
    let cancelled = false;
    const pool = localPool({ onTask: () => { cancelled = true; } });
    const result = await countCaptureText(history, { textEncoding: 'ascii' }, pool,
        { maxBatchBytes: 128, isCancelled: () => cancelled });
    assert.equal(result, null);
    assert.ok(pool.stats.tasks <= pool.maxWorkers);
    assert.equal(await countCaptureText(history, { textEncoding: 'ascii' }, pool,
        { isCancelled: () => true }), null);
});

test('fixed snapshot limits exclude appended bytes and optional ranges retain UTF16 alignment', async () => {
    assert.equal(typeof countCaptureText, 'function');
    const history = historyFromStreams([{ bytes: Uint8Array.of(0x41, 0, 0x42, 0, 0x43, 0, 0x44, 0) }]);
    const options = { startByte: 1, endByte: 7, flushPending: false, maxBatchBytes: 2 };
    assertCounter(await countCaptureText(history, { textEncoding: 'utf-16le' }, localPool(), options),
        serialCount(history, 'utf-16le', options), 'snapshot range');
});

test('unavailable workers preserve exact counts and continuation state with bounded main thread slices', async () => {
    assert.equal(typeof countCaptureText, 'function');
    const bytes = Uint8Array.of(0xe4, 0xb8, 0xad, 0, 0xf0, 0x9f);
    const history = historyFromStreams([{ bytes }]);
    const options = { flushPending: false };
    assertCounter(await countCaptureText(history, { textEncoding: 'utf-8' }, { available: false }, options),
        serialCount(history, 'utf-8', options), 'fallback');
});

test('final tail policy is evaluated after outstanding worker jobs so pause and resume keep the right state', async () => {
    const history = historyFromStreams([{ bytes: Uint8Array.of(0xe4, 0xb8) }]);
    for (const initiallyPaused of [false, true]) {
        let paused = initiallyPaused;
        const pool = localPool({ onTask: () => { paused = !initiallyPaused; } });
        const counter = await countCaptureText(history, { textEncoding: 'utf-8' }, pool,
            { flushPending: () => paused });
        assert.deepEqual({ total: counter.total, failed: counter.failed },
            initiallyPaused ? { total: 0, failed: 0 } : { total: 2, failed: 2 });
        assert.deepEqual(counter.decoder.pending.map(entry => entry.value), initiallyPaused ? [0xe4, 0xb8] : []);
    }
});

test('ordered worker reductions retain counts beyond signed 32 bit limits', async () => {
    assert.equal(typeof countCaptureText, 'function');
    const history = historyFromStreams([{ bytes: new Uint8Array(32).fill(0x41) }]);
    const pool = { available: true, maxWorkers: 3,
        async runTask() { return { total: 2147483648, failed: 1, pending: [], orphanByte: false }; } };
    const counter = await countCaptureText(history, { textEncoding: 'ascii' }, pool, { maxBatchBytes: 4 });
    assert.deepEqual({ total: counter.total, failed: counter.failed }, { total: 17179869184, failed: 8 });
});
