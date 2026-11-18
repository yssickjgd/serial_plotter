/** Raw stream framing by recognized frames, reception silence, or encoded line endings. */
const rawDataParser = typeof module !== 'undefined' ? require('./dataParser').DataParser : globalThis.SerialPlotter.DataParser;
const rawProtocol = typeof module !== 'undefined' ? require('./protocolEngine').Protocol : globalThis.SerialPlotter.Protocol;
const rawFrameLimits = typeof module !== 'undefined' ? require('./projectLimits').PROJECT_LIMITS : globalThis.SerialPlotter.Limits;

class RawFrameParser {
    constructor({ now = () => performance.now(), wallNow = () => Date.now(),
        setTimeout: schedule = (callback, delay) => globalThis.setTimeout(callback, delay),
        clearTimeout: cancel = timer => globalThis.clearTimeout(timer) } = {}) {
        this.now = now;
        this.wallNow = wallNow;
        this.schedule = schedule;
        this.cancel = cancel;
        this.buffer = new Uint8Array(256);
        this.length = 0;
        this.timer = null;
        this.timerVersion = 0;
        this.boundary = 'idle';
        this.idleGapSeconds = 0.001;
        this.encoding = 'utf-8';
        this.delimiter = new Uint8Array(0);
        this.characterWidth = 1;
        this.frameCount = 0;
        this.failCount = 0;
        this.onRawData = null;
        this.onFrameParsed = null;
        this.onFrameParts = null;
        this.frameParts = [];
        this.onCallbackError = null;
        this.nextByte = 0;
        this.streamStartByte = 0;
        this.suspendTimers = false;
        this.maxFrameBytes = rawFrameLimits.defaultMaxRawFrameBytes;
        this.delimiterTail = [];
        this.segmented = false;
        this.arrayFraming = null;
        this.protocolScanner = null;
        this._clearFramedScan();
    }

    setFormat({ boundary = 'idle', idleGapSeconds = 0.001, encoding = 'utf-8',
        maxFrameBytes = rawFrameLimits.defaultMaxRawFrameBytes, arrayFraming = null, protocolFraming = null } = {}) {
        if (!['idle', 'cr', 'lf', 'crlf', 'lfcr'].includes(boundary))
            throw new Error('不支持的断帧方式');
        const gap = Number(idleGapSeconds);
        if (!Number.isFinite(gap) || gap < 0) throw new RangeError('断帧间隔必须为非负数');
        if (!RawFrameParser.ENCODINGS.includes(encoding)) throw new Error('不支持的字符集');
        if (!Number.isSafeInteger(maxFrameBytes) || maxFrameBytes < 1)
            throw new RangeError('Raw frame byte limit must be a positive integer');
        if (boundary === 'idle' && arrayFraming) {
            const { header, footer, footerOffset, frameLength } = arrayFraming;
            if (!(header instanceof Uint8Array) || !(footer instanceof Uint8Array) || !Number.isSafeInteger(frameLength) ||
                frameLength < 1 || !Number.isSafeInteger(footerOffset) || footerOffset < header.length ||
                footerOffset + footer.length > frameLength) throw new RangeError('数组断帧规则无效');
        }
        const scanner = boundary === 'idle' && protocolFraming
            ? new rawProtocol.StreamParser(protocolFraming, { deferDecode: true }) : null;
        this.onFrameParts = null;
        this.reset();
        this.boundary = boundary;
        this.arrayFraming = boundary === 'idle' ? arrayFraming : null;
        this.protocolScanner = scanner;
        if (scanner) scanner.onFrameParsed = (_record, _time, bytes, _timestamp, stamp) => {
            const start = stamp.byteOffset - this.framedBaseByte;
            this._cutUnmatched(start, 'unmatched');
            this._publishFramed(start, start + bytes.length, 'protocol', false, bytes);
            this.framedStart = start + bytes.length;
        };
        this.idleGapSeconds = gap;
        this.encoding = encoding;
        this.maxFrameBytes = maxFrameBytes;
        this.characterWidth = encoding.startsWith('utf-16') ? 2 : 1;
        const characters = { idle: [], cr: [13], lf: [10], crlf: [13, 10], lfcr: [10, 13] }[boundary];
        this.delimiter = Uint8Array.from(characters.flatMap(value => this.characterWidth === 1
            ? [value] : encoding === 'utf-16le' ? [value, 0] : [0, value]));
    }

