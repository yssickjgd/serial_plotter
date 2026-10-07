const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function displayModule() {
    const sourcePath = path.join(__dirname, '..', 'monitorDisplay.js');
    assert.ok(fs.existsSync(sourcePath), 'MonitorDisplay must provide the display configuration API');
    return require(sourcePath);
}

test('display options fill missing defaults without sharing mutable input state', () => {
    const { normalizeDisplayOptions, DEFAULTS } = displayModule();
    const input = { hexAscii: true, hexBytesPerLine: '16', hexGroupBytes: '4', refreshRate: '20',
        keyword: 'ACK\n[warn]', keywordColor: '#ABC123', unknown: 'discard me' };
    const options = normalizeDisplayOptions(input);
    assert.deepEqual(options, {
        hexBytesPerLine: 16, hexGroupBytes: 4, hexOffset: 'none', hexAscii: true,
        textInvalid: 'replacement', textNewline: 'escape', textTab: 'escape',
        timestamp: 'clock', showDirection: true, showRx: true, showTx: true, showErrors: true,
        keyword: 'ACK\n[warn]', keywordFormat: 'text', keywordColor: '#ABC123', keywordCaseSensitive: false,
        rxColor: '#50b4ff', txColor: '#63ff9a', rxErrorColor: '#ffcc02', txErrorColor: '#ff5a5a',
        searchCurrentColor: '#ff8c00', searchMatchColor: '#745a00',
        foldLong: false, foldLines: 8, numericSignificantDigits: 6
    });
    assert.equal(input.hexBytesPerLine, '16');
    options.showRx = false;
    assert.equal(DEFAULTS.showRx, true);
    assert.equal(normalizeDisplayOptions().showRx, true);
});

test('display options reject invalid known values instead of silently resetting them', () => {
    const { normalizeDisplayOptions } = displayModule();
    const invalid = [
        { hexBytesPerLine: 12 }, { hexGroupBytes: '3' }, { hexOffset: 'packet' },
        { hexAscii: 'true' }, { textInvalid: 'ignore' }, { textNewline: 'newline' },
        { textTab: 4 }, { timestamp: 'date' }, { showDirection: 1 }, { showRx: null },
        { showTx: 'false' }, { showErrors: undefined }, { keywordCaseSensitive: 0 },
        { foldLong: 1 }, { foldLines: 0 }, { foldLines: 65 }, { foldLines: 1.5 },
        { keywordColor: 'red' }, { keyword: 5 },
        { numericSignificantDigits: 0 }, { numericSignificantDigits: 18 },
        { numericSignificantDigits: 6.5 }, { numericSignificantDigits: '6' }
    ];
    for (const value of invalid) assert.throws(() => normalizeDisplayOptions(value), Error,
        `accepted invalid ${Object.keys(value)[0]}`);
    for (const value of [null, [], 'hex']) assert.throws(() => normalizeDisplayOptions(value), Error);
    assert.equal(normalizeDisplayOptions({ foldLines: 1 }).foldLines, 1);
    assert.equal(normalizeDisplayOptions({ foldLines: 64 }).foldLines, 64);
    assert.equal(normalizeDisplayOptions({ numericSignificantDigits: 1 }).numericSignificantDigits, 1);
    assert.equal(normalizeDisplayOptions({ numericSignificantDigits: 17 }).numericSignificantDigits, 17);
});

test('legacy refresh rates are ignored and never become active display settings', () => {
    const { normalizeDisplayOptions, DEFAULTS } = displayModule();
    assert.ok(!Object.hasOwn(DEFAULTS, 'refreshRate'));
    for (const refreshRate of [1, '20', 60, 'obsolete']) {
        const options = normalizeDisplayOptions({ refreshRate, showTx: false });
        assert.ok(!Object.hasOwn(options, 'refreshRate'));
        assert.equal(options.showTx, false);
    }
});

