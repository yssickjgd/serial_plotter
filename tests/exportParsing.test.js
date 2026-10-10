const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { FrameBuffer } = require('../frameBuffer');
const api = fs.existsSync(require.resolve('../frameBuffer').replace('frameBuffer.js', 'exportParsing.js'))
    ? require('../exportParsing') : {};
const encoders = fs.existsSync(require.resolve('../frameBuffer').replace('frameBuffer.js', 'textEncoder.js'))
    ? require('../textEncoder') : {};
const yieldControl = () => Promise.resolve();

test('export-only numeric parsing handles split frames and leaves source bytes untouched', async () => {
    assert.equal(typeof api.reparsedFrames, 'function');
    const source = new FrameBuffer(1, 10);
    source.appendRaw(Uint8Array.of(0xff, 0xaa, 0, 0), '', 1, 1000);
    source.appendRaw(Uint8Array.of(0x80, 0x3f, 0xaa, 0, 0, 0, 0xc0), '', 2, 1001);
    const version = source.version;
    const result = [];
    for await (const frame of api.reparsedFrames(source, { dataType: 'float32', endianness: 'little',
        channelsCount: '1', enableHeader: true, headerHex: 'AA', enableFooter: false, enableChecksum: false },
    { numeric: true, yieldControl })) result.push(frame);
    assert.deepEqual(result.map(frame => frame.samples), [[1], [-2]]);
    assert.deepEqual(result.map(frame => frame.timestamp), [1000, 1001]);
    assert.equal(source.version, version);
    assert.deepEqual([...source.rawBytesAt(0)], [255, 170, 0, 0]);
});

test('export-only text framing keeps cross-block delimiters and byte gaps separate', async () => {
    assert.equal(typeof api.reparsedFrames, 'function');
    const source = new FrameBuffer(1, 10);
    source.appendRaw(Uint8Array.of(65, 13), '', 1, 1000, { byteOffset: 0 });
    source.appendRaw(Uint8Array.of(10, 66, 13, 10), '', 2, 1001, { byteOffset: 2 });
    source.appendRaw(Uint8Array.of(67), '', 3, 1002, { byteOffset: 20 });
    const rows = [];
    for await (const row of api.reparsedFrames(source, { boundary: 'crlf', encoding: 'utf-8' }, { yieldControl })) rows.push(row);
    assert.deepEqual(rows.map(row => [...row.bytes]), [[65, 13, 10], [66, 13, 10], [67]]);
    assert.equal(rows.at(-1).incomplete, true);
    assert.equal(rows.at(-1).streamEnded, true);
});

test('streamed export supports channel operations, frame checksums and cancellation', async () => {
    const source = new FrameBuffer(1, 10);
    source.appendRaw(Uint8Array.of(0xaa, 1, 2, 0xbb, 3, 0xaa, 3, 4, 0xbb, 7), '', 1, 1000);
    const options = { channelIndices: [0, 2], timestamps: false };
    const rules = { enableHeader: true, headerHex: 'AA', enableFooter: true, footerHex: 'BB',
        enableChecksum: true, dataType: 'uint8', endianness: 'little', channelsCount: '2' };
    let text = '';
    for await (const chunk of api.reparsedCsvChunks(source, rules, [{ name: 'A' }, { name: 'B' }, { name: 'Sum' }],
        options, { yieldControl, definitions: [{ number: 3, type: 'formula', expression: 'CH01+CH02' }] })) text += chunk;
    assert.equal(text, 'Index,A,Sum\r\n0,1,3\r\n1,3,7\r\n');
    await assert.rejects(async () => {
        for await (const frame of api.reparsedFrames(source, rules, { numeric: true, check() { throw new Error('cancelled'); } }))
            assert.fail(frame);
    }, /cancelled/);
});

test('text export preserves cross-record characters and UTF-16 alignment after retention', async () => {
    const rx = new FrameBuffer(1, 10), tx = new FrameBuffer(1, 10);
    rx.appendRaw(Uint8Array.of(0xe4, 0xb8), 'a', 1, 1000);
    tx.appendRaw(Uint8Array.of(65), 'b', 2, 1000);
    rx.appendRaw(Uint8Array.of(0xad), 'c', 3, 1001);
    let text = '';
    for await (const part of api.reparsedTextChunks(rx, tx, { direction: 'both', encoding: 'utf-8',
        textBoundary: 'records', timestamps: false, markers: false }, { yieldControl })) text += part;
    assert.equal(text, '中A');
    const odd = new FrameBuffer(1, 10);
    odd.appendRaw(Uint8Array.of(0, 66, 0), '', 1, 1000, { byteOffset: 1, streamStartByte: 0 });
    text = '';
    for await (const part of api.reparsedTextChunks(odd, tx, { direction: 'rx', encoding: 'utf-16le',
        textBoundary: 'records', timestamps: false, markers: false }, { yieldControl })) text += part;
    assert.equal(text, '\\x00B');
});

test('export encoders roundtrip all supported charsets and reject unrepresentable text', async () => {
    assert.equal(typeof encoders.createExportTextEncoder, 'function');
    for (const [encoding, text] of [['utf-8', '中文😀'], ['ascii', 'Hello'], ['utf-16le', '中文😀'],
        ['utf-16be', '中文😀'], ['gbk', '中文'], ['gb18030', '中文😀'], ['big5', '繁體中文'],
        ['shift_jis', '日本語'], ['windows-1252', '€é']]) {
        const encoder = await encoders.createExportTextEncoder(encoding, { yieldControl });
        if (encoding === 'windows-1252') assert.deepEqual([...encoder.encode(text)], [0x80, 0xe9]);
        else assert.equal(new TextDecoder(encoding).decode(encoder.encode(text)), text, encoding);
    }
    const ascii = await encoders.createExportTextEncoder('ascii');
    assert.throws(() => ascii.encode('中文'), /无法.*编码/);
    const gbk = await encoders.createExportTextEncoder('gbk', { yieldControl });
    assert.throws(() => gbk.encode('😀'), /无法.*编码/);
});
