/** Acquisition owns the archive and shared interpretations independently of views. */
const captureServiceDependencies = typeof module !== 'undefined'
    ? { ...require('./captureHistory'), ...require('./rawFrameParser'), ...require('./dataParser'),
        ...require('./frameBuffer'), ...require('./historyWorkers'), ...require('./textHistory'),
        ...require('./computedFrames'), ...require('./channelOperations'), ...require('./sampleRate'),
        ...require('./captureMemory'), TextCodec: require('./textCodec') } : globalThis.SerialPlotter;

class CaptureService {
    constructor(options = {}) {
        const { CaptureHistory, HistoryWorkerPool } = captureServiceDependencies;
        this.capacity = options.capacity ?? 1000;
        this.maxRawFrameBytes = options.maxRawFrameBytes ?? 1048576;
        this._validateLimit(this.maxRawFrameBytes);
        this.rebuildHistory = options.rebuildHistory !== false;
        this.now = options.now ?? (() => performance.now());
        this.wallNow = options.wallNow ?? (() => Date.now());
        this.parserOptions = { now: this.now, wallNow: this.wallNow };
        if (options.setTimeout) this.parserOptions.setTimeout = options.setTimeout;
        if (options.clearTimeout) this.parserOptions.clearTimeout = options.clearTimeout;
        this.yieldControl = options.yieldControl;
        this.channelDefinitions = options.channelDefinitions ?? [];
        this.channelNames = options.channelNames ?? options.numericFormat?.channelNames ?? [];
        this.onChange = options.onChange ?? (() => {});
        this.onProgress = options.onProgress ?? (() => {});
        this.onError = options.onError ?? (() => {});
        this.onMemoryPressure = options.onMemoryPressure ?? (() => {});
        this.history = new CaptureHistory();
        this.workerPool = options.workerPool ?? new HistoryWorkerPool(options.workerOptions);
        this.sources = new Set();
        this.sourceKeys = new Map();
        this.textStats = new Map();
        this.txFrames = new captureServiceDependencies.FrameBuffer(1, this.capacity);
        this.txFrames.setRawMode(true);
        this.stats = { rxBytes: 0, txBytes: 0 };
        this.epoch = 0;
        this.nextSource = 1;
        this.nextOrder = 1;
        this.paused = false;
        this.disposed = false;
        this.receiving = false;
        const numeric = { captureMode: 'number', channelsCount: 1, enableHeader: true,
            headerHex: 'AB', dataType: 'float32', ...options.numericFormat };
        numeric.isLittleEndian ??= numeric.endianness !== 'big';
        this.catalogCount = Math.max(Number(numeric.channelsCount), Number(options.catalogCount ?? numeric.catalogCount ?? numeric.channelsCount));
        numeric.catalogCount = this.catalogCount;
        this.numericSource = this._createSource(numeric, true, 'numeric', 0);
        const baseFormat = this._rawFormat({ captureMode: 'hex' });
        const baseKey = this._sourceKey(baseFormat, true);
        this.baseSource = this._createSource(baseFormat, true, baseKey, 0);
        this.memory = new captureServiceDependencies.CaptureMemoryBudget(this, options.memoryLimitBytes);
    }

    _validateLimit(bytes) {
        if (!Number.isSafeInteger(bytes) || bytes < 1)
            throw new RangeError('Raw frame byte limit must be a positive integer');
    }

    _rawFormat(format) {
        const boundary = format.captureMode === 'hex' ? 'idle' : format.textBoundary ?? format.boundary ?? 'idle';
        const encoding = format.textEncoding ?? format.encoding ?? 'utf-8';
        return { captureMode: boundary === 'idle' ? 'hex' : 'text', textBoundary: boundary,
            idleGapSeconds: Number(format.idleGapSeconds ?? 0.001),
            textEncoding: boundary === 'idle' || !encoding.startsWith('utf-16') ? 'utf-8' : encoding,
            maxRawFrameBytes: this.maxRawFrameBytes };
    }

    _sourceKey(format, rebuild) {
        const boundary = format.textBoundary;
        return `${this.epoch}:${rebuild ? 'history' : this.history.endByte}:` +
            `${boundary}:${boundary === 'idle' ? format.idleGapSeconds : format.textEncoding}:${this.maxRawFrameBytes}`;
    }

