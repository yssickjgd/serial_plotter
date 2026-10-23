/** Shared numeric read view. Extra columns never duplicate original bytes or samples. */
const computedChannelApi = typeof module !== 'undefined' ? require('./channelOperations') : globalThis.SerialPlotter;
const COMPUTED_CHUNK_SIZE = 4096;

class ComputedFrames {
    constructor(raw, definitions = [], options = {}) {
        this.raw = raw; this.chunkSize = raw.chunkSize ?? COMPUTED_CHUNK_SIZE; this.definitions = definitions.map(value => ({ ...value }));
        this.channelNames = options.names ?? [];
        this.engine = new computedChannelApi.ChannelOperations(raw.channelCount, definitions,
            { names: this.channelNames, symbolVersion: options.symbolVersion });
        this.definitions = this.engine.definitions;
        this.columns = new Map(); this.revision = 0; this.serial = raw.length; this.generation = 0;
        this.rebuilding = false; this.progress = null; this.pendingAffected = new Set(); this.storageRevision = 0;
        this.yieldTimers = new Map();
        this.yieldControl = options.yieldControl ?? (() => new Promise(resolve => {
            const id = setTimeout(() => { this.yieldTimers.delete(id); resolve(); }, 0);
            this.yieldTimers.set(id, resolve);
        }));
        this.onProgress = options.onProgress ?? (() => {}); this.onChange = options.onChange ?? (() => {});
        this._values = raw.values;
        return new Proxy(this, {
            get: (target, key) => {
                if (key in target) { const value = Reflect.get(target, key); return typeof value === 'function' ? value.bind(target) : value; }
                const value = raw[key]; return typeof value === 'function' ? value.bind(raw) : value;
            }
        });
    }
    get channelCount() { return this.engine.channelCount; }
    get rawChannelCount() { return this.raw.channelCount; }
    get version() { return this.raw.version + this.revision; }
    get values() { return this._values; }
    get length() { return this.raw.length; }
    get capacity() { return this.raw.capacity; }
    get estimatedMemoryBytes() {
        let bytes = this.raw.estimatedMemoryBytes + this.engine.requiredMemoryBytes;
        if (this.replayEngine) bytes += this.replayEngine.requiredMemoryBytes;
        for (const columns of new Set([this.columns, this.replayColumns])) if (columns)
            for (const chunks of columns.values()) for (const chunk of chunks) if (chunk) bytes += chunk.byteLength;
        return bytes;
    }
    discardOldest(count) {
        const removed = this.raw.discardOldest(count);
        if (!removed) return 0;
        for (const chunks of this.columns.values()) for (let i = 0; i < chunks.length; i++)
            if (!this.raw.frames[i]) delete chunks[i];
        this._values = [...this.raw.values, this.columns];
        this.revision++;
        return removed;
    }
    estimateAppendMemory(count, byteLength, frameLength, activeChannels) {
        let bytes = this.raw.estimateAppendMemory(count, byteLength, frameLength, activeChannels);
        count = Math.min(this.capacity, Math.max(1, Math.ceil(count)));
        const start = (this.raw.head + this.length) % this.raw.storageCapacity;
        for (let offset = 0; offset < count;) {
            const slot = (start + offset) % this.raw.storageCapacity, chunk = Math.floor(slot / this.chunkSize);
            for (const definition of this.definitions) if (definition.type === 'formula' && !this.columns.get(definition.number)?.[chunk])
                bytes += this.chunkSize * 8;
            offset += Math.min(count - offset, this.chunkSize - slot % this.chunkSize, this.raw.storageCapacity - slot);
        }
        return bytes;
    }
    _cancelYields() {
        for (const [id, resolve] of this.yieldTimers) { clearTimeout(id); resolve(); }
        this.yieldTimers.clear();
    }
    _slot(index) { return (this.raw.head + index) % this.raw.storageCapacity; }
    _write(columns, number, slot, value) {
        let chunks = columns.get(number);
        if (!chunks) { chunks = []; columns.set(number, chunks); }
        const chunk = Math.floor(slot / this.chunkSize);
        chunks[chunk] ??= new Float64Array(this.chunkSize).fill(NaN);
        chunks[chunk][slot % this.chunkSize] = value;
    }
    getValue(channel, index) {
        if (index < 0 || index >= this.raw.length || channel < 0 || channel >= this.channelCount) return NaN;
        if (channel < this.raw.channelCount) return this.raw.getValue(channel, index);
        const slot = this._slot(index);
        return this.columns.get(channel + 1)?.[Math.floor(slot / this.chunkSize)]?.[slot % this.chunkSize] ?? NaN;
    }
    copyChannel(channel, start = 0, end = this.length) {
        if (channel < this.raw.channelCount) return this.raw.copyChannel(channel, start, end);
        const first = Math.max(0, Math.min(this.length, Math.floor(start)));
        const last = Math.max(first, Math.min(this.length, Math.floor(end)));
        const result = new Float64Array(last - first);
        const chunks = this.columns.get(channel + 1);
        for (let offset = 0; offset < result.length;) {
            const slot = this._slot(first + offset), within = slot % this.chunkSize;
            const count = Math.min(result.length - offset, this.chunkSize - within, this.raw.storageCapacity - slot);
            const chunk = chunks?.[Math.floor(slot / this.chunkSize)];
            if (chunk) result.set(chunk.subarray(within, within + count), offset);
            else result.fill(NaN, offset, offset + count);
            offset += count;
        }
        return result;
    }
    channelSlice(channel, start = 0, end = this.length) {
        const values = [];
        for (let i = Math.max(0, start); i < Math.min(end, this.length); i++) values.push(this.getValue(channel, i));
        return values;
    }
    isSignal(channel) { return channel < this.raw.channelCount || this.engine.entries.get(channel + 1)?.definition.type === 'formula'; }
    append(samples, ...metadata) {
        this.raw.append(samples, ...metadata); this.serial++;
        if (!this.definitions.some(definition => definition.type === 'formula')) return;
        const values = this.engine.push(samples), slot = this._slot(this.length - 1);
        for (const definition of this.definitions) if (definition.type === 'formula')
            this._write(this.columns, definition.number, slot, values[definition.number - 1]);
    }
    _affected(next) {
        const changed = new Set(), previous = new Map(this.definitions.map(value => [value.number, value]));
        for (const entry of next.definitions) {
            const old = previous.get(entry.number);
            if (!old || entry.type !== old.type || entry.expression !== old.expression || entry.initial !== old.initial)
                changed.add(entry.number);
        }
        for (const number of previous.keys()) if (!next.entries.has(number)) changed.add(number);
        return this._expandAffected(next, changed);
    }
    _expandAffected(next, affected) {
        const outgoing = new Map();
        for (const [number, entry] of next.entries) for (const dependency of entry.dependencies) {
            if (!outgoing.has(dependency)) outgoing.set(dependency, []);
            outgoing.get(dependency).push(number);
        }
        const queue = [...affected];
        for (let index = 0; index < queue.length; index++) for (const number of outgoing.get(queue[index]) ?? [])
            if (!affected.has(number)) { affected.add(number); queue.push(number); }
        return affected;
    }
    updateDefinitions(definitions, { rebuild = true, all = false, reapply = [], numberMap = null,
        rawChannelCount = this.raw.channelCount, symbolVersion = 2 } = {}) {
        this.chunkSize = this.raw.chunkSize ?? COMPUTED_CHUNK_SIZE;
        const next = new computedChannelApi.ChannelOperations(rawChannelCount, definitions, { names: this.channelNames, symbolVersion });
        definitions = next.definitions;
        this.raw.setChannelCount(rawChannelCount, { preserve: true });
        if (numberMap) {
            next.adoptRenumbered(this.engine, numberMap);
            this.columns = new Map([...this.columns].filter(([number]) => numberMap.has(number))
                .map(([number, column]) => [numberMap.get(number), column]));
            this.pendingAffected = new Set([...this.pendingAffected].filter(number => numberMap.has(number))
                .map(number => numberMap.get(number)));
            rebuild = this.rebuilding;
            reapply = [...this.pendingAffected];
            this.engine = next; this.definitions = next.definitions;
        }
        const affected = all ? new Set([...next.entries.keys()]) : this._affected(next);
        // Applying an unchanged expression can explicitly rebuild future-only edits in retained history.
        if (rebuild) for (const number of reapply) if (next.entries.has(number)) affected.add(number);
        if (rebuild && this.rebuilding) for (const number of this.pendingAffected) affected.add(number);
        this._expandAffected(next, affected);
        next.adoptUnchanged(this.engine, affected);
        // Explicit lookbacks refer to retained samples even when a new expression is introduced.
        for (const [number, history] of next.history) if (history !== this.engine.history.get(number)) {
            for (let index = Math.max(0, this.length - history.size); index < this.length; index++)
                history.push(this.getValue(number - 1, index));
        }
        this.engine = next; this.definitions = next.definitions;
        for (const number of this.columns.keys()) if (!next.entries.has(number)) this.columns.delete(number);
        const generation = ++this.generation;
        this._cancelYields();
        this.replayColumns = null;
        this.replayEngine = null;
        this.revision++; this._values = [...this.raw.values, this.columns];
        this.rebuilding = rebuild && affected.size > 0 && this.length > 0;
        this.pendingAffected = this.rebuilding ? affected : new Set();
        this.progress = this.rebuilding ? { processedBytes: 0, totalBytes: this.length } : null;
        this.onChange(); this.onProgress();
        if (!this.rebuilding) return Promise.resolve();
        const cancelled = () => generation !== this.generation;
        return (async () => {
            let worker = new computedChannelApi.ChannelOperations(this.raw.channelCount, definitions, { names: this.channelNames, symbolVersion: 2 });
            this.replayEngine = worker;
            let columns = new Map(), cursor = this.serial - this.length, storageRevision = this.storageRevision;
            this.replayColumns = columns;
            const unchanged = [...worker.entries].filter(([number, entry]) => entry.ast && !affected.has(number)).map(([number]) => number);
            const overrides = new Map();
            await this.yieldControl();
            while (!cancelled() && cursor < this.serial) {
                const first = this.serial - this.length;
                if (cursor < first || storageRevision !== this.storageRevision) {
                    worker = new computedChannelApi.ChannelOperations(this.raw.channelCount, definitions, { names: this.channelNames, symbolVersion: 2 });
                    this.replayEngine = worker;
                    columns = new Map(); cursor = first; storageRevision = this.storageRevision;
                    this.replayColumns = columns;
                }
                const stop = Math.min(this.serial, cursor + 512);
                const deadline = performance.now() + 8;
                for (; cursor < stop; cursor++) {
                    const index = cursor - (this.serial - this.length);
                    const samples = Array.from({ length: this.raw.channelCount }, (_, c) => this.raw.getValue(c, index));
                    for (const number of unchanged) overrides.set(number, this.getValue(number - 1, index));
                    const values = worker.push(samples, overrides), slot = this._slot(index);
                    for (const number of affected) if (worker.entries.get(number)?.ast)
                        this._write(columns, number, slot, values[number - 1]);
                    if (performance.now() >= deadline) { cursor++; break; }
                }
                this.progress = { processedBytes: Math.min(this.length, worker.sample), totalBytes: this.length };
                this.onProgress();
                if (cursor < this.serial) await this.yieldControl();
            }
            if (cancelled()) return;
            worker.adoptUnchanged(this.engine, affected);
            this.engine = worker;
            for (const number of affected) if (worker.entries.has(number)) {
                if (columns.has(number)) this.columns.set(number, columns.get(number));
                else this.columns.delete(number);
            }
            this.rebuilding = false; this.progress = null; this.pendingAffected.clear(); this.revision++;
            this.replayColumns = null;
            this.replayEngine = null;
            this._values = [...this.raw.values, this.columns]; this.onChange(); this.onProgress();
        })().catch(error => {
            if (!cancelled()) {
                this.replayColumns = null;
                this.replayEngine = null;
                this.rebuilding = false; this.progress = null; this.pendingAffected.clear();
                this.onChange(); this.onProgress();
            }
            throw error;
        });
    }
    resize(capacity) {
        if (capacity === this.raw.capacity) return;
        this.storageRevision++;
        if (capacity <= this.raw.storageCapacity && capacity >= this.raw.storageCapacity / 4) this.raw.resize(capacity);
        else {
            const count = Math.min(this.length, capacity), first = this.length - count, columns = new Map();
            for (const number of this.columns.keys()) for (let index = 0; index < count; index++)
                this._write(columns, number, index, this.getValue(number - 1, first + index));
            this.raw.resize(capacity); this.columns = columns;
        }
        this._values = [...this.raw.values, this.columns]; this.revision++;
        this.onProgress();
    }
    clear() {
        this._cancelYields();
        this.generation++; this.rebuilding = false; this.progress = null; this.raw.clear(); this.columns.clear();
        this.replayColumns = null;
        this.replayEngine = null;
        this.engine = new computedChannelApi.ChannelOperations(this.raw.channelCount, this.definitions, { names: this.channelNames, symbolVersion: 2 });
        this.serial = 0; this._values = [...this.raw.values, this.columns]; this.revision++; this.onProgress();
    }
    setChannelCount(count) {
        // Validate global channel numbering before changing any stored raw data.
        new computedChannelApi.ChannelOperations(count, this.definitions, { names: this.channelNames, symbolVersion: 2 });
        this.raw.setChannelCount(count); this.clear();
    }
    resetFormat(count, definitions, { symbolVersion } = {}) {
        const engine = new computedChannelApi.ChannelOperations(count, definitions, { names: this.channelNames, symbolVersion });
        this.generation++; this._cancelYields(); this.raw.clear(); this.raw.setChannelCount(count);
        this.chunkSize = this.raw.chunkSize ?? COMPUTED_CHUNK_SIZE;
        this.replayColumns = null;
        this.replayEngine = null;
        this.engine = engine; this.definitions = engine.definitions; this.columns.clear(); this.serial = 0;
        this.rebuilding = false; this.progress = null; this.revision++; this._values = [...this.raw.values, this.columns];
    }
    replaceFrom(other) {
        this.generation++; this._cancelYields(); this.raw.replaceFrom(other.raw ?? other); this.serial = this.length; this.columns.clear();
        this.chunkSize = this.raw.chunkSize ?? COMPUTED_CHUNK_SIZE;
        this.replayColumns = null;
        this.replayEngine = null;
        this.engine = new computedChannelApi.ChannelOperations(this.raw.channelCount, this.definitions, { names: this.channelNames, symbolVersion: 2 });
        this._values = [...this.raw.values, this.columns]; this.revision++;
        return this.updateDefinitions(this.definitions, { rebuild: true, all: true });
    }
    dispose() {
        this.generation++; this._cancelYields(); this.rebuilding = false; this.columns.clear();
        this.replayColumns = null; this.replayEngine = null; this.raw.clear(); this._values = this.raw.values;
    }
}

globalThis.SerialPlotter ??= {};
globalThis.SerialPlotter.ComputedFrames = ComputedFrames;
if (typeof module !== 'undefined') module.exports = { ComputedFrames };
