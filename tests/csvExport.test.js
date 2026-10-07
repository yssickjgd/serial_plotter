const test = require('node:test');
const assert = require('node:assert/strict');
const { FrameBuffer } = require('../frameBuffer');

test('CSV export reads all retained samples from a shared frame buffer', () => {
    const { exportFrameCsv } = require('../csvExport');
    const frames = new FrameBuffer(1, 2);
    frames.append([1]);
    frames.append([2]);
    frames.append([3]);
    assert.equal(exportFrameCsv(frames, [{ name: 'sensor,1' }]),
        'Index,"sensor,1"\r\n0,2\r\n1,3\r\n');
});

test('CSV exports transformed channel values and leaves overflow cells empty', () => {
    const { exportFrameCsv } = require('../csvExport');
    const frames = new FrameBuffer(2, 2);
    frames.append([4, 1e308], Uint8Array.of(0x10));
    assert.equal(exportFrameCsv(frames, [
        { name: 'gain', gainEnabled: true, gain: -2, offsetEnabled: true, offset: 3 },
        { name: 'overflow', gainEnabled: true, gain: 1e308, offsetEnabled: false, offset: 0 }
    ]), 'Index,gain,overflow\r\n0,-5,\r\n');
    assert.equal(frames.getValue(0, 0), 4);
    assert.deepEqual(frames.frameAt(0).bytes, Uint8Array.of(0x10));
});

test('streamed CSV writes bounded chunks with a UTF-8 BOM', async () => {
    const { writeFrameCsv } = require('../csvExport');
    const frames = new FrameBuffer(1, 1200);
    for (let i = 0; i < 1200; i++) frames.append([i], Uint8Array.of(i & 255), '', i);
    const chunks = [];
    const writable = { async write(bytes) { chunks.push(bytes); } };
    await writeFrameCsv(frames, [{ name: 'value' }], writable);
    assert.ok(chunks.length >= 4);
    assert.deepEqual([...chunks[0]], [0xEF, 0xBB, 0xBF]);
    const csv = new TextDecoder().decode(Buffer.concat(chunks.map(bytes => Buffer.from(bytes))));
    assert.ok(csv.startsWith('Index,value\r\n0,0\r\n'));
    assert.ok(csv.endsWith('1199,1199\r\n'));
});


test('optional CSV timestamps preserve millisecond precision and the retained row order', () => {
    const { exportFrameCsv } = require('../csvExport');
    const frames = new FrameBuffer(1, 2);
    for (let i = 0; i < 3; i++) frames.append([i], Uint8Array.of(i), '', i, 1700000000001 + i);
    assert.equal(exportFrameCsv(frames, [{ name: 'sensor' }], { timestamps: true }),
        'Index,Timestamp,sensor\r\n0,2023-11-14T22:13:20.002Z,1\r\n1,2023-11-14T22:13:20.003Z,2\r\n');
    assert.equal(exportFrameCsv(frames, [{ name: 'sensor' }]), 'Index,sensor\r\n0,1\r\n1,2\r\n');
});

test('streamed CSV uses the same optional timestamp column as downloaded CSV', async () => {
    const { exportFrameCsv, writeFrameCsv } = require('../csvExport');
    const frames = new FrameBuffer(1, 2);
    frames.append([3], Uint8Array.of(3), '', 0, 1700000000123);
    const chunks = [];
    await writeFrameCsv(frames, [{ name: 'CH1' }], { async write(bytes) { chunks.push(bytes); } },
        () => {}, { timestamps: true });
    assert.match(new TextDecoder().decode(Buffer.concat(chunks)), /Index,Timestamp,CH1\r\n0,2023-11-14T22:13:20.123Z,3/);
    assert.equal(new TextDecoder().decode(Buffer.concat(chunks)),
        exportFrameCsv(frames, [{ name: 'CH1' }], { timestamps: true }));
});
