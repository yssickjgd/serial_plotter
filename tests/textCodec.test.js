const test = require('node:test');
const assert = require('node:assert/strict');

test('character statistics preserve UTF-16 alignment at an evicted byte boundary', () => {
    const { TextCharacterCounter } = require('../textCodec');
    const counter = new TextCharacterCounter('utf-16le', { byteOffset: 1 });
    counter.write(Uint8Array.of(0, 1, 0, 66, 0));
    assert.deepEqual(counter.flush(), { total: 3, failed: 2 });
});

test('mapped text decoder preserves Unicode and cross-frame byte positions', () => {
    const { MappedTextDecoder } = require('../textCodec');
    const decoder = new MappedTextDecoder('utf-8');
    assert.deepEqual(decoder.write(Uint8Array.of(0xe4, 0xb8), 0), []);
    const tokens = decoder.write(Uint8Array.of(0xad, 0x0d, 0x0a), 1);
    assert.equal(tokens.map(token => token.text).join(''), '中\r\n');
    assert.equal(tokens.map(token => token.display).join(''), '中\\r\\n');
    assert.deepEqual([tokens[0].startFrame, tokens[0].startByte,
        tokens[0].endFrame, tokens[0].endByte], [0, 0, 1, 1]);
});

test('text decoding handles all supported encodings and strict ASCII invalid bytes', () => {
    const { MappedTextDecoder } = require('../textCodec');
    const samples = [
        ['utf-8', [0xe4, 0xb8, 0xad], '中'], ['ascii', [0x41], 'A'],
        ['gbk', [0xd6, 0xd0], '中'], ['gb18030', [0xd6, 0xd0], '中'],
        ['big5', [0xa4, 0xa4], '中'], ['utf-16le', [0x2d, 0x4e], '中'],
        ['utf-16be', [0x4e, 0x2d], '中'], ['shift_jis', [0x82, 0xa0], 'あ'],
        ['windows-1252', [0x80], '€']
    ];
    for (const [encoding, bytes, expected] of samples) {
        const decoder = new MappedTextDecoder(encoding);
        const tokens = [...decoder.write(Uint8Array.from(bytes), 0), ...decoder.flush()];
        assert.equal(tokens.map(token => token.text).join(''), expected, encoding);
    }
    const decoder = new MappedTextDecoder('ascii');
    const invalid = decoder.write(Uint8Array.of(0xff), 0)[0];
    assert.equal(invalid.invalid, true);
    assert.equal(invalid.display, '\uFFFD');
    assert.equal(invalid.exportDisplay, '\\xFF');
});

test('invalid and truncated sequences preserve bytes without swallowing following text', () => {
    const { MappedTextDecoder } = require('../textCodec');
    const decoder = new MappedTextDecoder('utf-8');
    const tokens = [...decoder.write(Uint8Array.of(0xe4, 0x41, 0xe4), 0), ...decoder.flush()];
    assert.equal(tokens.map(token => token.display).join(''), '\uFFFDA\uFFFD');
    assert.deepEqual(tokens.map(token => [token.startByte, token.endByte]), [[0, 1], [1, 2], [2, 3]]);
});

test('UTF-16 supplementary characters can span frames', () => {
    const { MappedTextDecoder } = require('../textCodec');
    const decoder = new MappedTextDecoder('utf-16le');
    assert.deepEqual(decoder.write(Uint8Array.of(0x3d, 0xd8, 0), 0), []);
    const tokens = decoder.write(Uint8Array.of(0xde), 1);
    assert.equal(tokens[0].text, '😀');
    assert.equal(tokens[0].endFrame, 1);
});

test('an evicted half UTF-16 code unit remains visible without shifting later characters', () => {
    const { MappedTextDecoder } = require('../textCodec');
    const decoder = new MappedTextDecoder('utf-16le', { byteOffset: 1 });
    const tokens = [...decoder.write(Uint8Array.of(0x4e, 0x41, 0), 0), ...decoder.flush()];
    assert.equal(tokens.map(token => token.display).join(''), '\uFFFDA');
});

