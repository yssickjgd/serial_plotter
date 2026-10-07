(function(root) {
    'use strict';

    const DEFAULTS = Object.freeze({
        hexBytesPerLine: 'auto', hexGroupBytes: 1, hexOffset: 'none', hexAscii: false,
        textInvalid: 'replacement', textNewline: 'escape', textTab: 'escape',
        timestamp: 'clock', showDirection: true, showRx: true, showTx: true, showErrors: true,
        keyword: '', keywordFormat: 'text', keywordColor: '#bc8fff', keywordCaseSensitive: false,
        rxColor: '#50b4ff', txColor: '#63ff9a', rxErrorColor: '#ffcc02', txErrorColor: '#ff5a5a',
        searchCurrentColor: '#ff8c00', searchMatchColor: '#745a00',
        foldLong: false, foldLines: 8, refreshRate: 10, numericSignificantDigits: 6
    });
    const ENUMS = {
        hexBytesPerLine: ['auto', 8, 16, 32], hexGroupBytes: [1, 2, 4, 8],
        hexOffset: ['none', 'frame', 'stream'], textInvalid: ['replacement', 'escape'],
        textNewline: ['escape', 'line-break'], textTab: ['escape', 'spaces-4', 'spaces-8'],
        timestamp: ['clock', 'absolute', 'relative', 'none'], refreshRate: [1, 5, 10, 20, 30],
        keywordFormat: ['hex', 'text']
    };
    const COLORS = new Set(['keywordColor', 'rxColor', 'txColor', 'rxErrorColor', 'txErrorColor',
        'searchCurrentColor', 'searchMatchColor']);

    function hexKeywordPatterns(keyword) {
        const byteUtils = typeof module !== 'undefined' && module.exports
            ? require('./byteUtils').ByteUtils : root.SerialPlotter.ByteUtils;
        const patterns = [];
        const seen = new Set();
        for (const line of keyword.split(/\r\n|\r|\n/)) {
            if (!line.trim()) continue;
            const bytes = byteUtils.hexToBytes(line);
            if (!bytes.length) throw new TypeError('Hex keyword must contain a complete byte pattern');
            const key = bytes.join(',');
            if (seen.has(key)) continue;
            seen.add(key);
            patterns.push(bytes);
        }
        return patterns;
    }

    /** Validate saved and UI options without mutating the caller or accepting unknown keys. */
    function normalizeDisplayOptions(input = {}) {
        if (!input || typeof input !== 'object' || Array.isArray(input))
            throw new TypeError('Display options must be an object');
        const result = { ...DEFAULTS };
        for (const key of Object.keys(DEFAULTS)) {
            if (!Object.prototype.hasOwnProperty.call(input, key)) continue;
            let value = input[key];
            const choices = ENUMS[key];
            if (choices) {
                if (typeof value === 'string') {
                    const numeric = choices.find(choice => typeof choice === 'number' && String(choice) === value);
                    if (numeric !== undefined) value = numeric;
                }
                if (!choices.includes(value)) throw new RangeError(`Invalid display option: ${key}`);
            } else if (typeof DEFAULTS[key] === 'boolean') {
                if (typeof value !== 'boolean') throw new TypeError(`Invalid display option: ${key}`);
            } else if (key === 'foldLines') {
                if (!Number.isInteger(value) || value < 1 || value > 64)
                    throw new RangeError('foldLines must be an integer from 1 to 64');
            } else if (key === 'numericSignificantDigits') {
                if (!Number.isInteger(value) || value < 1 || value > 17)
                    throw new RangeError('numericSignificantDigits must be an integer from 1 to 17');
            } else if (COLORS.has(key)) {
                if (typeof value !== 'string' || !/^#[0-9a-f]{6}$/i.test(value))
                    throw new TypeError(`${key} must be a six-digit Hex color`);
            } else if (key === 'keyword') {
                if (typeof value !== 'string') throw new TypeError('keyword must be text');
                const lines = value.split(/\r\n|\r|\n/);
                if (value.length > 2048 || lines.some(line => line.length > 256) ||
                    lines.filter(line => line.length > 0).length > 32)
                    throw new RangeError('keyword exceeds its text or line limit');
            }
            result[key] = value;
        }
        if (result.keywordFormat === 'hex') hexKeywordPatterns(result.keyword);
        return result;
    }

    function nonnegativeInteger(value, name) {
        if (!Number.isSafeInteger(value) || value < 0)
            throw new RangeError(`${name} must be a nonnegative safe integer`);
        return value;
    }

    function blockColumns(byteCount, options, offsetDigits) {
        if (!byteCount) return 0;
        const groups = options.hexGroupBytes > 1 ? Math.floor((byteCount - 1) / options.hexGroupBytes) : 0;
        return byteCount * 3 - 1 + groups + (options.hexOffset === 'none' ? 0 : offsetDigits + 2) +
            (options.hexAscii ? byteCount + 4 : 0);
    }

    /** Measure fixed byte blocks arithmetically, including their physical wrapping and short tail. */
    function hexRowLayout(byteLength, bodyColumns, input, byteOffset = 0) {
        nonnegativeInteger(byteLength, 'byteLength');
        nonnegativeInteger(byteOffset, 'byteOffset');
        if (!Number.isFinite(bodyColumns) || !Number.isSafeInteger(Math.floor(bodyColumns)) || bodyColumns < 1)
            throw new RangeError('bodyColumns must be positive');
        const columns = Math.floor(bodyColumns);
        const options = normalizeDisplayOptions(input);
        const finalOffset = (options.hexOffset === 'stream' ? byteOffset : 0) + Math.max(0, byteLength - 1);
        nonnegativeInteger(finalOffset, 'final byte offset');
        const offsetDigits = Math.max(8, finalOffset.toString(16).length);
        let bytesPerLine = options.hexBytesPerLine;
        if (bytesPerLine === 'auto') {
            // Binary search also handles grouping overhead without scanning the frame's bytes.
            let low = 1, high = Math.max(1, Math.floor((columns + 1) / 3));
            while (low < high) {
                const candidate = Math.ceil((low + high) / 2);
                if (blockColumns(candidate, options, offsetDigits) <= columns) low = candidate;
                else high = candidate - 1;
            }
            bytesPerLine = low;
        }
        const linesPerBlock = Math.max(1, Math.ceil(blockColumns(bytesPerLine, options, offsetDigits) / columns));
        const fullBlockCount = Math.floor(byteLength / bytesPerLine);
        const tailByteLength = byteLength % bytesPerLine;
        const tailLines = tailByteLength ? Math.ceil(blockColumns(tailByteLength, options, offsetDigits) / columns) : 0;
        return {
            byteMode: 'hex', hex: true, byteLength, bytesPerLine, columns,
            hexGroupBytes: options.hexGroupBytes, hexOffset: options.hexOffset, hexAscii: options.hexAscii,
            byteOffset, offsetDigits, linesPerBlock, fullBlockCount, tailByteLength, tailLines,
            lineCount: Math.max(1, fullBlockCount * linesPerBlock + tailLines)
        };
    }

    function hexBlockParts(bytes, layout, start) {
        const count = Math.min(layout.bytesPerLine, bytes.length - start);
        const parts = [], values = new Array(count);
        if (layout.hexOffset !== 'none') {
            const offset = start + (layout.hexOffset === 'stream' ? layout.byteOffset : 0);
            parts.push({ text: `${offset.toString(16).toUpperCase().padStart(layout.offsetDigits, '0')}: `,
                byteIndex: null });
        }
        for (let index = 0; index < count; index++) {
            if (index) parts.push({ text: layout.hexGroupBytes > 1 && index % layout.hexGroupBytes === 0 ? '  ' : ' ',
                byteIndex: null });
            const value = bytes[start + index];
            values[index] = value;
            parts.push({ text: value.toString(16).toUpperCase().padStart(2, '0'), byteIndex: start + index });
        }
        if (layout.hexAscii) {
            parts.push({ text: '  |', byteIndex: null });
            for (let index = 0; index < count; index++) {
                const value = values[index];
                parts.push({ text: value >= 32 && value <= 126 ? String.fromCharCode(value) : '.',
                    byteIndex: start + index });
            }
            parts.push({ text: '|', byteIndex: null });
        }
        return parts;
    }

    /** Materialize only blocks intersecting [firstLine, lastLine); every byte index is frame-relative. */
    function hexVisibleParts(bytes, layout) {
        const firstLine = Math.max(0, Math.min(layout.lineCount, Math.floor(layout.firstLine ?? 0)));
        const lastLine = Math.max(firstLine, Math.min(layout.lineCount, Math.floor(layout.lastLine ?? layout.lineCount)));
        if (!bytes.length || firstLine >= lastLine) return [];
        const result = [];
        let cachedBlock = -1, blockParts;
        for (let line = firstLine; line < lastLine; line++) {
            if (line > firstLine) result.push({ text: '\n', byteIndex: null });
            const block = Math.min(layout.fullBlockCount, Math.floor(line / layout.linesPerBlock));
            if (block !== cachedBlock) {
                blockParts = hexBlockParts(bytes, layout, block * layout.bytesPerLine);
                cachedBlock = block;
            }
            const startColumn = (line - block * layout.linesPerBlock) * layout.columns;
            const endColumn = startColumn + layout.columns;
            let column = 0;
            for (const part of blockParts) {
                const end = column + part.text.length;
                if (end > startColumn && column < endColumn) result.push({
                    text: part.text.slice(Math.max(0, startColumn - column), Math.min(part.text.length, endColumn - column)),
                    byteIndex: part.byteIndex
                });
                column = end;
                if (column >= endColumn) break;
            }
        }
        return result;
    }

    /** Kept self-contained so the text history worker can embed this function directly. */
    function textTokenDisplay(token, options = {}) {
        if (token.failed) return options.textInvalid === 'escape' ? token.exportDisplay : token.display;
        if (options.textNewline === 'line-break' && (token.text === '\r' || token.text === '\n'))
            return token.text;
        if (token.text === '\t') {
            if (options.textTab === 'spaces-4') return '    ';
            if (options.textTab === 'spaces-8') return '        ';
        }
        return token.display;
    }

    /** Escape keyword syntax internally; matched ranges always address the original UTF-16 string. */
    function keywordRanges(text, input) {
        const options = normalizeDisplayOptions(input);
        if (!options.keyword || !text) return [];
        const ranges = [];
        for (const keyword of new Set(options.keyword.split(/\r\n|\r|\n/))) {
            if (!keyword) continue;
            const literal = keyword.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
            const pattern = new RegExp(literal, options.keywordCaseSensitive ? 'gu' : 'giu');
            let match;
            while ((match = pattern.exec(text)) !== null) {
                ranges.push({ start: match.index, end: match.index + match[0].length });
                // Allow overlapping matches while advancing across entire surrogate pairs.
                pattern.lastIndex = match.index + (text.codePointAt(match.index) > 0xffff ? 2 : 1);
            }
        }
        ranges.sort((a, b) => a.start - b.start || a.end - b.end);
        const merged = [];
        for (const range of ranges) {
            const previous = merged[merged.length - 1];
            if (previous && range.start <= previous.end) previous.end = Math.max(previous.end, range.end);
            else merged.push({ ...range });
        }
        return merged;
    }

    /** Maximum Hex pattern length, for extending visible raw-byte fragments before rendering. */
    function keywordMaxBytes(input) {
        const options = normalizeDisplayOptions(input);
        if (!options.keyword || options.keywordFormat !== 'hex') return 0;
        return Math.max(0, ...hexKeywordPatterns(options.keyword).map(pattern => pattern.length));
    }

    /** Match original bytes near [firstByte, lastByte), retaining complete intersecting patterns. */
    function hexKeywordRanges(bytes, input, { firstByte = 0, lastByte = bytes.length } = {}) {
        const options = normalizeDisplayOptions(input);
        nonnegativeInteger(firstByte, 'firstByte');
        nonnegativeInteger(lastByte, 'lastByte');
        firstByte = Math.min(firstByte, bytes.length);
        lastByte = Math.min(lastByte, bytes.length);
        if (!options.keyword || firstByte >= lastByte) return [];
        const ranges = [];
        for (const pattern of hexKeywordPatterns(options.keyword)) {
            const firstStart = Math.max(0, firstByte - pattern.length + 1);
            const lastStart = Math.min(lastByte - 1, bytes.length - pattern.length);
            for (let start = firstStart; start <= lastStart; start++) {
                let matched = true;
                for (let index = 0; index < pattern.length; index++) {
                    if (bytes[start + index] !== pattern[index]) {
                        matched = false;
                        break;
                    }
                }
                if (matched) ranges.push({ start, end: start + pattern.length });
            }
        }
        ranges.sort((a, b) => a.start - b.start || a.end - b.end);
        const merged = [];
        for (const range of ranges) {
            const previous = merged[merged.length - 1];
            if (previous && range.start <= previous.end) previous.end = Math.max(previous.end, range.end);
            else merged.push({ ...range });
        }
        return merged;
    }

    function rowIsVisible(row, options = {}) {
        const rx = row.kind === 'rx' || row.kind === 'error';
        const tx = row.kind === 'tx' || row.kind === 'tx-error';
        if (rx && options.showRx === false || tx && options.showTx === false) return false;
        if ((row.kind === 'error' || row.kind === 'tx-error') && options.showErrors === false) return false;
        return true;
    }

    const api = { DEFAULTS, normalizeDisplayOptions, hexRowLayout, hexVisibleParts,
        textTokenDisplay, keywordRanges, hexKeywordRanges, keywordMaxBytes, rowIsVisible };
    root.SerialPlotter = root.SerialPlotter || {};
    root.SerialPlotter.MonitorDisplay = api;
    if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
