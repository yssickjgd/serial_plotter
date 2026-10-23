/** A fixed-rate numeric view backed by change events rather than repeated held samples. */
(function(root) {
    const deps = typeof module !== 'undefined' ? { ...require('./channelOperations'), ...require('./plotMath') } : root.SerialPlotter;
    class SynchronizedFrames {
        constructor(channelCount, capacity, { sampleRate = 1000, expiry = {}, definitions = [], names = [], symbolVersion, resolveFrame = () => null,
            yieldControl = () => new Promise(resolve => setTimeout(resolve, 0)), onChange = () => {}, onProgress = () => {} } = {}) {
            if (!Number.isFinite(sampleRate) || sampleRate <= 0 || sampleRate > 1000000) throw new RangeError('同步采样率无效');
            if (!Number.isSafeInteger(capacity) || capacity < 2 || capacity > 3600000) throw new RangeError('同步采样容量无效');
            this.channelCount = channelCount; this.baseChannelCount = channelCount; this.capacity = capacity; this.sampleRate = sampleRate;
            this.expiry = expiry; this.definitions = definitions; this.names = names; this.symbolVersion = symbolVersion; this.resolveFrame = resolveFrame;
            this.rawMode = false; this.chunkSize = 256; this.values = []; this.frames = [];
            this.yieldControl = yieldControl; this.onChange = onChange; this.onProgress = onProgress; this.generation = 0;
            this.clear();
        }
        clear() {
            this.generation++; this.rebuilding = false; this.progress = null; this.replayColumns = null; this.replayEngine = null;
            this.pendingAffected = new Set();
            this.events = new Map(); this.origins = []; this.segments = []; this.columns = new Map(); this.length = 0;
            this.head = 0; this.next = 0; this.active = null; this.version = (this.version ?? 0) + 1;
            this.timestampsMonotonic = true; this.lastTimestamp = -Infinity;
            this.firstTimestamp = NaN;
            this.expiryRules = [{ time: -Infinity, expiry: { ...this.expiry } }];
            this.engine = new deps.ChannelOperations(this.baseChannelCount, this.definitions, { names: this.names, symbolVersion: this.symbolVersion });
            this.definitions = this.engine.definitions; this.symbolVersion = 2;
            this.rawChannelCount = this.baseChannelCount; this.channelCount = this.engine.channelCount;
            this.provenancePlans = new Map(); this.provenanceResults = new Map(); this.provenanceLags = new WeakMap(); this.provenanceEpochs = new Map();
        }
        get originTimestamp() { return this.firstTimestamp; }
        get estimatedMemoryBytes() {
            let size = this.segments.length * 96 + this.origins.length * 64 + this.engine.requiredMemoryBytes;
            for (const events of this.events.values()) size += events.length * 128;
            for (const column of this.columns.values()) for (const chunk of column.values()) size += chunk.byteLength;
            if (this.replayEngine) size += this.replayEngine.requiredMemoryBytes;
            if (this.replayColumns) for (const column of this.replayColumns.values()) for (const chunk of column.values()) size += chunk.byteLength;
            const plans = new Set(this.provenancePlans.values());
            for (const epochs of this.provenanceEpochs.values()) for (const epoch of epochs) { size += 64; plans.add(epoch.plan); }
            for (const plan of plans) size += plan.length * 64;
            size += this.provenanceResults.size * 256;
            return size;
        }
        estimateAppendMemory(count = 1) {
            let formulas = 0; for (const definition of this.definitions) if (definition.type === 'formula') formulas++;
            return 256 + Math.min(this.capacity, count) * formulas * 8 + formulas * this.chunkSize * 8;
        }
        start(timestamp) {
            if (this.active || !Number.isFinite(timestamp)) return;
            this.active = { first: this.next, time: timestamp, count: 0, step: 1000 / this.sampleRate };
            if (!Number.isFinite(this.firstTimestamp)) this.firstTimestamp = timestamp;
            this.segments.push(this.active);
        }
        stop() { this.active = null; }
        ingest(timestamp, values, origin) {
            if (!Number.isFinite(timestamp)) throw new RangeError('同步记录时间无效');
            const samplingTime = timestamp;
            this.start(timestamp);
            this.advance(timestamp, false);
            const lastTick = this.active.time + (this.active.count - 1) * this.active.step;
            if (this.active.count && timestamp <= lastTick + 1e-8) timestamp = lastTick + this.active.step;
            this.origins.push({ timestamp, origin });
            for (const [channel, value] of values) {
                if (!Number.isInteger(channel) || channel < 0 || channel >= this.rawChannelCount) throw new RangeError('字段映射超出原始通道目录');
                const events = this.events.get(channel) ?? [];
                events.push({ timestamp, value: Number.isFinite(value) ? value : NaN, origin });
                this.events.set(channel, events);
            }
            this.advance(samplingTime);
        }
        advance(timestamp, inclusive = true) {
            if (!this.active || !Number.isFinite(timestamp)) return 0;
            const segment = this.active, step = segment.step;
            const count = Math.max(segment.count, Math.floor((timestamp - segment.time) / step + (inclusive ? 1e-8 : -1e-8)) + 1);
            const added = count - segment.count;
            if (!added) return 0;
            if (this.definitions.some(d => d.type === 'formula')) {
                for (let tick = segment.count; tick < count; tick++) {
                    const time = segment.time + tick * step;
                    const values = Array.from({ length: this.rawChannelCount }, (_, channel) => this._eventValue(channel, time));
                    const result = this.engine.push(values), index = segment.first + tick;
                    for (const d of this.definitions) if (d.type === 'formula') {
                        const column = this.columns.get(d.number - 1) ?? new Map(), key = Math.floor(index / this.chunkSize);
                        if (!column.has(key)) column.set(key, new Float64Array(this.chunkSize).fill(NaN));
                        column.get(key)[index % this.chunkSize] = result[d.number - 1]; this.columns.set(d.number - 1, column);
                    }
                }
            }
            segment.count = count; this.next = segment.first + count; this.length += added;
            this.lastTimestamp = segment.time + (count - 1) * step; this.version++;
            if (this.length > this.capacity) this.discardOldest(this.length - this.capacity);
            return added;
        }
        _event(channel, timestamp) {
            const events = this.events.get(channel); if (!events?.length) return null;
            let low = 0, high = events.length;
            while (low < high) { const mid = (low + high) >>> 1; if (events[mid].timestamp <= timestamp) low = mid + 1; else high = mid; }
            return events[low - 1] ?? null;
        }
        _eventValue(channel, time) {
            let low = 0, high = this.expiryRules.length;
            while (low < high) { const mid = (low + high) >>> 1; if (this.expiryRules[mid].time <= time) low = mid + 1; else high = mid; }
            const event = this._event(channel, time), ttl = Number(this.expiryRules[low - 1]?.expiry[channel] ?? 0);
            return !event || ttl > 0 && time - event.timestamp >= ttl * 1000 ? NaN : event.value;
        }
        statusAt(channel, index) {
            return this.provenanceInfoAt(channel, index).status;
        }
        provenanceAt(channel, index) {
            if (channel < this.rawChannelCount) return this._event(channel, this.timestampAt(index))?.origin ?? null;
            const info = this.provenanceInfoAt(channel, index);
            return info.origin ? { ...info.origin, origins: info.origins, ...(info.truncated ? { truncated: true } : {}) } : null;
        }
        _samplePeriod(index) {
            const position = this.head + index;
            if (position < 0 || position >= this.next) return null;
            let low = 0, high = this.segments.length;
            while (low < high) { const mid = (low + high) >>> 1; if (this.segments[mid].first <= position) low = mid + 1; else high = mid; }
            const segment = this.segments[low - 1];
            if (!segment || position >= segment.first + segment.count) return null;
            const time = segment.time + (position - segment.first) * segment.step;
            return { time, start: position === segment.first ? time - 1e-7 : time - segment.step };
        }
        _newInPeriod(eventTime, period) { return period && eventTime > period.start + 1e-8 && eventTime <= period.time + 1e-8; }
        _provenancePlan(number, index) {
            const epochs = this.provenanceEpochs.get(number), position = this.head + index;
            if (epochs) {
                let low = 0, high = epochs.length;
                while (low < high) { const mid = (low + high) >>> 1; if (epochs[mid].first <= position) low = mid + 1; else high = mid; }
                if (low) return epochs[low - 1].plan;
            }
            return this._currentProvenancePlan(number);
        }
        _currentProvenancePlan(number) {
            if (this.provenancePlans.has(number)) return this.provenancePlans.get(number);
            const references = [], ast = this.engine.entries.get(number)?.ast, pending = ast ? [{ node: ast, delays: [] }] : [];
            while (pending.length) {
                const { node, delays } = pending.pop();
                if (node.type === 'reference') {
                    const entry = this.engine.entries.get(node.number);
                    if (node.number <= this.rawChannelCount || entry?.ast) references.push({ number: node.number, index: node.index ?? 0, delays });
                } else if (node.type === 'call') {
                    let offsets = null;
                    if (node.name === 'DIFF') offsets = [0, -1];
                    if (node.name === 'FILTER') {
                        const parameter = node.parameter;
                        offsets = this.provenanceLags.get(parameter);
                        if (!offsets) {
                            offsets = [];
                            if (parameter.kernel) {
                                for (let index = 0; index < parameter.kernel.length; index++) if (parameter.kernel[index] !== 0) offsets.push(-index);
                            } else {
                                const nodes = [parameter.system.ast], used = new Set();
                                while (nodes.length) {
                                    const current = nodes.pop();
                                    if (current.type === 'reference' && current.number === 'X') used.add(current.index ?? 0);
                                    for (const child of [current.left, current.right, current.value]) if (child && typeof child === 'object') nodes.push(child);
                                }
                                offsets = [...used];
                            }
                            this.provenanceLags.set(parameter, offsets);
                        }
                    }
                    if (!offsets || offsets.length) pending.push({ node: node.signal ?? node.args[0], delays: offsets ? [...delays, offsets] : delays });
                } else for (const child of [node.left, node.right, node.value]) if (child && typeof child === 'object') pending.push({ node: child, delays });
            }
            this.provenancePlans.set(number, references); return references;
        }
        /** Trace only actual signal references; query work and optional origin lists are bounded. */
        provenanceInfoAt(channel, index) {
            const key = `${this.version}:${channel}:${this.head + index}`;
            if (this.provenanceResults.has(key)) return this.provenanceResults.get(key);
            const period = this._samplePeriod(index), value = this.getValue(channel, index), origins = [], originKeys = new Set();
            let representative = null, representativeTime = -Infinity, newestInputTime = -Infinity, expired = false, hasInputs = false, work = 0, originLimit = false;
            const pending = [{ number: channel + 1, index }], visited = new Map();
            while (pending.length && work++ < 262144) {
                const task = pending.pop();
                if (task.plan) {
                    const reference = task.plan[task.referenceAt];
                    if (task.referenceAt + 1 < task.plan.length) pending.push({ ...task, referenceAt: task.referenceAt + 1 });
                    if (reference) pending.push({ reference, delayAt: 0, index: task.index });
                    continue;
                }
                if (task.reference) {
                    const { reference, delayAt } = task;
                    if (delayAt < reference.delays.length) {
                        const offsets = reference.delays[delayAt], offsetAt = task.offsetAt ?? 0;
                        if (offsetAt + 1 < offsets.length) pending.push({ ...task, offsetAt: offsetAt + 1 });
                        if (offsetAt < offsets.length) pending.push({ reference, delayAt: delayAt + 1, index: task.index + offsets[offsetAt] });
                    } else pending.push({ number: reference.number, index: task.index + reference.index });
                    continue;
                }
                if (!visited.has(task.number)) visited.set(task.number, new Set());
                if (visited.get(task.number).has(task.index)) continue;
                visited.get(task.number).add(task.index);
                if (task.number > this.rawChannelCount) {
                    const plan = this._provenancePlan(task.number, task.index);
                    if (plan.length) pending.push({ plan, referenceAt: 0, index: task.index });
                    continue;
                }
                hasInputs = true;
                const sample = this._samplePeriod(task.index), event = sample ? this._event(task.number - 1, sample.time) : null;
                if (!event) continue;
                if (!Number.isFinite(this._eventValue(task.number - 1, sample.time))) { expired = true; continue; }
                newestInputTime = Math.max(newestInputTime, event.timestamp);
                const origin = event.origin; if (!origin) continue;
                const originKey = `${origin.order}:${origin.byteOffset}:${origin.endByte}`;
                if (!originKeys.has(originKey) && origins.length < 64) { originKeys.add(originKey); origins.push(origin); }
                else if (!originKeys.has(originKey)) originLimit = true;
                if (event.timestamp > representativeTime || event.timestamp === representativeTime && (origin.order ?? 0) > (representative?.order ?? 0)) {
                    representative = origin; representativeTime = event.timestamp;
                }
            }
            const status = !period || !Number.isFinite(value) ? expired ? 'expired' : 'missing'
                : this._newInPeriod(newestInputTime, period) ? 'new' : 'held';
            if (representative && !origins.includes(representative)) {
                if (origins.length === 64) origins[63] = representative; else origins.push(representative);
            }
            const result = { status, origin: representative, origins, hasInputs: hasInputs || pending.length > 0, truncated: originLimit || pending.length > 0 };
            if (this.provenanceResults.size >= 64) this.provenanceResults.delete(this.provenanceResults.keys().next().value);
            this.provenanceResults.set(key, result); return result;
        }
        getValue(channel, index) {
            if (index < 0 || index >= this.length || channel < 0 || channel >= this.channelCount) return NaN;
            if (channel < this.rawChannelCount) return this._eventValue(channel, this.timestampAt(index));
            const position = this.head + index;
            return this.columns.get(channel)?.get(Math.floor(position / this.chunkSize))?.[position % this.chunkSize] ?? NaN;
        }
        copyChannel(channel, start = 0, end = this.length) {
            start = Math.max(0, start); end = Math.min(this.length, end);
            return Float64Array.from({ length: Math.max(0, end - start) }, (_, i) => this.getValue(channel, start + i));
        }
        channelSlice(channel, start = 0, end = this.length) { return Array.from(this.copyChannel(channel, start, end)); }
        isSignal(channel) { return channel < this.rawChannelCount || this.engine.entries.get(channel + 1)?.definition.type === 'formula'; }
        timestampAt(index) {
            if (index < 0 || index >= this.length) return NaN;
            const target = this.head + index;
            let low = 0, high = this.segments.length;
            while (low < high) { const mid = (low + high) >>> 1; if (this.segments[mid].first <= target) low = mid + 1; else high = mid; }
            const segment = this.segments[low - 1];
            return segment ? segment.time + (target - segment.first) * segment.step : NaN;
        }
        _origin(index) {
            const time = this.timestampAt(index); let low = 0, high = this.origins.length;
            while (low < high) { const mid = (low + high) >>> 1; if (this.origins[mid].timestamp <= time) low = mid + 1; else high = mid; }
            return this.origins[low - 1]?.origin ?? {};
        }
        frameAt(index) {
            if (index < 0 || index >= this.length) return null;
            const origin = this._origin(index), raw = this.resolveFrame(origin), timestamp = this.timestampAt(index);
            return { ...origin, bytes: raw?.bytes ?? new Uint8Array(0), timestamp,
                time: new Date(timestamp).toISOString(), order: this.orderAt(index), synchronized: true };
        }
        rawBytesAt(index) { return this.frameAt(index)?.bytes ?? null; }
        rawByteOffsetAt(index) { return this._origin(index).byteOffset ?? 0; }
        orderAt(index) { return this._origin(index).order ?? 0; }
        indexAtOrAfterOrder(order) {
            let low = 0, high = this.length;
            while (low < high) { const mid = (low + high) >>> 1; if (this.orderAt(mid) < order) low = mid + 1; else high = mid; }
            return Math.min(this.length - 1, low);
        }
        nearestTimestampIndex(time) {
            if (!this.length) return -1;
            let low = 0, high = this.length;
            while (low < high) { const mid = (low + high) >>> 1; if (this.timestampAt(mid) < time) low = mid + 1; else high = mid; }
            if (!low) return 0; if (low === this.length) return this.length - 1;
            return time - this.timestampAt(low - 1) <= this.timestampAt(low) - time ? low - 1 : low;
        }
        streamEndedAt(index) { return index === this.length - 1 && !this.active; }
        streamStartByteAt() { return 0; }
        updateSynchronization({ sampleRate = this.sampleRate, expiry = this.expiry }, { timestamp = this.lastTimestamp } = {}) {
            if (!Number.isFinite(sampleRate) || sampleRate <= 0 || sampleRate > 1000000) throw new RangeError('同步采样率无效');
            const time = Math.max(Number.isFinite(timestamp) ? timestamp : 0, Number.isFinite(this.lastTimestamp) ? this.lastTimestamp + 1e-7 : 0);
            this.expiry = { ...expiry }; this.expiryRules.push({ time, expiry: { ...expiry } });
            if (sampleRate !== this.sampleRate) {
                const running = Boolean(this.active); this.stop(); this.sampleRate = sampleRate;
                if (running) this.start(Math.max(time, this.lastTimestamp + 1000 / sampleRate));
            }
            this.version++;
        }
        _affected(next, seeds = []) {
            const previous = new Map(this.definitions.map(definition => [definition.number, definition])), changed = new Set(seeds), outgoing = new Map();
            for (const [number, entry] of next.entries) {
                const old = previous.get(number), definition = entry.definition;
                if (!old || old.type !== definition.type || old.expression !== definition.expression || old.initial !== definition.initial) changed.add(number);
                for (const dependency of entry.dependencies) {
                    if (!outgoing.has(dependency)) outgoing.set(dependency, []);
                    outgoing.get(dependency).push(number);
                }
            }
            for (const number of previous.keys()) if (!next.entries.has(number)) changed.add(number);
            const queue = [...changed];
            for (let index = 0; index < queue.length; index++) for (const number of outgoing.get(queue[index]) ?? [])
                if (!changed.has(number)) { changed.add(number); queue.push(number); }
            return changed;
        }
        _write(columns, channel, position, value) {
            let column = columns.get(channel); if (!column) { column = new Map(); columns.set(channel, column); }
            const key = Math.floor(position / this.chunkSize);
            if (!column.has(key)) column.set(key, new Float64Array(this.chunkSize).fill(NaN));
            column.get(key)[position % this.chunkSize] = value;
        }
        updateDefinitions(definitions, { rebuild = true, reapply = [], all = false, numberMap = null,
            rawChannelCount = this.rawChannelCount, symbolVersion = 2 } = {}) {
            const next = new deps.ChannelOperations(rawChannelCount, definitions, { names: this.names, symbolVersion });
            definitions = next.definitions;
            if (numberMap) {
                next.adoptRenumbered(this.engine, numberMap);
                this.columns = new Map([...this.columns].filter(([channel]) => numberMap.has(channel + 1))
                    .map(([channel, column]) => [numberMap.get(channel + 1) - 1, column]));
                const remappedEvents = new Map();
                for (const [channel, events] of this.events) if (numberMap.has(channel + 1)) remappedEvents.set(numberMap.get(channel + 1) - 1, events);
                this.events = remappedEvents;
                this.pendingAffected = new Set([...this.pendingAffected].filter(number => numberMap.has(number)).map(number => numberMap.get(number)));
                this.definitions = next.definitions; this.engine = next;
                this.provenanceEpochs = new Map([...this.provenanceEpochs].filter(([number]) => numberMap.has(number)).map(([number, epochs]) =>
                    [numberMap.get(number), epochs.map(epoch => ({ ...epoch, plan: epoch.plan.map(reference =>
                        ({ ...reference, number: numberMap.get(reference.number) ?? reference.number })) }))]));
                this.provenancePlans.clear(); this.provenanceLags = new WeakMap();
            }
            const affected = this._affected(next, rebuild ? [...reapply, ...this.pendingAffected] : []);
            if (all) for (const number of next.entries.keys()) affected.add(number);
            const oldPlans = new Map();
            if (this.length) for (const number of affected) if (this.engine.entries.get(number)?.ast) oldPlans.set(number, this._currentProvenancePlan(number));
            next.adoptUnchanged(this.engine, affected);
            for (const [number, history] of next.history) if (history !== this.engine.history.get(number))
                for (let index = Math.max(0, this.length - history.size); index < this.length; index++) history.push(this.getValue(number - 1, index));
            this.rawChannelCount = this.baseChannelCount = rawChannelCount; this.engine = next; this.definitions = next.definitions; this.channelCount = next.channelCount;
            this.provenancePlans.clear(); this.provenanceResults.clear(); this.provenanceLags = new WeakMap();
            for (const [number, plan] of oldPlans) if (next.entries.get(number)?.ast) {
                const epochs = this.provenanceEpochs.get(number) ?? [{ first: -Infinity, plan }];
                const change = { first: this.next, plan: this._currentProvenancePlan(number) };
                if (epochs.at(-1).first === change.first) epochs[epochs.length - 1] = change; else epochs.push(change);
                this.provenanceEpochs.set(number, epochs);
            }
            for (const number of this.provenanceEpochs.keys()) if (!next.entries.has(number)) this.provenanceEpochs.delete(number);
            for (const channel of this.columns.keys()) if (!next.entries.has(channel + 1)) this.columns.delete(channel);
            const generation = ++this.generation; this.replayEngine = null; this.replayColumns = null;
            this.rebuilding = Boolean(rebuild && affected.size && this.length); this.pendingAffected = this.rebuilding ? affected : new Set();
            this.progress = this.rebuilding ? { processedBytes: 0, totalBytes: this.length } : null;
            this.version++; this.values = [this.columns]; this.onChange(); this.onProgress();
            if (!this.rebuilding) return Promise.resolve();
            const cancelled = () => generation !== this.generation;
            return (async () => {
                let worker = new deps.ChannelOperations(rawChannelCount, definitions, { names: this.names, symbolVersion: 2 }), columns = new Map(), cursor = this.head;
                this.replayEngine = worker; this.replayColumns = columns;
                const unchanged = [...worker.entries].filter(([number, entry]) => entry.ast && !affected.has(number)).map(([number]) => number);
                const overrides = new Map(); await this.yieldControl();
                while (!cancelled() && cursor < this.next) {
                    if (cursor < this.head) {
                        cursor = this.head; worker = new deps.ChannelOperations(rawChannelCount, definitions, { names: this.names, symbolVersion: 2 }); columns = new Map();
                        this.replayEngine = worker; this.replayColumns = columns;
                    }
                    const end = Math.min(this.next, cursor + 512), deadline = performance.now() + 8;
                    for (; cursor < end; cursor++) {
                        const index = cursor - this.head, time = this.timestampAt(index);
                        const samples = Array.from({ length: rawChannelCount }, (_, channel) => this._eventValue(channel, time));
                        for (const number of unchanged) overrides.set(number, this.getValue(number - 1, index));
                        const result = worker.push(samples, overrides);
                        for (const number of affected) if (worker.entries.get(number)?.ast) this._write(columns, number - 1, cursor, result[number - 1]);
                        if (performance.now() >= deadline) { cursor++; break; }
                    }
                    this.progress = { processedBytes: Math.min(this.length, worker.sample), totalBytes: this.length }; this.onProgress();
                    if (cursor < this.next) await this.yieldControl();
                }
                if (cancelled()) return;
                worker.adoptUnchanged(this.engine, affected); this.engine = worker;
                for (const number of affected) if (worker.entries.has(number)) {
                    if (columns.has(number - 1)) this.columns.set(number - 1, columns.get(number - 1)); else this.columns.delete(number - 1);
                    this.provenanceEpochs.delete(number);
                }
                this.rebuilding = false; this.progress = null; this.pendingAffected.clear(); this.replayColumns = null; this.replayEngine = null;
                this.version++; this.values = [this.columns]; this.onChange(); this.onProgress();
            })().catch(error => {
                if (!cancelled()) { this.rebuilding = false; this.progress = null; this.replayColumns = null; this.replayEngine = null; this.onProgress(); }
                throw error;
            });
        }
        discardOldest(count) {
            count = Math.min(this.length, Math.max(0, Math.floor(count))); if (!count) return 0;
            this.head += count; this.length -= count;
            while (this.segments.length > 1 && this.segments[1].first <= this.head) this.segments.shift();
            const time = this.timestampAt(0);
            let origins = 0; while (origins < this.origins.length - 1 && this.origins[origins + 1].timestamp <= time) origins++;
            if (origins) this.origins.splice(0, origins);
            for (const events of this.events.values()) {
                let remove = 0; while (remove < events.length - 1 && events[remove + 1].timestamp <= time) remove++;
                if (remove) events.splice(0, remove);
            }
            for (const column of this.columns.values()) for (const key of column.keys())
                if ((key + 1) * this.chunkSize <= this.head) column.delete(key);
            for (const epochs of this.provenanceEpochs.values()) while (epochs.length > 1 && epochs[1].first <= this.head) epochs.shift();
            this.version++; return count;
        }
        resize(capacity) { this.capacity = capacity; if (this.length > capacity) this.discardOldest(this.length - capacity); }
        dispose() { this.clear(); }
    }
    root.SerialPlotter ??= {}; root.SerialPlotter.SynchronizedFrames = SynchronizedFrames;
    if (typeof module !== 'undefined') module.exports = { SynchronizedFrames };
})(globalThis);