test('keyword configuration enforces total, per-line and nonempty-line bounds', () => {
    const { normalizeDisplayOptions } = displayModule();
    const accepted = `${'a'.repeat(256)}\n${'b'.repeat(256)}`;
    assert.equal(normalizeDisplayOptions({ keyword: accepted }).keyword, accepted);
    assert.throws(() => normalizeDisplayOptions({ keyword: 'a'.repeat(257) }), Error);
    assert.throws(() => normalizeDisplayOptions({ keyword: Array(33).fill('x').join('\n') }), Error);
    assert.throws(() => normalizeDisplayOptions({ keyword: Array(9).fill('x'.repeat(255)).join('\n') }), Error);
    assert.equal(normalizeDisplayOptions({ keyword: `${'\n'.repeat(40)}x` }).keyword,
        `${'\n'.repeat(40)}x`);
});

test('display color options accept only six-digit Hex values and fill old saved options', () => {
    const { normalizeDisplayOptions } = displayModule();
    const colorKeys = ['rxColor', 'txColor', 'rxErrorColor', 'txErrorColor',
        'searchCurrentColor', 'searchMatchColor'];
    const old = normalizeDisplayOptions({ keyword: 'ACK', showTx: false });
    assert.equal(old.keywordFormat, 'text');
    assert.deepEqual(colorKeys.map(key => old[key]),
        ['#50b4ff', '#63ff9a', '#ffcc02', '#ff5a5a', '#ff8c00', '#745a00']);
    for (const key of [...colorKeys, 'keywordColor']) {
        assert.equal(normalizeDisplayOptions({ [key]: '#aBc123' })[key], '#aBc123');
        for (const value of ['red', '#abc', '#12345678', '#12fg34', '123456', null, 0])
            assert.throws(() => normalizeDisplayOptions({ [key]: value }), Error,
                `accepted invalid ${key}: ${value}`);
    }
});

test('Hex keyword configuration accepts complete byte patterns in each supported notation', () => {
    const { normalizeDisplayOptions, keywordMaxBytes } = displayModule();
    const keyword = 'aa BB\r\n0Xcc, 0xdd\r001122\n\n \t';
    const options = normalizeDisplayOptions({ keywordFormat: 'hex', keyword });
    assert.equal(options.keyword, keyword);
    assert.equal(options.keywordFormat, 'hex');
    assert.equal(keywordMaxBytes(options), 3);
    assert.equal(keywordMaxBytes({ keywordFormat: 'hex', keyword: '\n \t\n' }), 0);
    assert.equal(keywordMaxBytes(), 0);
});

test('Hex keyword configuration rejects malformed lines before an edit can be applied', () => {
    const { normalizeDisplayOptions } = displayModule();
    for (const keyword of ['a', 'abc', 'gg', 'aa\nzz', 'A0xB', '0x', ', ,', 'aa-ff'])
        assert.throws(() => normalizeDisplayOptions({ keywordFormat: 'hex', keyword }), Error,
            `accepted invalid Hex keyword: ${keyword}`);
    assert.throws(() => normalizeDisplayOptions({ keywordFormat: 'binary' }), Error);
    assert.throws(() => normalizeDisplayOptions({ keywordFormat: 'hex', keyword: 'AA'.repeat(129) }), Error);
    assert.throws(() => normalizeDisplayOptions({ keywordFormat: 'hex', keyword: Array(33).fill('AA').join('\n') }), Error);
    assert.equal(normalizeDisplayOptions({ keyword: 'ACK\na' }).keyword, 'ACK\na');
});

test('Hex keywords match original bytes, ignore Hex letter case, and merge overlapping patterns', () => {
    const { hexKeywordRanges, keywordMaxBytes } = displayModule();
    const bytes = Uint8Array.of(0, 0xaa, 0xbb, 0xcc, 0xaa, 0xbb, 0xcc, 0xff);
    const options = { keywordFormat: 'hex', keyword: 'aabb\n0xBB 0xCC\nAABB\nff', keywordCaseSensitive: true };
    assert.deepEqual(hexKeywordRanges(bytes, options), [{ start: 1, end: 8 }]);
    assert.equal(keywordMaxBytes(options), 2);
    assert.deepEqual(hexKeywordRanges(Uint8Array.of(1, 1, 1, 1),
        { keywordFormat: 'hex', keyword: '010101' }), [{ start: 0, end: 4 }]);
    assert.deepEqual(hexKeywordRanges(bytes), []);
    assert.deepEqual(hexKeywordRanges(new Uint8Array(), options), []);
});

