/** Character decoding with source byte spans shared by text display and search. */
const TEXT_CHARSETS = Object.freeze(['utf-8', 'ascii', 'gbk', 'gb18030', 'big5',
    'utf-16le', 'utf-16be', 'shift_jis', 'windows-1252']);

function normalizeTextEncoding(encoding = 'utf-8') {
    const normalized = String(encoding).toLowerCase().replace('shift-jis', 'shift_jis');
    if (!TEXT_CHARSETS.includes(normalized)) throw new RangeError('文本字符集无效');
    return normalized;
}

function isFailedTextCharacter(char) {
    const code = char.codePointAt(0);
    return char !== '\r' && char !== '\n' && char !== '\t' &&
        (code < 32 || code >= 127 && code <= 159 || code === 0xfeff);
}

function visibleText(text) {
    return [...text].map(char => {
        if (char === '\r') return '\\r';
        if (char === '\n') return '\\n';
        if (char === '\t') return '\\t';
        if (isFailedTextCharacter(char)) return '\uFFFD';
        return char;
    }).join('');
}

function escapedText(text) {
    return [...text].map(char => {
        const code = char.codePointAt(0);
        if (char === '\r') return '\\r';
        if (char === '\n') return '\\n';
        if (char === '\t') return '\\t';
        if (code < 32 || code === 127) return `\\x${code.toString(16).padStart(2, '0').toUpperCase()}`;
        if (code >= 128 && code <= 159 || code === 0xfeff)
            return `\\u${code.toString(16).padStart(4, '0').toUpperCase()}`;
        return char;
    }).join('');
}

class MappedTextDecoder {
    constructor(encoding = 'utf-8', { byteOffset = 0 } = {}) {
        this.encoding = normalizeTextEncoding(encoding);
        this.decoder = this.encoding === 'ascii' ? null
            : new TextDecoder(this.encoding, { fatal: true, ignoreBOM: true });
        this.pending = [];
        this.orphanByte = this.encoding.startsWith('utf-16') && byteOffset % 2 !== 0;
    }

    _unitLength(first = this.pending[0].value, second = this.pending[1]?.value) {
        const { encoding } = this;
        if (encoding.startsWith('utf-16')) {
            if (second === undefined) return 2;
            const word = encoding === 'utf-16le' ? first | second << 8 : first << 8 | second;
            return word >= 0xd800 && word <= 0xdbff ? 4 : 2;
        }
        if (encoding === 'utf-8') return first < 0x80 ? 1 : first >= 0xc2 && first <= 0xdf
            ? 2 : first >= 0xe0 && first <= 0xef ? 3 : first >= 0xf0 && first <= 0xf4 ? 4 : 1;
        if (encoding === 'gb18030' && first >= 0x81 && first <= 0xfe) {
            if (second === undefined) return 2;
            return second >= 0x30 && second <= 0x39 ? 4 : 2;
        }
        if ((encoding === 'gbk' || encoding === 'big5') && first >= 0x81 && first <= 0xfe) return 2;
        if (encoding === 'shift_jis' && (first >= 0x81 && first <= 0x9f ||
            first >= 0xe0 && first <= 0xfc)) return 2;
        return 1;
    }

