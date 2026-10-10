const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { CaptureService } = fs.existsSync(require('node:path').join(__dirname, '../captureService.js'))
    ? require('../captureService') : {};
const numericFormat = { captureMode: 'number', enableHeader: false, enableFooter: false,
    dataType: 'uint8', channelsCount: 1, isLittleEndian: true };
function service(options = {}) {
    assert.equal(typeof CaptureService, 'function', 'shared acquisition service must be available');
    return new CaptureService({ numericFormat, now: () => 0,
        setTimeout: () => 0, clearTimeout: () => {}, ...options });
}
const bytes = source => Array.from({ length: source.frames.length }, (_, i) => [...source.frames.rawBytesAt(i)]);

test('one-kilohertz numeric input retains every raw byte with per-source frame capacity', t => {
    const s = service({ capacity: 1000, numericFormat: { ...numericFormat, dataType: 'float32', channelsCount: 23 } });
    t.after(() => s.dispose());
    const hex = s.acquireSource({ captureMode: 'hex' }), text = s.acquireSource({ captureMode: 'text', textBoundary: 'idle' });
    assert.equal(hex, text);
    const data = new Uint8Array(23 * 4), view = new DataView(data.buffer);
    for (let c = 0; c < 23; c++) view.setFloat32(c * 4, c / 2, true);
    for (let i = 0; i < 1500; i++) s.receive(data, { arrival: i, timestamp: 1700000000000 + i });
    s.endStream();
    assert.equal(hex.frames.length, 1000); assert.equal(s.numericSource.frames.length, 1000);
    assert.equal(hex.frames.rawByteOffsetAt(0), 500 * 92);
    assert.equal(hex.frames.retainedByteLength, 1000 * 92);
    for (let i = 0; i < 1000; i++) assert.deepEqual(hex.frames.rawBytesAt(i), data);
    s.clear();
    for (let i = 0; i < 300; i++) s.receive(data, { arrival: i * .5, timestamp: 1700000000000 + i });
    assert.equal(hex.frames.length, 0, 'continuous arrivals shorter than the idle gap are a pending raw record');
    s.endStream();
    assert.equal(hex.frames.length, 1); assert.equal(hex.frames.retainedByteLength, 300 * 92);
});

test('large-capacity idle history preserves batched 23-channel frames and 1024-byte segments', t => {
    const s = service({ capacity: 3600000, maxRawFrameBytes: 1024,
        numericFormat: { ...numericFormat, dataType: 'float32', channelsCount: 23,
            enableFooter: true, footerHex: '00 00 80 7F' } });
    t.after(() => s.dispose());
    const hex = s.acquireSource({ captureMode: 'hex' });
    const text = s.acquireSource({ captureMode: 'text', textEncoding: 'ascii', textBoundary: 'idle' });
    assert.equal(hex, text);
    const frame = new Uint8Array(96), data = new DataView(frame.buffer);
    for (let c = 0; c < 23; c++) data.setFloat32(c * 4, c / 2, true);
    frame.set([0, 0, 128, 127], 92);
    const block = new Uint8Array(288);
    for (let i = 0; i < 3; i++) block.set(frame, i * frame.length);
    for (const interval of [3, .5]) {
        s.clear();
        for (let i = 0; i < 3000; i++) s.receive(block, { arrival: i * interval, timestamp: 1700000000000 + i });
        s.endStream();
        assert.equal(s.numericSource.frames.length, 9000);
        assert.equal(hex.frames.length, interval === 3 ? 3000 : Math.ceil(864000 / 1024));
        assert.equal(hex.frames.retainedByteLength, 864000);
        let offset = 0;
        for (let i = 0; i < hex.frames.length; i++) {
            const bytes = hex.frames.rawBytesAt(i);
            assert.ok(bytes.length <= 1024);
            assert.equal(hex.frames.rawByteOffsetAt(i), offset);
            for (const byte of bytes) assert.equal(byte, frame[offset++ % frame.length]);
        }
        assert.equal(offset, 864000);
    }
});