test('Hex viewport matching includes complete patterns crossing both byte boundaries', () => {
    const { hexKeywordRanges } = displayModule();
    const bytes = Uint8Array.of(0xaa, 0xbb, 0xcc, 0, 0, 0xaa, 0xbb, 0xcc, 0);
    const options = { keywordFormat: 'hex', keyword: 'aa bb cc' };
    assert.deepEqual(hexKeywordRanges(bytes, options, { firstByte: 1, lastByte: 7 }),
        [{ start: 0, end: 3 }, { start: 5, end: 8 }]);
    assert.deepEqual(hexKeywordRanges(bytes, options, { firstByte: 3, lastByte: 5 }), []);
    assert.deepEqual(hexKeywordRanges(bytes, options, { firstByte: 6, lastByte: 6 }), []);
    assert.deepEqual(hexKeywordRanges(bytes, options, { firstByte: 7, lastByte: 8 }),
        [{ start: 5, end: 8 }]);
});

test('late Hex keyword viewport matching reads only nearby bytes in a million-byte frame', () => {
    const { hexKeywordRanges } = displayModule();
    const frame = new Uint8Array(1_000_000);
    frame.set([0xaa, 0xbb, 0xcc], 900_000);
    frame.set([0xaa, 0xbb, 0xcc], 900_019);
    const reads = [];
    const bytes = new Proxy(frame, {
        get(target, key) {
            if (/^\d+$/.test(String(key))) reads.push(Number(key));
            return Reflect.get(target, key, target);
        }
    });
    assert.deepEqual(hexKeywordRanges(bytes, { keywordFormat: 'hex', keyword: 'aabbcc' },
        { firstByte: 900_001, lastByte: 900_020 }),
    [{ start: 900_000, end: 900_003 }, { start: 900_019, end: 900_022 }]);
    assert.ok(reads.length <= 63, `scanned too many bytes: ${reads.length}`);
    assert.ok(reads.every(index => index >= 899_999 && index < 900_022),
        'read byte outside the viewport and keyword overlap');
});

test('default Hex auto layout keeps existing spacing and fills available columns', () => {
    const { hexRowLayout, hexVisibleParts } = displayModule();
    const bytes = Uint8Array.of(0, 1, 2, 3, 4, 5, 6, 255);
    const layout = hexRowLayout(bytes.length, 11);
    assert.equal(layout.byteMode, 'hex');
    assert.equal(layout.hex, true);
    assert.equal(layout.bytesPerLine, 4);
    assert.equal(layout.lineCount, 2);
    assert.equal(layout.columns, 11);
    assert.equal(hexVisibleParts(bytes, layout).map(part => part.text).join(''),
        '00 01 02 03\n04 05 06 FF');
});

test('Hex grouping, offset and ASCII output share the original byte indexes', () => {
    const { hexRowLayout, hexVisibleParts } = displayModule();
    const bytes = Uint8Array.of(65, 66, 0, 255, 67, 68, 69, 70, 71);
    const layout = hexRowLayout(bytes.length, 80,
        { hexBytesPerLine: 8, hexGroupBytes: 2, hexOffset: 'stream', hexAscii: true }, 4096);
    const parts = hexVisibleParts(bytes, layout);
    assert.equal(parts.map(part => part.text).join(''),
        '00001000: 41 42  00 FF  43 44  45 46  |AB..CDEF|\n00001008: 47  |G|');
    for (const [index, hex, ascii] of [[0, '41', 'A'], [2, '00', '.'], [8, '47', 'G']]) {
        assert.deepEqual(parts.filter(part => part.byteIndex === index).map(part => part.text), [hex, ascii]);
    }
    assert.ok(parts.filter(part => part.text.includes('000010')).every(part => part.byteIndex === null));
});

