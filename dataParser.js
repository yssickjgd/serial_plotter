/** Streaming binary-frame parser. Callbacks receive bytes, never preformatted Hex.
 * Footer errors report only bytes discarded during resynchronization, without
 * repeating bytes that might belong to a later valid frame. */
const parserByteUtils = typeof module !== 'undefined'
    ? require('./byteUtils').ByteUtils : globalThis.SerialPlotter.ByteUtils;
const parserLimits = typeof module !== 'undefined'
    ? require('./projectLimits').PROJECT_LIMITS : globalThis.SerialPlotter.Limits;

class DataParser {
    constructor() {
        this.buffer = new Uint8Array(256);
        this.readOffset = 0;
        this.writeOffset = 0;
        this.enableHeader = true;
        this.headerBytes = Uint8Array.of(0xAB);
        this.enableFooter = false;
        this.footerBytes = Uint8Array.of(0x0D, 0x0A);
        this.dataType = 'float32';
        this.littleEndian = true;
        this.channelsCount = 1;
        this.enableChecksum = false;
        this.onFrameParsed = null;
        this.onRawData = null;
        this.onFrameError = null;
        this.onCallbackError = null;
        this.frameCount = 0;
        this.failCount = 0;
    }

    static hexToBytes(value) {
        return parserByteUtils.hexToBytes(value);
    }

    setFormat({ enableHeader, headerHex, enableFooter, footerHex,
        dataType, isLittleEndian, channelsCount, enableChecksum }) {
        const count = Number(channelsCount);
        if (!Number.isSafeInteger(count) || count < parserLimits.minChannels || count > parserLimits.maxChannels)
            throw new RangeError(`通道数需为 ${parserLimits.minChannels}–${parserLimits.maxChannels}`);
        const type = dataType || 'float32';
        if (!Object.hasOwn(DataParser.TYPE_LENGTH, type)) throw new Error('不支持的数据类型');
        const header = enableHeader !== false ? DataParser.hexToBytes(headerHex || '') : new Uint8Array(0);
        const footer = enableFooter === true ? DataParser.hexToBytes(footerHex || '') : new Uint8Array(0);
        if (enableHeader !== false && !header.length) throw new Error('启用帧头时必须填写帧头');
        if (enableFooter === true && !footer.length) throw new Error('启用帧尾时必须填写帧尾');
        this.enableHeader = enableHeader !== false;
        this.headerBytes = header;
        this.enableFooter = enableFooter === true;
        this.footerBytes = footer;
        this.enableChecksum = enableChecksum === true;
        this.dataType = type;
        this.littleEndian = isLittleEndian !== false;
        this.channelsCount = count;
        this.reset();
    }

    getTypeLength() { return DataParser.TYPE_LENGTH[this.dataType]; }
    reset() { this.readOffset = 0; this.writeOffset = 0; }

    /** Finish a stopped stream without losing bytes that could not form a complete frame. */
    flushPending() {
        const pending = this.buffer.slice(this.readOffset, this.writeOffset);
        this.reset();
        if (pending.length && this.onFrameError)
            this._notify(this.onFrameError, 'incomplete', _fmtTime(new Date()), pending);
    }

    appendData(data) {
        if (!(data instanceof Uint8Array)) data = new Uint8Array(data);
        if (!data.length) return;
        const time = _fmtTime(new Date());
        if (this.onRawData) this._notify(this.onRawData, data, time);
        this._reserve(data.length);
        this.buffer.set(data, this.writeOffset);
        this.writeOffset += data.length;
        this.processBuffer();
    }

    _reserve(extra) {
        if (this.buffer.length - this.writeOffset >= extra) return;
        const pending = this.writeOffset - this.readOffset;
        if (this.buffer.length - pending >= extra) {
            this.buffer.copyWithin(0, this.readOffset, this.writeOffset);
        } else {
            const next = new Uint8Array(Math.max(this.buffer.length * 2, pending + extra));
            next.set(this.buffer.subarray(this.readOffset, this.writeOffset));
            this.buffer = next;
        }
        this.readOffset = 0;
        this.writeOffset = pending;
    }

    _notify(callback, ...args) {
        try {
            callback(...args);
        } catch (error) {
            if (this.onCallbackError) this.onCallbackError(error);
            else console.error('解析器回调异常:', error);
            throw error;
        }
    }