test('numeric widgets share derived samples once and parser replay rebuilds computation', async t => {
    const s = service({ channelDefinitions: [{ number: 2, type: 'formula', expression: 'int(CH01)' }] });
    t.after(() => s.dispose());
    const a = s.acquireSource(numericFormat), b = s.acquireSource(numericFormat);
    s.receive(Uint8Array.of(1, 2, 3));
    assert.equal(a.frames, b.frames);
    assert.deepEqual(a.frames.channelSlice(1), [1, 3, 6]);
    await s.updateChannelDefinitions([{ number: 2, type: 'formula', expression: 'int(CH01*2)' }], { rebuild: false });
    s.receive(Uint8Array.of(4));
    assert.deepEqual(a.frames.channelSlice(1), [1, 3, 6, 8]);
    await s.updateNumericFormat(numericFormat);
    assert.deepEqual(a.frames.channelSlice(1), [2, 6, 12, 20]);
    assert.deepEqual(a.frames.channelSlice(0), [1, 2, 3, 4]);
    assert.deepEqual(bytes(a), [[1], [2], [3], [4]]);
});

test('shared numeric endianness applies to initial parsing and format changes', async t => {
    const s = service({ numericFormat: { captureMode: 'number', enableHeader: false,
        dataType: 'uint16', channelsCount: 1, endianness: 'big' } });
    t.after(() => s.dispose());
    s.receive(Uint8Array.of(1, 2));
    assert.deepEqual(s.numericSource.frames.channelSlice(0), [258]);
    await s.updateNumericFormat({ endianness: 'little' });
    assert.deepEqual(s.numericSource.frames.channelSlice(0), [513]);
    await s.updateNumericFormat({ endianness: 'big' });
    assert.deepEqual(s.numericSource.frames.channelSlice(0), [258]);
    await s.updateNumericFormat({ isLittleEndian: true });
    assert.deepEqual(s.numericSource.frames.channelSlice(0), [513]);
});

test('capture runs with zero widgets and shared sources count each received byte once', async t => {
    const s = service(); t.after(() => s.dispose());
    s.receive(Uint8Array.of(1, 2, 3)); s.endStream();
    assert.equal(s.stats.rxBytes, 3);
    assert.deepEqual(s.numericSource.frames.channelSlice(0), [1, 2, 3]);
    assert.deepEqual(bytes(s.baseSource), [[1, 2, 3]]);
    const a = s.acquireSource({ captureMode: 'text', textBoundary: 'idle', textEncoding: 'ascii' });
    const b = s.acquireSource({ captureMode: 'hex', idleGapSeconds: 0.001 });
    assert.equal(a, b);
    assert.equal(s.acquireSource(numericFormat), s.numericSource);
    s.appendTx(Uint8Array.of(9), 500);
    assert.equal(s.stats.txBytes, 1);
    assert.equal(s.txFrames.frameAt(0).kind, 'tx');
});

test('independent replay catches arriving bytes exactly once while other sources remain live', async t => {
    let release; const gate = new Promise(resolve => { release = resolve; });
    const s = service({ yieldControl: () => gate }); t.after(() => s.dispose());
    s.receive(Uint8Array.of(65, 10));
    const source = s.acquireSource({ captureMode: 'text', textBoundary: 'lf' });
    assert.equal(source.rebuilding, true);
    s.receive(Uint8Array.of(66, 10));
    assert.deepEqual(s.numericSource.frames.channelSlice(0), [65, 10, 66, 10]);
    release(); await source.ready;
    assert.deepEqual(bytes(source), [[65, 10], [66, 10]]);
    s.receive(Uint8Array.of(67, 10));
    assert.deepEqual(bytes(source), [[65, 10], [66, 10], [67, 10]]);
    assert.ok(source.frames.orderAt(0) < source.frames.orderAt(1));
});

test('numeric changes preserve raw sources and stable frame buffer identity', async t => {
    const s = service(); t.after(() => s.dispose());
    s.receive(Uint8Array.of(1, 2, 3, 4)); s.endStream();
    const frames = s.numericSource.frames;
    const rawVersion = s.baseSource.frames.version;
    await s.updateNumericFormat({ ...numericFormat, dataType: 'uint16' });
    assert.equal(s.numericSource.frames, frames);
    assert.deepEqual(frames.channelSlice(0), [513, 1027]);
    assert.equal(s.baseSource.frames.version, rawVersion);
    await s.updateNumericFormat(numericFormat, { rebuild: false });
    assert.equal(frames.length, 0);
    assert.deepEqual(bytes(s.baseSource), [[1, 2, 3, 4]]);
});

