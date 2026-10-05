const test = require('node:test');
const assert = require('node:assert/strict');
const { FrameBuffer } = require('../frameBuffer');
const { parseMonitorSearch, MonitorSearchSession } = require('../monitorSearch');

function run(frames, options) {
    const search = new MonitorSearchSession(frames, options);
    while (!search.step(1)) { /* one frame per incremental step */ }
    return search.matches;
}

test('Hex and ASCII searches cross frame boundaries and retain byte positions', () => {
    const frames = new FrameBuffer(1, 5);
    frames.append([1], Uint8Array.of(0x41, 0x42), 't1', 10);
    frames.append([2], Uint8Array.of(0x43, 0x41), 't2', 11);
    frames.append([3], Uint8Array.of(0x42, 0x43), 't3', 12);
    const matches = run(frames, parseMonitorSearch('hex', '42 43'));
    assert.deepEqual(matches.map(m => [m.startFrame, m.startByte, m.endFrame, m.endByte]),
        [[0, 1, 1, 1], [2, 0, 2, 2]]);
    assert.equal(run(frames, parseMonitorSearch('ascii', 'ABC')).length, 2);
    assert.throws(() => parseMonitorSearch('ascii', '中文'), /ASCII/);
});

test('decoded numeric search applies tolerance and channel selection', () => {
    const frames = new FrameBuffer(2, 5);
    frames.append([1.01, 2], Uint8Array.of(1), 't1', 10);
    frames.append([3, 1.05], Uint8Array.of(2), 't2', 11);
    const matches = run(frames, parseMonitorSearch('number', '1', '0.06', -1));
    assert.deepEqual(matches.map(m => [m.startFrame, m.channel]), [[0, 0], [1, 1]]);
    assert.equal(run(frames, parseMonitorSearch('number', '1', 0.06, 0)).length, 1);
    assert.equal(run(frames, parseMonitorSearch('number', '1', '', -1)).length, 0,
        'an empty tolerance keeps exact-match behavior');
    assert.throws(() => parseMonitorSearch('number', '1', '-1'), /误差/);
});

test('decoded numeric search checks only the selected channel set', () => {
    const frames = new FrameBuffer(3, 5);
    frames.append([1, 1, 1], Uint8Array.of(1), 't1', 10);
    frames.append([2, 1, 1], Uint8Array.of(2), 't2', 11);
    const matches = run(frames, parseMonitorSearch('number', '1', 0, [0, 2]));
    assert.deepEqual(matches.map(m => [m.startFrame, m.channel]), [[0, 0], [0, 2], [1, 2]]);
    assert.throws(() => parseMonitorSearch('number', '1', 0, []), /通道/);
    assert.throws(() => parseMonitorSearch('number', '1', 0, [0, 0]), /通道/);
    assert.throws(() => run(frames, parseMonitorSearch('number', '1', 0, [0, 3])), RangeError);
});

test('byte search finds overlapping sequences without counting rejected prefixes', () => {
    const frames = new FrameBuffer(1, 5);
    frames.append([0], Uint8Array.of(0x41, 0x41), '', 1);
    frames.append([0], Uint8Array.of(0x41, 0x41), '', 2);
    const matches = run(frames, parseMonitorSearch('ascii', 'AAA'));
    assert.deepEqual(matches.map(match => [match.startFrame, match.startByte]),
        [[0, 0], [0, 1]]);
});
