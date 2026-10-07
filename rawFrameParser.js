/** Raw stream framing by reception silence or encoded line endings. */
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
        this.onCallbackError = null;
        this.nextByte = 0;
        this.streamStartByte = 0;
        this.suspendTimers = false;
    }

    setFormat({ boundary = 'idle', idleGapSeconds = 0.001, encoding = 'utf-8' } = {}) {
        if (!['idle', 'cr', 'lf', 'crlf', 'lfcr'].includes(boundary))
            throw new Error('不支持的断帧方式');
        const gap = Number(idleGapSeconds);
        if (!Number.isFinite(gap) || gap <= 0) throw new RangeError('断帧间隔必须为正数');
        if (!RawFrameParser.ENCODINGS.includes(encoding)) throw new Error('不支持的字符集');
        this.reset();
        this.boundary = boundary;
        this.idleGapSeconds = gap;
        this.encoding = encoding;
        this.characterWidth = encoding.startsWith('utf-16') ? 2 : 1;
        const characters = { idle: [], cr: [13], lf: [10], crlf: [13, 10], lfcr: [10, 13] }[boundary];
        this.delimiter = Uint8Array.from(characters.flatMap(value => this.characterWidth === 1
            ? [value] : encoding === 'utf-16le' ? [value, 0] : [0, value]));
    }

    reset() {
        this._cancelTimer();
        this.length = 0;
        this.timestamp = NaN;
        this.time = '';
        this.deadline = NaN;
        this.streamStartByte = this.nextByte;
    }

    flushPending() {
        this._cancelTimer();
        this._emit(this.boundary !== 'idle', true);
        this.streamStartByte = this.nextByte;
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
        if (this.boundary === 'idle' && this.length && arrival >= this.deadline)
            this._emit(false);
        if (this.onRawData) this._notify(this.onRawData, data, time, source);
        if (this.boundary === 'idle') {
            this._startFrame(time, timestamp, source, byteOffset);
            this._reserve(data.length);
            this.buffer.set(data, this.length);
            this.length += data.length;
            this.deadline = arrival + this.idleGapSeconds * 1000;
            this._scheduleTimer();
            return;
        }
        this._reserve(data.length);
        for (let i = 0; i < data.length; i++) {
            this._startFrame(time, timestamp, source, byteOffset + i);
            this.buffer[this.length++] = data[i];
            if (this._endsWithDelimiter()) this._emit(false);
        }
    }

    _startFrame(time, timestamp, source, byteOffset) {
        if (this.length) return;
        this.time = time;
        this.timestamp = timestamp;
        const width = source.sourceEndByte - source.sourceStartByte;
        this.frameMetadata = { byteOffset, arrival: source.arrival,
            streamStartByte: source.streamStartByte ?? this.streamStartByte,
            order: (source.order || 0) + (width > 0 ? (byteOffset - source.sourceStartByte) / width : 0) };
        this.streamStartByte = this.frameMetadata.streamStartByte;
    }

    _reserve(extra) {
        if (this.length + extra <= this.buffer.length) return;
        const buffer = new Uint8Array(Math.max(this.buffer.length * 2, this.length + extra));
        buffer.set(this.buffer.subarray(0, this.length));
        this.buffer = buffer;
    }

    _endsWithDelimiter() {
        if (this.length < this.delimiter.length ||
            (this.frameMetadata.byteOffset + this.length - this.frameMetadata.streamStartByte) % this.characterWidth !== 0) return false;
        const start = this.length - this.delimiter.length;
        for (let i = 0; i < this.delimiter.length; i++)
            if (this.buffer[start + i] !== this.delimiter[i]) return false;
        return true;
    }

    _emit(incomplete, streamEnded = false) {
        if (!this.length) return;
        const bytes = this.buffer.slice(0, this.length);
        const time = this.time, timestamp = this.timestamp;
        this.length = 0;
        this.frameCount++;
        if (this.onFrameParsed) this._notify(this.onFrameParsed, bytes, time, timestamp,
            { ...this.frameMetadata, endByte: this.frameMetadata.byteOffset + bytes.length, incomplete, streamEnded });
    }

    _cancelTimer() {
        this.timerVersion++;
        if (this.timer !== null) this.cancel(this.timer);
        this.timer = null;
    }

    _scheduleTimer() {
        this._cancelTimer();
        if (this.suspendTimers) return;
        const version = this.timerVersion;
        const delay = Math.min(2147483647, Math.max(0, this.deadline - this.now()));
        this.timer = this.schedule(() => {
            if (version !== this.timerVersion) return;
            this.timer = null;
            if (!this.length) return;
            if (this.now() < this.deadline) this._scheduleTimer();
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