test('future-only sources share a start position and never consume earlier partial frames', async t => {
    const s = service({ rebuildHistory: false }); t.after(() => s.dispose());
    s.receive(Uint8Array.of(65));
    const a = s.acquireSource({ captureMode: 'text', textBoundary: 'lf' });
    const b = s.acquireSource({ captureMode: 'text', textBoundary: 'lf', textEncoding: 'ascii' });
    assert.equal(a, b);
    s.receive(Uint8Array.of(66, 10));
    assert.deepEqual(bytes(a), [[66, 10]]);
    s.releaseSource(a); s.releaseSource(b);
    assert.equal(s.sources.has(a), false);
});

test('capacity applies to all windows and archive keeps the oldest pending source', async t => {
    const s = service({ capacity: 4, maxRawFrameBytes: 3 }); t.after(() => s.dispose());
    const line = s.acquireSource({ captureMode: 'text', textBoundary: 'lf' }); await line.ready;
    s.receive(Uint8Array.of(1, 2, 3, 4, 5, 6, 7));
    for (let i = 0; i < 4; i++) s.appendTx(Uint8Array.of(i));
    s.setCapacity(2); s.endStream();
    assert.deepEqual(bytes(line), [[4, 5, 6], [7]]);
    assert.equal(line.frames.frameAt(0).endReason, 'limit');
    assert.equal(s.numericSource.frames.length, 2);
    assert.equal(s.txFrames.length, 2);
    assert.equal(s.history.startByte, 3);
});

test('text counters are shared, incremental and preserve multibyte characters across forced segments', async t => {
    const s = service({ maxRawFrameBytes: 2 }); t.after(() => s.dispose());
    s.receive(Uint8Array.of(0xe4, 0xb8));
    const counts = s.getTextStats(s.baseSource, 'utf-8'); await counts.ready;
    assert.equal(counts.total, 0);
    s.receive(Uint8Array.of(0xad, 65)); s.endStream();
    assert.equal(s.getTextStats(s.baseSource, 'utf-8'), counts);
    assert.deepEqual([counts.total, counts.failed], [2, 0]);
    s.receive(Uint8Array.of(0xe4)); s.pause(true);
    assert.deepEqual([counts.total, counts.failed], [3, 1]);
});

test('clear invalidates replay and callback failures cannot stop other capture pipelines', async t => {
    let release; const gate = new Promise(resolve => { release = resolve; });
    const s = service({ yieldControl: () => gate, onChange: () => { throw new Error('view'); } });
    t.after(() => s.dispose());
    s.receive(Uint8Array.of(65, 10));
    const source = s.acquireSource({ captureMode: 'text', textBoundary: 'lf' });
    const old = source.ready;
    s.clear(); release(); await old;
    s.receive(Uint8Array.of(66, 10));
    assert.deepEqual(bytes(source), [[66, 10]]);
    assert.equal(s.stats.rxBytes, 2);
    assert.equal(s.workerPool.disposed, false);
});

test('pause ignores received history but counts transport bytes and retains TX frames', t => {
    const s = service(); t.after(() => s.dispose());
    s.receive(Uint8Array.of(1)); s.pause(true);
    s.receive(Uint8Array.of(2, 3)); s.appendTx(Uint8Array.of(4));
    assert.equal(s.stats.rxBytes, 3);
    assert.equal(s.history.endByte, 1);
    assert.deepEqual([...s.txFrames.rawBytesAt(0)], [4]);
    s.pause(false); s.receive(Uint8Array.of(5));
    assert.deepEqual(s.numericSource.frames.channelSlice(0), [1, 5]);
});

test('raw limit changes preserve numeric frames and expose segmentation metadata after replay', async t => {
    const s = service(); t.after(() => s.dispose());
    s.receive(Uint8Array.of(1, 2, 3, 4, 5)); s.endStream();
    const numericVersion = s.numericSource.frames.version;
    await s.setMaxRawFrameBytes(2);
    assert.deepEqual(bytes(s.baseSource), [[1, 2], [3, 4], [5]]);
    assert.equal(s.baseSource.frames.frameAt(0).endReason, 'limit');
    assert.equal(s.baseSource.frames.frameAt(0).segmented, true);
    assert.equal(s.numericSource.frames.version, numericVersion);
});

