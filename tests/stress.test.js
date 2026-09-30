const test = require('node:test');
const assert = require('node:assert/strict');
const { performance } = require('node:perf_hooks');
const { DataParser } = require('../dataParser');
const { FrameBuffer } = require('../frameBuffer');

test('300000 23-channel frames retain every latest sample and raw byte', () => {
    const parser = new DataParser();
    parser.setFormat({ enableHeader: false, enableFooter: true, footerHex: '00 00 80 7F',
        enableChecksum: false, dataType: 'float32', isLittleEndian: true, channelsCount: 23 });
    const frames = new FrameBuffer(23, 5000);
    parser.onFrameParsed = (values, time, bytes) => frames.append(values, bytes, time);
    const frameSize = 23 * 4 + 4;
    const batch = 50;
    const input = new Uint8Array(frameSize * batch);
    const view = new DataView(input.buffer);
    const start = performance.now();
    for (let first = 0; first < 300000; first += batch) {
        for (let r = 0; r < batch; r++) {
            const base = r * frameSize;
            for (let c = 0; c < 23; c++) view.setFloat32(base + c * 4, first + r + c / 32, true);
            input.set([0, 0, 128, 127], base + 92);
        }
        parser.appendData(input);
    }
    const elapsed = performance.now() - start;
    assert.equal(parser.frameCount, 300000);
    assert.equal(frames.length, 5000);
    for (let i = 0; i < 5000; i++) {
        assert.equal(frames.getValue(0, i), 295000 + i);
        assert.equal(frames.getValue(22, i), 295000 + i + 22 / 32);
        assert.equal(new DataView(frames.frameAt(i).bytes.buffer).getFloat32(0, true), 295000 + i);
    }
    console.log(`300000 frames parsed and retained in ${elapsed.toFixed(0)} ms`);
});