test('nonprintable controls display replacements while CR LF and TAB remain visible escapes', () => {
    const { MappedTextDecoder } = require('../textCodec');
    const decoder = new MappedTextDecoder('utf-8');
    const tokens = decoder.write(new TextEncoder().encode('A\0\x1b\x7f\u0085\ufeff\r\n\t\uFFFD'), 2);
    assert.equal(tokens.map(token => token.display).join(''), 'A\uFFFD\uFFFD\uFFFD\uFFFD\uFFFD\\r\\n\\t\uFFFD');
    assert.equal(tokens.map(token => token.text).join(''), 'A\0\x1b\x7f\u0085\ufeff\r\n\t\uFFFD');
    assert.equal(tokens.map(token => token.exportDisplay).join(''),
        'A\\x00\\x1B\\x7F\\u0085\\uFEFF\\r\\n\\t\uFFFD');
    assert.deepEqual(tokens.map(token => token.failed), [false, true, true, true, true, true,
        false, false, false, false]);
    assert.ok(tokens.every(token => !token.invalid));
    assert.deepEqual([tokens[4].startFrame, tokens[4].startByte, tokens[4].endFrame,
        tokens[4].endByte], [2, 4, 2, 6]);
});

test('text character counter counts Unicode code points and failures across byte writes', () => {
    const { TextCharacterCounter } = require('../textCodec');
    assert.equal(typeof TextCharacterCounter, 'function');
    const counter = new TextCharacterCounter('utf-8');
    assert.deepEqual(counter.write(Uint8Array.of(0xe4, 0xb8)), { total: 0, failed: 0 });
    assert.deepEqual(counter.write(Uint8Array.of(0xad, 0xf0, 0x9f)), { total: 1, failed: 0 });
    assert.deepEqual(counter.write(Uint8Array.of(0x98, 0x80, 0x00, 0xff, 0x0d, 0x0a, 0x09)),
        { total: 7, failed: 2 });
    assert.deepEqual(counter.write(new TextEncoder().encode('\uFFFD\u0085\ufeffe\u0301')),
        { total: 12, failed: 4 });
    assert.deepEqual([counter.total, counter.failed], [12, 4]);
    assert.deepEqual(counter.flush(), { total: 12, failed: 4 });
});

test('text character counter flushes incomplete units once and reset discards old encoding state', () => {
    const { TextCharacterCounter } = require('../textCodec');
    assert.equal(typeof TextCharacterCounter, 'function');
    const counter = new TextCharacterCounter('utf-16le');
    assert.deepEqual(counter.write(Uint8Array.of(0x3d, 0xd8, 0x00)), { total: 0, failed: 0 });
    assert.deepEqual(counter.write(Uint8Array.of(0xde, 0x00, 0x00)), { total: 2, failed: 1 });
    assert.deepEqual(counter.write(Uint8Array.of(0x41)), { total: 2, failed: 1 });
    assert.deepEqual(counter.flush(), { total: 3, failed: 2 });
    assert.deepEqual(counter.flush(), { total: 3, failed: 2 });
    counter.write(Uint8Array.of(0x2d));
    counter.reset('gbk');
    assert.deepEqual([counter.total, counter.failed], [0, 0]);
    assert.deepEqual(counter.write(Uint8Array.of(0xd6)), { total: 0, failed: 0 });
    assert.deepEqual(counter.write(Uint8Array.of(0xd0)), { total: 1, failed: 0 });
    counter.reset();
    assert.deepEqual(counter.write(Uint8Array.of(0xd6, 0xd0)), { total: 1, failed: 0 });
});

test('character counting supports every selected encoding without counting individual bytes', () => {
    const { TextCharacterCounter } = require('../textCodec');
    const samples = [
        ['utf-8', [0xf0, 0x9f, 0x98, 0x80], 1, 0], ['ascii', [0x41, 0xff, 0x09], 3, 1],
        ['gbk', [0xd6, 0xd0], 1, 0], ['gb18030', [0x94, 0x39, 0xfc, 0x36], 1, 0],
        ['big5', [0xa4, 0xa4], 1, 0], ['utf-16le', [0x3d, 0xd8, 0x00, 0xde], 1, 0],
        ['utf-16be', [0xd8, 0x3d, 0xde, 0x00], 1, 0], ['shift_jis', [0x82, 0xa0], 1, 0],
        ['windows-1252', [0x80, 0x81, 0x7f], 3, 2]
    ];
    for (const [encoding, bytes, total, failed] of samples) {
        const counter = new TextCharacterCounter(encoding);
        for (const byte of bytes) counter.write(Uint8Array.of(byte));
        assert.deepEqual(counter.flush(), { total, failed }, encoding);
    }
});

