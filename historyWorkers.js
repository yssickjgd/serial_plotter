/** Lazy historical decode workers with two logical cores reserved for the UI.
 * protocol-decode tasks take {schema,records:[{bytes}|Uint8Array],maxDecodedFields?}
 * and return decoded records in input order, retaining exact64 BigInts and spans.
 * Batches are bounded to 256 frames, 4 MiB input and 65536 output fields (a lower
 * maxDecodedFields is allowed). protocol-batch-limit errors permit split retries;
 * protocol-record-limit identifies one frame exceeding the caller's field budget.
 */
function validateProtocolHistoryTask(task) {
    if (!task.schema || typeof task.schema !== 'object' || Array.isArray(task.schema))
        throw new TypeError('Protocol history task requires a schema');
    if (!Array.isArray(task.records) || task.records.length > 256)
        throw new RangeError('Protocol decode batch must contain at most 256 records');
    if (task.maxDecodedFields !== undefined && (!Number.isInteger(task.maxDecodedFields) ||
        task.maxDecodedFields < 1 || task.maxDecodedFields > 65536))
        throw new RangeError('Protocol decoded field budget must be between 1 and 65536');
    let byteLength = 0;
    for (const record of task.records) {
        const bytes = record instanceof Uint8Array ? record : record?.bytes;
        if (!(bytes instanceof Uint8Array)) throw new TypeError('Protocol history record bytes must be a Uint8Array');
        byteLength += bytes.length;
        if (byteLength > 4194304) throw new RangeError('Protocol decode batch exceeds the 4 MiB byte limit');
    }
}
function createHistoryTaskProcessor(task, dependencies) {
    if (task?.kind === 'protocol-stream-check') {
        if (!task.schema || typeof task.schema !== 'object' || Array.isArray(task.schema) ||
            !(task.bytes instanceof Uint8Array) || task.bytes.length > 1048576)
            throw new TypeError('Protocol stream checks require a schema and at most 1 MiB of bytes');
        const chunkSize = task.chunkSize ?? 2048;
        if (!Number.isSafeInteger(chunkSize) || chunkSize < 1 || chunkSize > 16384)
            throw new RangeError('Protocol stream chunk size must be between 1 and 16384');
        const parser = new dependencies.Protocol.StreamParser(task.schema);
        let offset = 0, frames = 0, errors = 0, invalidFrames = 0;
        parser.onFrameParsed = record => { frames++; if (record.valid === false) { errors++; invalidFrames++; } };
        parser.onFrameError = () => { errors++; };
        return {
            step(byteBudget) {
                let remaining = byteBudget === Infinity ? Infinity : Math.max(1, Math.floor(byteBudget) || 1);
                while (offset < task.bytes.length && remaining > 0) {
                    const end = Math.min(task.bytes.length, offset + Math.min(chunkSize, remaining));
                    parser.appendData(task.bytes.subarray(offset, end), { byteOffset: offset, timestamp: 0 });
                    remaining -= end - offset; offset = end;
                }
                return offset === task.bytes.length;
            },
            result() { return { frames, errors, invalidFrames, pending: parser.length }; }
        };
    }
    if (task?.kind === 'protocol-decode') {
        validateProtocolHistoryTask(task);
        const compiled = dependencies.Protocol.compile(task.schema), records = [];
        let index = 0, decodedFields = 0;
        const fieldBudget = task.maxDecodedFields ?? 65536;
        const limitError = (code, message) => { const error = new RangeError(message); error.code = code; return error; };
        return {
            step(byteBudget) {
                let remaining = byteBudget === Infinity ? Infinity : Math.max(1, Math.floor(byteBudget) || 1);
                while (index < task.records.length) {
                    const source = task.records[index], bytes = source instanceof Uint8Array ? source : source.bytes;
                    let record;
                    try { record = dependencies.Protocol.decode(bytes, compiled, { maxFields: Math.min(fieldBudget, 32768) }); }
                    catch (error) {
                        if (error.code === 'field-limit') throw limitError('protocol-record-limit', 'Protocol record exceeds its decoded field budget');
                        throw error;
                    }
                    decodedFields += record.flatFields.length;
                    if (decodedFields > fieldBudget) throw limitError('protocol-batch-limit', 'Protocol batch exceeds its decoded field budget; split this batch');
                    records.push(record); index++; remaining -= Math.max(1, bytes.length);
                    if (remaining <= 0) break;
                }
                return index === task.records.length;
            },
            result() { return records; }
        };
    }
    if (task?.kind === 'fft') {
        if (!(task.values instanceof Float64Array))
            throw new TypeError('FFT values must be a Float64Array');
        let result;
        return {
            step() {
                const spectrum = dependencies.prepareFrequencySeries(task.values,
                    task.removeDc === true, task.windowType);
                result = { ...spectrum, mags: Float64Array.from(spectrum.mags),
                    phases: Float64Array.from(spectrum.phases ?? []),
                    logMags: Float64Array.from(spectrum.mags,
                        value => value > 0 && Number.isFinite(value) ? Math.log10(value) : NaN),
                    unwrappedPhases: Float64Array.from(dependencies.unwrapPhaseDegrees(spectrum.phases ?? [])) };
                return true;
            },
            result() { return result; }
        };
    }
    if (!(task?.bytes instanceof Uint8Array)) throw new TypeError('History task bytes must be a Uint8Array');
    if (task.kind === 'hex-assemble') {
        if (!Array.isArray(task.parts) || task.parts.some(part => !(part instanceof Uint8Array)))
            throw new TypeError('Historical Hex parts must be Uint8Arrays');
        const length = task.parts.reduce((total, part) => total + part.length, 0);
        if (!Number.isSafeInteger(length)) throw new RangeError('Historical Hex batch is too large');
        const bytes = new Uint8Array(length);
        let partIndex = 0, partOffset = 0, offset = 0;
        return {
            step(byteBudget) {
                let remaining = Math.max(1, byteBudget);
                while (partIndex < task.parts.length) {
                    const part = task.parts[partIndex];
                    const end = Math.min(part.length, partOffset + remaining);
                    bytes.set(part.subarray(partOffset, end), offset);
                    const count = end - partOffset;
                    offset += count; remaining -= count; partOffset = end;
                    if (partOffset === part.length) { partIndex++; partOffset = 0; }
                    if (remaining <= 0) break;
                }
                return partIndex === task.parts.length;
            },
            result() { return bytes; }
        };
    }
    if (task.kind === 'numeric') {
        const { frameLength, headerLength, channels, type } = task;
        const width = Object.hasOwn(dependencies.TYPE_LENGTH, type) ? dependencies.TYPE_LENGTH[type] : 0;
        if (!width || !Number.isSafeInteger(frameLength) || frameLength < 1 ||
            !Number.isSafeInteger(headerLength) || headerLength < 0 ||
            !Number.isSafeInteger(channels) || channels < 1 ||
            headerLength + channels * width > frameLength || task.bytes.length % frameLength !== 0)
            throw new RangeError('Invalid historical numeric frame layout');
        const frameCount = task.bytes.length / frameLength;
        const values = new Float64Array(frameCount * channels);
        let frame = 0;
        return {
            step(byteBudget) {
                const end = Math.min(frameCount, frame + Math.max(1, Math.floor(byteBudget / frameLength)));
                for (; frame < end; frame++) {
                    const view = new DataView(task.bytes.buffer,
                        task.bytes.byteOffset + frame * frameLength + headerLength, channels * width);
                    dependencies.decodeNumericPayload(view, type, task.littleEndian, channels, values, frame * channels);
                }
                return frame === frameCount;
            },
            result() { return values; }
        };
    }
    if (task.kind === 'text-prepare') {
        const before = task.before ?? [], following = task.streamEnded ? [] : task.following ?? [];
        if (!Number.isSafeInteger(task.frame) || task.frame < 0 ||
            !Number.isSafeInteger(task.columns) || task.columns < 1 ||
            !Array.isArray(before) || !Array.isArray(following) ||
            [...before, ...following].some(part => !(part?.bytes instanceof Uint8Array) ||
                !Number.isSafeInteger(part.frame) || part.frame < 0 ||
                !Number.isSafeInteger(part.start) || part.start < 0))
            throw new RangeError('Invalid historical text preparation context');
        const decoder = new dependencies.MappedTextDecoder(task.encoding, { byteOffset: task.byteOffset ?? 0 });
        const data = { chunks: [], length: 0, width: 0, initialLines: [0], layouts: new Map(),
            columns: task.columns, byteLength: task.bytes.length, byteOffset: task.rawByteOffset,
            nextOrders: [...(task.nextOrders ?? [])], streamEnded: task.streamEnded === true,
            displayOptions: task.displayOptions };
        const parts = [...before, { frame: task.frame, bytes: task.bytes, start: 0 }, ...following];
        const current = before.length;
        const consume = tokens => dependencies.appendCompactTokens(data,
            tokens.filter(token => token.startFrame === task.frame));
        let partIndex = 0, offset = 0, complete = false;
        return {
            step(byteBudget) {
                if (complete) return true;
                let remaining = byteBudget === Infinity ? Infinity : Math.max(1, Math.floor(byteBudget) || 1);
                while (partIndex < parts.length) {
                    const part = parts[partIndex];
                    if (offset === part.bytes.length) {
                        if (partIndex === current)
                            data.needsFollowing = decoder.pending.some(entry => entry.frame === task.frame);
                        partIndex++;
                        offset = 0;
                        continue;
                    }
                    if (remaining <= 0) return false;
                    if (partIndex === current && offset === 0)
                        data.initialPending = decoder.pending.map(entry => ({ ...entry }));
                    const end = Math.min(part.bytes.length, offset + Math.min(2048, remaining));
                    const tokens = decoder.write(part.bytes.subarray(offset, end), part.frame, part.start + offset);
                    if (partIndex >= current) consume(tokens);
                    remaining -= end - offset;
                    offset = end;
                }
                consume(decoder.flush());
                data.layouts.set(data.columns, Uint32Array.from(data.initialLines));
                delete data.initialLines;
                complete = true;
                return true;
            },
            result() { return data; }
        };
    }
    if (task.kind !== 'text-count') throw new RangeError('Unsupported history task');
    const counter = new dependencies.TextCharacterCounter(task.encoding, { byteOffset: task.byteOffset ?? 0 });
    if (task.pending != null) counter.decoder.pending = task.pending.map(entry => ({ ...entry }));
    if (typeof task.orphanByte === 'boolean') counter.decoder.orphanByte = task.orphanByte;
    let offset = 0;
    return {
        step(byteBudget) {
            const end = Math.min(task.bytes.length, offset + byteBudget);
            counter.write(task.bytes.subarray(offset, end), offset);
            offset = end;
            if (offset < task.bytes.length) return false;
            if (task.flush) counter.flush();
            return true;
        },
        result() {
            return { total: counter.total, failed: counter.failed,
                pending: counter.decoder.pending.map(entry => ({ ...entry })),
                orphanByte: counter.decoder.orphanByte };
        }
    };
}