    processBuffer() {
        const headerLen = this.headerBytes.length;
        const footerLen = this.footerBytes.length;
        const payloadLen = this.getTypeLength() * this.channelsCount;
        const frameLen = headerLen + payloadLen + footerLen + Number(this.enableChecksum);
        let rejectedStart = -1;
        const flushRejected = () => {
            if (rejectedStart < 0) return;
            const discarded = this.buffer.slice(rejectedStart, this.readOffset);
            rejectedStart = -1;
            if (this.onFrameError) this._notify(this.onFrameError,
                'footer', _fmtTime(new Date()), discarded);
        };
        while (this.writeOffset - this.readOffset >= frameLen) {
            const start = this.readOffset;
            if (headerLen) {
                let matches = true;
                for (let j = 0; j < headerLen; j++) {
                    if (this.buffer[start + j] !== this.headerBytes[j]) { matches = false; break; }
                }
                if (!matches) { this.readOffset++; continue; }
            }
            const payloadStart = start + headerLen;
            const footerStart = payloadStart + payloadLen;
            let footerValid = true;
            for (let j = 0; j < footerLen; j++) {
                if (this.buffer[footerStart + j] !== this.footerBytes[j]) { footerValid = false; break; }
            }
            if (!footerValid) {
                this.failCount++;
                if (rejectedStart < 0) rejectedStart = start;
                this.readOffset++;
                continue;
            }
            flushRejected();
            const frame = this.buffer.slice(start, start + frameLen);
            if (this.enableChecksum) {
                let sum = 0;
                for (let i = payloadStart; i < footerStart; i++) sum += this.buffer[i];
                if ((sum & 255) !== this.buffer[footerStart + footerLen]) {
                    this.failCount++;
                    if (this.onFrameError) this._notify(this.onFrameError, 'checksum', _fmtTime(new Date()), frame);
                    this.readOffset += frameLen;
                    continue;
                }
            }
            const view = new DataView(this.buffer.buffer, this.buffer.byteOffset + payloadStart, payloadLen);
            const stride = this.getTypeLength();
            const values = new Array(this.channelsCount);
            for (let c = 0; c < values.length; c++) {
                const off = c * stride;
                switch (this.dataType) {
                    case 'int8': values[c] = view.getInt8(off); break;
                    case 'uint8': values[c] = view.getUint8(off); break;
                    case 'int16': values[c] = view.getInt16(off, this.littleEndian); break;
                    case 'uint16': values[c] = view.getUint16(off, this.littleEndian); break;
                    case 'int32': values[c] = view.getInt32(off, this.littleEndian); break;
                    case 'uint32': values[c] = view.getUint32(off, this.littleEndian); break;
                    case 'float32': values[c] = view.getFloat32(off, this.littleEndian); break;
                    case 'float64': values[c] = view.getFloat64(off, this.littleEndian); break;
                    case 'int64': values[c] = Number(view.getBigInt64(off, this.littleEndian)); break;
                    case 'uint64': values[c] = Number(view.getBigUint64(off, this.littleEndian)); break;
                }
            }
            this.frameCount++;
            if (this.onFrameParsed) {
                const receivedAt = new Date();
                this._notify(this.onFrameParsed, values, _fmtTime(receivedAt), frame, receivedAt.getTime());
            }
            this.readOffset += frameLen;
        }
        flushRejected();
        if (this.readOffset === this.writeOffset) {
            this.reset();
            if (this.buffer.length > 65536) this.buffer = new Uint8Array(256);
        } else if (this.readOffset > this.buffer.length / 2) {
            const pending = this.writeOffset - this.readOffset;
            if (this.buffer.length > 65536 && pending < 32768) {
                const next = new Uint8Array(65536);
                next.set(this.buffer.subarray(this.readOffset, this.writeOffset));
                this.buffer = next;
            } else {
                this.buffer.copyWithin(0, this.readOffset, this.writeOffset);
            }
            this.readOffset = 0;
            this.writeOffset = pending;
        }
    }
}

DataParser.TYPE_LENGTH = Object.freeze({ int8: 1, uint8: 1, int16: 2, uint16: 2,
    int32: 4, uint32: 4, float32: 4, int64: 8, uint64: 8, float64: 8 });

function _fmtTime(d) {
    return [d.getHours(), d.getMinutes(), d.getSeconds()].map(n => String(n).padStart(2, '0')).join(':')
        + '.' + String(d.getMilliseconds()).padStart(3, '0');
}

if (typeof module !== 'undefined') module.exports = { DataParser };
globalThis.SerialPlotter ??= {};
globalThis.SerialPlotter.DataParser = DataParser;
