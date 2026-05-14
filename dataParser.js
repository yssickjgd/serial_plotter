/* ═══════════════════════════════════════════════════════════════
 *  dataParser.js — 二进制帧解析器
 *
 *  职责：接收原始字节流，按帧格式配置（帧头/帧尾/校验和/数据类型/通道数）
 *        进行帧匹配与校验，成功后解析有效载荷并通过回调上报。
 *
 *  代码结构：
 *    1. 构造函数（默认配置、回调声明、统计计数器）
 *    2. 配置（setFormat、getTypeLength）
 *    3. 缓冲区管理（appendData、processBuffer）
 *    4. 帧解析（_parsePayload）
 *    5. 工具函数（_fmtTime、_bytesToHex）
 * ═══════════════════════════════════════════════════════════════ */

class DataParser {
    /** 初始化默认帧格式配置、回调指针和统计计数器 */
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
        this.onFrameError  = null;  // (type: 'checksum'|'footer', timeStr, hexStr)

        // Stats counters (reset externally by caller)
        this.frameCount = 0;
        this.failCount  = 0;
    }

    /* ── 配置 ── */

    /** Hex 字符串 → Uint8Array（自动忽略空格、逗号、0x 前缀） */
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

    /** 应用帧格式配置，并清空缓冲区 */
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

    /** 返回当前数据类型的单通道字节长度 */
    getTypeLength() {
        switch (this.dataType) {
            case 'int8':  case 'uint8':  return 1;
            case 'int16': case 'uint16': return 2;
            case 'int32': case 'uint32': case 'float32': return 4;
            case 'int64': case 'uint64': case 'float64': return 8;
            default: return 4;
        }
    }

    /* ── 缓冲区管理 ── */

    /** 追加原始字节到缓冲区，触发 onRawData 回调后调用 processBuffer 解析 */
    appendData(newData) {
        if (this.onRawData && newData && newData.length > 0) {
            try {
                this.onRawData(_bytesToHex(newData), _fmtTime(new Date()));
            } catch (e) {
                console.error('onRawData 回调异常:', e);
            }
        }
        const merged = new Uint8Array(this.buffer.length + newData.length);
        merged.set(this.buffer, 0);
        merged.set(newData, this.buffer.length);
        this.buffer = merged;
        this.processBuffer();
    }

    /**
     * 帧匹配主循环：在缓冲区中搜索完整帧并依次校验。
     *
     * 算法流程：
     *   1. 若启用帧头，逐字节搜索帧头特征序列，未找到则保留尾部避免跨包截断
     *   2. 检查剩余字节是否足够一帧长度
     *   3. 校验帧尾（若启用）→ 校验校验和（若启用）→ 解析有效载荷
     *   4. 移动缓冲区指针，继续搜索下一帧
     */
    processBuffer() {
        const headerLen   = this.enableHeader ? this.headerBytes.length : 0;
        const footerLen   = this.enableFooter ? this.footerBytes.length : 0;
        const checksumLen = this.enableChecksum ? 1 : 0;
        const payloadLen  = this.getTypeLength() * this.channelsCount;
        const frameLen    = headerLen + payloadLen + footerLen + checksumLen;

        while (this.buffer.length >= frameLen) {
            let startIndex = 0;

            // 步骤 1：帧头搜索——逐字节滑动窗口匹配 headerBytes
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
                    // 未找到帧头：保留尾部 headerLen-1 字节（可能为跨包帧头的前半部分）
                    this.buffer = this.buffer.slice(Math.max(0, this.buffer.length - headerLen + 1));
                    break;
                }
                if (found > 0) { this.buffer = this.buffer.slice(found); continue; }
                startIndex = 0;
            }

            // 步骤 2：长度检查——缓冲区剩余字节不足一帧时退出等待更多数据
            if (startIndex + frameLen > this.buffer.length) break;

            const payloadStart = startIndex + headerLen;
            const footerStart  = payloadStart + payloadLen;
            const checksumPos  = footerStart + footerLen;
            const fullFrame    = this.buffer.slice(startIndex, startIndex + frameLen);
            const payload      = this.buffer.slice(payloadStart, payloadStart + payloadLen);

            // 步骤 3a：帧尾校验
            let footerValid = true;
            if (this.enableFooter && footerLen > 0) {
                for (let j = 0; j < footerLen; j++) {
                    if (this.buffer[footerStart + j] !== this.footerBytes[j]) { footerValid = false; break; }
                }
                if (!footerValid) {
                    this.failCount++;
                    if (this.onFrameError) {
                        try { this.onFrameError('footer', _fmtTime(new Date()), _bytesToHex(fullFrame)); }
                        catch (e) { console.error('onFrameError 回调异常:', e); }
                    }
                    this.buffer = this.buffer.slice(startIndex + 1);
                    continue;
                }
            }

            // 步骤 3b：8-bit 和校验
            let checksumValid = true;
            if (this.enableChecksum) {
                let sum = 0;
                for (let i = 0; i < payload.length; i++) sum += payload[i];
                const expected = sum & 0xFF;
                const provided = this.buffer[checksumPos];
                if (expected !== provided) {
                    checksumValid = false;
                    this.failCount++;
                    if (this.onFrameError) {
                        try { this.onFrameError('checksum', _fmtTime(new Date()), _bytesToHex(fullFrame)); }
                        catch (e) { console.error('onFrameError 回调异常:', e); }
                    }
                }
            }

            // 步骤 3c：校验通过 → 解析有效载荷
            if (checksumValid) {
                this.frameCount++;
                this._parsePayload(payload, fullFrame);
            }

            // 步骤 4：移动缓冲区指针，继续搜索下一帧
            this.buffer = this.buffer.slice(startIndex + frameLen);
        }
    }

    /* ── 帧解析 ── */

    /** 按数据类型和通道数解析有效载荷，通过 onFrameParsed 回调上报数值数组 */
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
                try {
                    this.onFrameParsed(values, _fmtTime(now), _bytesToHex(fullFrame));
                } catch (e) {
                    console.error('onFrameParsed 回调异常:', e);
                }
            }
        } catch (e) { console.error('解析异常:', e); }
    }
}

/* ── 工具函数 ── */

/** 返回 "HH:MM:SS.mmm" 格式的时间字符串 */
function _fmtTime(d) {
    return [d.getHours(), d.getMinutes(), d.getSeconds()]
        .map(n => n.toString().padStart(2, '0')).join(':')
        + '.' + d.getMilliseconds().toString().padStart(3, '0');
}

/** Uint8Array → Hex 字符串（大写，空格分隔） */
function _bytesToHex(arr) {
    let s = '';
    for (let i = 0; i < arr.length; i++)
        s += arr[i].toString(16).padStart(2, '0').toUpperCase() + ' ';
    return s.trim();
}
