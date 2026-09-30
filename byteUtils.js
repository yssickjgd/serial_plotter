/** Conversion helpers shared by the parser, monitor, and send panel. */
const ByteUtils = Object.freeze({
    hexToBytes(value) {
        const clean = String(value).trim().split(/[\s,]+/).map(token => {
            const digits = /^0x/i.test(token) ? token.slice(2) : token;
            if (/[^0-9a-f]/i.test(digits))
                throw new Error('Hex 必须由完整的十六进制字节组成');
            return digits;
        }).join('');
        if (clean.length % 2 || /[^0-9a-f]/i.test(clean))
            throw new Error('Hex 必须由完整的十六进制字节组成');
        const out = new Uint8Array(clean.length / 2);
        for (let i = 0; i < out.length; i++) out[i] = parseInt(clean.slice(i * 2, i * 2 + 2), 16);
        return out;
    },
    bytesToHex(bytes) {
        let text = '';
        for (let i = 0; i < bytes.length; i++) {
            if (i) text += ' ';
            text += bytes[i].toString(16).padStart(2, '0').toUpperCase();
        }
        return text;
    },
    textToBytes(value) { return new TextEncoder().encode(value); },
    bytesToText(bytes) { return new TextDecoder('latin1').decode(bytes); }
});

globalThis.SerialPlotter ??= {};
globalThis.SerialPlotter.ByteUtils = ByteUtils;
if (typeof module !== 'undefined') module.exports = { ByteUtils };
