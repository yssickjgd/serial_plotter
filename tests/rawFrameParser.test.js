const test = require('node:test');
const assert = require('node:assert/strict');
const rawModule = require('node:fs').existsSync(require('node:path').join(__dirname, '../rawFrameParser.js'))
    ? require('../rawFrameParser') : {};

function fixture(format = {}) {
    assert.equal(typeof rawModule.RawFrameParser, 'function', 'raw framing must be available');
    let now = 0, wallNow = 1700000000000, timerId = 0;
    const timers = new Map(), frames = [], received = [];
    const parser = new rawModule.RawFrameParser({ now: () => now, wallNow: () => wallNow,
        setTimeout: (callback, delay) => { timers.set(++timerId, { callback, delay }); return timerId; },
        clearTimeout: id => timers.delete(id) });
    parser.setFormat({ boundary: 'idle', idleGapSeconds: 0.01, encoding: 'utf-8', ...format });
    parser.onFrameParsed = (bytes, time, timestamp, metadata) => frames.push({ bytes: [...bytes], time, timestamp, ...metadata });
    parser.onRawData = (bytes, time) => received.push({ bytes: [...bytes], time });
    return { parser, frames, received, timers, at: (ms, wall = 1700000000000 + ms) => { now = ms; wallNow = wall; },
        fire: () => { const callbacks = [...timers.values()]; timers.clear(); callbacks.forEach(timer => timer.callback()); } };
}

test('idle parser groups bytes and keeps the first arrival timestamp', () => {
    const f = fixture();
    f.parser.appendData(Uint8Array.of(1, 2));
    f.at(8); f.parser.appendData(Uint8Array.of(3));
    f.at(18); f.fire();
    assert.deepEqual(f.frames.map(frame => frame.bytes), [[1, 2, 3]]);
    assert.equal(f.frames[0].timestamp, 1700000000000);
    assert.equal(f.frames[0].incomplete, false);
    assert.equal(f.parser.frameCount, 1);
    assert.equal(f.parser.failCount, 0);
    assert.equal(f.received.length, 2);
});

test('delayed and early idle timers cannot merge separated frames or finish too soon', () => {
    const f = fixture();
    f.parser.appendData(Uint8Array.of(1));
    f.at(5); f.fire();
    assert.equal(f.frames.length, 0);
    f.at(20, 1600000000000); f.parser.appendData(Uint8Array.of(2));
    assert.deepEqual(f.frames.map(frame => frame.bytes), [[1]]);
    f.at(30); f.fire();
    assert.deepEqual(f.frames.map(frame => frame.bytes), [[1], [2]]);
    assert.equal(f.frames[1].timestamp, 1600000000000);
});

test('all line separators retain delimiters, split across chunks, and preserve empty lines', () => {
    for (const [boundary, delimiter] of [['cr', [13]], ['lf', [10]], ['crlf', [13, 10]], ['lfcr', [10, 13]]]) {
        const f = fixture({ boundary });
        f.parser.appendData(Uint8Array.of(65, ...delimiter.slice(0, 1)));
        f.at(2); f.parser.appendData(Uint8Array.of(...delimiter.slice(1), ...delimiter, 66));
        f.parser.flushPending();
        assert.deepEqual(f.frames.map(frame => frame.bytes), [[65, ...delimiter], delimiter, [66]], boundary);
        assert.deepEqual(f.frames.map(frame => frame.incomplete), [false, false, true]);
        assert.equal(f.timers.size, 0);
    }
});

test('UTF-16 line matching respects character alignment and fragmented code units', () => {
    for (const [encoding, bytes, expected] of [
        ['utf-16le', [13, 1, 65, 0, 13, 0, 10, 0, 66, 0], [[13, 1, 65, 0, 13, 0, 10, 0], [66, 0]]],
        ['utf-16be', [1, 13, 0, 65, 0, 13, 0, 10, 0, 66], [[1, 13, 0, 65, 0, 13, 0, 10], [0, 66]]]
    ]) {
        const f = fixture({ boundary: 'crlf', encoding });
        bytes.forEach(byte => f.parser.appendData(Uint8Array.of(byte)));
        f.parser.flushPending();
        assert.deepEqual(f.frames.map(frame => frame.bytes), expected);
    }
});

