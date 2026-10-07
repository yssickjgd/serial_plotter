/** Incremental search over retained decoded samples or the continuous raw byte stream. */
const searchByteUtils = typeof module !== 'undefined'
    ? require('./byteUtils').ByteUtils : globalThis.SerialPlotter.ByteUtils;
const searchTextUtils = typeof module !== 'undefined'
    ? require('./textCodec') : globalThis.SerialPlotter.TextCodec;

function parseMonitorSearch(kind, query, tolerance = 0, channel = -1, encoding = 'utf-8', caseSensitive = true) {
    if (kind === 'text') {
        const pattern = [...String(query)];
        if (!pattern.length) throw new Error('请输入搜索内容');
        return { kind, pattern, encoding: searchTextUtils.normalizeTextEncoding(encoding),
            caseSensitive: Boolean(caseSensitive) };
    }
    if (kind === 'number') {
        const value = Number(query);
        const error = String(tolerance).trim() === '' ? 0 : Number(tolerance);
        if (String(query).trim() === '' || !Number.isFinite(value))
            throw new Error('请输入有限的目标数值');
        if (!Number.isFinite(error) || error < 0)
            throw new Error('误差范围必须是非负有限数值');
        if (Array.isArray(channel)) {
            if (!channel.length || channel.some(index => !Number.isInteger(index) || index < 0) ||
                new Set(channel).size !== channel.length)
                throw new Error('通道选择无效');
            channel = [...channel].sort((left, right) => left - right);
        } else if (!Number.isInteger(channel) || channel < -1) {
            throw new Error('通道选择无效');
        }
        return { kind, value, tolerance: error, channel };
    }
    let bytes;
    if (kind === 'hex') bytes = searchByteUtils.hexToBytes(query);
    else if (kind === 'ascii') {
        if ([...query].some(char => char.charCodeAt(0) > 127))
            throw new Error('ASCII 搜索只能输入 0–127 的字符');
        bytes = Uint8Array.from([...query].map(char => char.charCodeAt(0)));
    } else throw new Error('搜索类型无效');
    if (!bytes.length) throw new Error('请输入搜索内容');
    return { kind, bytes };
}