    reset() {
        this._cancelTimer();
        this.length = 0;
        this.frameParts = [];
        this.timestamp = NaN;
        this.time = '';
        this.deadline = NaN;
        this.streamStartByte = this.nextByte;
        this.delimiterTail = [];
        this.segmented = false;
        this._clearFramedScan();
        this.protocolScanner?.reset();
    }

    flushPending() {
        this._cancelTimer();
        if (this.arrayFraming || this.protocolScanner) this._flushUnmatched(true);
        else this._emit(this.boundary !== 'idle', true);
        this.delimiterTail = [];
        this.segmented = false;
        this.streamStartByte = this.nextByte;
    }

    /** Read the open idle record without committing it to history or copying its bytes. */
    pendingIdleFrame() {
        if (this.boundary !== 'idle' || !this.length || this.onFrameParts) return null;
        return { ...this.frameMetadata, bytes: this.buffer.subarray(0, this.length),
            time: this.time, timestamp: this.timestamp, kind: 'rx' };
    }

    /** Historical idle replay can assemble immutable input views in background workers. */
    setFramePartsCallback(callback) {
        if (callback !== null && (typeof callback !== 'function' || this.boundary !== 'idle' || this.arrayFraming || this.protocolScanner))
            throw new TypeError('Deferred frame assembly requires idle framing and a callback');
        if (callback === null && this.onFrameParts && this.length) {
            this._reserve(0);
            let offset = 0;
            for (const part of this.frameParts) { this.buffer.set(part, offset); offset += part.length; }
        } else if (callback && !this.onFrameParts && this.length) {
            this.frameParts = [this.buffer.slice(0, this.length)];
        }
        this.onFrameParts = callback;
        if (!callback) this.frameParts = [];
    }

    appendData(data, metadata = {}) {
        if (!(data instanceof Uint8Array)) data = new Uint8Array(data);
        if (!data.length) return;
        const arrival = Number.isFinite(metadata.arrival) ? metadata.arrival : this.now();
        const timestamp = Number.isFinite(metadata.timestamp) ? metadata.timestamp : this.wallNow();
        const byteOffset = Number.isSafeInteger(metadata.byteOffset) ? metadata.byteOffset : this.nextByte;
        const source = { ...metadata, arrival, timestamp, byteOffset, endByte: byteOffset + data.length,
            sourceStartByte: metadata.sourceStartByte ?? byteOffset,
            sourceEndByte: metadata.sourceEndByte ?? byteOffset + data.length };
        this.nextByte = source.endByte;
        const time = RawFrameParser.formatTime(timestamp);
        if (this.boundary === 'idle' && this.idleGapSeconds > 0 && arrival >= this.deadline) {
            if (this.arrayFraming || this.protocolScanner) this._flushUnmatched();
            else this._emit(false);
            this.segmented = false;
        }
        if (this.onRawData) this._notify(this.onRawData, data, time, source);
        if (this.boundary === 'idle') {
            if (this.arrayFraming || this.protocolScanner) this._appendFramed(data, source);
            else for (let offset = 0; offset < data.length;) {
                this._startFrame(time, timestamp, source, byteOffset + offset);
                const count = Math.min(data.length - offset, this.maxFrameBytes - this.length);
                const part = data.subarray(offset, offset + count);
                if (this.onFrameParts) this.frameParts.push(part);
                else {
                    this._reserve(count);
                    this.buffer.set(part, this.length);
                }
                this.length += count;
                offset += count;
                if (this.length === this.maxFrameBytes) this._emit(false, false, 'limit');
            }
            this.deadline = arrival + this.idleGapSeconds * 1000;
            this._scheduleTimer();
            return;
        }
        for (let i = 0; i < data.length; i++) {
            this._startFrame(time, timestamp, source, byteOffset + i);
            this._reserve(1);
            this.buffer[this.length++] = data[i];
            this.delimiterTail.push(data[i]);
            if (this.delimiterTail.length > this.delimiter.length) this.delimiterTail.shift();
            if (this._endsWithDelimiter()) this._emit(false, false, 'delimiter');
            else if (this.length === this.maxFrameBytes) this._emit(false, false, 'limit');
        }
    }