    _newParser(format, startByte) {
        const { DataParser, RawFrameParser } = captureServiceDependencies;
        const numeric = format.captureMode === 'number';
        const parser = numeric ? new DataParser() : new RawFrameParser(this.parserOptions);
        parser.nextByte = startByte;
        parser.setFormat(numeric ? format : { boundary: format.textBoundary,
            idleGapSeconds: format.idleGapSeconds, encoding: format.textEncoding,
            maxFrameBytes: this.maxRawFrameBytes });
        return parser;
    }

    _createSource(format, persistent, key, startByte) {
        const parser = this._newParser(format, startByte);
        const numeric = format.captureMode === 'number';
        let frames = new captureServiceDependencies.FrameBuffer(numeric ? Number(format.catalogCount ?? format.channelsCount) : 1, this.capacity);
        if (numeric) frames = new captureServiceDependencies.ComputedFrames(frames, this.channelDefinitions,
            { yieldControl: this.yieldControl, names: this.channelNames });
        if (!numeric) frames.setRawMode(true);
        const source = { id: `source-${this.nextSource++}`, kind: numeric ? 'numeric' : 'raw',
            frames, parser, format: { ...format }, refs: 0, persistent, key, startByte,
            generation: 0, rebuilding: false, progress: null, errors: [], errorBytes: 0, ready: null, pin: null };
        if (numeric) source.sampleRate = new captureServiceDependencies.SampleRateEstimator();
        source.ready = Promise.resolve(source);
        if (numeric) {
            frames.onChange = () => this._safeNotify(this.onChange, source);
            frames.onProgress = () => { this.memory?.enforce(); this._safeNotify(this.onProgress, source); };
        }
        this.sources.add(source);
        this.sourceKeys.set(key, source);
        this._attach(source);
        return source;
    }

    _safeNotify(callback, ...args) {
        try { callback(...args); } catch { /* View callbacks cannot break acquisition. */ }
    }

    _error(source, error) {
        error.reason ??= error.type ?? error.message ?? 'error';
        error.kind ??= 'error';
        error.timestamp ??= this.wallNow();
        error.order ??= this.nextOrder++;
        source.errors.push(error);
        source.errorBytes += error.bytes?.length ?? 0;
        while (source.errors.length > this.capacity) source.errorBytes -= source.errors.shift().bytes?.length ?? 0;
        this._safeNotify(this.onError, error, source);
    }

    _attach(source) {
        const parser = source.parser;
        parser.onFrameError = (type, time, bytes, metadata) =>
            this._error(source, { type, time, bytes, ...metadata, kind: 'error' });
        parser.onCallbackError = error => this._error(source, error);
        const changed = () => {
            this._safeNotify(this.onChange, source);
            if (!this.receiving) { this._prune(); this.memory?.check(); }
        };
        if (source.kind === 'numeric') parser.onFrameParsed = (values, time, bytes, timestamp, metadata) => {
            const count = source.frames.rawChannelCount;
            if (values.length !== count) {
                const padded = new Array(count).fill(NaN);
                for (let channel = 0; channel < Math.min(count, values.length); channel++) padded[channel] = values[channel];
                values = padded;
            }
            source.frames.append(values, bytes, time, metadata.order, timestamp, metadata);
            changed();
        };
        else parser.onFrameParsed = (bytes, time, timestamp, metadata) => {
            source.frames.appendRaw(bytes, time, metadata.order, timestamp, metadata);
            changed();
        };
    }

    receive(bytes, metadata = {}) {
        if (this.disposed) return;
        if (!(bytes instanceof Uint8Array)) bytes = new Uint8Array(bytes);
        this.stats.rxBytes += bytes.length;
        if (this.paused || !bytes.length) return;
        // Bound transient parser/archive allocations even if the transport delivers a huge block.
        const timestamp = metadata.timestamp ?? this.wallNow(), arrival = metadata.arrival ?? this.now();
        for (let offset = 0; offset < bytes.length;) {
            let length = Math.min(bytes.length - offset, 65536);
            let fits = this.memory.beforeReceive(length);
            while (!fits && length > 1) {
                length = Math.max(1, Math.floor(length / 2));
                fits = this.memory.beforeReceive(length);
            }
            if (!fits) {
                this.memory.blockedReason = '预算无法容纳下一数据块，已安全暂停，请提高预算或减少数据源';
                this.pause(true);
                this._safeNotify(this.onMemoryPressure, { ...this.memoryUsage(), blocked: true });
                break;
            }
            this._receivePart(bytes.subarray(offset, offset + length), { timestamp, arrival });
            offset += length;
        }
    }