test('flush retains pending data, reset cancels it, and formats validate before resetting', () => {
    const f = fixture();
    f.parser.appendData(Uint8Array.of(1));
    assert.throws(() => f.parser.setFormat({ boundary: 'other' }));
    assert.throws(() => f.parser.setFormat({ boundary: 'idle', idleGapSeconds: 0 }));
    assert.throws(() => f.parser.setFormat({ encoding: 'invalid' }));
    f.parser.flushPending();
    assert.deepEqual(f.frames[0].bytes, [1]);
    assert.equal(f.frames[0].incomplete, false);
    assert.equal(f.timers.size, 0);
    f.parser.appendData(Uint8Array.of(2));
    f.parser.reset(); f.at(100); f.fire();
    assert.equal(f.frames.length, 1);
    f.parser.flushPending();
    assert.equal(f.frames.length, 1);
});

test('callback exceptions are surfaced after preserving parser progress', () => {
    const f = fixture({ boundary: 'lf' });
    let error;
    f.parser.onCallbackError = value => { error = value; };
    f.parser.onFrameParsed = () => { throw new Error('callback failed'); };
    assert.throws(() => f.parser.appendData(Uint8Array.of(1, 10)), /callback failed/);
    assert.equal(error.message, 'callback failed');
    f.parser.onFrameParsed = () => {};
    f.parser.flushPending();
    assert.equal(f.parser.frameCount, 1);
});

test('default browser timers are invoked with their global receiver', () => {
    const schedule = globalThis.setTimeout, cancel = globalThis.clearTimeout;
    const timers = [];
    globalThis.setTimeout = function(callback) {
        assert.equal(this, globalThis, 'Window.setTimeout requires its Window receiver');
        timers.push(callback); return timers.length;
    };
    globalThis.clearTimeout = function() {
        assert.equal(this, globalThis, 'Window.clearTimeout requires its Window receiver');
    };
    try {
        const parser = new rawModule.RawFrameParser();
        parser.appendData(Uint8Array.of(65));
        parser.flushPending();
        assert.equal(parser.frameCount, 1);
        assert.equal(timers.length, 1);
    } finally { globalThis.setTimeout = schedule; globalThis.clearTimeout = cancel; }
});

test('replay metadata retains UTF-16 alignment at an odd retained absolute byte offset', () => {
    const f = fixture({ boundary: 'crlf', encoding: 'utf-16le' });
    f.parser.appendData(Uint8Array.of(0, 13, 0, 10, 0, 66, 0),
        { byteOffset: 1, timestamp: 1000, arrival: 0, order: 2 });
    f.parser.flushPending();
    assert.deepEqual(f.frames.map(frame => frame.bytes), [[0, 13, 0, 10, 0], [66, 0]]);
    assert.deepEqual(f.frames.map(frame => [frame.byteOffset, frame.endByte]), [[1, 6], [6, 8]]);
});

test('suspended replay timers resume against the actual live monotonic clock', () => {
    const f = fixture();
    f.parser.suspendTimers = true;
    f.parser.appendData(Uint8Array.of(65), { timestamp: 1000, arrival: 0, byteOffset: 30, order: 4 });
    assert.equal(f.timers.size, 0);
    f.at(8);
    f.parser.resumeTimers();
    assert.equal(f.timers.size, 1);
    assert.equal([...f.timers.values()][0].delay, 2);
    f.at(10); f.fire();
    assert.equal(f.frames[0].timestamp, 1000);
    assert.equal(f.frames[0].byteOffset, 30);
    f.at(11);
    f.parser.appendData(Uint8Array.of(66));
    f.at(21); f.fire();
    assert.equal(f.frames[1].timestamp, 1700000000011);
});

test('forced flush marks a stream end while ordinary idle frames preserve their shared stream origin', () => {
    const f = fixture();
    f.parser.appendData(Uint8Array.of(0xE4));
    f.parser.flushPending();
    assert.equal(f.frames[0].streamEnded, true);
    assert.equal(f.frames[0].streamStartByte, 0);
    f.at(20); f.parser.appendData(Uint8Array.of(0xB8, 0xAD));
    f.at(30); f.fire();
    assert.equal(f.frames[1].streamEnded, false);
    assert.equal(f.frames[1].streamStartByte, 1);
});

test('UTF-16 delimiter alignment restarts after a forced odd-length stream ending', () => {
    const f = fixture({ boundary: 'crlf', encoding: 'utf-16le' });
    f.parser.appendData(Uint8Array.of(255)); f.parser.flushPending();
    f.parser.appendData(Uint8Array.of(65, 0, 13, 0, 10, 0));
    assert.deepEqual(f.frames.map(frame => frame.bytes), [[255], [65, 0, 13, 0, 10, 0]]);
    assert.equal(f.frames[1].streamStartByte, 1);
    assert.equal(f.frames[1].incomplete, false);
});