test('character counting does not construct mapped display and export tokens', () => {
    const { TextCharacterCounter } = require('../textCodec');
    const counter = new TextCharacterCounter('utf-8');
    const mappedOutput = () => { throw new Error('counting must not request mapped tokens'); };
    counter.decoder.write = mappedOutput;
    counter.decoder.flush = mappedOutput;
    assert.deepEqual(counter.write(Uint8Array.of(65, 0, 255, 0xe4, 0xb8)),
        { total: 3, failed: 2 });
    assert.deepEqual(counter.decoder.pending,
        [{ value: 0xe4, frame: 0, byte: 3 }, { value: 0xb8, frame: 0, byte: 4 }]);
    assert.deepEqual(counter.write(Uint8Array.of(0xad, 0xf0, 0x9f)),
        { total: 4, failed: 2 });
    assert.deepEqual(counter.flush(), { total: 6, failed: 4 });
    assert.deepEqual(counter.flush(), { total: 6, failed: 4 });
});

test('UTF-8 invalid scalar values retain byte grouping and incomplete state', () => {
    const { MappedTextDecoder } = require('../textCodec');
    const decoder = new MappedTextDecoder('utf-8');
    assert.deepEqual(decoder.write(Uint8Array.of(0xe0, 0x80), 7, 9), []);
    const tokens = decoder.write(Uint8Array.of(0x80, 65, 0xed, 0xa0, 0x80,
        0xf4, 0x90, 0x80, 0x80, 0xc0, 0x80), 8, 4);
    assert.equal(tokens.map(token => token.display).join(''), '\uFFFD\uFFFD\uFFFDA' + '\uFFFD'.repeat(9));
    assert.equal(tokens.map(token => token.exportDisplay).join(''),
        '\\xE0\\x80\\x80A\\xED\\xA0\\x80\\xF4\\x90\\x80\\x80\\xC0\\x80');
    assert.deepEqual(tokens.map(token => [token.startFrame, token.startByte,
        token.endFrame, token.endByte]), [[7, 9, 7, 10], [7, 10, 7, 11],
        ...Array.from({ length: 11 }, (_, index) => [8, 4 + index, 8, 5 + index])]);
});

test('character counting matches mapped decoding across random split chunks for every encoding', () => {
    const { CHARSETS, MappedTextDecoder, TextCharacterCounter, isFailedTextCharacter } = require('../textCodec');
    let state = 0x651f38d2;
    const random = () => {
        state ^= state << 13;
        state ^= state >>> 17;
        state ^= state << 5;
        return state >>> 0;
    };
    for (const encoding of CHARSETS) {
        for (const byteOffset of [0, 1]) {
            const bytes = Uint8Array.from({ length: 1027 }, () => random() & 255);
            const mapped = new MappedTextDecoder(encoding, { byteOffset });
            const counter = new TextCharacterCounter(encoding, { byteOffset });
            let total = 0, failed = 0;
            const addTokens = tokens => {
                for (const token of tokens) {
                    for (const char of token.text) {
                        total++;
                        if (token.invalid || isFailedTextCharacter(char)) failed++;
                    }
                }
            };
            for (let offset = 0; offset < bytes.length;) {
                const chunk = bytes.subarray(offset, offset + 1 + random() % 23);
                addTokens(mapped.write(chunk, 0));
                assert.deepEqual(counter.write(chunk), { total, failed }, `${encoding} at ${offset}`);
                assert.deepEqual(counter.decoder.pending, mapped.pending, `${encoding} pending at ${offset}`);
                assert.equal(counter.decoder.orphanByte, mapped.orphanByte, `${encoding} alignment at ${offset}`);
                offset += chunk.length;
            }
            addTokens(mapped.flush());
            assert.deepEqual(counter.flush(), { total, failed }, `${encoding} flush`);
            assert.deepEqual(counter.decoder.pending, [], `${encoding} flushed pending`);
        }
    }
});