function historyWorkerDependencies() {
    const codec = typeof module !== 'undefined' ? require('./textCodec') : globalThis.SerialPlotter.TextCodec;
    const numeric = typeof module !== 'undefined' ? require('./numericCodec') : globalThis.SerialPlotter.NumericCodec;
    const parser = typeof module !== 'undefined' ? require('./dataParser').DataParser : globalThis.SerialPlotter.DataParser;
    const layout = typeof module !== 'undefined' ? require('./monitorView').MonitorTextLayout
        : globalThis.SerialPlotter.MonitorTextLayout;
    const spectrum = typeof module !== 'undefined' ? require('./spectrum') : globalThis.SerialPlotter;
    const phase = typeof module !== 'undefined' ? require('./systemResponse') : globalThis.SerialPlotter;
    const Protocol = typeof module !== 'undefined' ? require('./protocolEngine').Protocol : globalThis.SerialPlotter.Protocol;
    return { ...codec, ...numeric, ...layout, ...spectrum, unwrapPhaseDegrees: phase.unwrapPhaseDegrees,
        TYPE_LENGTH: parser.TYPE_LENGTH, Protocol };
}

/** Self-contained classic worker source; no network requests are needed for file:// use. */
function buildHistoryWorkerSource(dependencies = historyWorkerDependencies()) {
    const functions = ['normalizeTextEncoding', 'isFailedTextCharacter', 'visibleText', 'escapedText',
        'MappedTextDecoder', 'TextCharacterCounter', 'textCells', 'appendCompactTokens'];
    const display = typeof module !== 'undefined' ? require('./monitorDisplay') : globalThis.SerialPlotter.MonitorDisplay;
    return `'use strict';\nconst TEXT_CHARSETS = ${JSON.stringify(dependencies.CHARSETS)};\n` +
        `const monitorDisplayUtils = { textTokenDisplay: ${display.textTokenDisplay.toString()} };\n` +
        `const HISTORY_TYPE_LENGTH = ${JSON.stringify(dependencies.TYPE_LENGTH)};\n` +
        `const FFT_WINDOWS = ${JSON.stringify(dependencies.FFT_WINDOWS)};\n` +
        ['nextPow2', 'fftInPlace', 'windowCoefficient', 'prepareFrequencySeries', 'unwrapPhaseDegrees']
            .map(name => dependencies[name].toString()).join('\n') + '\n' +
        dependencies.decodeNumericPayload.toString() + '\n' +
        functions.map(name => dependencies[name].toString()).join('\n') + '\n' +
        `const Protocol = (${dependencies.Protocol.createFactorySource()})(globalThis,
            { normalizeTextEncoding, MappedTextDecoder, CHARSETS: TEXT_CHARSETS });\n` +
        validateProtocolHistoryTask.toString() + '\n' +
        createHistoryTaskProcessor.toString() + `\nself.onmessage = ({ data }) => {
            try {
                const processor = createHistoryTaskProcessor(data.task,
                    { TextCharacterCounter, MappedTextDecoder, textCells, appendCompactTokens,
                        TYPE_LENGTH: HISTORY_TYPE_LENGTH, decodeNumericPayload, prepareFrequencySeries, unwrapPhaseDegrees, Protocol });
                processor.step(Infinity);
                const result = processor.result();
                const transfer = ArrayBuffer.isView(result) ? [result.buffer] : [];
                if (data.task.kind === 'fft') transfer.push(result.mags.buffer, result.phases.buffer,
                    result.logMags.buffer, result.unwrappedPhases.buffer);
                if (data.task.kind === 'protocol-decode') {
                    const buffers = new Set(), seen = new Set();
                    const visit = value => {
                        if (!value || typeof value !== 'object' || seen.has(value)) return;
                        seen.add(value);
                        if (ArrayBuffer.isView(value)) buffers.add(value.buffer);
                        else for (const item of Object.values(value)) visit(item);
                    };
                    visit(result); transfer.push(...buffers);
                }
                if (result.chunks) {
                    for (const chunk of result.chunks) {
                        for (const key of ['offsets', 'cells', 'starts', 'ends', 'crosses', 'failed', 'breaks'])
                            transfer.push(chunk[key].buffer);
                    }
                    for (const lines of result.layouts.values()) transfer.push(lines.buffer);
                }
                self.postMessage({ id: data.id, result }, transfer);
            } catch (error) {
                self.postMessage({ id: data.id, error: { name: error.name, message: error.message, code: error.code } });
            }
        };\n`;
}

