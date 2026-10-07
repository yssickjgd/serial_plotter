const test = require('node:test');
const assert = require('node:assert/strict');
const { FrameBuffer } = require('../frameBuffer');

test('atomic replacement transfers complete replay state while preserving the consumer identity', () => {
    const destination = new FrameBuffer(1, 3);
    destination.append([99]);
    const previousVersion = destination.version;
    const replacement = new FrameBuffer(2, 4);
    replacement.appendRaw(Uint8Array.of(1, 2), 'old', 5, 1000, { byteOffset: 50, incomplete: true });
    replacement.appendRaw(Uint8Array.of(3), 'new', 6, 900, { byteOffset: 52 });
    const storage = replacement.frames;
    destination.replaceFrom(replacement);
    assert.equal(destination.channelCount, 2);
    assert.equal(destination.capacity, 4);
    assert.equal(destination.rawMode, true);
    assert.equal(destination.timestampsMonotonic, false);
    assert.equal(destination.frames, storage);
    assert.equal(destination.version, previousVersion + 1);
    assert.equal(destination.frameAt(0).byteOffset, 50);
    assert.equal(destination.frameAt(0).incomplete, true);
    assert.equal(replacement.length, 0);
    replacement.appendRaw(Uint8Array.of(9));
    assert.equal(destination.length, 2);
    assert.deepEqual([...destination.frameAt(1).bytes], [3]);
});

test('numeric source byte offsets survive buffer wrap and resizing', () => {
    const frames = new FrameBuffer(1, 2);
    for (let i = 0; i < 4; i++) frames.append([i], Uint8Array.of(i), '', i, 1000 + i,
        { byteOffset: 10 + i * 2, endByte: 11 + i * 2 });
    assert.equal(frames.frameAt(0).byteOffset, 14);
    assert.equal(frames.frameAt(1).endByte, 17);
    frames.resize(20);
    assert.equal(frames.frameAt(0).byteOffset, 14);
    assert.equal(frames.rawByteOffsetAt(1), 16);
});

test('raw stream boundary metadata survives wrap, resizing and atomic adoption without copying bytes to inspect it', () => {
    const frames = new FrameBuffer(1, 2);
    frames.appendRaw(Uint8Array.of(255), '', 1, 1000, { byteOffset: 0, streamStartByte: 0, streamEnded: true });
    frames.appendRaw(Uint8Array.of(65, 0), '', 2, 1010, { byteOffset: 1, streamStartByte: 1 });
    frames.appendRaw(Uint8Array.of(66, 0), '', 3, 1020, { byteOffset: 3, streamStartByte: 1, streamEnded: true });
    assert.equal(typeof frames.streamEndedAt, 'function');
    assert.equal(frames.streamEndedAt(0), false);
    assert.equal(frames.streamEndedAt(1), true);
    assert.equal(frames.streamStartByteAt(0), 1);
    frames.resize(20);
    assert.equal(frames.frameAt(1).streamEnded, true);
    assert.equal(frames.frameAt(1).streamStartByte, 1);
    const destination = new FrameBuffer(1, 10);
    destination.replaceFrom(frames);
    assert.equal(destination.streamEndedAt(1), true);
    assert.equal(destination.streamStartByteAt(0), 1);
});

test('marking an already emitted raw frame ends its stream without duplicating bytes', () => {
    const frames = new FrameBuffer(1, 10);
    frames.appendRaw(Uint8Array.of(0xE4));
    const before = frames.version;
    assert.equal(typeof frames.markStreamEnded, 'function');
    assert.equal(frames.markStreamEnded(), true);
    assert.equal(frames.streamEndedAt(0), true);
    assert.equal(frames.version, before + 1);
    assert.equal(frames.markStreamEnded(), false);
    assert.equal(frames.version, before + 1);
    assert.equal(frames.length, 1);
});

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

test('raw frames keep variable lengths without allocating numerical channels or fixed strides', () => {
    const frames = new FrameBuffer(50, 100);
    assert.equal(typeof frames.appendRaw, 'function');
    const before = process.memoryUsage().arrayBuffers;
    frames.appendRaw(new Uint8Array(100000), 'first', 1, 1000, { incomplete: true });
    for (let i = 0; i < 99; i++) frames.appendRaw(Uint8Array.of(i), '', i + 2, 1001 + i);
    assert.ok(process.memoryUsage().arrayBuffers - before < 1_000_000);
    assert.ok(frames.values.every(chunks => chunks.length === 0));
    assert.equal(frames.getValue(0, 0), undefined);
    assert.equal(frames.frameAt(0).incomplete, true);
    assert.equal(frames.rawBytesAt(0).length, 100000);
    assert.equal(frames.channelCount, 50);
    assert.throws(() => frames.append(Array(50).fill(0)), /混合|模式/);
});

test('raw near-capacity resize and overwrite release evicted byte references', () => {
    const frames = new FrameBuffer(1, 8);
    for (let i = 0; i < 8; i++) frames.appendRaw(Uint8Array.of(i), `t${i}`, i, i, { incomplete: i === 7 });
    const rawChunks = frames.frames;
    frames.resize(6);
    assert.equal(frames.frames, rawChunks);
    assert.equal(frames.frames[0].rawRecords.filter(Boolean).length, 6);
    for (let i = 8; i < 12; i++) frames.appendRaw(Uint8Array.of(i), `t${i}`, i, i);
    assert.deepEqual(Array.from({ length: 6 }, (_, i) => frames.rawBytesAt(i)[0]), [6, 7, 8, 9, 10, 11]);
    assert.equal(frames.frames[0].rawRecords.filter(Boolean).length, 6);
    assert.equal(frames.frameAt(1).incomplete, true);
    frames.resize(2);
    assert.deepEqual(frames.frameAt(0).bytes, Uint8Array.of(10));
    assert.equal(frames.nearestTimestampIndex(11), 1);
    frames.clear();
    frames.append([12]);
    assert.equal(frames.getValue(0, 0), 12);
    assert.throws(() => frames.appendRaw(Uint8Array.of(13)), /混合|模式/);
});

test('raw absolute byte offsets preserve UTF-16 alignment after eviction and resizing', () => {
    const frames = new FrameBuffer(1, 4);
    frames.appendRaw(Uint8Array.of(65));
    frames.appendRaw(Uint8Array.of(0, 13, 0));
    frames.appendRaw(Uint8Array.of(66, 0));
    frames.appendRaw(Uint8Array.of(10, 0));
    frames.appendRaw(Uint8Array.of(67));
    assert.equal(typeof frames.rawByteOffsetAt, 'function');
    assert.deepEqual(Array.from({ length: 4 }, (_, i) => frames.rawByteOffsetAt(i)), [1, 4, 6, 8]);
    assert.equal(frames.frameAt(0).byteOffset, 1);
    assert.equal(frames.rawByteOffsetAt(-1), undefined);
    frames.resize(3);
    assert.equal(frames.rawByteOffsetAt(0), 4);
    frames.resize(8);
    frames.appendRaw(Uint8Array.of(0, 13, 0, 10, 0));
    assert.deepEqual(Array.from({ length: 4 }, (_, i) => frames.rawByteOffsetAt(i)), [4, 6, 8, 9]);
    frames.resize(2);
    assert.equal(frames.rawByteOffsetAt(0), 8);
    frames.appendRaw(Uint8Array.of(68, 0));
    assert.equal(frames.rawByteOffsetAt(0), 9);
    assert.equal(frames.rawByteOffsetAt(1), 14);
    frames.clear();
    frames.appendRaw(Uint8Array.of(69));
    assert.equal(frames.rawByteOffsetAt(0), 0);
});