    _clearFramedScan() {
        this.arrayScan = 0;
        this.framedStart = 0;
        this.framedSpans = [];
        this.framedSpanHead = 0;
    }

    get estimatedMemoryBytes() {
        return this.buffer.byteLength + this.framedSpans.length * 256 + (this.protocolScanner?.estimatedMemoryBytes ?? 0);
    }

    _framedStamp(byteOffset) {
        while (this.framedSpanHead + 1 < this.framedSpans.length &&
            this.framedSpans[this.framedSpanHead].endByte <= byteOffset) this.framedSpanHead++;
        return this._stampAt(this.framedSpans[this.framedSpanHead], byteOffset);
    }

    _publishFramed(start, end, endReason, streamEnded = false, bytes) {
        if (start === end) return;
        const stamp = this._framedStamp(this.framedBaseByte + start);
        this._publish(bytes ?? this.buffer.slice(start, end), RawFrameParser.formatTime(stamp.timestamp),
            stamp.timestamp, stamp, end - start, false, streamEnded, endReason);
    }

    _cutUnmatched(end, tailReason, streamEnded = false) {
        const fullSegmentEnd = tailReason === 'stream' || tailReason === 'idle' ? end - 1 : end;
        while (this.framedStart + this.maxFrameBytes <= fullSegmentEnd) {
            const next = this.framedStart + this.maxFrameBytes;
            this._publishFramed(this.framedStart, next, 'limit');
            this.framedStart = next;
        }
        if (tailReason && end > this.framedStart) {
            this._publishFramed(this.framedStart, end, tailReason, streamEnded);
            this.framedStart = end;
        }
    }

    _appendFramed(data, source) {
        if (this.length && this.framedBaseByte + this.length !== source.byteOffset) this._flushUnmatched(true);
        if (!this.length) this.framedBaseByte = source.byteOffset;
        this.framedSpans.push(source);
        this._reserve(data.length);
        this.buffer.set(data, this.length);
        this.length += data.length;
        if (this.protocolScanner) {
            this.protocolScanner.appendData(data, source);
            // The scanner may still need its pending prefix for the next matching attempt.
            this._cutUnmatched(this.protocolScanner.bufferBaseByte - this.framedBaseByte);
        } else this._scanArray();
        const start = this.framedStart;
        this.length -= start;
        this.framedStart = 0;
        if (!this.length) {
            this._clearFramedScan();
            return;
        }
        if (start) this.buffer.copyWithin(0, start, start + this.length);
        this.framedBaseByte += start;
        const stamp = this._framedStamp(this.framedBaseByte);
        this.frameMetadata = stamp;
        this.timestamp = stamp.timestamp;
        this.time = RawFrameParser.formatTime(stamp.timestamp);
        if (this.framedSpanHead) {
            this.framedSpans = this.framedSpans.slice(this.framedSpanHead);
            this.framedSpanHead = 0;
        }
    }

    _scanArray() {
        const { header, footer, footerOffset, frameLength } = this.arrayFraming;
        // Only cut bytes before the scan cursor. The remaining candidate may span receive blocks.
        let scan = this.arrayScan;
        while (scan + (header.length || frameLength) <= this.length) {
            if (rawDataParser.matchesBytes(this.buffer, scan, header)) {
                const end = scan + frameLength;
                if (end > this.length) break;
                if (rawDataParser.matchesBytes(this.buffer, scan + footerOffset, footer)) {
                    this._cutUnmatched(scan, 'unmatched');
                    this._publishFramed(scan, end, 'array');
                    this.framedStart = scan = end;
                    continue;
                }
            }
            scan++;
        }
        this._cutUnmatched(scan);
        this.arrayScan = scan - this.framedStart;
    }

    _flushUnmatched(streamEnded = false) {
        this._cutUnmatched(this.length, streamEnded ? 'stream' : 'idle', streamEnded);
        this.length = 0;
        this._clearFramedScan();
        this.protocolScanner?.reset();
    }

