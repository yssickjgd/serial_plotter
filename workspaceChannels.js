/** The workspace catalog maps capture-local channels to a contiguous shared channel space. */
(function(root) {
    const S = typeof module !== 'undefined'
        ? { ...require('./channelOperations'), ...require('./engineFrames'), ...require('./plotMath'), ...require('./sourceTimebase') }
        : root.SerialPlotter;
    const MAX = 65535;
    const sampleMethods = ['hold', 'nearest', 'linear', 'quadratic', 'spline'];
    const sampleTime = event => event.traceTime ?? event.timestamp;
    const sourceIdPattern = /^(?:primary|serial-[1-9]\d*)$/;
    const idFor = entry => entry.sourceId + '/' + entry.channelId;
    const defaultColor = index => ['#ff0000', '#00ff00', '#00ffff', '#ffff00', '#ff00ff', '#ffffff'][index % 6];

    function normalizeWorkspaceChannels(input = {}) {
        if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('全局通道配置无效');
        const { mappings = [], channelDefinitions = [], channelNames = [], channelColors = [], sampleRate = 1000, holdMs = 50, waitMs = 20, methods = {}, timebases = {} } = input;
        if (!Array.isArray(mappings) || !Array.isArray(channelDefinitions) || mappings.length + channelDefinitions.length > MAX ||
            (!mappings.length && channelDefinitions.length) || !Array.isArray(channelNames) || !Array.isArray(channelColors))
            throw new Error('全局通道目录无效或超过 65535 路');
        if (typeof sampleRate !== 'number' || !Number.isFinite(sampleRate) || sampleRate < .001 || sampleRate > 1000000)
            throw new Error('全局同步采样率需在 0.001–1000000 Hz 之间');
        if (!Number.isSafeInteger(holdMs) || holdMs < 0 || holdMs > 86400000)
            throw new Error('样点有效期需为 0–86400000 毫秒的整数');
        if (!Number.isSafeInteger(waitMs) || waitMs < 0 || waitMs > 60000) throw new Error('等待后点需为 0–60000 毫秒的整数');
        if (!methods || typeof methods !== 'object' || Array.isArray(methods) ||
            Object.entries(methods).some(([id, method]) => !sourceIdPattern.test(id) || !sampleMethods.includes(method)))
            throw new Error('同步取值方式无效');
        const seen = new Set();
        const entries = mappings.map(entry => {
            if (!entry || typeof entry.sourceId !== 'string' || !sourceIdPattern.test(entry.sourceId) ||
                typeof entry.channelId !== 'string' || !entry.channelId || entry.channelId.length > 240 ||
                !Number.isInteger(entry.number) || entry.number < 1 || entry.number > MAX ||
                typeof entry.name !== 'string' || !/^#[0-9a-f]{6}$/i.test(entry.color) || seen.has(idFor(entry)))
                throw new Error('全局通道映射无效或重复');
            seen.add(idFor(entry));
            return { sourceId: entry.sourceId, channelId: entry.channelId, number: entry.number, name: entry.name, color: entry.color };
        });
        if (channelNames.some(name => typeof name !== 'string') || channelColors.some(color => !/^#[0-9a-f]{6}$/i.test(color)))
            throw new Error('全局通道名称或颜色无效');
        const names = entries.map((entry, index) => channelNames[index] ?? entry.name);
        const colors = entries.map((entry, index) => channelColors[index] ?? entry.color);
        const rawCount = Math.max(1, entries.length);
        const engine = new S.ChannelOperations(rawCount, channelDefinitions, { names: channelNames.length ? channelNames : names, symbolVersion: 2 });
        for (let i = entries.length; i < engine.channelCount; i++) {
            names[i] = channelNames[i] ?? S.formatChannelId(i);
            colors[i] = channelColors[i] ?? defaultColor(i);
        }
        if (!timebases || typeof timebases !== 'object' || Array.isArray(timebases)) throw new Error('来源时间基准配置无效');
        const clocks = Object.fromEntries(Object.entries(timebases).map(([id, settings]) => {
            if (!sourceIdPattern.test(id)) throw new Error('来源时间基准编号无效');
            return [id, S.normalizeSourceTimebase(settings)];
        }));
        return { mappings: entries, channelDefinitions: engine.definitions, channelNames: names, channelColors: colors, sampleRate, holdMs, waitMs, methods: { ...methods }, timebases: clocks };
    }

    function planWorkspaceChannels(previous, mappings, legacy = []) {
        const newIndices = new Map(mappings.map((entry, index) => [idFor(entry), index + 1]));
        const numberMap = new Map();
        const oldMappings = previous.mappings ?? [];
        for (const [index, entry] of oldMappings.entries()) {
            const target = newIndices.get(idFor(entry));
            if (target) numberMap.set(index + 1, target);
        }
        const derived = [...(previous.channelDefinitions ?? [])].sort((a, b) => a.number - b.number);
        const names = mappings.map((entry, index) => /^CH\d+$/.test(entry.name) ? S.formatChannelId(index) : entry.name);
        const colors = mappings.map(entry => entry.color);
        for (const [index, definition] of derived.entries()) numberMap.set(definition.number, mappings.length + index + 1);
        const remap = (expression, mapping) => {
            const refs = String(expression).match(/\bCH[0-9]+\b/g) ?? [];
            if (refs.some(ref => !mapping.has(Number(ref.slice(2))))) throw new Error('重排将移除仍被公式引用的通道，请先调整公式');
            return S.renumberChannelExpression(expression, mapping);
        };
        const definitions = derived.map(definition => {
            const number = numberMap.get(definition.number), name = previous.channelNames?.[definition.number - 1];
            names[number - 1] = name && !/^CH\d+$/.test(name) ? name : S.formatChannelId(number - 1);
            colors[number - 1] = previous.channelColors?.[definition.number - 1] ?? defaultColor(number - 1);
            return { ...definition, number, expression: definition.type === 'formula' ? remap(definition.expression, numberMap) : definition.expression };
        });
        for (const source of legacy) {
            if (!source.definitions.length) continue;
            const local = new Map();
            for (const [index, entry] of mappings.entries()) if (entry.sourceId === source.id) local.set(entry.number, index + 1);
            if (!local.size) continue;
            for (const [index, definition] of source.definitions.entries()) local.set(definition.number, mappings.length + definitions.length + index + 1);
            for (const definition of source.definitions) {
                const number = local.get(definition.number), name = source.names[definition.number - 1];
                definitions.push({ ...definition, id: source.id + '/' + (definition.id ?? definition.number), number,
                    expression: definition.type === 'formula' ? remap(definition.expression, local) : definition.expression });
                names[number - 1] = name && !/^CH\d+$/.test(name) ? name : S.formatChannelId(number - 1);
                colors[number - 1] = source.colors[definition.number - 1] ?? defaultColor(number - 1);
            }
        }
        const globals = normalizeWorkspaceChannels({ ...previous, mappings, channelDefinitions: definitions, channelNames: names, channelColors: colors });
        return { globals, numberMap };
    }

    class WorkspaceSynchronizedFrames extends S.SynchronizedFrames {
        get retainedByteLength() { return 0; }
        get multipleSources() { return true; }

        get hasPendingTrace() { return !this.length && this.active != null && Number.isFinite(this.earliestTrace); }

        timeBounds(start, end, extend = true) {
            if (this.hasPendingTrace) return { first: this.earliestTrace, last: this.latestTrace };
            const first = start === 0 && !this.head ? Math.min(this.earliestTrace ?? Infinity, this.timestampAt(start)) : this.timestampAt(start), tick = this.timestampAt(end - 1);
            const last = extend && end === this.length ? Math.max(tick, this.origins.at(-1)?.timestamp ?? tick) : tick;
            return { first, last };
        }

        liveTimeBounds(count) {
            const last = this.latestTrace;
            if (!Number.isFinite(last)) return null;
            const earliest = this.head ? this.timestampAt(0) : this.earliestTrace;
            const duration = (Math.max(2, count) - 1) * 1000 / this.sampleRate;
            return { first: Math.max(earliest, last - duration), last };
        }

        indexAtTimeBoundary(time, includeEqual = false) {
            let low = 0, high = this.length;
            while (low < high) {
                const mid = Math.floor((low + high) / 2), timestamp = this.timestampAt(mid);
                if (timestamp < time || includeEqual && timestamp === time) low = mid + 1;
                else high = mid;
            }
            return low;
        }

        orderAt(index) { return index >= 0 && index < this.length ? this.head + index + 1 : NaN; }
        indexAtOrAfterOrder(order) { return Math.min(this.length - 1, Math.max(0, Math.ceil(order - this.head - 1))); }

        originIndex(sourceId) {
            if (this.originIndexes?.version !== this.version) {
                const sources = new Map();
                for (const [index, entry] of this.origins.entries()) {
                    const origin = entry.origin;
                    if (!origin?.sourceId || !Number.isFinite(origin.byteOffset)) continue;
                    let lane = sources.get(origin.sourceId);
                    if (!lane) { lane = { size: 0, checkpoints: [], first: entry }; sources.set(origin.sourceId, lane); }
                    if (lane.size++ % 128 === 0) lane.checkpoints.push(index);
                    lane.last = entry;
                }
                this.originIndexes = { version: this.version, sources };
            }
            return this.originIndexes.sources.get(sourceId);
        }

        locateOrigin(sourceId, value, byByte = false) {
            const lane = this.originIndex(sourceId);
            if (!lane || !Number.isFinite(value)) return null;
            const key = entry => byByte ? entry.origin.byteOffset : (entry.origin.alignedTime ?? entry.timestamp);
            if (value < key(lane.first) || (byByte ? value >= lane.last.origin.endByte : value > key(lane.last))) return null;
            const points = lane.checkpoints;
            let low = 0, high = points.length;
            while (low < high) {
                const mid = (low + high) >>> 1;
                if (key(this.origins[points[mid]]) <= value) low = mid + 1; else high = mid;
            }
            let previous = null;
            for (let i = points[Math.max(0, low - 1)]; i < this.origins.length; i++) {
                const entry = this.origins[i];
                if (entry.origin?.sourceId !== sourceId) continue;
                const current = key(entry);
                if (byByte) {
                    if (current > value) return null;
                    if (value < entry.origin.endByte) return entry;
                } else if (current >= value) {
                    return !previous || current - value < value - key(previous) ? entry : previous;
                }
                previous = entry;
            }
            return null;
        }

        // A late observation can appear on its original curve without revising published grid values.
        _estimate(channel, time, includeLate = false) {
            const list = this.events.get(channel);
            if (!list?.length) return null;
            let low = 0, high = list.length;
            while (!includeLate && low < high) {
                const mid = (low + high) >>> 1;
                if (list[mid].sealedThrough < time) low = mid + 1; else high = mid;
            }
            const available = includeLate ? list.length : low;
            low = 0; high = available;
            while (low < high) {
                const mid = (low + high) >>> 1;
                if (sampleTime(list[mid]) <= time) low = mid + 1; else high = mid;
            }
            const ttl = this.expiry[channel] * 1000;
            const usable = i => {
                if (i < 0 || i >= available) return null;
                const point = list[i], delta = sampleTime(point) - time;
                return Number.isFinite(point.value) && (!ttl || Math.abs(delta) < ttl) ? point : null;
            };
            const left = usable(low - 1), right = usable(low);
            const method = this.sampleMethods?.[channel] ?? 'hold';
            if ((left && sampleTime(left) === time) || method === 'hold') return left;
            if (method === 'nearest') {
                if (right?.origin?.breakBefore && left) return left;
                if (!left || !right) return left ?? right;
                return time - sampleTime(left) < sampleTime(right) - time ? left : right;
            }
            if (!left || !right || right.origin?.breakBefore) return null;
            const h = sampleTime(right) - sampleTime(left), x = (time - sampleTime(left)) / h;
            if (!(h > 0)) return null;
            let value = left.value + x * (right.value - left.value);
            if (method === 'quadratic' || method === 'spline') {
                let before = usable(low - 2), after = usable(low + 1);
                if (left.origin?.breakBefore || before && sampleTime(before) >= sampleTime(left)) before = null;
                if (after?.origin?.breakBefore || after && sampleTime(after) <= sampleTime(right)) after = null;
                if (method === 'quadratic') {
                    const extra = before ?? after;
                    if (!extra) return null;
                    const u = (sampleTime(extra) - sampleTime(left)) / h;
                    value += x * (x - 1) * (extra.value - left.value - u * (right.value - left.value)) / (u * (u - 1));
                } else {
                    if (!before || !after) return null;
                    // Natural cubic through the four adjacent samples, evaluated on its middle interval.
                    const h0 = sampleTime(left) - sampleTime(before), h2 = sampleTime(after) - sampleTime(right);
                    const slope = (right.value - left.value) / h;
                    const r1 = 6 * (slope - (left.value - before.value) / h0);
                    const r2 = 6 * ((after.value - right.value) / h2 - slope);
                    const a = 2 * (h0 + h), b = 2 * (h + h2), det = a * b - h * h;
                    const m1 = (b * r1 - h * r2) / det, m2 = (a * r2 - h * r1) / det;
                    value += h * h / 6 * (((1 - x) ** 3 - (1 - x)) * m1 + (x ** 3 - x) * m2);
                }
            }
            return Number.isFinite(value) ? { value, timestamp: time, origin: x < .5 ? left.origin : right.origin } : null;
        }
        _eventValue(channel, time) { return this._estimate(channel, time)?.value ?? NaN; }
        _event(channel, time) { return this._estimate(channel, time); }

        clear() { super.clear(); this.earliestTrace = Infinity; this.latestTrace = -Infinity; }

        recordValues(time, values, origin, traceTime = time) {
            this.earliestTrace = Math.min(this.earliestTrace, traceTime);
            this.latestTrace = Math.max(this.latestTrace, traceTime);
            super.recordValues(time, values, origin);
            for (const [channel] of values) {
                const event = this.events.get(channel).at(-1);
                event.sealedThrough = this.lastTimestamp;
                event.traceTime = traceTime;
            }
        }

        rawTraceAt(channel, start, end, bounds) {
            if (channel >= this.rawChannelCount) return null;
            const entries = this.events.get(channel) ?? [], { first, last } = bounds ?? this.timeBounds(start, end);
            let low = 0, high = entries.length;
            while (low < high) { const mid = (low + high) >>> 1; if (sampleTime(entries[mid]) < first) low = mid + 1; else high = mid; }
            const times = [], values = [], expiry = this.expiry[channel] * 1000;
            let recoveredIndices;
            const appendRecovered = time => {
                const value = this._estimate(channel, time, true)?.value ?? NaN;
                if (Number.isFinite(value)) (recoveredIndices ??= new Set()).add(values.length);
                times.push(time);
                values.push(value);
            };
            const breaks = (left, right) => right.origin?.breakBefore || expiry > 0 && sampleTime(right) - sampleTime(left) >= expiry;
            const boundary = (left, right, time) => {
                if (!left || !right || time <= sampleTime(left) || time >= sampleTime(right) || breaks(left, right) ||
                    !Number.isFinite(left.value) || !Number.isFinite(right.value)) return false;
                times.push(time);
                values.push(left.value + (right.value - left.value) * (time - sampleTime(left)) / (sampleTime(right) - sampleTime(left)));
                return true;
            };
            const fillMissing = (left, right) => {
                const { missingBefore: count, period } = right?.origin ?? {};
                if (!left || !count) return false;
                const startTime = sampleTime(right) - count * period;
                const from = Math.max(0, Math.ceil((first - startTime) / period));
                const to = Math.min(count - 1, Math.floor((last - startTime) / period));
                // Large outages need only a bounded number of display points.
                const stride = Math.max(1, Math.ceil((to - from + 1) / 256));
                for (let slot = from; slot <= to; slot += stride) appendRecovered(startTime + slot * period);
                if (to > from && (to - from) % stride) appendRecovered(startTime + to * period);
                return true;
            };
            const syntheticStart = !entries[low]?.origin?.missingBefore && boundary(entries[low - 1], entries[low], first);
            let i = low;
            for (; i < entries.length && sampleTime(entries[i]) <= last; i++) {
                const entry = entries[i];
                if (!fillMissing(entries[i - 1], entry) && times.length && breaks(entries[i - 1], entry)) {
                    times.push(sampleTime(entry)); values.push(NaN);
                }
                times.push(sampleTime(entry)); values.push(entry.value);
            }
            const syntheticEnd = last !== first && !fillMissing(entries[i - 1], entries[i]) &&
                boundary(entries[i - 1], entries[i], last);
            return { times, values, recoveredIndices, syntheticStart, syntheticEnd };
        }
    }

    class WorkspaceChannelCapture {
        constructor(settings, capacity, options = {}) {
            this.onChange = options.onChange ?? (() => {});
            this.resolveFrame = options.resolveFrame ?? (() => null);
            this.memoryLimit = options.memoryLimit ?? (() => Infinity);
            this.capacity = capacity; this.epoch = 0; this.paused = false; this.pauses = []; this.disposed = false;
            this.numericSource = { id: 'workspace-channels', kind: 'numeric', sampleRate: {}, generation: 0 };
            this.numericSource.ready = Promise.resolve(this.numericSource);
            this.dataEngine = { mode: 'Data_Array', choices: () => [], globals: {}, config: { mappings: [] } };
            this.configure(settings);
        }

        get settings() {
            const { channelDefinitions, channelNames, channelColors } = this.dataEngine.globals;
            return { mappings: this.mappings, sampleRate: this.sampleRate, holdMs: this.holdMs, waitMs: this.waitMs, methods: this.methods,
                channelDefinitions, channelNames, channelColors, timebases: this.timebases };
        }
        get alignmentLabel() {
            const labels = new Set(this.mappings.map(({ sourceId }) => {
                const settings = this.appliedTimebases[sourceId];
                if (settings?.mode === 'fixed') return settings.sequenceChannelId ? '固定率 · 设备帧序号' : '固定率估算';
                if (settings?.mode === 'device') return settings.deviceClock === 'shared' ? '共用设备时钟' : '设备时间 · 首帧锚定';
                return '近似对齐';
            }));
            return '全局通道 · ' + (labels.size > 1 ? '混合时基' : labels.values().next().value ?? '近似对齐');
        }
        acquireSource() { return this.numericSource; }
        releaseSource() {}
        configure(input, beforeCommit = () => {}) {
            const config = normalizeWorkspaceChannels(input);
            const { mappings, sampleRate, holdMs, channelDefinitions, channelNames, channelColors, timebases } = config;
            const count = Math.max(1, mappings.length), expiry = {};
            for (let i = 0; i < count; i++) expiry[i] = holdMs / 1000;
            const frames = new WorkspaceSynchronizedFrames(count, this.capacity, { sampleRate, expiry, definitions: channelDefinitions,
                names: channelNames, symbolVersion: 2, resolveFrame: this.resolveFrame, onChange: () => this.onChange() });
            frames.retainedPredecessors = 2;
            frames.useFormulaInputsOnly = true;
            frames.sampleMethods = mappings.map(entry => config.methods[entry.sourceId] ?? 'hold');
            if (frames.estimatedMemoryBytes > this.memoryLimit()) throw new Error('全局通道状态超过内存预算');
            beforeCommit();
            this.numericSource.frames?.dispose();
            Object.assign(this, { mappings, sampleRate, holdMs, waitMs: config.waitMs, methods: config.methods, timebases, appliedTimebases: { ...timebases } });
            const records = mappings.map((entry, index) => ({ number: index + 1, id: idFor(entry), name: channelNames[index] }));
            Object.assign(this.dataEngine.globals, { channelsCount: String(count), channelNames, channelColors, channelDefinitions,
                channelRecords: records, rebuildHistory: true, symbolVersion: 2 });
            Object.assign(this.numericSource, { frames, sampleRate: { rate: sampleRate } });
            this.numericSource.generation++; this.epoch++;
            this.cursors = new Map();
            this.clockAnchors = new Map();
            this.sharedAnchor = {};
            this.latestReceipt = -Infinity; this.pendingGrid = false;
            this.lastEventTime = -Infinity;
            this.onChange();
        }

        setPaused(paused, now) {
            if (this.paused === paused) return;
            this.paused = paused;
            if (paused) this.pauseStarted = now;
            else {
                const duration = Math.max(0, now - this.pauseStarted);
                if (duration) this.pauses.push({ start: this.pauseStarted, end: now,
                    total: (this.pauses.at(-1)?.total ?? 0) + duration });
                this.pauseStarted = null;
            }
        }

        pauseSection(timestamp) {
            let lo = 0, hi = this.pauses.length;
            while (lo < hi) {
                const mid = (lo + hi) >>> 1;
                if (this.pauses[mid].end <= timestamp) lo = mid + 1; else hi = mid;
            }
            return lo;
        }

        plotTime(timestamp, section = this.pauseSection(timestamp)) {
            return timestamp - (this.pauses[section - 1]?.total ?? 0);
        }

        receiveTime(time) {
            let lo = 0, hi = this.pauses.length;
            while (lo < hi) {
                const mid = (lo + hi) >>> 1, { end, total } = this.pauses[mid];
                if (end - total <= time) lo = mid + 1; else hi = mid;
            }
            return time + (this.pauses[lo - 1]?.total ?? 0);
        }

        createAlignmentReplay(settings = this.settings) {
            const replay = new WorkspaceChannelCapture(settings, this.capacity, {
                resolveFrame: this.resolveFrame, memoryLimit: this.memoryLimit
            });
            replay.pauses = this.pauses;
            for (const [id, state] of this.clockAnchors) {
                if (JSON.stringify(this.timebases[id]) === state.policy)
                    replay.clockAnchors.set(id, { policy: state.policy, anchors: S.cloneSourceTimebaseAnchors(state.anchors) });
            }
            if (replay.clockAnchors.has(this.sharedAnchor.sourceId)) replay.sharedAnchor = { ...this.sharedAnchor };
            return replay;
        }

        finishAlignmentReplay(replay) {
            const previous = this.numericSource.frames;
            const updated = replay.numericSource.frames;
            updated.onChange = () => this.onChange();
            Object.assign(this.numericSource, { frames: updated, generation: this.numericSource.generation + 1 });
            Object.assign(this, { cursors: replay.cursors, clockAnchors: replay.clockAnchors, sharedAnchor: replay.sharedAnchor,
                latestReceipt: replay.latestReceipt, pendingGrid: replay.pendingGrid, lastEventTime: replay.lastEventTime,
                appliedTimebases: { ...replay.timebases } });
            this.epoch++;
            this.numericSource.sampleRate.rate = replay.sampleRate;
            previous.dispose();
            this.onChange();
        }

        clear() {
            this.numericSource.frames.clear();
            this.numericSource.generation++; this.epoch++;
            this.cursors.clear();
            this.clockAnchors.clear(); this.sharedAnchor = {};
            this.latestReceipt = this.lastEventTime = -Infinity; this.pendingGrid = false;
            this.onChange();
        }
        resize(capacity) { this.capacity = capacity; this.numericSource.frames.resize(capacity); this.trim(); }
        trim() {
            const frames = this.numericSource.frames, budget = this.memoryLimit();
            while (frames.length > 1 && frames.estimatedMemoryBytes > budget)
                frames.discardOldest(Math.min(frames.length - 1, Math.max(1, Math.ceil(frames.length / 4))));
            if (frames.estimatedMemoryBytes > budget) {
                // A read batch can contain many real samples with the same timestamp.
                const eventLimit = Math.max(1, Math.floor(budget / Math.max(1, frames.events.size) / 256));
                for (const events of frames.events.values()) if (events.length > eventLimit) events.splice(0, events.length - eventLimit);
                const limit = Math.max(1, Math.floor(budget / 512));
                if (frames.origins.length > limit) frames.origins.splice(0, frames.origins.length - limit);
            }
        }
        updateChannelDefinitions(definitions, options) {
            const frames = this.numericSource.frames;
            const engine = new S.ChannelOperations(frames.rawChannelCount, definitions, { names: this.dataEngine.globals.channelNames, symbolVersion: 2 });
            if (engine.requiredMemoryBytes * 2 + frames.estimateAppendMemory() > this.memoryLimit())
                throw new Error('全局运算通道状态超过内存预算');
            frames.names = this.dataEngine.globals.channelNames;
            return frames.updateDefinitions(definitions, options);
        }

        ingest(events, finish = true, until = Infinity) {
            if (!events.length) {
                const added = finish ? this.advanceGrid(Math.min(until, this.lastEventTime)) : 0;
                if (added) { this.trim(); this.onChange(); }
                return added;
            }
            const frames = this.numericSource.frames, capacity = frames.capacity, version = frames.version;
            let added;
            // Evict in batches so each source event does not shift a large retained array.
            frames.capacity += Math.min(1024, events.length);
            try {
                for (const { time, values, origin } of events) {
                    if (!Number.isFinite(time)) continue;
                    const normalized = Math.max(time, this.lastEventTime);
                    if (normalized - this.lastEventTime > capacity * 1000 / this.sampleRate && frames.active) {
                        frames.advance(this.lastEventTime);
                        frames.stop();
                    }
                    frames.start(normalized);
                    frames.recordValues(normalized, values, origin, time);
                    this.lastEventTime = normalized;
                }
                added = Number.isFinite(this.lastEventTime) ? this.advanceGrid(Math.min(until, this.lastEventTime), finish) : 0;
            } finally {
                frames.capacity = capacity;
                if (frames.length > capacity) frames.discardOldest(frames.length - capacity);
            }
            if (frames.version === version) frames.version++;
            this.trim(); this.onChange();
            return added;
        }

        advanceGrid(target, inclusive = true) {
            const frames = this.numericSource.frames;
            if (!frames.active || !Number.isFinite(target)) return 0;
            const limit = 2048;
            const next = frames.active.time + frames.active.count * frames.active.step;
            const end = frames.definitions.some(d => d.type === 'formula') ? Math.min(target, next + limit * frames.active.step) : target;
            const added = frames.advance(end, end < target || inclusive, 6);
            const nextTick = frames.active.time + frames.active.count * frames.active.step;
            this.pendingGrid = inclusive ? nextTick <= target : nextTick < target;
            return added;
        }

        createCursor(settings, source, epoch) {
            const timing = this.timebases[settings.id] ?? S.normalizeSourceTimebase();
            const policy = JSON.stringify(timing);
            let state = this.clockAnchors.get(settings.id);
            if (!state || state.policy !== policy) {
                state = { policy, anchors: new Map() };
                this.clockAnchors.set(settings.id, state);
            }
            const clock = new S.SourceTimebase(timing, { offsetMs: settings.timeOffsetMs ?? 0, sharedAnchor: this.sharedAnchor,
                anchors: state.anchors, estimateLoss: true });
            return { source, generation: source.generation, epoch, readFrame: null, pending: [], clock, timing };
        }

        collect(connections, cutoff = Infinity, limit = 1024) {
            const inputs = new Map();
            for (const [index, entry] of this.mappings.entries()) {
                const columns = inputs.get(entry.sourceId) ?? [];
                columns.push([index, entry.number - 1]); inputs.set(entry.sourceId, columns);
            }
            const lanes = [];
            for (const { settings, capture } of connections) {
                const columns = inputs.get(settings.id), engine = capture.dataEngine;
                if (!columns || engine.mode === 'Raw_Data') continue;
                const protocol = engine.mode === 'Self_Defined_Frame';
                const source = protocol ? engine.recordsSource : engine.arraySource;
                if (!source || source.rebuilding) continue;
                const frames = source.frames;
                const previous = this.cursors.get(settings.id);
                if (previous && (source !== previous.source || source.generation !== previous.generation || capture.epoch !== previous.epoch)) {
                    this.clear();
                    return this.collect(connections, cutoff, limit);
                }
                const cursor = previous ?? this.createCursor(settings, source, capture.epoch);
                this.cursors.set(settings.id, cursor);
                const { timing } = cursor;
                if (timing.mode !== 'receive' && frames.length) {
                    const firstOrder = frames.orderAt(0);
                    if (cursor.prunedOrder !== firstOrder) {
                        cursor.prunedOrder = firstOrder;
                        const stream = capture.history?.streamStartAt?.(frames.rawByteOffsetAt(0)) ?? 0;
                        const prefix = cursor.epoch + ':' + cursor.generation + ':';
                        cursor.clock.pruneBefore(prefix + stream, firstOrder);
                        const { anchors } = this.clockAnchors.get(settings.id);
                        for (const key of anchors.keys()) {
                            if (!key.startsWith(prefix) || Number(key.slice(prefix.length)) < stream) anchors.delete(key);
                        }
                    }
                }
                const markerId = timing.mode === 'fixed' ? timing.sequenceChannelId : timing.mode === 'device' ? timing.timestampChannelId : null;
                const channel = markerId ? engine.globals.channelRecords?.find(entry => entry.type === 'raw' && entry.id === markerId) : null;
                const index = cursor.readFrame === null ? Math.max(0, frames.length - this.capacity)
                    : Math.max(0, cursor.readFrame + 1 - frames.frameOrdinalAt(0));
                lanes.push({ cursor, columns, frames, protocol, engine, capture, index, markerIndex: channel ? channel.number - 1 : -1, id: settings.id });
            }
            const events = [];
            limit = Math.min(limit, Math.max(1, Math.floor(131072 / Math.max(1, this.mappings.length))));
            let work = limit + lanes.length, scanLimited = false, futureReceipt = Infinity;
            const peek = lane => {
                const { cursor, frames } = lane;
                while (!cursor.pending.length && lane.index < frames.length) {
                    if (work-- <= 0) { scanLimited = true; break; }
                    const index = lane.index, timestamp = frames.timestampAt(index);
                    if (timestamp > cutoff) { futureReceipt = Math.min(futureReceipt, timestamp); break; }
                    const order = frames.orderAt(index);
                    lane.index++;
                    const byteOffset = frames.rawByteOffsetAt(index);
                    const frameIndex = frames.frameOrdinalAt(index);
                    cursor.readFrame = frameIndex;
                    let projected, marker;
                    if (lane.protocol) {
                        const record = lane.engine.decode(index)?.record;
                        if (!record || record.valid === false || record.known === false) continue;
                        projected = lane.engine.projectRecord(record, lane.markerIndex);
                        marker = projected.marker;
                    } else if (lane.markerIndex >= 0) marker = frames.getTimingValue(lane.markerIndex, index);
                    const stream = lane.capture.history?.streamStartAt?.(byteOffset) ?? 0;
                    const streamKey = cursor.epoch + ':' + cursor.generation + ':' + stream;
                    const section = this.pauseSection(timestamp);
                    const joinPause = cursor.pauseSection !== undefined && cursor.pauseSection !== section;
                    cursor.pauseSection = section;
                    if (cursor.timing.mode === 'fixed' && !cursor.timing.sequenceChannelId && cursor.batchStamp !== timestamp) {
                        cursor.batchStamp = timestamp;
                        let lo = index + 1, hi = frames.length;
                        while (lo < hi) {
                            const mid = (lo + hi) >>> 1;
                            if (frames.timestampAt(mid) === timestamp) lo = mid + 1; else hi = mid;
                        }
                        cursor.batchTail = frames.frameOrdinalAt(lo - 1);
                    }
                    const sample = cursor.clock.sample({ receiveTime: this.plotTime(timestamp, section),
                        order, frameIndex, batchTail: cursor.batchTail, marker, streamKey, joinPause });
                    cursor.invalidLatest = !sample;
                    if (!sample) continue;
                    if (sample.missingBefore) cursor.lastResync = sample.missingBefore;
                    const time = cursor.timing.mode === 'receive' ? Math.max(sample.time, cursor.lastTime ?? -Infinity) : sample.time;
                    cursor.lastTime = time;
                    if (cursor.timing.mode === 'device' && cursor.timing.deviceClock === 'shared') this.sharedAnchor.sourceId ??= lane.id;
                    const values = [];
                    for (const [target, local] of lane.columns) {
                        if (!projected || projected.values.has(local))
                            values.push([target, projected ? projected.values.get(local) : frames.getValue(local, index)]);
                    }
                    if (!values.length) continue;
                    if (Number.isFinite(sample.gapStart) && sample.gapStart < sample.time) {
                        cursor.pending.push({ time: sample.gapStart, receivedAt: timestamp, values: lane.columns.map(([target]) => [target, NaN]),
                            origin: null });
                    }
                    cursor.pending.push({ time, receivedAt: timestamp, values, origin: {
                        sourceId: lane.id, epoch: cursor.epoch, generation: cursor.generation, order, timestamp,
                        alignedTime: time, missingBefore: sample.missingBefore, period: sample.period, breakBefore: sample.breakBefore || time !== sample.time, byteOffset,
                        endByte: frames.frameAt(index, { copyBytes: false })?.endByte
                    } });
                }
                return cursor.pending[0];
            };
            let nextTime = Infinity, due = Infinity;
            for (let read = 0; read <= limit; read++) {
                let lane = null;
                nextTime = Infinity;
                for (const candidate of lanes) {
                    const pending = peek(candidate);
                    if (pending && pending.time < nextTime) { nextTime = pending.time; lane = candidate; }
                }
                due = lane ? lane.cursor.pending[0].receivedAt : Infinity;
                if (scanLimited || !lane || due > cutoff || read === limit) break;
                events.push(lane.cursor.pending.shift());
            }
            const newest = events.at(-1);
            if (newest) this.latestReceipt = Math.max(this.latestReceipt ?? -Infinity, ...events.map(event => event.receivedAt));
            const latestTime = Math.max(this.lastEventTime, newest?.time ?? -Infinity);
            const more = scanLimited || Number.isFinite(nextTime) && due <= cutoff;
            const remaining = more ? this.waitMs : Math.min(this.waitMs, Math.max(0, (this.latestReceipt ?? cutoff) + this.waitMs - cutoff));
            this.ingest(events, !more || nextTime > latestTime, latestTime - remaining);
            if (scanLimited || this.pendingGrid) return -Number.MAX_VALUE;
            due = Math.min(due, futureReceipt);
            return remaining > 0 && !more ? Math.min(due, this.latestReceipt + this.waitMs) : due;
        }

        dispose() { this.disposed = true; this.clear(); }
    }

    const api = { normalizeWorkspaceChannels, planWorkspaceChannels, WorkspaceChannelCapture };
    root.SerialPlotter ??= {}; Object.assign(root.SerialPlotter, api);
    if (typeof module !== 'undefined') module.exports = api;
})(globalThis);