    _receivePart(bytes, metadata) {
        const stamp = this.history.append(bytes, { timestamp: metadata.timestamp ?? this.wallNow(),
            arrival: metadata.arrival ?? this.now(), order: this.nextOrder++ });
        this.receiving = true;
        try {
            for (const source of this.sources) {
                if (source.rebuilding || this.dataEngine && !this.dataEngine.shouldFeed(source)) continue;
                try {
                    source.parser.appendData(bytes, stamp);
                    source.sampleRate?.observe(source.parser.frameCount, stamp.arrival);
                }
                catch (error) { this._error(source, error); }
            }
            this.dataEngine?.receive(bytes, stamp);
            for (const entry of this.textStats.values()) {
                if (!entry.rebuilding && entry.counter) {
                    entry.counter.write(bytes);
                    entry.endByte = stamp.endByte;
                    this._publishStats(entry);
                }
            }
        } finally { this.receiving = false; }
        this._prune();
    }

    acquireSource(format = {}, { rebuild = this.rebuildHistory } = {}) {
        if (this.disposed) throw new Error('Capture service disposed');
        if (['number', 'engine'].includes(format.captureMode ?? 'number')) {
            const source = this.dataEngine?.output(format.engineSource, format.enginePresentation === true || format.captureMode === 'engine') ?? this.numericSource;
            source.refs++;
            return source;
        }
        const normalized = this._rawFormat(format), key = this._sourceKey(normalized, rebuild);
        let source = this.sourceKeys.get(key);
        if (!source) {
            const start = rebuild ? this.history.startByte : this.history.endByte;
            source = this._createSource(normalized, false, key, start);
            if (rebuild && this.history.endByte > start) this._rebuild(source, start);
        }
        source.refs++;
        return source;
    }

    releaseSource(source) {
        if (!this.sources.has(source)) return;
        source.refs = Math.max(0, source.refs - 1);
        if (!source.refs) this._dropTextStats(source);
        if (!source.refs && !source.persistent) {
            source.generation++;
            source.parser.reset();
            source.pin = null;
            source.frames.dispose?.(); source.frames.clear(); source.errors.length = 0; source.errorBytes = 0;
            source.replayStorage = null;
            this.sources.delete(source);
            if (this.sourceKeys.get(source.key) === source) this.sourceKeys.delete(source.key);
            this._prune();
        }
    }

    updateNumericFormat(format, { rebuild = this.rebuildHistory } = {}) {
        const source = this.dataEngine?.arraySource ?? this.numericSource;
        const next = { ...source.format, ...format, captureMode: 'number' };
        this.catalogCount = Math.max(this.catalogCount, Number(this.dataEngine?.globals.channelsCount ?? 0), Number(next.channelsCount));
        next.catalogCount = this.catalogCount;
        if (!Object.hasOwn(format, 'isLittleEndian') && Object.hasOwn(format, 'endianness'))
            next.isLittleEndian = format.endianness !== 'big';
        this._newParser(next, this.history.endByte); // Validate before changing a live source.
        new captureServiceDependencies.ChannelOperations(next.catalogCount, this.channelDefinitions, { names: this.channelNames });
        source.format = next;
        return this._restart(source, rebuild);
    }

    updateChannelDefinitions(definitions, { rebuild = this.rebuildHistory, reapply = [], numberMap = null } = {}) {
        if (this.dataEngine)
            return this.dataEngine.updateChannelDefinitions(definitions, { rebuild, reapply, numberMap });
        const engine = new captureServiceDependencies.ChannelOperations(this.numericSource.frames.rawChannelCount, definitions,
            { names: this.channelNames, symbolVersion: 2 });
        const reserve = engine.requiredMemoryBytes * (rebuild && this.numericSource.frames.length ? 2 : 1);
        if (reserve > this.memory.limitBytes)
            throw new RangeError('运算通道的历史状态超过内存预算，请缩短历史索引、提高预算或关闭历史重建');
        this.memory.enforce(reserve);
        const result = this.numericSource.frames.updateDefinitions(definitions, { rebuild, reapply, numberMap });
        this.channelDefinitions = this.numericSource.frames.definitions.map(value => ({ ...value }));
        return result;
    }

