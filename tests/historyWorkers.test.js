const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { Worker: NodeWorker } = require('node:worker_threads');
const { resolveObjectURL } = require('node:buffer');

function deferred() {
    let resolve;
    const promise = new Promise(complete => { resolve = complete; });
    return { promise, resolve };
}

function nodeWorkerFactory({ gate, onStart, crash = false } = {}) {
    return source => {
        const worker = new NodeWorker(`
            const { parentPort, workerData, threadId } = require('node:worker_threads');
            globalThis.self = globalThis;
            globalThis.postMessage = (data, transfer) => parentPort.postMessage(data, transfer);
            parentPort.on('message', data => {
                parentPort.postMessage({ started: true, id: data.id, threadId });
                if (workerData.gate) Atomics.wait(new Int32Array(workerData.gate), 0, 0);
                if (workerData.crash) throw new Error('Worker crashed during decode');
                globalThis.onmessage({ data });
            });
            ${source}
        `, { eval: true, workerData: { gate, crash } });
        let closing = false;
        const adapter = {
            onmessage: null, onerror: null, onmessageerror: null,
            postMessage(data, transfer) { worker.postMessage(data, transfer); },
            terminate() { closing = true; return worker.terminate(); }
        };
        worker.on('message', data => {
            if (data.started) onStart?.(data);
            else adapter.onmessage?.({ data });
        });
        worker.on('error', error => adapter.onerror?.(error));
        worker.on('messageerror', error => adapter.onmessageerror?.(error));
        worker.on('exit', code => {
            if (!closing) adapter.onerror?.(new Error(`Worker exited: ${code}`));
        });
        return adapter;
    };
}

function loadPool() {
    const file = path.resolve(__dirname, '../historyWorkers.js');
    const exports = fs.existsSync(file) ? require(file) : {};
    assert.equal(typeof exports.HistoryWorkerPool, 'function', 'history worker pool must be available');
    return exports;
}

test('history worker budget reserves two logical cores and creates workers only when needed', () => {
    const { HistoryWorkerPool } = loadPool();
    for (const [hardwareConcurrency, expected] of [
        [0, 0], [1, 0], [2, 0], [3, 1], [8, 6], [32, 30], [2.9, 0],
        [undefined, 0], [NaN, 0], [Infinity, 0], [-1, 0]
    ]) {
        const pool = new HistoryWorkerPool({ hardwareConcurrency,
            workerFactory() { throw new Error('workers must stay lazy'); } });
        assert.equal(pool.maxWorkers, expected);
        assert.equal(pool.available, expected > 0);
        assert.equal(pool.workerCount, 0);
        pool.dispose();
    }
    const unavailable = new HistoryWorkerPool({ hardwareConcurrency: 8, WorkerClass: null });
    assert.equal(unavailable.available, false);
    unavailable.dispose();
});