function historyAbortError() {
    const error = new Error('History worker pool disposed');
    error.name = 'AbortError';
    return error;
}

class HistoryWorkerPool {
    constructor(options = {}) {
        const cores = Object.hasOwn(options, 'hardwareConcurrency')
            ? options.hardwareConcurrency : globalThis.navigator?.hardwareConcurrency;
        this.maxWorkers = Number.isFinite(cores) && cores > 0 ? Math.max(0, Math.floor(cores) - 2) : 0;
        this.WorkerClass = Object.hasOwn(options, 'WorkerClass') ? options.WorkerClass : globalThis.Worker;
        this.workerFactory = options.workerFactory;
        this.available = this.maxWorkers > 0 && (typeof this.workerFactory === 'function' ||
            typeof this.WorkerClass === 'function' && typeof globalThis.Blob === 'function' &&
            typeof globalThis.URL?.createObjectURL === 'function');
        this.workers = [];
        this.peakWorkers = 0;
        this.queue = [];
        this.jobs = new Set();
        this.fftSources = new WeakMap();
        this.fftCacheEntries = new Map(); this.fftCacheBytes = 0; this.fftCacheLimitBytes = 64 * 1048576;
        this.nextId = 1;
        this.disposed = false;
        this.fallbackJob = null;
        this.schedule = options.schedule ?? (callback => setTimeout(callback, 0));
        this.cancelSchedule = options.cancelSchedule ?? (handle => clearTimeout(handle));
        this.fallbackTimer = null;
        this.sliceBytes = Number.isSafeInteger(options.sliceBytes) && options.sliceBytes > 0
            ? options.sliceBytes : 2048;
        this.workerSource = null;
        this.workerURL = null;
        this.pumping = false;
        this.idleSchedule = options.setTimeout ?? ((callback, delay) => setTimeout(callback, delay));
        this.idleCancel = options.clearTimeout ?? (timer => clearTimeout(timer));
    }

