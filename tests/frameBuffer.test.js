const test = require('node:test');
const assert = require('node:assert/strict');
const { FrameBuffer } = require('../frameBuffer');

test('constructor enforces the same channel and capacity limits as resizing', () => {
    assert.throws(() => new FrameBuffer(25, 1000), /通道数/);
    assert.throws(() => new FrameBuffer(1, 100001), /最大采样点数/);
});

test('retains each sample and raw frame in the same bounded window', () => {
    const buffer = new FrameBuffer(2, 3);
    for (let i = 0; i < 5; i++) buffer.append([i, i + 10], Uint8Array.of(i), `t${i}`);
    assert.equal(buffer.length, 3);
    assert.deepEqual(buffer.channelSlice(0, 0, 3), [2, 3, 4]);
    assert.deepEqual(buffer.channelSlice(1, 0, 3), [12, 13, 14]);
    assert.deepEqual([...buffer.frameAt(0).bytes], [2]);
    assert.equal(buffer.frameAt(2).time, 't4');
});

test('resizing preserves newest frames and channel changes reset incompatible samples', () => {
    const buffer = new FrameBuffer(1, 4);
    for (let i = 0; i < 4; i++) buffer.append([i], Uint8Array.of(i), 't');
    buffer.resize(2);
    assert.deepEqual(buffer.channelSlice(0, 0, 2), [2, 3]);
    buffer.resize(5);
    buffer.append([4], Uint8Array.of(4), 't');
    assert.deepEqual(buffer.channelSlice(0, 0, 3), [2, 3, 4]);
    buffer.setChannelCount(2);
    assert.equal(buffer.length, 0);
});