test('releasing one replay leaves another source and the global worker pool usable', async t => {
    let release; const gate = new Promise(resolve => { release = resolve; });
    const s = service({ yieldControl: () => gate }); t.after(() => s.dispose());
    s.receive(Uint8Array.of(65, 10, 66, 13));
    const a = s.acquireSource({ captureMode: 'text', textBoundary: 'lf' });
    const b = s.acquireSource({ captureMode: 'text', textBoundary: 'cr' });
    s.releaseSource(a); release(); await Promise.all([a.ready, b.ready]);
    assert.equal(s.workerPool.disposed, false);
    assert.deepEqual(bytes(b), [[65, 10, 66, 13]]);
    s.receive(Uint8Array.of(67, 13));
    assert.deepEqual(bytes(b), [[65, 10, 66, 13], [67, 13]]);
});

test('each frame in one receive block has a unique monotonic order through replay', async t => {
    const s = service(); t.after(() => s.dispose());
    s.receive(Uint8Array.of(65, 10, 66, 10, 67, 10)); s.endStream();
    const a = s.acquireSource({ captureMode: 'text', textBoundary: 'lf' }); await a.ready;
    assert.deepEqual(Array.from({ length: a.frames.length }, (_, i) => a.frames.orderAt(i)), [1, 1 + 2 / 6, 1 + 4 / 6]);
    s.appendTx(Uint8Array.of(9)); s.receive(Uint8Array.of(68, 10));
    assert.ok(a.frames.orderAt(3) > s.txFrames.orderAt(0));
});

test('numeric errors have display metadata and remain bounded while raw capture continues', t => {
    const s = service({ capacity: 2, numericFormat: { ...numericFormat, enableHeader: true,
        headerHex: 'AB', enableFooter: true, footerHex: 'CD' } });
    t.after(() => s.dispose());
    for (let i = 0; i < 4; i++) s.receive(Uint8Array.of(0xab, 1, 0), { timestamp: 100 + i });
    s.endStream();
    assert.ok(s.numericSource.errors.length > 0 && s.numericSource.errors.length <= 2);
    for (const error of s.numericSource.errors) {
        assert.equal(typeof error.order, 'number');
        assert.equal(typeof error.timestamp, 'number');
        assert.equal(typeof error.reason, 'string');
        assert.equal(error.kind, 'error');
    }
    assert.equal(bytes(s.baseSource).flat().length, 12);
});

test('closing the last user of a text count cancels its scan and releases its archive pin', async t => {
    const s = service({ capacity: 2, maxRawFrameBytes: 1 }); t.after(() => s.dispose());
    const source = s.acquireSource({ captureMode: 'text', textBoundary: 'lf' });
    s.receive(Uint8Array.of(65, 10));
    const counts = s.getTextStats(source, 'ascii');
    s.releaseSource(source);
    await counts.ready;
    s.receive(Uint8Array.of(66, 67, 68, 69)); s.endStream();
    assert.equal(s.textStats.size, 0);
    assert.equal(s.history.startByte, 4);
});

test('last text view release drops decoding statistics while persistent base capture continues', async t => {
    const s = service(); t.after(() => s.dispose());
    const source = s.acquireSource({ captureMode: 'hex' });
    const counts = s.getTextStats(source, 'ascii'); await counts.ready;
    s.releaseSource(source);
    s.receive(Uint8Array.of(65)); s.endStream();
    assert.equal(s.textStats.size, 0);
    assert.deepEqual(bytes(s.baseSource), [[65]]);
});

test('character counting catches arrivals during the historical scan exactly once', async t => {
    const s = service(); t.after(() => s.dispose());
    s.receive(Uint8Array.of(0xe4));
    const counts = s.getTextStats(s.baseSource, 'utf-8');
    s.receive(Uint8Array.of(0xb8, 0xad, 65)); s.endStream();
    await counts.ready;
    assert.deepEqual([counts.total, counts.failed], [2, 0]);
    s.receive(Uint8Array.of(66)); s.endStream();
    assert.deepEqual([counts.total, counts.failed], [3, 0]);
});