    get workerCount() { return this.workers.length; }
    clearFftCache() {
        this.fftSources = new WeakMap(); this.fftCacheEntries.clear(); this.fftCacheBytes = 0;
    }
    _forgetFft(promise) {
        const entry = this.fftCacheEntries.get(promise);
        if (!entry) return;
        if (entry.cache.entries.get(entry.key) === promise) entry.cache.entries.delete(entry.key);
        this.fftCacheBytes -= entry.bytes; this.fftCacheEntries.delete(promise);
    }
    setFftCacheLimit(bytes) {
        this.fftCacheLimitBytes = bytes;
        for (const [promise, entry] of this.fftCacheEntries) {
            if (this.fftCacheBytes <= bytes) break;
            if (entry.bytes) this._forgetFft(promise);
        }
    }
    setWorkerLimit(limit) {
        this.workerLimit = Math.max(1, Math.min(this.maxWorkers, Math.floor(limit)));
        for (const slot of [...this.workers].reverse()) if (!slot.job && this.workers.length > this.workerLimit) {
            this._closeWorker(slot);
            this.workers = this.workers.filter(item => item !== slot);
        }
    }

    /** Share identical input snapshots before reading samples or dispatching workers. */
    requestFft(source, options, readValues) {
        if (this.disposed) return Promise.reject(historyAbortError());
        let cache = this.fftSources.get(source);
        if (!cache || cache.version !== source.version) {
            if (cache) for (const promise of cache.entries.values()) this._forgetFft(promise);
            cache = { version: source.version, entries: new Map() };
            this.fftSources.set(source, cache);
        }
        const key = JSON.stringify([options.channel, options.start, options.end,
            options.removeDc, options.windowType, options.gain, options.offset]);
        if (cache.entries.has(key)) return cache.entries.get(key);
        let promise;
        try {
            promise = this.runTask({ kind: 'fft', values: readValues(),
                removeDc: options.removeDc, windowType: options.windowType });
        } catch (error) { return Promise.reject(error); }
        cache.entries.set(key, promise);
        this.fftCacheEntries.set(promise, { cache, key, bytes: 0 });
        while (cache.entries.size > Math.max(32, source.channelCount * 4))
            this._forgetFft(cache.entries.values().next().value);
        promise.then(result => {
            const entry = this.fftCacheEntries.get(promise);
            if (!entry) return;
            for (const value of Object.values(result)) {
                if (ArrayBuffer.isView(value)) entry.bytes += value.byteLength;
                else if (Array.isArray(value)) entry.bytes += value.length * 8;
            }
            this.fftCacheBytes += entry.bytes; this.setFftCacheLimit(this.fftCacheLimitBytes);
        }, () => this._forgetFft(promise));
        return promise;
    }