test('local text tasks count every encoding and preserve partial character state', async () => {
    const { HistoryWorkerPool } = loadPool();
    const pool = new HistoryWorkerPool({ hardwareConcurrency: 2 });
    try {
        const fixtures = [
            ['utf-8', [0xf0, 0x9f, 0x98, 0x80, 0, 0xff, 13, 10, 9], 6, 2],
            ['ascii', [65, 255, 9], 3, 1], ['gbk', [0xd6, 0xd0], 1, 0],
            ['gb18030', [0x94, 0x39, 0xfc, 0x36], 1, 0], ['big5', [0xa4, 0xa4], 1, 0],
            ['utf-16le', [0x3d, 0xd8, 0, 0xde], 1, 0],
            ['utf-16be', [0xd8, 0x3d, 0xde, 0], 1, 0], ['shift_jis', [0x82, 0xa0], 1, 0],
            ['windows-1252', [0x80, 0x81, 0x7f], 3, 2]
        ];
        for (const [encoding, bytes, total, failed] of fixtures) {
            const result = await pool.runTask({ kind: 'text-count', bytes: Uint8Array.from(bytes),
                encoding, byteOffset: 0, pending: null, flush: true });
            assert.deepEqual(result, { total, failed, pending: [], orphanByte: false }, encoding);
        }
        const first = await pool.runTask({ kind: 'text-count', bytes: Uint8Array.of(0xe4, 0xb8),
            encoding: 'utf-8', byteOffset: 0, pending: null, flush: false });
        assert.deepEqual(first, { total: 0, failed: 0,
            pending: [{ value: 0xe4, frame: 0, byte: 0 }, { value: 0xb8, frame: 0, byte: 1 }],
            orphanByte: false });
        const second = await pool.runTask({ kind: 'text-count', bytes: Uint8Array.of(0xad, 0xe4),
            encoding: 'utf-8', byteOffset: 2, pending: first.pending, flush: true });
        assert.deepEqual(second, { total: 2, failed: 1, pending: [], orphanByte: false });
        assert.equal(first.pending.length, 2, 'restoring state must not consume caller-owned pending entries');
        const orphan = await pool.runTask({ kind: 'text-count', bytes: new Uint8Array(),
            encoding: 'utf-16le', byteOffset: 1, pending: null, flush: false });
        assert.equal(orphan.orphanByte, true);
        const aligned = await pool.runTask({ kind: 'text-count', bytes: Uint8Array.of(0, 1, 0, 66, 0),
            encoding: 'utf-16le', byteOffset: 1, pending: orphan.pending,
            orphanByte: orphan.orphanByte, flush: true });
        assert.deepEqual(aligned, { total: 3, failed: 2, pending: [], orphanByte: false });
    } finally { pool.dispose(); }
});

test('fallback yields between small slices and cancellation rejects active and queued jobs', async () => {
    const { HistoryWorkerPool } = loadPool();
    const pool = new HistoryWorkerPool({ hardwareConcurrency: 1, sliceBytes: 64 });
    let timerRan = false;
    const timer = setTimeout(() => { timerRan = true; }, 0);
    const result = await pool.runTask({ kind: 'text-count', encoding: 'ascii',
        bytes: new Uint8Array(1024).fill(65), flush: true });
    clearTimeout(timer);
    assert.equal(timerRan, true, 'fallback must yield to UI events before finishing a large job');
    assert.equal(result.total, 1024);
    pool.dispose();

    const scheduled = [];
    const cancelled = new HistoryWorkerPool({ hardwareConcurrency: 1,
        schedule(callback) { scheduled.push(callback); return callback; },
        cancelSchedule(callback) { scheduled.splice(scheduled.indexOf(callback), 1); } });
    const task = { kind: 'text-count', encoding: 'ascii', bytes: Uint8Array.of(65), flush: true };
    const active = cancelled.runTask(task);
    const queued = cancelled.runTask(task);
    const errors = Promise.all([assert.rejects(active, { name: 'AbortError' }),
        assert.rejects(queued, { name: 'AbortError' })]);
    assert.equal(scheduled.length, 1, 'only one fallback job should run at a time');
    cancelled.dispose();
    assert.equal(scheduled.length, 0, 'disposing the pool must release scheduled fallback work');
    for (const callback of scheduled) callback();
    await errors;
    await assert.rejects(cancelled.runTask(task), { name: 'AbortError' });
});