    _startFrame(time, timestamp, source, byteOffset) {
        if (this.length) return;
        this.time = time;
        this.timestamp = timestamp;
        this.frameMetadata = this._stampAt(source, byteOffset);
        this.streamStartByte = this.frameMetadata.streamStartByte;
    }

    _stampAt(source, byteOffset) {
        const width = source.sourceEndByte - source.sourceStartByte;
        return { byteOffset, timestamp: source.timestamp, arrival: source.arrival,
            streamStartByte: source.streamStartByte ?? this.streamStartByte,
            order: (source.order || 0) + (width > 0 ? (byteOffset - source.sourceStartByte) / width : 0) };
    }

    _reserve(extra) {
        if (this.length + extra <= this.buffer.length) return;
        const buffer = new Uint8Array(Math.max(this.buffer.length * 2, this.length + extra));
        buffer.set(this.buffer.subarray(0, this.length));
        this.buffer = buffer;
    }

    _endsWithDelimiter() {
        if (this.delimiterTail.length < this.delimiter.length ||
            (this.frameMetadata.byteOffset + this.length - this.frameMetadata.streamStartByte) % this.characterWidth !== 0) return false;
        for (let i = 0; i < this.delimiter.length; i++)
            if (this.delimiterTail[i] !== this.delimiter[i]) return false;
        return true;
    }

    _emit(incomplete, streamEnded = false, endReason = streamEnded ? 'stream' : 'idle') {
        if (!this.length) return;
        const length = this.length;
        const bytes = this.onFrameParts ? this.frameParts : this.buffer.slice(0, length);
        this.frameParts = [];
        const time = this.time, timestamp = this.timestamp;
        this.length = 0;
        this._publish(bytes, time, timestamp, this.frameMetadata, length, incomplete, streamEnded, endReason);
    }

    _publish(bytes, time, timestamp, metadata, length, incomplete, streamEnded, endReason) {
        this.frameCount++;
        const segmented = this.segmented || endReason === 'limit';
        this.segmented = endReason === 'limit';
        if (endReason !== 'limit') this.delimiterTail = [];
        const callback = this.onFrameParts || this.onFrameParsed;
        if (callback) this._notify(callback, bytes, time, timestamp,
            { ...metadata, endByte: metadata.byteOffset + length, incomplete, streamEnded,
                segmented, endReason });
    }

    _cancelTimer() {
        this.timerVersion++;
        if (this.timer !== null) this.cancel(this.timer);
        this.timer = null;
    }

    _scheduleTimer() {
        this._cancelTimer();
        if (this.suspendTimers || !this.idleGapSeconds) return;
        const version = this.timerVersion;
        const delay = Math.min(2147483647, Math.max(0, this.deadline - this.now()));
        this.timer = this.schedule(() => {
            if (version !== this.timerVersion) return;
            this.timer = null;
            if (!this.length) return;
            if (this.now() < this.deadline) this._scheduleTimer();
            else if (this.arrayFraming || this.protocolScanner) this._flushUnmatched();
            else this._emit(false);
        }, delay);
    }

    /** Replay postpones real timers; restoring them makes a pending frame live again. */
    resumeTimers() {
        this.suspendTimers = false;
        if (this.boundary === 'idle' && this.length) this._scheduleTimer();
    }

    _notify(callback, ...args) {
        try { callback(...args); }
        catch (error) {
            if (this.onCallbackError) this.onCallbackError(error);
            else console.error('解析器回调异常:', error);
            throw error;
        }
    }

    static formatTime(timestamp) {
        const date = new Date(timestamp);
        const pad = (value, width = 2) => String(value).padStart(width, '0');
        return `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}.${pad(date.getMilliseconds(), 3)}`;
    }
}

RawFrameParser.ENCODINGS = Object.freeze(['utf-8', 'ascii', 'gbk', 'gb18030', 'big5',
    'utf-16le', 'utf-16be', 'shift_jis', 'windows-1252']);
if (typeof module !== 'undefined') module.exports = { RawFrameParser };
globalThis.SerialPlotter ??= {};
globalThis.SerialPlotter.RawFrameParser = RawFrameParser;