    runTask(task) {
        if (this.disposed) return Promise.reject(historyAbortError());
        if (task?.kind === 'fft' && !(task.values instanceof Float64Array))
            return Promise.reject(new TypeError('FFT values must be a Float64Array'));
        if (task?.kind === 'protocol-decode') {
            try { validateProtocolHistoryTask(task); }
            catch (error) { return Promise.reject(error); }
        }
        if (!['fft', 'protocol-decode'].includes(task?.kind) && !(task?.bytes instanceof Uint8Array))
            return Promise.reject(new TypeError('History task bytes must be a Uint8Array'));
        if (task.kind === 'hex-assemble' && (!Array.isArray(task.parts) ||
            task.parts.some(part => !(part instanceof Uint8Array))))
            return Promise.reject(new TypeError('Historical Hex parts must be Uint8Arrays'));
        if (task.kind === 'text-prepare' && [task.before, task.following].some(parts => parts != null &&
            (!Array.isArray(parts) || parts.some(part => !(part?.bytes instanceof Uint8Array)))))
            return Promise.reject(new TypeError('History text context bytes must be Uint8Arrays'));
        return new Promise((resolve, reject) => {
            const job = { id: this.nextId++, task, resolve, reject, settled: false };
            this.jobs.add(job);
            if (task.kind === 'fft') {
                const firstOther = this.queue.findIndex(queued => queued.task.kind !== 'fft');
                this.queue.splice(firstOther < 0 ? this.queue.length : firstOther, 0, job);
            } else this.queue.push(job);
            this._pump();
        });
    }