test('real workers run on separate threads within the core budget and return results in caller order', { timeout: 10000 }, async t => {
    const { HistoryWorkerPool } = loadPool();
    const gate = new SharedArrayBuffer(4);
    const started = deferred();
    const threadIds = new Set();
    let starts = 0;
    const pool = new HistoryWorkerPool({ hardwareConcurrency: 5,
        workerFactory: nodeWorkerFactory({ gate, onStart({ threadId }) {
            threadIds.add(threadId);
            if (++starts === 3) started.resolve();
        } }) });
    t.after(() => {
        Atomics.store(new Int32Array(gate), 0, 1);
        Atomics.notify(new Int32Array(gate), 0);
        pool.dispose();
    });
    const jobs = Array.from({ length: 7 }, (_, index) => pool.runTask({ kind: 'text-count',
        bytes: new Uint8Array(index + 1).fill(65), encoding: 'ascii', flush: true }));
    const completed = Promise.all(jobs);
    completed.catch(() => {});
    assert.equal(pool.workerCount, 3, 'jobs must be assigned to real workers, up to N minus two');
    await started.promise;
    assert.equal(threadIds.size, 3, 'three independent workers must execute concurrently');
    assert.equal(starts, 3, 'queued jobs must wait for a free worker');
    Atomics.store(new Int32Array(gate), 0, 1);
    Atomics.notify(new Int32Array(gate), 0);
    const results = await completed;
    assert.deepEqual(results.map(result => result.total), [1, 2, 3, 4, 5, 6, 7]);
    assert.equal(pool.peakWorkers, 3);
    assert.equal(threadIds.size, 3);
});

test('worker text state matches decoded Unicode, malformed bytes, and pending positions', async t => {
    const { HistoryWorkerPool } = loadPool();
    const pool = new HistoryWorkerPool({ hardwareConcurrency: 3, workerFactory: nodeWorkerFactory() });
    t.after(() => pool.dispose());
    const result = await pool.runTask({ kind: 'text-count',
        encoding: 'utf-8', bytes: Uint8Array.of(0xad, 0, 0xff, 0xf0, 0x9f), byteOffset: 2,
        pending: [{ value: 0xe4, frame: 17, byte: 9 }, { value: 0xb8, frame: 17, byte: 10 }],
        flush: false });
    assert.deepEqual(result, { total: 3, failed: 2,
        pending: [{ value: 0xf0, frame: 0, byte: 3 }, { value: 0x9f, frame: 0, byte: 4 }],
        orphanByte: false });
    assert.equal(pool.workerCount, 1, 'text decode must execute in the worker');
});

test('worker crashes preserve original input and drain work through one asynchronous fallback', async t => {
    const { HistoryWorkerPool } = loadPool();
    const pool = new HistoryWorkerPool({ hardwareConcurrency: 4,
        workerFactory: nodeWorkerFactory({ crash: true }) });
    t.after(() => pool.dispose());
    const bytes = Uint8Array.of(65, 0xff, 66);
    const results = await Promise.all(Array.from({ length: 4 }, () => pool.runTask({ kind: 'text-count',
        bytes, encoding: 'ascii', flush: true })));
    assert.deepEqual([...bytes], [65, 255, 66], 'worker transfers must preserve the retained source bytes');
    assert.ok(results.every(result => result.total === 3 && result.failed === 1));
    assert.equal(pool.available, false);
    assert.equal(pool.workerCount, 0);
});

const NUMERIC_FIXTURES = [
    ['int8', 'setInt8', 1, [-128, 127, 0, -1], [-128, 127, 0, -1]],
    ['uint8', 'setUint8', 1, [0, 255, 1, 127], [0, 255, 1, 127]],
    ['int16', 'setInt16', 2, [-32768, 32767, -1, 256], [-32768, 32767, -1, 256]],
    ['uint16', 'setUint16', 2, [0, 65535, 1, 512], [0, 65535, 1, 512]],
    ['int32', 'setInt32', 4, [-2147483648, 2147483647, -1, 65536], [-2147483648, 2147483647, -1, 65536]],
    ['uint32', 'setUint32', 4, [0, 4294967295, 1, 65536], [0, 4294967295, 1, 65536]],
    ['int64', 'setBigInt64', 8, [-9007199254740992n, 9007199254740991n, -1n, 65536n],
        [-9007199254740992, 9007199254740991, -1, 65536]],
    ['uint64', 'setBigUint64', 8, [0n, 18446744073709551615n, 1n, 65536n],
        [0, 18446744073709552000, 1, 65536]],
    ['float32', 'setFloat32', 4, [-1.5, Infinity, NaN, -0], [-1.5, Infinity, NaN, -0]],
    ['float64', 'setFloat64', 8, [-Math.PI, Number.MIN_VALUE, -Infinity, -0],
        [-Math.PI, Number.MIN_VALUE, -Infinity, -0]]
];

