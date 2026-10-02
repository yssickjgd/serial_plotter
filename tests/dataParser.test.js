const test = require('node:test');
const assert = require('node:assert/strict');
const { DataParser } = require('../dataParser');

test('reports consumer callback failures through a dedicated error hook', () => {
    const parser = new DataParser();
    parser.setFormat({ enableHeader: false, enableFooter: false,
        dataType: 'uint8', channelsCount: 1 });
    const errors = [];
    parser.onFrameParsed = () => { throw new Error('view failed'); };
    parser.onCallbackError = error => errors.push(error.message);
    assert.throws(() => parser.appendData(Uint8Array.of(7)), /view failed/);
    assert.deepEqual(errors, ['view failed']);
});

test('parsed frames include a system timestamp alongside their display time', () => {
    const parser = new DataParser();
    parser.setFormat({ enableHeader: false, enableFooter: false,
        dataType: 'uint8', channelsCount: 1 });
    let received;
    parser.onFrameParsed = (values, time, bytes, timestamp) => {
        received = { values, time, bytes, timestamp };
    };
    const before = Date.now();
    parser.appendData(Uint8Array.of(7));
    const after = Date.now();
    assert.equal(received.values[0], 7);
    assert.match(received.time, /^\d\d:\d\d:\d\d\.\d\d\d$/);
    assert.ok(received.timestamp >= before && received.timestamp <= after);
});

test('reassembles split headers, rejects bad footer and checksum, and keeps raw bytes', () => {
    const parser = new DataParser();
    parser.setFormat({ enableHeader: true, headerHex: 'AA BB', enableFooter: true,
        footerHex: '0D', enableChecksum: true, dataType: 'uint16',
        isLittleEndian: true, channelsCount: 1 });
    const frames = [], errors = [];
    parser.onFrameParsed = (values, time, bytes) => frames.push({ values, bytes: [...bytes] });
    parser.onFrameError = (type) => errors.push(type);
    parser.appendData(Uint8Array.of(0, 0xAA));
    parser.appendData(Uint8Array.of(0xBB, 0x34, 0x12, 0x0D, 0x46));
    parser.appendData(Uint8Array.of(0xAA, 0xBB, 1, 0, 0x00, 1,
        0xAA, 0xBB, 2, 0, 0x0D, 9));
    assert.deepEqual(frames.map(f => f.values[0]), [0x1234]);
    assert.deepEqual(frames[0].bytes, [0xAA, 0xBB, 0x34, 0x12, 0x0D, 0x46]);
    assert.ok(errors.includes('footer'));
    assert.ok(errors.includes('checksum'));
});

test('footer resync reports each discarded byte once without overlapping a valid frame', () => {
    for (const chunks of [
        [Uint8Array.of(0x10, 0x20, 0x30, 0xEE)],
        [Uint8Array.of(0x10, 0x20), Uint8Array.of(0x30, 0xEE)]
    ]) {
        const parser = new DataParser();
        parser.setFormat({ enableHeader: false, enableFooter: true, footerHex: 'EE',
            dataType: 'uint8', channelsCount: 1, enableChecksum: false });
        const reported = [];
        parser.onFrameError = (reason, time, bytes) => {
            assert.equal(reason, 'footer');
            reported.push({ kind: 'error', bytes: [...bytes] });
        };
        parser.onFrameParsed = (values, time, bytes) => {
            reported.push({ kind: 'frame', bytes: [...bytes] });
            assert.deepEqual(values, [0x30]);
        };
        for (const chunk of chunks) parser.appendData(chunk);
        assert.deepEqual(reported.flatMap(item => item.bytes), [0x10, 0x20, 0x30, 0xEE]);
        assert.deepEqual(reported.filter(item => item.kind === 'frame').map(item => item.bytes),
            [[0x30, 0xEE]]);
    }
});

test('header resync keeps rejected and accepted byte ranges separate', () => {
    const parser = new DataParser();
    parser.setFormat({ enableHeader: true, headerHex: 'AA', enableFooter: true,
        footerHex: 'EE', dataType: 'uint8', channelsCount: 1 });
    const reported = [];
    parser.onFrameError = (reason, time, bytes) => reported.push([reason, ...bytes]);
    parser.onFrameParsed = (values, time, bytes) => reported.push(['frame', ...bytes]);
    parser.appendData(Uint8Array.of(0xAA, 0xAA, 0, 0xEE));
    assert.deepEqual(reported, [
        ['footer', 0xAA],
        ['frame', 0xAA, 0, 0xEE]
    ]);
});

test('flushing an incomplete tail reports its bytes once and resets the parser', () => {
    const parser = new DataParser();
    parser.setFormat({ enableHeader: false, enableFooter: true, footerHex: 'EE',
        dataType: 'uint8', channelsCount: 1 });
    const reported = [];
    parser.onFrameError = (reason, time, bytes) => reported.push([reason, ...bytes]);
    parser.onFrameParsed = (values, time, bytes) => reported.push(['frame', ...bytes]);
    parser.appendData(Uint8Array.of(0x10, 0x20));
    parser.flushPending();
    assert.deepEqual(reported, [['footer', 0x10], ['incomplete', 0x20]]);
    assert.equal(parser.readOffset, 0);
    assert.equal(parser.writeOffset, 0);
    parser.appendData(Uint8Array.of(0x30, 0xEE));
    assert.deepEqual(reported.at(-1), ['frame', 0x30, 0xEE]);
});

test('decodes signed, unsigned, float and 64-bit payloads', () => {
    const cases = [
        ['int8', [0xFE], -2], ['uint8', [0xFE], 254],
        ['int16', [0xFE, 0xFF], -2], ['uint16', [0xFE, 0xFF], 65534],
        ['int32', [0xFE, 0xFF, 0xFF, 0xFF], -2],
        ['uint32', [0xFE, 0xFF, 0xFF, 0xFF], 4294967294],
        ['float32', [0, 0, 0x80, 0x3F], 1],
        ['float64', [0, 0, 0, 0, 0, 0, 0xF0, 0x3F], 1],
        ['int64', [0xFE, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF], -2],
        ['uint64', [2, 0, 0, 0, 0, 0, 0, 0], 2]
    ];
    for (const [dataType, bytes, expected] of cases) {
        const parser = new DataParser();
        parser.setFormat({ enableHeader: false, enableFooter: false,
            enableChecksum: false, dataType, isLittleEndian: true, channelsCount: 1 });
        let actual;
        parser.onFrameParsed = values => { actual = values[0]; };
        parser.appendData(Uint8Array.from(bytes));
        assert.equal(actual, expected, dataType);
    }
});

test('releases oversized temporary chunk storage after parsing', () => {
    const parser = new DataParser();
    parser.setFormat({ enableHeader: false, enableFooter: false, enableChecksum: false,
        dataType: 'float64', channelsCount: 1 });
    parser.appendData(new Uint8Array(1200000));
    assert.equal(parser.frameCount, 150000);
    assert.ok(parser.buffer.length <= 65536);
});