    _restart(source, rebuild) {
        this._dropTextStats(source);
        source.sampleRate?.reset();
        source.generation++;
        source.parser.reset();
        source.errors.length = 0;
        source.errorBytes = 0;
        source.replayStorage = null;
        const start = rebuild ? this.history.startByte : this.history.endByte;
        source.startByte = start;
        if (rebuild && this.history.endByte > start) return this._rebuild(source, start);
        if (source.kind === 'numeric') source.frames.resetFormat(Number(source.format.catalogCount ?? source.format.channelsCount), this.channelDefinitions);
        else source.frames.clear();
        source.parser = this._newParser(source.format, start);
        source.rebuilding = false; source.pin = null; source.progress = null;
        this._attach(source);
        source.ready = Promise.resolve(source);
        this._safeNotify(this.onChange, source);
        return source.ready;
    }

    _workerReplayOptions(source, length) {
        const pool = this.workerPool;
        if (length < 524288 || !pool.available) return {};
        const options = { maxPendingDecodes: Math.max(1, pool.workerLimit ?? pool.maxWorkers) };
        if (source.kind === 'numeric') options.decodeBatch = records => {
            const format = source.format, frameLength = records[0].bytes.length;
            const bytes = new Uint8Array(records.length * frameLength);
            records.forEach((record, i) => bytes.set(record.bytes, i * frameLength));
            const headerLength = format.enableHeader !== false
                ? captureServiceDependencies.DataParser.hexToBytes(format.headerHex).length : 0;
            return pool.runTask({ kind: 'numeric', bytes, frameLength, headerLength,
                channels: Number(format.channelsCount), type: format.dataType,
                littleEndian: format.isLittleEndian !== false });
        };
        else if (source.format.captureMode === 'hex') options.assembleRawBatch = records =>
            pool.runTask({ kind: 'hex-assemble', bytes: new Uint8Array(0), parts: records.flatMap(record => record.parts) });
        return options;
    }

    _rebuild(source, startByte) {
        const generation = ++source.generation, epoch = this.epoch, snapshotEnd = this.history.endByte;
        source.rebuilding = true;
        source.pin = startByte;
        source.progress = { processedBytes: 0, totalBytes: snapshotEnd - startByte };
        const cancelled = () => this.disposed || epoch !== this.epoch || generation !== source.generation || !this.sources.has(source);
        const options = { startByte, stopByte: snapshotEnd, flushPending: false, isCancelled: cancelled,
            onStorage: storage => {
                if (!cancelled()) { source.replayStorage = storage; source.replayGeneration = generation; }
            },
            onProgress: progress => {
                if (!cancelled()) {
                    this.memory.enforce();
                    source.progress = progress; this._safeNotify(this.onProgress, source);
                }
            }, ...this._workerReplayOptions(source, snapshotEnd - startByte) };
        if (this.yieldControl) options.yieldControl = this.yieldControl;
        source.ready = (async () => {
            let result;
            try {
                result = await captureServiceDependencies.replayCaptureHistory(this.history, source.format, this.capacity, options);
                while (!cancelled() && !result.cancelled &&
                    (result.endByte < this.history.endByte || result.revision !== this.history.revision)) {
                    result = await captureServiceDependencies.replayCaptureHistory(this.history, source.format, this.capacity,
                        { ...options, stopByte: this.history.endByte, previousResult: result,
                            preserveCallbacks: true, decodeBatch: null, assembleRawBatch: null });
                }
                if (cancelled() || result.cancelled) { result.parser.reset(); return source; }
                result.frames.resize(this.capacity);
                if (source.kind === 'numeric') source.frames.definitions = this.channelDefinitions;
                const computedReady = source.frames.replaceFrom(result.frames);
                source.parser = result.parser;
                if (source.kind === 'raw') {
                    // Replay uses inert timers; adopt the caller's clock/scheduler before live handoff.
                    Object.assign(source.parser, { now: this.now, wallNow: this.wallNow });
                    if (this.parserOptions.setTimeout) source.parser.schedule = this.parserOptions.setTimeout;
                    if (this.parserOptions.clearTimeout) source.parser.cancel = this.parserOptions.clearTimeout;
                }
                source.errors = result.errors.slice(-this.capacity).map(error =>
                    ({ ...error, reason: error.reason ?? error.type ?? 'error' }));
                source.errorBytes = source.errors.reduce((sum, error) => sum + (error.bytes?.length ?? 0), 0);
                source.pin = null; source.rebuilding = false;
                this._attach(source);
                if (source.kind === 'raw' && !this.paused) source.parser.resumeTimers();
                if (computedReady) await computedReady;
                if (cancelled()) return source;
                this._safeNotify(this.onChange, source);
                this._prune();
            } catch (error) {
                result?.parser.reset();
                if (!cancelled()) {
                    this._error(source, error);
                    source.rebuilding = false; source.pin = null;
                    source.frames.clear();
                    if (source.kind === 'numeric') source.frames.setChannelCount(Number(source.format.catalogCount ?? source.format.channelsCount));
                    source.parser = this._newParser(source.format, this.history.endByte);
                    this._attach(source);
                }
            }
            finally { if (source.replayGeneration === generation) source.replayStorage = null; }
            return source;
        })();
        return source.ready;
    }