function numericTask(fixture, littleEndian) {
    const [type, setter, width, values] = fixture;
    const frameLength = 3 + width * 2 + 2;
    const storage = new Uint8Array(5 + frameLength * 2 + 7).fill(0xab);
    const bytes = storage.subarray(5, 5 + frameLength * 2);
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    for (let index = 0; index < values.length; index++) {
        view[setter](Math.floor(index / 2) * frameLength + 3 + index % 2 * width, values[index], littleEndian);
    }
    return { kind: 'numeric', bytes, frameLength, headerLength: 3, type, littleEndian, channels: 2 };
}

test('numeric worker and fallback results decode all datatypes and endian orders in frame order', async t => {
    const { HistoryWorkerPool } = loadPool();
    for (const workerFactory of [undefined, nodeWorkerFactory()]) {
        const pool = new HistoryWorkerPool({ hardwareConcurrency: workerFactory ? 4 : 2, workerFactory });
        t.after(() => pool.dispose());
        const jobs = [];
        for (const fixture of NUMERIC_FIXTURES) for (const littleEndian of [false, true]) {
            const task = numericTask(fixture, littleEndian);
            const originalBytes = [...task.bytes];
            jobs.push(pool.runTask(task).then(result => {
                assert.ok(result instanceof Float64Array);
                assert.deepEqual([...result], fixture[4], `${fixture[0]} ${littleEndian}`);
                assert.deepEqual([...task.bytes], originalBytes, 'numeric input must retain its original bytes');
            }));
        }
        await Promise.all(jobs);
        if (workerFactory) assert.equal(pool.workerCount, 2);
    }
});

test('bad tasks reject cleanly while workers remain usable for later tasks', async t => {
    const { HistoryWorkerPool } = loadPool();
    const pool = new HistoryWorkerPool({ hardwareConcurrency: 3, workerFactory: nodeWorkerFactory() });
    t.after(() => pool.dispose());
    await assert.rejects(pool.runTask({ kind: 'text-count', bytes: [65], encoding: 'ascii', flush: true }),
        { name: 'TypeError' });
    await assert.rejects(pool.runTask({ ...textPrepareTask(),
        before: [{ frame: 6, start: 0, bytes: [0xe4, 0xb8] }] }), { name: 'TypeError' });
    await assert.rejects(pool.runTask({ kind: 'unknown', bytes: Uint8Array.of(65) }), { name: 'RangeError' });
    await assert.rejects(pool.runTask({ ...numericTask(NUMERIC_FIXTURES[0], true), frameLength: 0 }),
        { name: 'RangeError' });
    const result = await pool.runTask({ kind: 'text-count', bytes: Uint8Array.of(65), encoding: 'ascii', flush: true });
    assert.equal(result.total, 1);
    assert.equal(pool.available, true);
    assert.equal(pool.workerCount, 1);
});

test('disposing the pool terminates blocked workers and rejects queued jobs', { timeout: 10000 }, async t => {
    const { HistoryWorkerPool } = loadPool();
    const gate = new SharedArrayBuffer(4);
    const started = deferred();
    const pool = new HistoryWorkerPool({ hardwareConcurrency: 3,
        workerFactory: nodeWorkerFactory({ gate, onStart() { started.resolve(); } }) });
    t.after(() => pool.dispose());
    const task = { kind: 'text-count', bytes: Uint8Array.of(65), encoding: 'ascii', flush: true };
    const active = pool.runTask(task), queued = pool.runTask(task);
    const errors = Promise.all([assert.rejects(active, { name: 'AbortError' }),
        assert.rejects(queued, { name: 'AbortError' })]);
    await started.promise;
    pool.dispose();
    await errors;
    assert.equal(pool.workerCount, 0);
    assert.equal(pool.available, false);
});

