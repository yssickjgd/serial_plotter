const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const codec = fs.existsSync(require.resolve('../dataParser').replace('dataParser.js', 'numericCodec.js'))
    ? require('../numericCodec') : {};
const { DataParser } = require('../dataParser');

test('numeric codec preserves every type and endian and can fill a shared batch output', () => {
    assert.equal(typeof codec.decodeNumericPayload, 'function');
    for (const [type, method, values] of [
        ['int8', 'Int8', [-12, 7]], ['uint8', 'Uint8', [250, 7]],
        ['int16', 'Int16', [-1234, 789]], ['uint16', 'Uint16', [60000, 789]],
        ['int32', 'Int32', [-123456, 789]], ['uint32', 'Uint32', [4000000000, 789]],
        ['int64', 'BigInt64', [-1234567890123n, 789n]],
        ['uint64', 'BigUint64', [1234567890123n, 789n]],
        ['float32', 'Float32', [-1.25, Infinity]], ['float64', 'Float64', [-1.125, NaN]]
    ]) {
        for (const little of [false, true]) {
            const bytes = new Uint8Array(DataParser.TYPE_LENGTH[type] * 2);
            const view = new DataView(bytes.buffer);
            values.forEach((value, i) => view[`set${method}`](i * DataParser.TYPE_LENGTH[type], value, little));
            const expected = values.map(Number);
            assert.deepEqual(codec.decodeNumericPayload(view, type, little, 2), expected);
            const out = new Float64Array(4).fill(99);
            assert.equal(codec.decodeNumericPayload(view, type, little, 2, out, 1), out);
            assert.deepEqual(Array.from(out), [99, ...expected, 99]);
        }
    }
});

test('deferred numeric parsing keeps frame boundaries and checksum validation without decoding samples', () => {
    const parser = new DataParser();
    parser.setFormat({ enableHeader: true, headerHex: 'AA', enableFooter: true, footerHex: 'EE',
        enableChecksum: true, dataType: 'uint16', channelsCount: 1 });
    parser.decodeValues = false;
    const frames = [], errors = [];
    parser.onFrameParsed = (values, time, bytes) => frames.push({ values, bytes: Array.from(bytes) });
    parser.onFrameError = type => errors.push(type);
    parser.appendData(Uint8Array.of(0xAA, 1, 2));
    parser.appendData(Uint8Array.of(0xEE, 3, 0xAA, 4, 5, 0xEE, 0));
    assert.deepEqual(frames, [{ values: null, bytes: [0xAA, 1, 2, 0xEE, 3] }]);
    assert.deepEqual(errors, ['checksum']);
    parser.decodeValues = true;
    parser.appendData(Uint8Array.of(0xAA, 1, 0, 0xEE, 1));
    assert.equal(frames[1].values[0], 1);
});