    setCapacity(capacity) {
        // FrameBuffer validates before any window is resized.
        new captureServiceDependencies.FrameBuffer(1, capacity);
        let reserve = 0;
        for (const frames of [...this.sources].map(source => source.frames).concat(this.txFrames))
            if (capacity > frames.storageCapacity || capacity < frames.storageCapacity / 4)
                reserve += frames.estimatedMemoryBytes * Math.min(1, capacity / Math.max(1, frames.length));
        this.memory.enforce(reserve);
        this.capacity = capacity;
        for (const source of this.sources) {
            source.frames.resize(capacity);
            if (source.errors.length > capacity) {
                for (const error of source.errors.splice(0, source.errors.length - capacity)) source.errorBytes -= error.bytes?.length ?? 0;
            }
        }
        this.txFrames.resize(capacity);
        this._prune();
        this.memory.enforce();
        this._safeNotify(this.onChange, null);
    }

    memoryUsage() { return this.memory.measure(); }
    setMemoryLimit(bytes) { this.memory.setLimit(bytes); }

    setMaxRawFrameBytes(bytes) {
        this._validateLimit(bytes);
        if (bytes === this.maxRawFrameBytes) return Promise.resolve();
        this.maxRawFrameBytes = bytes;
        const pending = [];
        this.sourceKeys.clear();
        for (const source of this.sources) {
            if (source.kind === 'raw') {
                source.format = { ...source.format, maxRawFrameBytes: bytes };
                source.key = this._sourceKey(source.format, this.rebuildHistory);
                pending.push(this._restart(source, this.rebuildHistory));
            }
            this.sourceKeys.set(source.key, source);
        }
        return Promise.all(pending);
    }

    pause(paused = true) {
        if (this.paused === Boolean(paused)) return;
        if (!paused) this.memory.blockedReason = '';
        this.endStream();
        this.paused = Boolean(paused);
    }

    endStream() {
        if (this.disposed) return;
        const boundary = { timestamp: this.wallNow(), arrival: this.now() };
        this.history.markBoundary(boundary);
        this.dataEngine?.endStream(boundary);
        this.receiving = true;
        try {
            for (const source of this.sources) {
                if (source.rebuilding || source.engineManaged) continue;
                try {
                    source.parser.flushPending();
                    source.sampleRate?.reset({ keepRate: true });
                    if (source.kind === 'raw' && source.frames.length) source.frames.markStreamEnded(source.frames.length - 1);
                } catch (error) { this._error(source, error); }
            }
            for (const entry of this.textStats.values()) if (!entry.rebuilding && entry.counter) {
                entry.counter.flush();
                entry.counter.decoder = new captureServiceDependencies.TextCodec.TextCharacterCounter(entry.encoding).decoder;
                this._publishStats(entry);
            }
        } finally { this.receiving = false; }
        this._prune();
        this._safeNotify(this.onChange, null);
    }

    appendTx(bytes, timestamp = this.wallNow()) {
        if (!(bytes instanceof Uint8Array)) bytes = new Uint8Array(bytes);
        const frame = { bytes, timestamp, time: captureServiceDependencies.RawFrameParser.formatTime(timestamp),
            order: this.nextOrder++, kind: 'tx' };
        this.stats.txBytes += bytes.length;
        const reserve = this.txFrames.estimateAppendMemory(1, bytes.length);
        if (reserve > this.memory.limitBytes || !this.memory.enforce(reserve)) {
            this.memory.blockedReason = 'TX 已发送，但本条记录无法放入内存预算，未缓存本条记录；已安全暂停';
            this.pause(true);
            this._safeNotify(this.onMemoryPressure, { ...this.memoryUsage(), blocked: true });
            return { ...frame, stored: false };
        }
        this.txFrames.appendRaw(bytes, frame.time, frame.order, timestamp, { kind: 'tx' });
        this._safeNotify(this.onChange, null);
        this.memory.enforce();
        return frame;
    }