test('blocked Blob worker creation releases its URL and completes through fallback', async t => {
    const { HistoryWorkerPool } = loadPool();
    let workerURL;
    const pool = new HistoryWorkerPool({ hardwareConcurrency: 8, WorkerClass: class {
        constructor(url) { workerURL = url; throw new Error('Blob worker creation blocked'); }
    } });
    t.after(() => pool.dispose());
    assert.equal(pool.available, true);
    const bytes = Uint8Array.of(0xe4, 0xb8, 0xad, 0);
    const result = await pool.runTask({ kind: 'text-count', bytes, encoding: 'utf-8', flush: true });
    assert.deepEqual(result, { total: 2, failed: 1, pending: [], orphanByte: false });
    assert.match(workerURL, /^blob:/);
    assert.equal(resolveObjectURL(workerURL), undefined, 'a failed worker must not retain its Blob URL');
    assert.deepEqual([...bytes], [0xe4, 0xb8, 0xad, 0]);
    assert.equal(pool.available, false);
    assert.equal(pool.workerCount, 0);
});

function textPrepareTask() {
    return { kind: 'text-prepare', encoding: 'utf-8', frame: 7,
        bytes: Uint8Array.of(0xad, 65, 0xf0, 0x9f, 0x98, 0x80, 0, 66, 0xe4, 0xb8),
        byteOffset: 0, before: [{ frame: 6, bytes: Uint8Array.of(0xe4, 0xb8), start: 100 }],
        following: [{ frame: 8, bytes: Uint8Array.of(0xad, 67), start: 0 }],
        columns: 4, rawByteOffset: 123, nextOrders: [8.1, 9.1, undefined, undefined], streamEnded: false };
}

function textLayoutDependencies() {
    return { ...require('../textCodec'), ...require('../numericCodec'),
        TYPE_LENGTH: require('../dataParser').DataParser.TYPE_LENGTH,
        ...require('../monitorView').MonitorTextLayout };
}

test('text layout workers preserve cross-frame Unicode, wrapping, and compact source mappings', async t => {
    const { HistoryWorkerPool, createHistoryTaskProcessor } = loadPool();
    const task = textPrepareTask();
    const processor = createHistoryTaskProcessor(task, textLayoutDependencies());
    assert.equal(processor.step(Infinity), true);
    const expected = processor.result();
    assert.equal(expected.chunks.map(chunk => chunk.text).join(''), 'A\u{1f600}\uFFFDB\u4e2d');
    assert.deepEqual([...expected.layouts.get(4)], [0, 3]);
    assert.equal(expected.length, 5);
    assert.equal(expected.width, 3);
    assert.equal(expected.needsFollowing, true);
    assert.deepEqual(expected.initialPending, [
        { value: 0xe4, frame: 6, byte: 100 }, { value: 0xb8, frame: 6, byte: 101 }
    ]);
    assert.deepEqual([...expected.chunks[0].starts], [1, 2, 6, 7]);
    assert.deepEqual([...expected.chunks[0].ends], [2, 6, 7, 8]);
    assert.deepEqual([...expected.chunks[0].failed], [0, 0, 1, 0]);
    assert.deepEqual([...expected.chunks[1].starts], [8]);
    assert.deepEqual([...expected.chunks[1].ends], [1]);
    assert.deepEqual([...expected.chunks[1].crosses], [1]);
    assert.equal(expected.byteLength, 10);
    assert.equal(expected.byteOffset, 123);
    assert.deepEqual(expected.nextOrders, [8.1, 9.1, undefined, undefined]);
    assert.equal(Object.hasOwn(expected, 'initialLines'), false);
    const pool = new HistoryWorkerPool({ hardwareConcurrency: 3, workerFactory: nodeWorkerFactory() });
    t.after(() => pool.dispose());
    const originals = [task.bytes, ...task.before.map(part => part.bytes), ...task.following.map(part => part.bytes)]
        .map(bytes => [...bytes]);
    const result = await pool.runTask(task);
    assert.deepEqual(result, expected);
    assert.equal(pool.workerCount, 1);
    assert.deepEqual([task.bytes, ...task.before.map(part => part.bytes), ...task.following.map(part => part.bytes)]
        .map(bytes => [...bytes]), originals, 'layout transfers must preserve all current and context bytes');
});