test('auto Hex layout fits all selected decorations before choosing bytes per line', () => {
    const { hexRowLayout, hexVisibleParts } = displayModule();
    const bytes = Uint8Array.of(65, 66, 67, 68, 69);
    const layout = hexRowLayout(bytes.length, 26,
        { hexGroupBytes: 2, hexOffset: 'frame', hexAscii: true });
    assert.equal(layout.bytesPerLine, 3);
    assert.equal(layout.linesPerBlock, 1);
    assert.equal(layout.lineCount, 2);
    assert.equal(hexVisibleParts(bytes, layout).map(part => part.text).join(''),
        '00000000: 41 42  43  |ABC|\n00000003: 44 45  |DE|');
});

test('manual Hex byte counts wrap complete blocks without truncating narrow rows', () => {
    const { hexRowLayout, hexVisibleParts } = displayModule();
    const bytes = Uint8Array.from({ length: 10 }, (_, index) => index);
    const layout = hexRowLayout(bytes.length, 10, { hexBytesPerLine: 8 });
    assert.equal(layout.bytesPerLine, 8);
    assert.equal(layout.linesPerBlock, 3);
    assert.equal(layout.lineCount, 4);
    assert.equal(hexVisibleParts(bytes, layout).map(part => part.text).join(''),
        '00 01 02 0\n3 04 05 06\n 07\n08 09');
    const middle = hexVisibleParts(bytes, { ...layout, firstLine: 1, lastLine: 3 });
    assert.equal(middle.map(part => part.text).join(''), '3 04 05 06\n 07');
    assert.equal(middle[0].byteIndex, 3);
    assert.ok(middle.every(part => part.byteIndex === null || part.byteIndex >= 3 && part.byteIndex <= 7));
});

test('manual grouped blocks count each full block and shorter tail precisely', () => {
    const { hexRowLayout, hexVisibleParts } = displayModule();
    const bytes = Uint8Array.from({ length: 9 }, (_, index) => 65 + index);
    const layout = hexRowLayout(bytes.length, 10,
        { hexBytesPerLine: 8, hexGroupBytes: 2, hexOffset: 'frame', hexAscii: true });
    assert.equal(layout.linesPerBlock, 5);
    assert.equal(layout.lineCount, 7);
    const output = hexVisibleParts(bytes, layout).map(part => part.text).join('');
    assert.equal(output,
        '00000000: \n41 42  43 \n44  45 46 \n 47 48  |A\nBCDEFGH|\n00000008: \n49  |I|');
    assert.equal(hexVisibleParts(bytes, { ...layout, firstLine: 4, lastLine: 6 })
        .map(part => part.text).join(''), 'BCDEFGH|\n00000008: ');
});

test('Hex offset grows beyond eight digits and stream offset changes only display labels', () => {
    const { hexRowLayout, hexVisibleParts } = displayModule();
    const bytes = Uint8Array.of(65);
    const layout = hexRowLayout(1, 40, { hexOffset: 'stream' }, 0x100000000);
    assert.equal(layout.offsetDigits, 9);
    assert.equal(hexVisibleParts(bytes, layout).map(part => part.text).join(''), '100000000: 41');
    assert.equal(hexVisibleParts(bytes, layout).find(part => part.text === '41').byteIndex, 0);
    const frame = hexRowLayout(1, 40, { hexOffset: 'frame' }, 0x100000000);
    assert.equal(hexVisibleParts(bytes, frame).map(part => part.text).join(''), '00000000: 41');
});

test('empty, tiny and out-of-range Hex views retain accurate physical line counts', () => {
    const { hexRowLayout, hexVisibleParts } = displayModule();
    const empty = hexRowLayout(0, 1);
    assert.equal(empty.lineCount, 1);
    assert.deepEqual(hexVisibleParts(new Uint8Array(), empty), []);
    const layout = hexRowLayout(1, 1);
    assert.equal(layout.bytesPerLine, 1);
    assert.equal(layout.lineCount, 2);
    assert.equal(hexVisibleParts(Uint8Array.of(255), layout).map(part => part.text).join(''), 'F\nF');
    assert.deepEqual(hexVisibleParts(Uint8Array.of(255), { ...layout, firstLine: 2, lastLine: 3 }), []);
});