    _publishStats(entry) {
        entry.total = entry.counter.total;
        entry.failed = entry.counter.failed;
    }

    _dropTextStats(source) {
        for (const [key, entry] of this.textStats) {
            entry.sources.delete(source);
            if (!entry.sources.size) this.textStats.delete(key);
        }
    }

    getTextStats(source, encoding = 'utf-8') {
        const { TextCharacterCounter, normalizeTextEncoding } = captureServiceDependencies.TextCodec;
        encoding = normalizeTextEncoding(encoding);
        const start = Math.max(source.startByte, this.history.startByte);
        const key = `${this.epoch}:${source.startByte}:${encoding}`;
        if (this.textStats.has(key)) {
            const entry = this.textStats.get(key);
            entry.sources.add(source);
            return entry;
        }
        const epoch = this.epoch, end = this.history.endByte;
        const entry = { total: 0, failed: 0, rebuilding: true, encoding, endByte: end, pin: start,
            counter: null, ready: null, sources: new Set([source]) };
        this.textStats.set(key, entry);
        const cancelled = () => this.disposed || epoch !== this.epoch || this.textStats.get(key) !== entry;
        entry.ready = (async () => {
            try {
                const pool = end - start >= 524288 ? this.workerPool : null;
                const counter = await captureServiceDependencies.countCaptureText(this.history, encoding, pool,
                    { startByte: start, endByte: end, flushPending: false, isCancelled: cancelled });
                if (!counter || cancelled()) return entry;
                for (const span of this.history.readRange(end, this.history.endByte)) {
                    counter.write(span.bytes);
                    if (span.streamEnded) { counter.flush(); counter.decoder = new TextCharacterCounter(encoding).decoder; }
                }
                entry.counter = counter; entry.endByte = this.history.endByte;
                entry.pin = null; entry.rebuilding = false;
                this._publishStats(entry);
                this._prune();
                this._safeNotify(this.onChange, source);
            } catch (error) {
                if (!cancelled()) { entry.pin = null; entry.rebuilding = false; this._error(source, error); }
            }
            return entry;
        })();
        return entry;
    }

    _prune() {
        let earliest = this.history.endByte;
        for (const source of this.sources) {
            if (source.pin !== null) earliest = Math.min(earliest, source.pin);
            if (source.frames.length) earliest = Math.min(earliest, source.frames.rawByteOffsetAt(0));
            const parser = source.parser;
            if (source.kind === 'raw' && parser.length) earliest = Math.min(earliest, parser.frameMetadata.byteOffset);
            if (source.kind === 'numeric' && parser.writeOffset > parser.readOffset)
                earliest = Math.min(earliest, parser.bufferBaseByte + parser.readOffset);
            if (source.kind === 'protocol' && parser.length)
                earliest = Math.min(earliest, parser.nextByte - parser.length);
        }
        for (const entry of this.textStats.values()) if (entry.pin !== null) earliest = Math.min(earliest, entry.pin);
        this.history.pruneBefore(earliest);
    }

    clear() {
        this.epoch++;
        this.history.clear();
        this.textStats.clear();
        this.txFrames.clear();
        this.stats.rxBytes = 0; this.stats.txBytes = 0;
        this.sourceKeys.clear();
        this.workerPool.clearFftCache?.();
        this.memory.reset();
        this.dataEngine?.clear();
        for (const source of this.sources) {
            if (source.engineManaged) continue;
            source.key = source.kind === 'numeric' ? 'numeric' : this._sourceKey(source.format, true);
            this.sourceKeys.set(source.key, source);
            this._restart(source, false);
        }
        this._safeNotify(this.onChange, null);
    }

    dispose() {
        if (this.disposed) return;
        this.disposed = true; this.epoch++;
        this.dataEngine?.dispose();
        for (const source of this.sources) {
            source.generation++; source.parser.reset(); source.frames.dispose?.(); source.frames.clear();
            source.replayStorage = null; source.errors.length = 0; source.errorBytes = 0;
        }
        this.history.clear(); this.txFrames.clear();
        this.sources.clear(); this.sourceKeys.clear(); this.textStats.clear();
        this.workerPool.dispose();
    }
}

if (typeof module !== 'undefined') module.exports = { CaptureService };
globalThis.SerialPlotter ??= {};
globalThis.SerialPlotter.CaptureService = CaptureService;