    _settle(job, error, result) {
        if (job.settled) return;
        job.settled = true;
        this.jobs.delete(job);
        job.task = null;
        if (error) job.reject(error);
        else job.resolve(result);
    }

    _pump() {
        if (this.disposed || this.pumping) return;
        this.pumping = true;
        try {
            while (this.queue.length && !this.disposed) {
                if (!this.available) {
                    if (!this.fallbackJob) this._startFallback(this.queue.shift());
                    break;
                }
                const limit = this.workerLimit ?? this.maxWorkers;
                if (this.workers.filter(worker => worker.job).length >= limit) break;
                let slot = this.workers.find(worker => !worker.job);
                if (!slot && this.workers.length < limit) {
                    try { slot = this._createWorker(); }
                    catch { this._failWorkers(); continue; }
                }
                if (!slot) break;
                if (slot.idleTimer != null) this.idleCancel(slot.idleTimer);
                slot.idleTimer = null;
                const job = this.queue.shift();
                slot.job = job;
                try {
                    const fft = job.task.kind === 'fft', protocol = job.task.kind === 'protocol-decode';
                    const data = fft ? new Float64Array(job.task.values) : protocol ? null : new Uint8Array(job.task.bytes);
                    const task = fft ? { ...job.task, values: data } : protocol ? { ...job.task } : { ...job.task, bytes: data };
                    const transfer = data ? [data.buffer] : [];
                    if (protocol) task.records = task.records.map(record => {
                        const bytes = new Uint8Array(record instanceof Uint8Array ? record : record.bytes);
                        transfer.push(bytes.buffer); return { bytes };
                    });
                    if (task.kind === 'hex-assemble') {
                        task.parts = task.parts.map(part => {
                            const copy = new Uint8Array(part);
                            transfer.push(copy.buffer);
                            return copy;
                        });
                    }
                    if (task.kind === 'text-prepare') {
                        for (const key of ['before', 'following']) {
                            task[key] = (task[key] ?? []).map(part => {
                                const copy = new Uint8Array(part.bytes);
                                transfer.push(copy.buffer);
                                return { ...part, bytes: copy };
                            });
                        }
                    }
                    slot.worker.postMessage({ id: job.id, task }, transfer);
                } catch { this._failWorkers(); }
            }
        } finally {
            this.pumping = false;
            for (const slot of this.workers) if (!slot.job && slot.idleTimer == null) {
                slot.idleTimer = this.idleSchedule(() => {
                    slot.idleTimer = null;
                    if (slot.job || slot.closed) return;
                    this._closeWorker(slot);
                    this.workers = this.workers.filter(item => item !== slot);
                }, 10000);
                slot.idleTimer?.unref?.();
            }
        }
    }