test('Hex layout rejects invalid dimensions and offsets before deriving physical lines', () => {
    const { hexRowLayout } = displayModule();
    for (const args of [[-1, 10], [1.5, 10], [1, 0], [1, NaN], [1, Infinity],
        [1, Number.MAX_SAFE_INTEGER + 1], [1, 10, undefined, -1],
        [1, 10, undefined, Number.MAX_SAFE_INTEGER + 1],
        [2, 10, { hexOffset: 'stream' }, Number.MAX_SAFE_INTEGER]]) {
        assert.throws(() => hexRowLayout(...args), RangeError);
    }
});

test('a late visible Hex slice reads only its block from a million-byte frame', () => {
    const { hexRowLayout, hexVisibleParts } = displayModule();
    const reads = [];
    const bytes = new Proxy({ length: 1000000 }, { get(target, key) {
        if (/^\d+$/.test(String(key))) { reads.push(Number(key)); return 65; }
        return target[key];
    } });
    const layout = hexRowLayout(bytes.length, 20,
        { hexBytesPerLine: 32, hexOffset: 'stream', hexAscii: true }, 5000000);
    const parts = hexVisibleParts(bytes, { ...layout, firstLine: 155554, lastLine: 155555 });
    assert.ok(parts.length > 0);
    assert.ok(reads.length <= 32, `formatted offscreen bytes: ${reads.length}`);
    assert.ok(reads.every(index => index >= 622208 && index < 622240));
    assert.ok(parts.every(part => part.byteIndex === null || part.byteIndex >= 622208 && part.byteIndex < 622240));
});

test('text display choices preserve original tokens and their failure and byte mappings', () => {
    const { textTokenDisplay } = displayModule();
    const token = Object.freeze({ text: '\0', display: '\uFFFD', exportDisplay: '\\x00', failed: true,
        startFrame: 1, startByte: 2, endFrame: 1, endByte: 3 });
    assert.equal(textTokenDisplay(token), '\uFFFD');
    assert.equal(textTokenDisplay(token, { textInvalid: 'escape' }), '\\x00');
    assert.equal(token.text, '\0');
    assert.deepEqual([token.startFrame, token.startByte, token.endFrame, token.endByte, token.failed],
        [1, 2, 1, 3, true]);
    const validReplacement = { text: '\uFFFD', display: '\uFFFD', exportDisplay: '\uFFFD', failed: false };
    assert.equal(textTokenDisplay(validReplacement, { textInvalid: 'escape' }), '\uFFFD');
});

test('text newline and tab choices render controls without changing their raw characters', () => {
    const { textTokenDisplay } = displayModule();
    for (const [text, display] of [['\r', '\\r'], ['\n', '\\n']]) {
        const token = Object.freeze({ text, display, exportDisplay: display, failed: false });
        assert.equal(textTokenDisplay(token), display);
        assert.equal(textTokenDisplay(token, { textNewline: 'line-break' }), text);
        assert.equal(token.text, text);
    }
    const tab = Object.freeze({ text: '\t', display: '\\t', exportDisplay: '\\t', failed: false });
    assert.equal(textTokenDisplay(tab), '\\t');
    assert.equal(textTokenDisplay(tab, { textTab: 'spaces-4' }), '    ');
    assert.equal(textTokenDisplay(tab, { textTab: 'spaces-8' }), '        ');
});

test('text token display can be copied into an isolated worker without module closures', () => {
    const { textTokenDisplay } = displayModule();
    const workerFunction = vm.runInNewContext(`(${textTokenDisplay.toString()})`);
    assert.equal(workerFunction({ text: 'A', display: 'A', failed: false }), 'A');
    assert.equal(workerFunction({ text: '\t', display: '\\t', failed: false }, { textTab: 'spaces-4' }), '    ');
    assert.equal(workerFunction({ text: '\uFFFD', display: '\uFFFD', exportDisplay: '\\xFF', failed: true },
        { textInvalid: 'escape' }), '\\xFF');
});

