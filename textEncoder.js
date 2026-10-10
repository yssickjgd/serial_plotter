/** Incremental export encoders. Legacy maps are built lazily from the browser decoder. */
const exportEncoderCodec = typeof module !== 'undefined' ? require('./textCodec') : SerialPlotter.TextCodec;
const exportEncoderMaps = new Map();

function gb18030PointerBytes(pointer) {
    const fourth = pointer % 10 + 0x30; pointer = Math.floor(pointer / 10);
    const third = pointer % 126 + 0x81; pointer = Math.floor(pointer / 126);
    return [Math.floor(pointer / 10) + 0x81, pointer % 10 + 0x30, third, fourth];
}

async function createExportTextEncoder(encoding = 'utf-8', { yieldControl = () => new Promise(resolve => setTimeout(resolve, 0)) } = {}) {
    encoding = exportEncoderCodec.normalizeTextEncoding(encoding);
    if (encoding === 'utf-8') return new TextEncoder();
    if (encoding.startsWith('utf-16')) return { encode(text) {
        const bytes = new Uint8Array(text.length * 2), view = new DataView(bytes.buffer);
        for (let i = 0; i < text.length; i++) view.setUint16(i * 2, text.charCodeAt(i), encoding === 'utf-16le');
        return bytes;
    } };
    if (!exportEncoderMaps.has(encoding)) exportEncoderMaps.set(encoding, (async () => {
        const map = new Map(), decoder = new TextDecoder(encoding === 'ascii' ? 'windows-1252' : encoding,
            { fatal: true, ignoreBOM: true });
        const add = bytes => {
            try {
                const text = decoder.decode(Uint8Array.from(bytes));
                if (text && !map.has(text)) map.set(text, bytes);
            } catch { /* Invalid byte sequences have no reverse mapping. */ }
        };
        for (let byte = 0; byte < (encoding === 'ascii' ? 128 : 256); byte++) add([byte]);
        if (encoding === 'windows-1252') {
            const codePoints = [0x20ac, 0x81, 0x201a, 0x192, 0x201e, 0x2026, 0x2020, 0x2021,
                0x2c6, 0x2030, 0x160, 0x2039, 0x152, 0x8d, 0x17d, 0x8f, 0x90, 0x2018,
                0x2019, 0x201c, 0x201d, 0x2022, 0x2013, 0x2014, 0x2dc, 0x2122, 0x161,
                0x203a, 0x153, 0x9d, 0x17e, 0x178];
            for (let i = 0; i < codePoints.length; i++) {
                map.delete(String.fromCodePoint(0x80 + i));
                map.set(String.fromCodePoint(codePoints[i]), [0x80 + i]);
            }
        }
        if (!['ascii', 'windows-1252'].includes(encoding)) {
            let work = 0;
            for (let lead = 0x81; lead <= 0xfe; lead++) {
                if (encoding === 'shift_jis' && !(lead <= 0x9f || lead >= 0xe0 && lead <= 0xfc)) continue;
                for (let trail = 0x40; trail <= 0xfe; trail++) {
                    if (trail === 0x7f || encoding === 'big5' && trail >= 0x7f && trail < 0xa1 ||
                        encoding === 'shift_jis' && trail > 0xfc) continue;
                    add([lead, trail]);
                    if (++work % 2048 === 0) await yieldControl();
                }
            }
            if (encoding === 'gb18030') for (let pointer = 0; pointer <= 39419; pointer++) {
                add(gb18030PointerBytes(pointer));
                if (pointer % 2048 === 2047) await yieldControl();
            }
            if (encoding === 'gb18030') map.set('\u20ac', [0xa2, 0xe3]);
        }
        return map;
    })());
    const map = await exportEncoderMaps.get(encoding);
    return { encode(text) {
        const characters = Array.from(text), result = [];
        for (let i = 0; i < characters.length; i++) {
            const pair = characters[i] + (characters[i + 1] ?? '');
            let bytes = i + 1 < characters.length ? map.get(pair) : null;
            if (bytes) i++;
            else bytes = map.get(characters[i]);
            const code = characters[i].codePointAt(0);
            if (!bytes && encoding === 'gb18030' && code >= 0x10000)
                bytes = gb18030PointerBytes(189000 + code - 0x10000);
            if (!bytes) throw new Error(`字符 ${JSON.stringify(characters[i])} 无法使用 ${encoding} 编码，请选择 UTF-8 或 UTF-16`);
            result.push(...bytes);
        }
        return Uint8Array.from(result);
    } };
}

globalThis.SerialPlotter ??= {};
globalThis.SerialPlotter.createExportTextEncoder = createExportTextEncoder;
if (typeof module !== 'undefined') module.exports = { createExportTextEncoder };