    _createWorker() {
        this.workerSource ??= buildHistoryWorkerSource();
        let worker;
        if (this.workerFactory) worker = this.workerFactory(this.workerSource);
        else {
            this.workerURL ??= URL.createObjectURL(new Blob([this.workerSource], { type: 'text/javascript' }));
            worker = new this.WorkerClass(this.workerURL);
        }
        const slot = { worker, job: null, closed: false };
        worker.onmessage = event => {
            if (slot.closed || this.disposed) return;
            const data = event.data;
            const job = slot.job;
            if (!job || data?.id !== job.id) return;
            if (!Object.hasOwn(data, 'error') && !Object.hasOwn(data, 'result')) {
                this._failWorkers();
                return;
            }
            slot.job = null;
            if (data.error) {
                const error = new Error(data.error.message);
                error.name = data.error.name || 'Error';
                if (data.error.code) error.code = data.error.code;
                this._settle(job, error);
            } else this._settle(job, null, data.result);
            this._pump();
        };
        worker.onerror = event => {
            event?.preventDefault?.();
            if (!slot.closed && !this.disposed) this._failWorkers();
        };
        worker.onmessageerror = () => {
            if (!slot.closed && !this.disposed) this._failWorkers();
        };
        this.workers.push(slot);
        this.peakWorkers = Math.max(this.peakWorkers, this.workers.length);
        return slot;
    }

    _closeWorker(slot) {
        slot.closed = true;
        if (slot.idleTimer != null) this.idleCancel(slot.idleTimer);
        slot.idleTimer = null;
        slot.worker.onmessage = null;
        slot.worker.onerror = null;
        slot.worker.onmessageerror = null;
        try {
            const completion = slot.worker.terminate();
            completion?.catch?.(() => {});
        } catch { /* Cleanup must continue even if one worker already exited. */ }
    }

    _closeWorkers() {
        for (const slot of this.workers) this._closeWorker(slot);
        this.workers.length = 0;
        if (this.workerURL) URL.revokeObjectURL(this.workerURL);
        this.workerURL = null;
        this.workerSource = null;
    }

    _failWorkers() {
        this.available = false;
        const active = this.workers.map(slot => slot.job).filter(job => job && !job.settled);
        this.queue = active.concat(this.queue).sort((left, right) => left.id - right.id);
        this._closeWorkers();
        this._pump();
    }

    _startFallback(job) {
        this.fallbackJob = job;
        let processor;
        const advance = () => {
            this.fallbackTimer = null;
            if (this.disposed || job.settled) return;
            try {
                processor ??= createHistoryTaskProcessor(job.task, historyWorkerDependencies());
                if (!processor.step(this.sliceBytes)) {
                    this.fallbackTimer = this.schedule(advance);
                    return;
                }
                this._settle(job, null, processor.result());
            } catch (error) {
                this._settle(job, error);
            }
            this.fallbackJob = null;
            this._pump();
        };
        this.fallbackTimer = this.schedule(advance);
    }

    dispose() {
        if (this.disposed) return;
        this.disposed = true;
        this.available = false;
        if (this.fallbackTimer != null) {
            try { this.cancelSchedule(this.fallbackTimer); }
            catch { /* Worker and promise cleanup must finish if a custom scheduler fails. */ }
        }
        this.fallbackTimer = null;
        for (const job of this.jobs) this._settle(job, historyAbortError());
        this.queue.length = 0;
        this.fallbackJob = null;
        this.clearFftCache();
        this._closeWorkers();
    }
}

if (typeof module !== 'undefined') module.exports = {
    HistoryWorkerPool, createHistoryTaskProcessor, buildHistoryWorkerSource
};
globalThis.SerialPlotter ??= {};
globalThis.SerialPlotter.HistoryWorkerPool = HistoryWorkerPool;
