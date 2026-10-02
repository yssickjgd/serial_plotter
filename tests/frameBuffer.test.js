const test = require('node:test');
const assert = require('node:assert/strict');
const { FrameBuffer } = require('../frameBuffer');

test('constructor enforces the same channel and capacity limits as resizing', () => {
    assert.throws(() => new FrameBuffer(51, 1000), /通道数/);
    assert.throws(() => new FrameBuffer(1, 3600001), /最大采样点数/);
    const large = new FrameBuffer(50, 3600000);
    assert.equal(large.capacity, 3600000);
    assert.equal(large.length, 0);
});

test('large capacity stores samples lazily and packs variable-length raw records', () => {
    const before = process.memoryUsage().arrayBuffers;
    const buffer = new FrameBuffer(50, 3600000);
    assert.ok(process.memoryUsage().arrayBuffers - before < 5_000_000,
        'setting a one-hour limit must not immediately allocate gigabytes');
    for (let i = 0; i < 5000; i++) buffer.append(
        Array.from({ length: 50 }, (_, c) => i + c),
        i === 4500 ? Uint8Array.of(1, 2, 3, 4) : Uint8Array.of(i & 255), `t${i}`, i);
    assert.equal(buffer.getValue(49, 4999), 5048);
    assert.deepEqual(buffer.frameAt(4500).bytes, Uint8Array.of(1, 2, 3, 4));
    assert.equal(buffer.frameAt(4999).time, 't4999');
    buffer.resize(100);
    assert.equal(buffer.length, 100);
    assert.equal(buffer.getValue(0, 0), 4900);
    assert.deepEqual(buffer.frameAt(0).bytes, Uint8Array.of(4900 & 255));
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

test('absolute timestamps and relative origin follow the oldest retained sample', () => {
    const buffer = new FrameBuffer(1, 3);
    for (let i = 0; i < 5; i++)
        buffer.append([i], Uint8Array.of(i), `t${i}`, i, 1000 + i * 100);
    assert.equal(buffer.originTimestamp, 1200);
    assert.equal(buffer.timestampAt(0), 1200);
    assert.equal(buffer.nearestTimestampIndex(1340), 1);
    assert.equal(buffer.nearestTimestampIndex(1390), 2);
    assert.deepEqual(buffer.rawBytesAt(2), Uint8Array.of(4));
    buffer.resize(2);
    assert.equal(buffer.originTimestamp, 1300);
    assert.equal(buffer.timestampAt(0), 1300);
    buffer.clear();
    assert.ok(Number.isNaN(buffer.originTimestamp));
});

test('chunk boundaries remain aligned when a large ring wraps', () => {
    const buffer = new FrameBuffer(50, 8193);
    for (let i = 0; i < 10240; i++) buffer.append(
        Array.from({ length: 50 }, (_, channel) => i * 100 + channel),
        Uint8Array.of(i & 255, (i >>> 8) & 255), `t${i}`, i, 1000 + i);
    assert.equal(buffer.length, 8193);
    assert.equal(buffer.getValue(49, 0), 2047 * 100 + 49);
    assert.equal(buffer.getValue(0, 8192), 10239 * 100);
    assert.deepEqual(buffer.frameAt(0).bytes, Uint8Array.of(2047 & 255, 2047 >>> 8));
    assert.equal(buffer.originTimestamp, 3047);
    assert.equal(buffer.nearestTimestampIndex(11239), 8192);
});

test('absolute-time jump still finds the nearest sample after a system clock adjustment', () => {
    const frames = new FrameBuffer(1, 5);
    [1000, 1100, 900, 950].forEach((time, i) =>
        frames.append([i], Uint8Array.of(i), '', i, time));
    assert.equal(frames.timestampsMonotonic, false);
    assert.equal(frames.nearestTimestampIndex(925), 2);
});

test('near-capacity resize reuses allocated chunks while preserving the ring order', () => {
    const frames = new FrameBuffer(1, 8);
    for (let i = 0; i < 8; i++) frames.append([i], Uint8Array.of(i), '', i, i);
    const oldChunks = frames.values[0];
    frames.resize(6);
    assert.equal(frames.values[0], oldChunks);
    for (let i = 8; i < 12; i++) frames.append([i], Uint8Array.of(i), '', i, i);
    assert.deepEqual(frames.channelSlice(0), [6, 7, 8, 9, 10, 11]);
    assert.deepEqual(frames.frameAt(0).bytes, Uint8Array.of(6));
    frames.resize(8);
    assert.equal(frames.values[0], oldChunks);
    frames.append([12], Uint8Array.of(12), '', 12, 12);
    assert.deepEqual(frames.channelSlice(0), [6, 7, 8, 9, 10, 11, 12]);
});