class MonitorSearchSession {
    constructor(frames, options) {
        if (options.kind === 'number') {
            this.numericChannels = Array.isArray(options.channel) ? options.channel :
                options.channel < 0 ? Array.from({ length: frames.channelCount }, (_, index) => index)
                    : [options.channel];
            if (this.numericChannels.some(channel => channel >= frames.channelCount))
                throw new RangeError('搜索通道超出当前帧格式');
        }
        this.frames = frames;
        this.options = options;
        this.length = frames.length;
        this.firstOrder = frames.orderAt(0);
        this.position = 0;
        this.matches = [];
        this.matched = 0;
        if (options.kind === 'text') this.textDecoder = new searchTextUtils.MappedTextDecoder(options.encoding,
            { byteOffset: (frames.rawByteOffsetAt?.(0) ?? 0) - (frames.streamStartByteAt?.(0) ?? 0) });
        if (options.bytes || options.pattern) {
            const pattern = options.bytes ?? options.pattern;
            this.pattern = pattern;
            // Unicode /iu uses simple case folding: one code point stays one code point.
            // Unlike whole-string case conversion, it cannot expand ß to ss or İ to i + dot.
            this.patternMatchers = options.kind === 'text' && options.caseSensitive === false
                ? pattern.map(char => new RegExp(`^${char.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'iu')) : null;
            this.prefix = new Uint32Array(pattern.length);
            for (let i = 1, j = 0; i < pattern.length; i++) {
                while (j && !this._matchesPattern(pattern[i], j)) j = this.prefix[j - 1];
                if (this._matchesPattern(pattern[i], j)) j++;
                this.prefix[i] = j;
            }
            this.recentFrames = new Uint32Array(pattern.length);
            this.recentBytes = new Uint32Array(pattern.length);
            this.bytePosition = 0;
            this.recentTokens = options.pattern ? new Array(pattern.length) : null;
        }
    }

    step(frameBudget = 256) {
        if (this.length && this.frames.orderAt(0) !== this.firstOrder)
            throw new Error('搜索期间最早帧已被覆盖，请重新搜索');
        const end = Math.min(this.length, this.position + frameBudget);
        const { frames, options } = this;
        for (let frame = this.position; frame < end; frame++) {
            if (options.kind === 'number') {
                for (const channel of this.numericChannels) {
                    const value = frames.getValue(channel, frame);
                    if (Number.isFinite(value) && Math.abs(value - options.value) <= options.tolerance)
                        this.matches.push({ startOrder: frames.orderAt(frame), endOrder: frames.orderAt(frame),
                            startFrame: frame, endFrame: frame, channel });
                }
                continue;
            }
            const bytes = frames.rawBytesAt(frame);
            if (options.kind === 'text') {
                this._consumeText(this.textDecoder.write(bytes, frame));
                if (frames.streamEndedAt?.(frame)) {
                    this._consumeText(this.textDecoder.flush());
                    this.textDecoder = new searchTextUtils.MappedTextDecoder(options.encoding);
                    this.matched = 0;
                }
                continue;
            }
            for (let byte = 0; byte < bytes.length; byte++) {
                const slot = this.bytePosition % options.bytes.length;
                this.recentFrames[slot] = frame;
                this.recentBytes[slot] = byte;
                this.bytePosition++;
                while (this.matched && bytes[byte] !== options.bytes[this.matched])
                    this.matched = this.prefix[this.matched - 1];
                if (bytes[byte] === options.bytes[this.matched]) this.matched++;
                if (this.matched === options.bytes.length) {
                    const firstSlot = (this.bytePosition - options.bytes.length) % options.bytes.length;
                    const startFrame = this.recentFrames[firstSlot];
                    this.matches.push({
                        startFrame, startByte: this.recentBytes[firstSlot],
                        endFrame: frame, endByte: byte + 1,
                        startOrder: frames.orderAt(startFrame), endOrder: frames.orderAt(frame)
                    });
                    this.matched = this.prefix[this.matched - 1];
                }
            }
        }
        this.position = end;
        if (this.position >= this.length && this.textDecoder && !this.textFinished) {
            this._consumeText(this.textDecoder.flush());
            this.textFinished = true;
        }
        return this.position >= this.length;
    }

    _matchesPattern(value, index) {
        return this.patternMatchers ? this.patternMatchers[index].test(value) : value === this.pattern[index];
    }

    _consumeText(tokens) {
        const pattern = this.options.pattern;
        for (const token of tokens) {
            if (token.invalid) {
                this.matched = 0;
                continue;
            }
            for (const char of token.text) {
                this.recentTokens[this.bytePosition % pattern.length] = token;
                this.bytePosition++;
                while (this.matched && !this._matchesPattern(char, this.matched))
                    this.matched = this.prefix[this.matched - 1];
                if (this._matchesPattern(char, this.matched)) this.matched++;
                if (this.matched === pattern.length) {
                    const start = this.recentTokens[(this.bytePosition - pattern.length) % pattern.length];
                    this.matches.push({ startFrame: start.startFrame, startByte: start.startByte,
                        endFrame: token.endFrame, endByte: token.endByte,
                        startOrder: this.frames.orderAt(start.startFrame),
                        endOrder: this.frames.orderAt(token.endFrame) });
                    this.matched = this.prefix[this.matched - 1];
                }
            }
        }
    }
}

if (typeof module !== 'undefined') module.exports = { parseMonitorSearch, MonitorSearchSession };
globalThis.SerialPlotter ??= {};
globalThis.SerialPlotter.MonitorSearch = { parseMonitorSearch, MonitorSearchSession };
