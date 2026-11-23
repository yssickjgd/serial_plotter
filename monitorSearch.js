/** Incremental search over retained decoded samples or the continuous raw byte stream. */
const searchByteUtils = typeof module !== 'undefined'
    ? require('./byteUtils').ByteUtils : globalThis.SerialPlotter.ByteUtils;
const searchTextUtils = typeof module !== 'undefined'
    ? require('./textCodec') : globalThis.SerialPlotter.TextCodec;
const searchProtocolUtils = typeof module !== 'undefined'
    ? require('./protocolRecords') : globalThis.SerialPlotter;
const { transformChannelValue: searchTransform } = typeof module !== 'undefined'
    ? require('./channelTransform') : { transformChannelValue: globalThis.SerialPlotter.transformChannelValue };

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
                    const raw = frames.getValue(channel, frame);
                    const value = options.valueTransform ? options.valueTransform(raw, channel) : raw;
                    if (Number.isFinite(value) && Math.abs(value - options.value) <= options.tolerance)
                        this.matches.push({ startOrder: frames.orderAt(frame), endOrder: frames.orderAt(frame),
                            startFrame: frame, endFrame: frame, channel });
                }
                continue;
            }
            const bytes = frames.rawBytesAt(frame);
            if (options.kind === 'text') {
                for (let offset = 0; offset < bytes.length; offset += 16384)
                    this._consumeText(this.textDecoder.write(bytes.subarray(offset, offset + 16384), frame, offset));
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

function parseProtocolFieldSearch(kind, query, tolerance = 0, path = null, caseSensitive = true) {
    kind = String(kind).replace(/^field-/, '').replace(/^protocol-/, '');
    if (['int64', 'uint64', 'exact64', 'integer'].includes(kind)) kind = 'integer64';
    const paths = path === null || path === undefined || path === '' ? null : Array.isArray(path) ? path : [path];
    if (paths && paths.some(value => typeof value !== 'string' || !value)) throw new Error('结构字段路径无效');
    const options = { kind, paths, caseSensitive: Boolean(caseSensitive) };
    if (kind === 'number') {
        const numeric = parseMonitorSearch('number', query, tolerance);
        return { ...options, value: numeric.value, tolerance: numeric.tolerance };
    }
    if (kind === 'integer64') {
        if (typeof query === 'number' && !Number.isSafeInteger(query)) throw new Error('请使用十进制文本输入精确 64 位整数');
        const text = String(query).trim();
        if (!/^[+-]?\d+$/.test(text)) throw new Error('请输入十进制整数，64 位整数会保持精确');
        return { ...options, value: BigInt(text) };
    }
    if (kind === 'text') {
        if (!String(query).length) throw new Error('请输入搜索内容');
        return { ...options, query: String(query) };
    }
    throw new Error('结构字段搜索类型无效');
}

/** One match per field, with its exact source bytes and optional packed-bit location. */
class ProtocolFieldSearchSession {
    constructor(frames, options, extra = {}) {
        if (typeof options === 'function') options = { ...extra, decodeRecord: options };
        if (typeof options.decodeRecord !== 'function') throw new TypeError('结构字段搜索需要协议解码器');
        this.options = { ...options, ...parseProtocolFieldSearch(options.kind ?? 'text', options.query ?? options.value,
            options.tolerance ?? 0, options.paths ?? options.fieldPaths ?? options.path ?? null, options.caseSensitive ?? true) };
        this.frames = frames; this.decodeRecord = options.decodeRecord; this.length = frames.length;
        this.firstOrder = frames.orderAt(0); this.position = 0; this.matches = [];
    }
    step(frameBudget = 256) {
        if (!Number.isInteger(frameBudget) || frameBudget < 1) throw new RangeError('搜索步长必须为正整数');
        if (this.length && this.frames.orderAt(0) !== this.firstOrder) throw new Error('搜索期间最早帧已被覆盖，请重新搜索');
        const end = Math.min(this.length, this.position + frameBudget), options = this.options;
        for (let frame = this.position; frame < end; frame++) {
            const record = searchProtocolUtils.unwrapProtocolRecord(this.decodeRecord(frame));
            for (const field of searchProtocolUtils.protocolVisibleFields(record, { ...options, fieldPaths: options.paths })) {
                let match = false;
                if (options.kind === 'number') {
                    const value = typeof field.numeric === 'number' ? field.numeric : typeof field.value === 'number' ? field.value :
                        typeof field.value === 'bigint' && field.value >= BigInt(Number.MIN_SAFE_INTEGER) && field.value <= BigInt(Number.MAX_SAFE_INTEGER)
                            ? Number(field.value) : NaN;
                    match = Number.isFinite(value) && Math.abs(value - options.value) <= options.tolerance;
                } else if (options.kind === 'integer64') {
                    const value = field.value;
                    if (typeof value === 'bigint' || typeof value === 'number' && Number.isSafeInteger(value) ||
                        typeof value === 'string' && /^[+-]?\d+$/.test(value)) match = BigInt(value) === options.value;
                } else {
                    let text = searchProtocolUtils.protocolValueText(field.value), query = options.query;
                    if (!options.caseSensitive) { text = text.toLocaleLowerCase(); query = query.toLocaleLowerCase(); }
                    match = text.includes(query);
                }
                if (!match) continue;
                const byteLength = this.frames.rawBytesAt(frame).length;
                const startByte = Math.max(0, Math.min(byteLength, field.byteOffset ?? 0));
                const endByte = Math.max(startByte, Math.min(byteLength, field.endByte ?? startByte + 1));
                this.matches.push({ startFrame: frame, endFrame: frame, startOrder: this.frames.orderAt(frame),
                    endOrder: this.frames.orderAt(frame), startByte, endByte, path: field.path, fieldId: field.fieldId,
                    ...(field.bitOffset === undefined ? {} : { bitOffset: field.bitOffset, bitLength: field.bitLength }) });
            }
        }
        this.position = end; return this.position >= this.length;
    }
}

function createMonitorSearchProcessor(task, protocol) {
    const { orders, values, channels, records, search, start, firstOwned, firstSkip = 0, schema } = task;
    const frames = {
        length: orders.length, channelCount: channels?.length,
        orderAt: index => orders[index],
        getValue: (channel, index) => values[index * channels.length + channel],
        rawBytesAt: index => records[index].bytes,
        rawByteOffsetAt: index => records[index].byteOffset,
        streamStartByteAt: index => records[index].streamStart,
        streamEndedAt: index => records[index].ended
    };
    let session;
    if (schema) {
        const compiled = protocol.compile(schema);
        session = new ProtocolFieldSearchSession(frames, { ...search,
            decodeRecord: index => protocol.decode(records[index].bytes, compiled, { maxFields: task.maxFields }) });
    } else if (values) {
        session = new MonitorSearchSession(frames, { ...search, channel: -1,
            valueTransform: (raw, channel) => searchTransform(raw, search.channelSettings?.[channel]) });
    } else session = new MonitorSearchSession(frames, search);

    return {
        step(budget) { return session.step(budget === Infinity ? orders.length : Math.max(1, Math.floor(budget / 256))); },
        result() {
            return session.matches.filter(match => match.endFrame >= firstOwned).map(match => {
                if (match.startFrame === 0 && match.startByte !== undefined) match.startByte += firstSkip;
                if (match.endFrame === 0 && match.endByte !== undefined) match.endByte += firstSkip;
                match.startFrame += start;
                match.endFrame += start;
                if (channels) match.channel = channels[match.channel];
                return match;
            });
        }
    };
}

// Overlap preserves matches that start in one byte batch and end in the next.
function monitorSearchPrefix(frames, start, options) {
    const text = options.kind === 'text', encoding = options.encoding;
    const overlapBytes = text ? options.pattern.length * 4 + 4 : options.bytes.length - 1;
    let first = start, bytes = 0;
    while (first > 0 && bytes < overlapBytes) {
        if (text && frames.streamEndedAt?.(first - 1)) break;
        bytes += frames.rawBytesAt(--first).length;
    }
    const legacy = text && ['gbk', 'gb18030', 'big5', 'shift_jis'].includes(encoding);
    if (!legacy) return { first, skip: 0 };
    // Legacy encodings can interpret the same byte as a lead or trail byte. Start at
    // a stream boundary or a byte that cannot be part of a preceding character.
    const controlLimit = encoding === 'gb18030' ? 0x30 : 0x40;
    let checked = 0;
    for (let frame = first; frame > 0 && checked < 65536; frame--) {
        if (frames.streamEndedAt?.(frame - 1)) return { first: frame, skip: 0 };
        const record = frames.rawBytesAt(frame - 1);
        for (let index = record.length - 1; index >= 0 && checked < 65536; index--, checked++) {
            if (record[index] < controlLimit || record[index] === 0x7f) return { first: frame - 1, skip: index };
        }
        if (frame === 1) return { first: 0, skip: 0 };
    }
    return first ? null : { first: 0, skip: 0 };
}

function monitorSearchBatch(frames, start, length, options, channels, batchFrames) {
    const { schema } = options, records = [];
    const numeric = channels !== null;
    const prefix = numeric || schema ? { first: start, skip: 0 } : monitorSearchPrefix(frames, start, options);
    if (!prefix) return null;
    const { first, skip } = prefix;
    let end = start, bytes = 0;
    const frameLimit = numeric ? Math.max(1, Math.floor(32768 / channels.length)) : schema ? 128 : batchFrames;
    const maxEnd = Math.min(length, start + Math.min(batchFrames, frameLimit));
    for (let index = first; index < maxEnd; index++) {
        if (!numeric) {
            const raw = frames.rawBytesAt(index);
            const offset = index === first ? skip : 0;
            if (index > start && bytes + raw.length > 524288) break;
            records.push({ bytes: raw.subarray(offset), byteOffset: (frames.rawByteOffsetAt?.(index) ?? 0) + offset,
                streamStart: frames.streamStartByteAt?.(index) ?? 0, ended: frames.streamEndedAt?.(index) });
            bytes += raw.length - offset;
        }
        if (index >= start) end = index + 1;
    }
    const orders = Float64Array.from({ length: end - first }, (_, index) => frames.orderAt(first + index));
    const values = numeric ? new Float64Array(orders.length * channels.length) : null;
    if (values) for (let index = 0, slot = 0; index < orders.length; index++)
        for (const channel of channels) values[slot++] = frames.getValue(channel, first + index);
    const { valueTransform, decodeRecord, schema: _, maxFields, channelSettings, ...search } = options;
    if (numeric) search.channelSettings = channels.map(channel => channelSettings?.[channel]);
    return { end, task: { kind: 'monitor-search', start: first, firstOwned: start - first, firstSkip: skip,
        orders, values, channels, records, search, schema, maxFields } };
}

async function searchHistoryInWorkers(pool, frames, options, {
    batchFrames = 4096, isCurrent = () => true, onProgress = () => {}, signal
} = {}) {
    const channels = options.kind === 'number' && !options.schema ? new MonitorSearchSession(frames, options).numericChannels : null;
    const length = frames.length, jobs = new Map(), matches = [];
    const concurrency = pool.workerLimit ?? pool.maxWorkers;
    let position = 0, processed = 0, resultOrder = 0, nextJob = 0, workStarted = performance.now();
    const completed = new Map();
    while (position < length || jobs.size) {
        if (signal?.aborted || !isCurrent()) return null;
        while (position < length && jobs.size + completed.size < concurrency) {
            const batch = monitorSearchBatch(frames, position, length, options, channels, batchFrames);
            if (!batch) return null;
            const id = nextJob++, count = batch.end - position;
            const promise = pool.runTask(batch.task, { signal }).then(result => ({ id, count, result }), error => ({ id, error }));
            jobs.set(id, promise);
            position = batch.end;
            if (performance.now() - workStarted >= 8) {
                await new Promise(resolve => setTimeout(resolve, 0));
                workStarted = performance.now();
                if (signal?.aborted || !isCurrent()) return null;
            }
        }
        const { id, result, count, error } = await Promise.race(jobs.values());
        if (signal?.aborted || !isCurrent()) return null;
        if (error) throw error;
        jobs.delete(id);
        completed.set(id, result);
        while (completed.has(resultOrder)) {
            for (const match of completed.get(resultOrder)) matches.push(match);
            completed.delete(resultOrder++);
        }
        processed += count;
        onProgress(processed, length);
    }
    return matches;
}

function scanTimestampRange(timestampAt, target, start, end, scan) {
    for (let index = start; index < end; index++) {
        const timestamp = timestampAt(index);
        if (!Number.isFinite(timestamp)) continue;
        scan.minimum = Math.min(scan.minimum, timestamp);
        scan.maximum = Math.max(scan.maximum, timestamp);
        const distance = Math.abs(target - timestamp);
        if (distance < scan.distance) { scan.distance = distance; scan.nearest = index; }
    }
    return scan;
}

const monitorSearchApi = { parseMonitorSearch, MonitorSearchSession, parseProtocolFieldSearch, ProtocolFieldSearchSession,
    createMonitorSearchProcessor, searchHistoryInWorkers, scanTimestampRange };
if (typeof module !== 'undefined') module.exports = monitorSearchApi;
globalThis.SerialPlotter ??= {};
globalThis.SerialPlotter.MonitorSearch = monitorSearchApi;
Object.assign(globalThis.SerialPlotter, { parseProtocolFieldSearch, ProtocolFieldSearchSession });
