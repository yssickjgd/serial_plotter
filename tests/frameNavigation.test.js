const test = require('node:test');
const assert = require('node:assert/strict');
const { FrameBuffer } = require('../frameBuffer');

test('independent frame boundaries map by source bytes, including payload matches and retained edges', () => {
    const { frameIndexAtByteOffset, mapFrameIndex, mapMatchOrders } = require('../frameNavigation');
    const wave = new FrameBuffer(1, 4), bytes = new FrameBuffer(1, 4);
    for (let i = 0; i < 3; i++) wave.append([i], Uint8Array.of(0xAB, i), '', i + 1, 100,
        { byteOffset: 10 + i * 10 });
    bytes.appendRaw(new Uint8Array(40), '', 0, 100, { byteOffset: 0 });
    bytes.appendRaw(new Uint8Array(10), '', 4, 100, { byteOffset: 40 });
    assert.equal(frameIndexAtByteOffset(wave, 21), 1, 'byte inside numeric payload identifies that sample');
    assert.equal(frameIndexAtByteOffset(wave, 25), 1, 'equal distances prefer the earlier sample');
    assert.equal(frameIndexAtByteOffset(wave, 0), 0);
    assert.equal(frameIndexAtByteOffset(wave, 100), 2);
    assert.equal(mapFrameIndex(wave, bytes, 2), 0, 'one raw record can contain many numeric frames');
    assert.equal(mapFrameIndex(wave, wave, 1.5), 1.5, 'a shared window midpoint retains equal-distance semantics');
    assert.equal(mapFrameIndex(wave, bytes, 1.5), 0);
    assert.equal(mapFrameIndex(bytes, wave, 1), 2);
    const matches = [{ startFrame: 0, startByte: 21, endFrame: 0, endByte: 22, startOrder: 0, endOrder: 0 }];
    assert.equal(mapMatchOrders(bytes, wave, matches)[0].startOrder, 2);
    assert.equal(matches[0].startOrder, 0, 'byte highlighting keeps its original frame order');
    assert.equal(mapMatchOrders(wave, wave, matches), matches, 'shared numeric frames need no mapping');
    wave.clear(); assert.equal(mapFrameIndex(bytes, wave, 0), -1);
});

test('byte references preserve fractional waveform centers and nearest match offsets inside raw records', () => {
    const { byteOffsetAtIndex, nearestMatchIndexByByteOffset } = require('../frameNavigation');
    const wave = new FrameBuffer(1, 4), bytes = new FrameBuffer(1, 4);
    wave.append([1], Uint8Array.of(0xAB, 1), '', 1, 100, { byteOffset: 10 });
    wave.append([2], Uint8Array.of(0xAB, 2), '', 2, 100, { byteOffset: 20 });
    bytes.appendRaw(new Uint8Array(30), '', 0, 100, { byteOffset: 0 });
    const matches = [0, 10, 20, 20].map(startByte => ({ startFrame: 0, startByte }));
    assert.equal(byteOffsetAtIndex(wave, 0.5), 15);
    assert.equal(nearestMatchIndexByByteOffset(bytes, matches, 15), 1, 'equal distance prefers earlier offset');
    assert.equal(nearestMatchIndexByByteOffset(bytes, matches, 20), 2, 'equal offsets preserve the first match');
    assert.equal(nearestMatchIndexByByteOffset(bytes, matches, 100), 2);
    assert.equal(nearestMatchIndexByByteOffset(bytes, matches, 0), 0);
    assert.equal(byteOffsetAtIndex(wave, -1), null);
    assert.equal(nearestMatchIndexByByteOffset(bytes, [], 0), -1);
});