test('keywords are literal per-line matches, with selectable case and sorted merged ranges', () => {
    const { keywordRanges } = displayModule();
    const text = 'ACK a.b [warn] ack acb A.B';
    assert.deepEqual(keywordRanges(text, { keyword: 'a.b\r\n\nACK\r[warn]' }),
        [{ start: 0, end: 3 }, { start: 4, end: 7 }, { start: 8, end: 14 },
            { start: 15, end: 18 }, { start: 23, end: 26 }]);
    assert.deepEqual(keywordRanges(text, { keyword: 'ACK\na.b', keywordCaseSensitive: true }),
        [{ start: 0, end: 3 }, { start: 4, end: 7 }]);
    assert.deepEqual(keywordRanges('banana', { keyword: 'ana\nna' }), [{ start: 1, end: 6 }]);
    assert.deepEqual(keywordRanges('abc', { keyword: 'a\nb\nc' }), [{ start: 0, end: 3 }]);
    assert.deepEqual(keywordRanges('abc'), []);
});

test('keyword matches retain original UTF-16 indexes for Unicode case and overlapping symbols', () => {
    const { keywordRanges } = displayModule();
    assert.deepEqual(keywordRanges('\u0130x A', { keyword: 'a' }), [{ start: 3, end: 4 }]);
    assert.deepEqual(keywordRanges('😀😀X', { keyword: '😀😀\n😀' }), [{ start: 0, end: 4 }]);
    assert.deepEqual(keywordRanges('a+b aaab', { keyword: 'a+b' }), [{ start: 0, end: 3 }]);
});

test('RX and TX filtering intersects direction and error switches without hiding ordinary rows', () => {
    const { rowIsVisible } = displayModule();
    for (const kind of ['rx', 'error', 'tx', 'tx-error']) assert.equal(rowIsVisible({ kind }), true);
    assert.equal(rowIsVisible({ kind: 'rx' }, { showRx: false }), false);
    assert.equal(rowIsVisible({ kind: 'error' }, { showRx: false, showErrors: true }), false);
    assert.equal(rowIsVisible({ kind: 'error' }, { showRx: true, showErrors: false }), false);
    assert.equal(rowIsVisible({ kind: 'tx' }, { showTx: false }), false);
    assert.equal(rowIsVisible({ kind: 'tx-error' }, { showTx: false, showErrors: true }), false);
    assert.equal(rowIsVisible({ kind: 'tx-error' }, { showTx: true, showErrors: false }), false);
    assert.equal(rowIsVisible({ kind: 'rx' }, { showErrors: false, showTx: false, showDirection: false }), true);
    assert.equal(rowIsVisible({ kind: 'tx' }, { showErrors: false, showRx: false, showDirection: false }), true);
});

test('classic script exports the same API without requiring a CommonJS environment', () => {
    const context = vm.createContext({ SerialPlotter: { existingFeature: true } });
    vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'monitorDisplay.js'), 'utf8'), context);
    const api = context.SerialPlotter.MonitorDisplay;
    assert.equal(context.SerialPlotter.existingFeature, true);
    assert.equal(api.normalizeDisplayOptions().hexBytesPerLine, 'auto');
    assert.equal(api.hexRowLayout(9, 11).lineCount, 3);
    assert.equal(api.textTokenDisplay({ text: 'A', display: 'A' }), 'A');
});

test('classic script Hex keywords validate and match through shared browser byte helpers', () => {
    const context = vm.createContext({ SerialPlotter: {} });
    vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'monitorDisplay.js'), 'utf8'), context);
    vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'byteUtils.js'), 'utf8'), context);
    const api = context.SerialPlotter.MonitorDisplay;
    const options = { keywordFormat: 'hex', keyword: '0xaa BB\ncc' };
    assert.equal(api.normalizeDisplayOptions(options).keywordFormat, 'hex');
    assert.equal(api.keywordMaxBytes(options), 2);
    assert.equal(JSON.stringify(api.hexKeywordRanges(Uint8Array.of(0, 0xaa, 0xbb, 0, 0xcc), options)),
        '[{"start":1,"end":3},{"start":4,"end":5}]');
    assert.throws(() => api.normalizeDisplayOptions({ keywordFormat: 'hex', keyword: 'gg' }), /Hex/);
});