test('large numeric raw and text replays use one worker budget and preserve results', async t => {
    const { Worker } = require('node:worker_threads');
    const workerOptions = { hardwareConcurrency: 4, workerFactory: source => {
        const worker = new Worker(`const { parentPort } = require('node:worker_threads');
            globalThis.self = globalThis;
            globalThis.postMessage = (data, transfer) => parentPort.postMessage(data, transfer);
            parentPort.on('message', data => globalThis.onmessage({ data }));\n${source}`, { eval: true });
        const adapter = { postMessage: (data, transfer) => worker.postMessage(data, transfer),
            terminate: () => worker.terminate() };
        worker.on('message', data => adapter.onmessage?.({ data }));
        worker.on('error', error => adapter.onerror?.(error));
        return adapter;
    } };
    const s = service({ workerOptions }); t.after(() => s.dispose());
    const input = new Uint8Array(524288).fill(65);
    s.receive(input); s.endStream();
    const raw = s.acquireSource({ captureMode: 'hex', idleGapSeconds: 0.01 });
    const counts = s.getTextStats(s.baseSource, 'ascii');
    await Promise.all([raw.ready, counts.ready,
        s.updateNumericFormat({ ...numericFormat, dataType: 'uint16' })]);
    assert.equal(raw.frames.length, 1);
    assert.deepEqual(raw.frames.rawBytesAt(0), input);
    assert.equal(counts.total, 524288);
    assert.equal(counts.failed, 0);
    assert.equal(s.numericSource.frames.getValue(0, 999), 16705);
    assert.ok(s.workerPool.peakWorkers > 0 && s.workerPool.peakWorkers <= 2);
    assert.equal(s.workerPool.disposed, false);
});

for (const boundary of ['endStream', 'pause']) test(`${boundary} during final worker decode flushes the numeric tail before live handoff`, async t => {
    let release, entered;
    const started = new Promise(resolve => { entered = resolve; });
    const gate = new Promise(resolve => { release = resolve; });
    const { createHistoryTaskProcessor } = require('../historyWorkers');
    const { decodeNumericPayload } = require('../numericCodec');
    const { DataParser } = require('../dataParser');
    const pool = { available: true, maxWorkers: 1, dispose() {}, async runTask(task) {
        if (task.bytes.length === 4) { entered(); await gate; }
        const processor = createHistoryTaskProcessor(task, { TYPE_LENGTH: DataParser.TYPE_LENGTH, decodeNumericPayload });
        processor.step(Infinity);
        return processor.result();
    } };
    const s = service({ workerPool: pool, yieldControl: async () => {} });
    t.after(() => { release(); s.dispose(); });
    s.receive(new Uint8Array(524295).fill(1));
    const ready = s.updateNumericFormat({ dataType: 'uint32' });
    await started;
    if (boundary === 'pause') s.pause(true);
    else s.endStream();
    release(); await ready;
    const source = s.numericSource;
    assert.equal(source.parser.writeOffset - source.parser.readOffset, 0);
    assert.deepEqual(source.errors.map(error => [...error.bytes]), [[1, 1, 1]]);
    assert.equal(source.errors[0].type, 'incomplete');
    if (boundary === 'pause') s.pause(false);
    s.receive(Uint8Array.of(2));
    assert.equal(source.frames.channelSlice(0).at(-1), 16843009);
    assert.equal(source.parser.writeOffset - source.parser.readOffset, 1);
});

test('numeric catchup retains malformed-frame errors and the stream-ending tail', async t => {
    let release;
    const gate = new Promise(resolve => { release = resolve; });
    const format = { ...numericFormat, enableHeader: true, headerHex: 'AB', enableFooter: true, footerHex: 'CD' };
    const s = service({ numericFormat: format, yieldControl: () => gate });
    t.after(() => { release(); s.dispose(); });
    s.receive(Uint8Array.of(0xab, 1, 0xcd));
    const ready = s.updateNumericFormat(format);
    s.receive(Uint8Array.of(0xab, 2, 0)); s.endStream();
    release(); await ready;
    assert.equal(s.numericSource.parser.failCount, 1);
    assert.ok(s.numericSource.errors.some(error => error.type === 'footer'));
    assert.deepEqual(s.numericSource.errors.flatMap(error => [...error.bytes]), [0xab, 2, 0]);
});