test('text preparation fallback yields and flushes forced stream ends before following bytes', async t => {
    const { HistoryWorkerPool, createHistoryTaskProcessor } = loadPool();
    const task = { ...textPrepareTask(), bytes: Uint8Array.of(65, 0xe4, 0xb8), before: [], streamEnded: true };
    const processor = createHistoryTaskProcessor(task, textLayoutDependencies());
    let slices = 0;
    while (!processor.step(1)) slices++;
    assert.ok(slices >= 2, 'small budgets must not decode the whole row in one main thread slice');
    const expected = processor.result();
    assert.equal(expected.chunks.map(chunk => chunk.text).join(''), 'A\uFFFD\uFFFD');
    assert.equal(expected.needsFollowing, true);
    assert.ok(expected.chunks.every(chunk => [...chunk.crosses].every(value => value === 0)));
    const pool = new HistoryWorkerPool({ hardwareConcurrency: 2, sliceBytes: 1 });
    t.after(() => pool.dispose());
    assert.deepEqual(await pool.runTask(task), expected);
});

test('text preparation bounds decoder allocations even when a worker processes the whole job', async t => {
    const { HistoryWorkerPool, createHistoryTaskProcessor } = loadPool();
    const task = { ...textPrepareTask(), bytes: new Uint8Array(5000).fill(65),
        encoding: 'ascii', before: [], following: [], columns: 13 };
    const processor = createHistoryTaskProcessor(task, textLayoutDependencies());
    processor.step(Infinity);
    const expected = processor.result();
    assert.deepEqual(expected.chunks.map(chunk => chunk.cells.length), [2048, 2048, 904]);
    assert.equal(expected.length, 5000);
    assert.equal(expected.layouts.get(13).length, 385);
    assert.equal(expected.layouts.get(13).at(-1), 4992);
    for (const workerFactory of [undefined, nodeWorkerFactory()]) {
        const pool = new HistoryWorkerPool({ hardwareConcurrency: workerFactory ? 3 : 2, workerFactory });
        t.after(() => pool.dispose());
        assert.deepEqual(await pool.runTask(task), expected);
    }
});

test('text layout workers keep UTF16 alignment at odd retained origins and supplementary characters across records', async t => {
    const { HistoryWorkerPool } = loadPool();
    const task = { ...textPrepareTask(), encoding: 'utf-16be', byteOffset: 1, rawByteOffset: 41,
        bytes: Uint8Array.of(0x2d, 0, 65, 0xd8, 0x3d), before: [],
        following: [{ frame: 8, start: 0, bytes: Uint8Array.of(0xde, 0) }] };
    const pool = new HistoryWorkerPool({ hardwareConcurrency: 3, workerFactory: nodeWorkerFactory() });
    t.after(() => pool.dispose());
    const result = await pool.runTask(task);
    assert.equal(result.chunks.map(chunk => chunk.text).join(''), '\uFFFDA\u{1f600}');
    assert.equal(result.length, 3);
    assert.equal(result.width, 4);
    assert.deepEqual(result.chunks.flatMap(chunk => [...chunk.starts]), [0, 1, 3]);
    assert.deepEqual(result.chunks.flatMap(chunk => [...chunk.ends]), [1, 3, 2]);
    assert.deepEqual(result.chunks.flatMap(chunk => [...chunk.crosses]), [0, 0, 1]);
    assert.deepEqual(result.chunks.flatMap(chunk => [...chunk.failed]), [1, 0, 0]);
    assert.equal(result.byteOffset, 41);
});
