const test = require('node:test');
const assert = require('node:assert/strict');
const { FrameBuffer } = require('../frameBuffer');
const { parseMonitorSearch, MonitorSearchSession } = require('../monitorSearch');

function run(frames, options) {
    const search = new MonitorSearchSession(frames, options);
    while (!search.step(1)) { /* one frame per incremental step */ }
    return search.matches;
}

test('numeric search optionally compares transformed display values while retaining channel metadata', () => {
    const frames = new FrameBuffer(2, 5);
    frames.append([2, 5], Uint8Array.of(1, 2), '', 7);
    const options = { ...parseMonitorSearch('number', '5'), valueTransform: (value, channel) => channel === 0 ? value * 2 + 1 : value };
    assert.deepEqual(run(frames, options).map(match => match.channel), [0, 1]);
    assert.deepEqual(run(frames, parseMonitorSearch('number', '5')).map(match => match.channel), [1]);
});

test('text searches store a boolean case option and preserve the case-sensitive default', () => {
    const frames = new FrameBuffer(1, 5);
    frames.append([0], new TextEncoder().encode('aBc ABC abc'), '', 1);
    const defaultOptions = parseMonitorSearch('text', 'ABC');
    assert.equal(defaultOptions.caseSensitive, true);
    const exact = [[0, 4, 0, 7]];
    const positions = options => run(frames, options).map(match => [match.startFrame,
        match.startByte, match.endFrame, match.endByte]);
    assert.deepEqual(positions(defaultOptions), exact);
    assert.deepEqual(positions(parseMonitorSearch('text', 'ABC', 0, -1, 'utf-8', true)), exact);
    const insensitive = parseMonitorSearch('text', 'ABC', 0, -1, 'ascii', false);
    assert.equal(insensitive.caseSensitive, false);
    assert.deepEqual(positions(insensitive), [[0, 0, 0, 3], [0, 4, 0, 7], [0, 8, 0, 11]]);
});

test('case-insensitive mixed Chinese and ASCII text retains exact cross-frame byte spans', () => {
    const frames = new FrameBuffer(1, 5);
    frames.append([0], Uint8Array.of(0x78, 0xe4, 0xb8), '', 10);
    frames.append([0], Uint8Array.of(0xad, 0x41), '', 11);
    frames.append([0], Uint8Array.of(0x62, 0x79), '', 12);
    assert.deepEqual(run(frames, parseMonitorSearch('text', '中ab', 0, -1, 'utf-8', false)),
        [{ startFrame: 0, startByte: 1, endFrame: 2, endByte: 1, startOrder: 10, endOrder: 12 }]);
});

test('case-insensitive prefix matching finds every overlapping mixed-case occurrence', () => {
    const frames = new FrameBuffer(1, 5);
    frames.append([0], new TextEncoder().encode('aA'), '', 1);
    frames.append([0], new TextEncoder().encode('aAa'), '', 2);
    const matches = run(frames, parseMonitorSearch('text', 'AaA', 0, -1, 'utf-8', false));
    assert.deepEqual(matches.map(match => [match.startFrame, match.startByte,
        match.endFrame, match.endByte]), [[0, 0, 1, 1], [0, 1, 1, 2], [1, 0, 1, 3]]);
});

test('case-insensitive Unicode simple folding handles non-ASCII case equivalents', () => {
    const samples = [['Σςσ', 'σ', [[0, 2], [2, 4], [4, 6]]],
        ['ẞß', 'ß', [[0, 3], [3, 5]]], ['KkKſsS', 'Ks', [[4, 7]]]];
    for (const [text, query, expected] of samples) {
        const frames = new FrameBuffer(1, 5);
        frames.append([0], new TextEncoder().encode(text), '', 1);
        const matches = run(frames, parseMonitorSearch('text', query, 0, -1, 'utf-8', false));
        assert.deepEqual(matches.map(match => [match.startByte, match.endByte]), expected, text);
    }
});

test('Unicode simple folding never expands a source character or matches part of a case expansion', () => {
    const samples = [['ßẞssSS', 'SS', [[5, 7], [6, 8], [7, 9]]],
        ['İiIı', 'i', [[2, 3], [3, 4]]], ['İi\u0307', 'i\u0307', [[2, 5]]]];
    for (const [text, query, expected] of samples) {
        const frames = new FrameBuffer(1, 5);
        frames.append([0], new TextEncoder().encode(text), '', 1);
        const matches = run(frames, parseMonitorSearch('text', query, 0, -1, 'utf-8', false));
        assert.deepEqual(matches.map(match => [match.startByte, match.endByte]), expected, text);
    }
});