    _process(bytes, frame, startByte, final, counter = null) {
        const tokens = counter ? null : [];
        const { pending, encoding } = this;
        const pendingLength = pending.length, available = pendingLength + bytes.length;
        const utf16 = encoding.startsWith('utf-16');
        // Read pending bytes and the new chunk together; only an unfinished tail needs byte entries.
        const read = index => index < pendingLength ? pending[index].value : bytes[index - pendingLength];
        let position = 0;
        while (position < available) {
            const first = read(position);
            if (counter && first < 128 && !utf16) {
                // Count ASCII runs directly, without byte entries, strings, or display tokens.
                do {
                    const code = read(position++);
                    counter.total++;
                    if (code < 32 && code !== 9 && code !== 10 && code !== 13 || code === 127) counter.failed++;
                } while (position < available && read(position) < 128);
                continue;
            }
            let length = this._unitLength(first, position + 1 < available ? read(position + 1) : undefined);
            let invalid = false, text, code;
            if (encoding === 'utf-8') {
                for (let index = 1; index < length && position + index < available; index++) {
                    const byte = read(position + index);
                    if (byte < 0x80 || byte > 0xbf) { length = 1; invalid = true; break; }
                }
            }
            if (available - position < length) {
                if (!final) break;
                length = utf16 && available - position >= 2 ? 2 : 1;
                invalid = true;
            }
            if (!invalid) {
                if (encoding === 'ascii') {
                    if (first > 127) invalid = true;
                    else code = first;
                } else if (encoding === 'utf-8') {
                    if (first < 128) code = first;
                    else {
                        const second = read(position + 1);
                        invalid = length === 1 || first === 0xe0 && second < 0xa0 ||
                            first === 0xed && second > 0x9f || first === 0xf0 && second < 0x90 ||
                            first === 0xf4 && second > 0x8f;
                        if (invalid) length = 1;
                        else {
                            code = first & (length === 2 ? 0x1f : length === 3 ? 0x0f : 0x07);
                            for (let index = 1; index < length; index++) code = code << 6 | read(position + index) & 0x3f;
                        }
                    }
                } else if (utf16) {
                    code = encoding === 'utf-16le' ? first | read(position + 1) << 8
                        : first << 8 | read(position + 1);
                    if (code >= 0xd800 && code <= 0xdbff) {
                        const low = encoding === 'utf-16le' ? read(position + 2) | read(position + 3) << 8
                            : read(position + 2) << 8 | read(position + 3);
                        invalid = low < 0xdc00 || low > 0xdfff;
                        if (invalid) length = 2;
                        else code = 0x10000 + ((code - 0xd800) << 10) + low - 0xdc00;
                    } else invalid = code >= 0xdc00 && code <= 0xdfff;
                } else if (first < 128) code = first;
                else {
                    try {
                        if (encoding === 'windows-1252' && first >= 0x80 && first <= 0x9f) {
                            // Some Node ICU builds alias this decoder to Latin-1; keep browser and tests identical.
                            text = '€\u0081‚ƒ„…†‡ˆ‰Š‹Œ\u008DŽ\u008F\u0090‘’“”•–—˜™š›œ\u009DžŸ'[first - 0x80];
                        } else {
                            const unit = new Uint8Array(length);
                            for (let index = 0; index < length; index++) unit[index] = read(position + index);
                            text = this.decoder.decode(unit);
                        }
                    } catch { invalid = true; length = 1; }
                }
            }
            if (counter) {
                if (invalid || code !== undefined) {
                    counter.total++;
                    if (invalid || code < 32 && code !== 9 && code !== 10 && code !== 13 ||
                        code >= 127 && code <= 159 || code === 0xfeff) counter.failed++;
                } else {
                    for (const char of text) {
                        counter.total++;
                        if (isFailedTextCharacter(char)) counter.failed++;
                    }
                }
            } else {
                if (code !== undefined && !invalid) text = String.fromCodePoint(code);
                let failed = invalid;
                if (!invalid) for (const char of text) if (isFailedTextCharacter(char)) { failed = true; break; }
                const display = invalid ? '\uFFFD' : failed || text === '\r' || text === '\n' || text === '\t'
                    ? visibleText(text) : text;
                let exportDisplay = invalid ? '' : failed || text === '\r' || text === '\n' || text === '\t'
                    ? escapedText(text) : text;
                if (invalid) for (let index = 0; index < length; index++)
                    exportDisplay += `\\x${read(position + index).toString(16).padStart(2, '0').toUpperCase()}`;
                const end = position + length - 1;
                tokens.push({ text: invalid ? '\uFFFD' : text, display, exportDisplay, invalid, failed,
                    startFrame: position < pendingLength ? pending[position].frame : frame,
                    startByte: position < pendingLength ? pending[position].byte : startByte + position - pendingLength,
                    endFrame: end < pendingLength ? pending[end].frame : frame,
                    endByte: (end < pendingLength ? pending[end].byte : startByte + end - pendingLength) + 1 });
            }
            position += length;
        }
        pending.splice(0, Math.min(position, pendingLength));
        for (let index = Math.max(0, position - pendingLength); index < bytes.length; index++)
            pending.push({ value: bytes[index], frame, byte: startByte + index });
        return tokens;
    }

    _drain(final = false, counter = null) {
        return this._process(new Uint8Array(), 0, 0, final, counter);
    }

    _write(bytes, frame, startByte = 0, counter = null) {
        if (!bytes.length) return counter ? null : [];
        if (!this.orphanByte) return this._process(bytes, frame, startByte, false, counter);
        const first = this._process(bytes.subarray(0, 1), frame, startByte, true, counter);
        this.orphanByte = false;
        const rest = this._process(bytes.subarray(1), frame, startByte + 1, false, counter);
        return counter ? null : first.concat(rest);
    }

    write(bytes, frame, startByte = 0) { return this._write(bytes, frame, startByte); }

    flush() { return this._drain(true); }
}

/** Count completed Unicode characters without finalizing a partial character between writes. */
class TextCharacterCounter {
    constructor(encoding = 'utf-8', options = {}) { this.reset(encoding, options); }

    reset(encoding = this.encoding, options = {}) {
        this.decoder = new MappedTextDecoder(encoding, options);
        this.encoding = this.decoder.encoding;
        this.total = 0;
        this.failed = 0;
    }

    _count(tokens) {
        for (const token of tokens) {
            if (token.invalid) {
                this.total++;
                this.failed++;
            } else {
                for (const char of token.text) {
                    this.total++;
                    if (isFailedTextCharacter(char)) this.failed++;
                }
            }
        }
        return { total: this.total, failed: this.failed };
    }

    write(bytes, startByte = 0) {
        this.decoder._write(bytes, 0, startByte, this);
        return { total: this.total, failed: this.failed };
    }

    flush() {
        this.decoder._drain(true, this);
        return { total: this.total, failed: this.failed };
    }
}

const TextCodec = { CHARSETS: TEXT_CHARSETS, normalizeTextEncoding, visibleText, escapedText, isFailedTextCharacter,
    MappedTextDecoder, TextCharacterCounter };
if (typeof module !== 'undefined') module.exports = TextCodec;
globalThis.SerialPlotter ??= {};
globalThis.SerialPlotter.TextCodec = TextCodec;
globalThis.SerialPlotter.TextCharacterCounter = TextCharacterCounter;
