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