test('case-insensitive UTF-16 matches supplementary letters across split code units', () => {
    const samples = [
        ['utf-16le', [[0x78, 0x00, 0x01, 0xd8, 0x00], [0xdc, 0x41], [0x00, 0x2d, 0x4e]]],
        ['utf-16be', [[0x00, 0x78, 0xd8, 0x01, 0xdc], [0x00, 0x00], [0x41, 0x4e, 0x2d]]]
    ];
    for (const [encoding, chunks] of samples) {
        const frames = new FrameBuffer(1, 5);
        chunks.forEach((bytes, frame) => frames.append([0], Uint8Array.from(bytes), '', frame));
        const matches = run(frames, parseMonitorSearch('text', '𐐨a中', 0, -1, encoding, false));
        assert.deepEqual(matches.map(match => [match.startFrame, match.startByte,
            match.endFrame, match.endByte]), [[0, 2, 2, 3]], encoding);
    }
});

test('invalid text bytes break insensitive matches and never impersonate a replacement character', () => {
    const frames = new FrameBuffer(1, 5);
    frames.append([0], Uint8Array.of(0x41, 0xff), '', 1);
    frames.append([0], Uint8Array.of(0x62, 0x41, 0x42, 0xef, 0xbf), '', 2);
    frames.append([0], Uint8Array.of(0xbd, 0xe4), '', 3);
    assert.deepEqual(run(frames, parseMonitorSearch('text', 'ab', 0, -1, 'utf-8', false))
        .map(match => [match.startFrame, match.startByte, match.endFrame, match.endByte]), [[1, 1, 1, 3]]);
    for (const caseSensitive of [true, false]) {
        const matches = run(frames, parseMonitorSearch('text', '\uFFFD', 0, -1, 'utf-8', caseSensitive));
        assert.deepEqual(matches.map(match => [match.startFrame, match.startByte,
            match.endFrame, match.endByte]), [[1, 3, 2, 1]]);
    }
});

test('case-insensitive text keeps regular expression syntax literal', () => {
    const frames = new FrameBuffer(1, 5);
    frames.append([0], new TextEncoder().encode('a.c Axc A.C'), '', 1);
    const matches = run(frames, parseMonitorSearch('text', 'A.C', 0, -1, 'utf-8', false));
    assert.deepEqual(matches.map(match => [match.startByte, match.endByte]), [[0, 3], [8, 11]]);
});

test('Unicode text search maps cross-frame code points to exact original bytes', () => {
    const frames = new FrameBuffer(1, 5);
    frames.append([0], Uint8Array.of(0x41, 0xe4, 0xb8), '', 1);
    frames.append([0], Uint8Array.of(0xad, 0xe6, 0x96, 0x87), '', 2);
    const matches = run(frames, parseMonitorSearch('text', '中文', 0, -1, 'utf-8'));
    assert.deepEqual(matches.map(match => [match.startFrame, match.startByte,
        match.endFrame, match.endByte]), [[0, 1, 1, 4]]);
});

test('text searches use the selected charset, overlap and same-byte multi-character mappings', () => {
    const samples = [
        ['ascii', [65], 'A'], ['gbk', [0xd6, 0xd0], '中'],
        ['gb18030', [0x90, 0x30, 0x81, 0x30], '𐀀'], ['big5', [0xa4, 0xa4], '中'],
        ['utf-16le', [0x2d, 0x4e], '中'], ['utf-16be', [0x4e, 0x2d], '中'],
        ['shift_jis', [0x82, 0xa0], 'あ'], ['windows-1252', [0x80], '€']
    ];
    for (const [encoding, bytes, query] of samples) {
        const frames = new FrameBuffer(1, 5);
        for (let i = 0; i < bytes.length; i++) frames.append([0], Uint8Array.of(bytes[i]), '', i);
        const matches = run(frames, parseMonitorSearch('text', query, 0, -1, encoding));
        assert.equal(matches.length, 1, encoding);
        assert.equal(matches[0].startByte, 0);
        assert.equal(matches[0].endFrame, bytes.length - 1);
        assert.equal(matches[0].endByte, 1);
    }
    const frames = new FrameBuffer(1, 5);
    frames.append([0], Uint8Array.of(65, 65), '', 0);
    frames.append([0], Uint8Array.of(65, 65), '', 1);
    assert.equal(run(frames, parseMonitorSearch('text', 'AAA')).length, 2);
});

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
