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
