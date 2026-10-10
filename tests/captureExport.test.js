const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { FrameBuffer } = require('../frameBuffer');
const { CaptureService } = require('../captureService');
const api = fs.existsSync(require('node:path').join(__dirname, '../captureExport.js')) ? require('../captureExport') : {};
function buffers() {
    const rx = new FrameBuffer(1, 4), tx = new FrameBuffer(1, 4);
    rx.appendRaw(Uint8Array.of(0xe4, 0xb8), '01:02:03.004', 1, 1000);
    tx.appendRaw(Uint8Array.of(65, 10), '01:02:03.005', 2, 1001);
    rx.appendRaw(Uint8Array.of(0xad, 13, 10, 0xff), '01:02:03.006', 3, 1002);
    return { rx, tx };
}
function chunks(rx, tx, options) {
    assert.equal(typeof api.captureExportChunks, 'function', 'raw capture export must be available');
    return [...api.captureExportChunks(rx, tx, options)];
}
function service(t, options = {}) {
    const capture = new CaptureService({ now: () => 0, wallNow: () => 1000,
        setTimeout: () => 0, clearTimeout: () => {},
        numericFormat: { enableHeader: false, dataType: 'uint8' }, ...options });
    t.after(() => capture.dispose());
    return capture;
}
test('raw binary export preserves exact RX, TX or interleaved bytes without metadata', () => {
    const { rx, tx } = buffers();
    for (const [direction, expected] of [['rx', [228,184,173,13,10,255]], ['tx', [65,10]],
        ['both', [228,184,65,10,173,13,10,255]]])
        assert.deepEqual(Array.from(Buffer.concat(chunks(rx, tx, { format: 'binary', direction,
            timestamps: true, markers: true }))), expected);
});
test('Hex text export separates bytes and optionally labels each chronological record', () => {
    const { rx, tx } = buffers();
    assert.equal(chunks(rx, tx, { format: 'hex-text', direction: 'both', timestamps: true,
        markers: true }).join(''), '[01:02:03.004] RX E4 B8\r\n[01:02:03.005] TX 41 0A\r\n[01:02:03.006] RX AD 0D 0A FF\r\n');
    assert.equal(chunks(rx, tx, { format: 'hex-text', direction: 'tx' }).join(''), '41 0A\r\n');
});
test('text export maps split characters to their initial record and keeps line endings and invalid bytes visible', () => {
    const { rx, tx } = buffers();
    assert.equal(chunks(rx, tx, { format: 'text', direction: 'rx', encoding: 'utf-8' }).join(''), '中\r\n\\xFF');
    assert.equal(chunks(rx, tx, { format: 'text', direction: 'both', encoding: 'utf-8', markers: true }).join(''),
        'RX 中\r\nTX A\nRX \r\n\\xFF\r\n');
});

test('text export preserves incomplete characters at real receive stream boundaries', t => {
    const capture = service(t);
    capture.receive(Uint8Array.of(0xe4, 0xb8)); capture.endStream();
    capture.receive(Uint8Array.of(0xad)); capture.endStream();
    assert.equal(chunks(capture.baseSource.frames, capture.txFrames,
        { format: 'text', encoding: 'utf-8' }).join(''), '\\xE4\\xB8\\xAD');
});

test('text export decodes characters continuously across forced receive frame segments', t => {
    const capture = service(t, { maxRawFrameBytes: 2 });
    capture.receive(Uint8Array.of(0xe4, 0xb8));
    capture.receive(Uint8Array.of(0xad, 65)); capture.endStream();
    assert.equal(chunks(capture.baseSource.frames, capture.txFrames,
        { format: 'text', encoding: 'utf-8' }).join(''), '中A');
});

for (const [capacity, limit, expected] of [[2, 2, '中A'], [3, 1, '\\x4EA']])
    test(`text export aligns retained UTF-16 bytes to their receive stream origin with limit ${limit}`, t => {
        const capture = service(t, { capacity, maxRawFrameBytes: limit });
        capture.receive(Uint8Array.of(255)); capture.endStream();
        capture.receive(Uint8Array.of(0x2d, 0x4e, 65, 0)); capture.endStream();
        assert.equal(chunks(capture.baseSource.frames, capture.txFrames,
            { format: 'text', encoding: 'utf-16le' }).join(''), expected);
    });

test('text export flushes receive boundaries without breaking interleaved transmit characters', t => {
    const capture = service(t);
    capture.receive(Uint8Array.of(0xe4, 0xb8)); capture.endStream();
    capture.appendTx(Uint8Array.of(0xe4, 0xb8));
    capture.receive(Uint8Array.of(0xad)); capture.endStream();
    capture.appendTx(Uint8Array.of(0xad));
    assert.equal(chunks(capture.baseSource.frames, capture.txFrames,
        { format: 'text', direction: 'both', encoding: 'utf-8', markers: true }).join(''),
    'RX \\xE4\\xB8\r\nTX 中\r\nRX \\xAD\r\nTX \r\n');
});
test('text export supports legacy encodings and a retained odd UTF-16 byte origin', () => {
    const rx = new FrameBuffer(1, 2), tx = new FrameBuffer(1, 2);
    rx.appendRaw(Uint8Array.of(0xd6), '', 1); rx.appendRaw(Uint8Array.of(0xd0), '', 2);
    assert.equal(chunks(rx, tx, { format: 'text', encoding: 'gbk' }).join(''), '中');
    rx.clear(); rx.appendRaw(Uint8Array.of(0x2d), '', 1); rx.appendRaw(Uint8Array.of(0x4e), '', 2);
    rx.appendRaw(Uint8Array.of(65,0), '', 3);
    assert.equal(chunks(rx, tx, { format: 'text', encoding: 'utf-16le' }).join(''), '\\x4EA');
});
test('export refuses overwritten records and streams a binary file in bounded record batches', async () => {
    assert.equal(typeof api.captureExportChunks, 'function');
    assert.equal(typeof api.writeCaptureExport, 'function');
    const rx = new FrameBuffer(1, 3), tx = new FrameBuffer(1, 3);
    for (let i=0;i<3;i++) rx.appendRaw(Uint8Array.of(i), '', i);
    const iterator = api.captureExportChunks(rx, tx, { format: 'hex-text' }); iterator.next();
    rx.appendRaw(Uint8Array.of(3), '', 3);
    assert.throws(() => iterator.next(), /覆盖|变化/);
    const writes = [];
    await api.writeCaptureExport(rx, tx, { format: 'binary' }, { write: async data => writes.push(data) });
    assert.deepEqual(Array.from(Buffer.concat(writes)), [1,2,3]);
});
