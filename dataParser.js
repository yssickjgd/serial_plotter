class DataParser {
    constructor() {
        this.buffer = new Uint8Array(0);
        this.enableHeader   = true;
        this.headerBytes    = new Uint8Array([0xAB]);
        this.enableFooter   = false;
        this.footerBytes    = new Uint8Array([0x0D, 0x0A]);
        this.dataType       = 'float32';
        this.littleEndian   = true;
        this.channelsCount  = 1;
        this.enableChecksum = false;

        // Callbacks
        this.onFrameParsed = null;  // (values[], timeStr, hexStr)
        this.onRawData     = null;  // (hexStr, timeStr) — every incoming chunk
        this.onFrameError  = null;  // (type: 'checksum'|'footer', hexStr)

        // Stats counters (reset externally by caller)
        this.frameCount = 0;
        this.failCount  = 0;
    }

    static hexToBytes(hexStr) {
        let clean = hexStr.replace(/0x/gi, '').replace(/[\s,]+/g, '');
        if (clean.length === 0) return new Uint8Array(0);
        if (clean.length % 2 !== 0) clean = '0' + clean;
        const bytes = [];
        for (let i = 0; i < clean.length; i += 2) {
            const b = parseInt(clean.substring(i, i + 2), 16);
            if (!isNaN(b)) bytes.push(b);
        }
        return new Uint8Array(bytes);
    }

    setFormat({ enableHeader, headerHex, enableFooter, footerHex,
                dataType, isLittleEndian, channelsCount, enableChecksum }) {
        this.enableHeader   = enableHeader !== false;
        this.enableFooter   = enableFooter === true;
        this.enableChecksum = enableChecksum === true;
        this.dataType       = dataType || 'float32';
        this.littleEndian   = isLittleEndian !== false;
        this.channelsCount  = Math.max(1, parseInt(channelsCount) || 1);

        const hBytes = DataParser.hexToBytes(headerHex || '');
        this.headerBytes = (this.enableHeader && hBytes.length > 0) ? hBytes : new Uint8Array(0);

        const fBytes = DataParser.hexToBytes(footerHex || '');
        this.footerBytes = (this.enableFooter && fBytes.length > 0) ? fBytes : new Uint8Array(0);

        this.buffer = new Uint8Array(0);
    }

    getTypeLength() {
        switch (this.dataType) {
            case 'int8':  case 'uint8':  return 1;
            case 'int16': case 'uint16': return 2;
            case 'int32': case 'uint32': case 'float32': return 4;
            case 'int64': case 'uint64': case 'float64': return 8;
            default: return 4;
        }
    }

    appendData(newData) {
        const merged = new Uint8Array(this.buffer.length + newData.length);
        merged.set(this.buffer, 0);
        merged.set(newData, this.buffer.length);
        this.buffer = merged;
        this.processBuffer();
    }

    processBuffer() {
        const headerLen   = this.enableHeader ? this.headerBytes.length : 0;
        const footerLen   = this.enableFooter ? this.footerBytes.length : 0;
        const checksumLen = this.enableChecksum ? 1 : 0;
        const payloadLen  = this.getTypeLength() * this.channelsCount;
        const frameLen    = headerLen + payloadLen + footerLen + checksumLen;

        while (this.buffer.length >= frameLen) {
            let startIndex = 0;

            if (this.enableHeader && headerLen > 0) {
                let found = -1;
                for (let i = 0; i <= this.buffer.length - headerLen; i++) {
                    let match = true;
                    for (let j = 0; j < headerLen; j++) {
                        if (this.buffer[i + j] !== this.headerBytes[j]) { match = false; break; }
                    }
                    if (match) { found = i; break; }
                }
                if (found === -1) {
                    if (this.onRawData && this.buffer.length > headerLen - 1) {
                        const dropped = this.buffer.slice(0, Math.max(0, this.buffer.length - headerLen + 1));
                        if (dropped.length > 0) {
                            this.onRawData(_bytesToHex(dropped), _fmtTime(new Date()));
                        }
                    }
                    this.buffer = this.buffer.slice(Math.max(0, this.buffer.length - headerLen + 1));
                    break;
                }
                if (found > 0) { this.buffer = this.buffer.slice(found); continue; }
                startIndex = 0;
            }

            if (startIndex + frameLen > this.buffer.length) break;

            const payloadStart = startIndex + headerLen;
            const footerStart  = payloadStart + payloadLen;
            const checksumPos  = footerStart + footerLen;
            const fullFrame    = this.buffer.slice(startIndex, startIndex + frameLen);
            const payload      = this.buffer.slice(payloadStart, payloadStart + payloadLen);

            // Validate footer
            let footerValid = true;
            if (this.enableFooter && footerLen > 0) {
                for (let j = 0; j < footerLen; j++) {
                    if (this.buffer[footerStart + j] !== this.footerBytes[j]) { footerValid = false; break; }
                }
                if (!footerValid) {
                    this.failCount++;
                    if (this.onFrameError) this.onFrameError('footer', _bytesToHex(fullFrame));
                    this.buffer = this.buffer.slice(startIndex + 1);
                    continue;
                }
            }

            // Validate checksum
            let checksumValid = true;
            if (this.enableChecksum) {
                let sum = 0;
                for (let i = 0; i < payload.length; i++) sum += payload[i];
                const expected = sum & 0xFF;
                const provided = this.buffer[checksumPos];
                if (expected !== provided) {
                    checksumValid = false;
                    this.failCount++;
                    if (this.onFrameError) this.onFrameError('checksum', _bytesToHex(fullFrame));
                }
            }

            if (checksumValid) {
                this.frameCount++;
                this._parsePayload(payload, fullFrame);
            }
            this.buffer = this.buffer.slice(startIndex + frameLen);
        }
    }

    _parsePayload(payload, fullFrame) {
        const buf    = payload.buffer.slice(payload.byteOffset, payload.byteOffset + payload.byteLength);
        const view   = new DataView(buf);
        const stride = this.getTypeLength();
        const values = [];
        try {
            for (let c = 0; c < this.channelsCount; c++) {
                const off = c * stride;
                let val = 0;
                switch (this.dataType) {
                    case 'int8':    val = view.getInt8(off); break;
                    case 'uint8':   val = view.getUint8(off); break;
                    case 'int16':   val = view.getInt16(off, this.littleEndian); break;
                    case 'uint16':  val = view.getUint16(off, this.littleEndian); break;
                    case 'int32':   val = view.getInt32(off, this.littleEndian); break;
                    case 'uint32':  val = view.getUint32(off, this.littleEndian); break;
                    case 'float32': val = view.getFloat32(off, this.littleEndian); break;
                    case 'float64': val = view.getFloat64(off, this.littleEndian); break;
                    case 'int64':   val = Number(view.getBigInt64(off, this.littleEndian)); break;
                    case 'uint64':  val = Number(view.getBigUint64(off, this.littleEndian)); break;
                }
                values.push(val);
            }
            if (this.onFrameParsed) {
                const now = new Date();
                this.onFrameParsed(values, _fmtTime(now), _bytesToHex(fullFrame));
            }
        } catch (e) { console.error('解析异常:', e); }
    }
}

function _fmtTime(d) {
    return [d.getHours(), d.getMinutes(), d.getSeconds()]
        .map(n => n.toString().padStart(2, '0')).join(':')
        + '.' + d.getMilliseconds().toString().padStart(3, '0');
}

function _bytesToHex(arr) {
    let s = '';
    for (let i = 0; i < arr.length; i++)
        s += arr[i].toString(16).padStart(2, '0').toUpperCase() + ' ';
    return s.trim();
}
