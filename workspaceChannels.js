/** The workspace catalog maps capture-local channels to a contiguous shared channel space. */
(function(root) {
    const S = typeof module !== 'undefined'
        ? { ...require('./channelOperations'), ...require('./engineFrames'), ...require('./plotMath'), ...require('./sourceTimebase'),
            Limits: require('./projectLimits').PROJECT_LIMITS }
        : root.SerialPlotter;
    const MAX = 65535;
    const sampleMethods = ['hold', 'nearest', 'linear', 'quadratic', 'spline'];
    const sampleTime = event => event.traceTime ?? event.timestamp;
    function alignmentInput(capture) {
        const engine = capture.dataEngine;
        if (engine.mode === 'Raw_Data') return null;
        const source = engine.mode === 'Self_Defined_Frame' ? engine.recordsSource : engine.arraySource;
        return source?.rebuilding ? null : source;
    }
    // Bulk reads start with binary searches and carry both cursors through
    // adjacent grid rows. A dense batch can still be skipped by binary search.
    function eventBoundary(events, time, high, aligned, previous) {
        let low = previous ?? 0;
        if (previous !== undefined) {
            const end = Math.min(high, low + 16);
            while (low < end) {
                const event = events[low];
                if (!(aligned ? sampleTime(event) <= time : event.sealedThrough < time)) return low;
                low++;
            }
        }
        while (low < high) {
            const mid = (low + high) >>> 1, event = events[mid];
            if (aligned ? sampleTime(event) <= time : event.sealedThrough < time) low = mid + 1;
            else high = mid;
        }
        return low;
    }

    // The four-point natural spline can cover an edge interval when both extra
    // samples are on the same side of the bracket.
    function cubicCorrection(points, interval, x) {
        const [p0, p1, p2, p3] = points;
        const h0 = sampleTime(p1) - sampleTime(p0), h1 = sampleTime(p2) - sampleTime(p1), h2 = sampleTime(p3) - sampleTime(p2);
        const slope = (p2.value - p1.value) / h1;
        const r1 = 6 * (slope - (p1.value - p0.value) / h0), r2 = 6 * ((p3.value - p2.value) / h2 - slope);
        const a = 2 * (h0 + h1), b = 2 * (h1 + h2), det = a * b - h1 * h1;
        const second = [0, (b * r1 - h1 * r2) / det, (a * r2 - h1 * r1) / det, 0];
        const span = [h0, h1, h2][interval], left = 1 - x;
        return span * span / 6 * ((left ** 3 - left) * second[interval] + (x ** 3 - x) * second[interval + 1]);
    }

    const sourceIdPattern = /^(?:primary|serial-[1-9]\d*)$/;
    const idFor = entry => entry.sourceId + '/' + entry.channelId;
    const palette = S.Limits.defaultChannelColors;
    const defaultColor = index => palette[index % palette.length];

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
        _estimate(channel, time, includeLate = false, cursor, deadline = Infinity) {
            const list = this.events.get(channel);
            if (!list?.length) return null;
            const available = includeLate || list.at(-1).sealedThrough < time ? list.length
                : eventBoundary(list, time, list.length, false, cursor?.available);
            const low = eventBoundary(list, time, available, true, cursor?.index);
            if (cursor) { cursor.available = available; cursor.index = low; }
            const ttl = this.expiry[channel] * 1000;
            const usable = i => {
                if (i < 0 || i >= available) return null;
                const point = list[i], delta = sampleTime(point) - time;
                if (deadline !== Infinity && point.sealedThrough >= time && !(point.origin?.captureTime <= deadline)) return null;
                return Number.isFinite(point.value) && (!ttl || Math.abs(delta) < ttl) ? point : null;
            };
            const left = usable(low - 1), precedingTime = left ? sampleTime(left) : NaN;
            const method = this.sampleMethods?.[channel] ?? 'hold';
            if (method === 'hold' || precedingTime === time) return left;
            const right = usable(low);
            if (method === 'nearest') {
                if (right?.origin?.breakBefore) return left;
                if (!left || !right) return left ?? right;
                return time - sampleTime(left) < sampleTime(right) - time ? left : right;
            }
            if (!left || !right || right.origin?.breakBefore) return null;
            const leftTime = sampleTime(left), h = sampleTime(right) - leftTime, x = (time - leftTime) / h;
            if (!(h > 0)) return null;
            const estimate = value => ({ value, timestamp: time, origin: x < .5 ? left.origin : right.origin });
            const linear = (1 - x) * left.value + x * right.value;
            if (method === 'quadratic' || method === 'spline') {
                const neighbor = (index, step) => {
                    const stamp = sampleTime(list[index]);
                    for (let next = index + step; ; next += step) {
                        const point = usable(next);
                        if (!point || list[step < 0 ? next + 1 : next].origin?.breakBefore) return null;
                        if (sampleTime(point) !== stamp) return { point, index: next };
                    }
                };
                const before = neighbor(low - 1, -1), after = neighbor(low, 1);
                if (method === 'spline') {
                    let cubic = NaN;
                    if (before && after) cubic = cubicCorrection([before.point, left, right, after.point], 1, x);
                    else if (before) {
                        const earlier = neighbor(before.index, -1);
                        if (earlier) cubic = cubicCorrection([earlier.point, before.point, left, right], 2, x);
                    } else if (after) {
                        const later = neighbor(after.index, 1);
                        if (later) cubic = cubicCorrection([left, right, after.point, later.point], 0, x);
                    }
                    if (Number.isFinite(linear + cubic)) return estimate(linear + cubic);
                }
                const extra = (before ?? after)?.point;
                if (extra) {
                    const u = (sampleTime(extra) - leftTime) / h;
                    const quadratic = linear + x * (x - 1) * (extra.value - left.value - u * (right.value - left.value)) / (u * (u - 1));
                    if (Number.isFinite(quadratic)) return estimate(quadratic);
                }
            }
            return Number.isFinite(linear) ? estimate(linear) : null;
        }
        _eventValue(channel, time) { return this._estimate(channel, time)?.value ?? NaN; }
        _event(channel, time, readHistory = false) {
            return readHistory ? this._historyEvent(channel, time) : this._estimate(channel, time);
        }

        _historyEvent(channel, time, cursor) {
            const committed = this._estimate(channel, time, false, cursor);
            if (committed || !(this.events.get(channel)?.at(-1)?.sealedThrough >= time)) return committed;
            // An RX batch can be timestamped on time but reach the page late.
            // Repair missing historical raw samples while retaining committed formula inputs.
            return this._estimate(channel, time, true, undefined, time + this.waitMs);
        }

        getValue(channel, index) {
            if (channel < 0 || channel >= this.rawChannelCount) return super.getValue(channel, index);
            const time = this.timestampAt(index);
            return Number.isFinite(time) ? this._historyEvent(channel, time)?.value ?? NaN : NaN;
        }

        copyChannel(channel, start = 0, end = this.length) {
            if (channel < 0 || channel >= this.rawChannelCount) return super.copyChannel(channel, start, end);
            const first = Math.max(0, start), last = Math.min(this.length, end);
            const values = new Float64Array(Math.max(0, last - first)), cursor = {};
            for (let offset = 0; offset < values.length; offset++)
                values[offset] = this._historyEvent(channel, this.timestampAt(first + offset), cursor)?.value ?? NaN;
            return values;
        }

        clear() {
            super.clear();
            this.earliestTrace = Infinity; this.latestTrace = -Infinity;
            this.rawTraceSnapshots = null;
        }

        recordValues(time, values, origin, traceTime = time) {
            this.earliestTrace = Math.min(this.earliestTrace, traceTime);
            this.latestTrace = Math.max(this.latestTrace, traceTime);
            // An invalid observation carries no value. Only stream boundaries
            // should prevent interpolation between the surrounding valid samples.
            const invalid = origin && !origin.breakBefore && values.some(([, value]) => !Number.isFinite(value));
            const samples = invalid ? values.filter(([, value]) => Number.isFinite(value)) : values;
            super.recordValues(time, samples, origin, traceTime);
            for (const [channel] of samples) {
                const event = this.events.get(channel).at(-1);
                event.sealedThrough = this.lastTimestamp;
            }
        }

        rawTraceAt(channel, start, end, bounds) {
            if (channel >= this.rawChannelCount) return null;
            const { first, last } = bounds ?? this.timeBounds(start, end);
            if (this.rawTraceSnapshots?.version !== this.version)
                this.rawTraceSnapshots = { version: this.version, traces: new Map() };
            const { traces } = this.rawTraceSnapshots;
            const key = [channel, first, last, this.sampleMethods?.[channel], this.expiry[channel]].join(':');
            if (traces.has(key)) return traces.get(key);
            const trace = this._readRawTrace(channel, first, last);
            // The views also hold these snapshots, so share a bounded number of them.
            if (trace.times.length <= 131072) {
                if (traces.size === 8) traces.delete(traces.keys().next().value);
                traces.set(key, trace);
            }
            return trace;
        }

        _readRawTrace(channel, first, last) {
            const entries = this.events.get(channel) ?? [];
            let low = 0, high = entries.length;
            while (low < high) { const mid = (low + high) >>> 1; if (sampleTime(entries[mid]) < first) low = mid + 1; else high = mid; }
            const start = low, end = eventBoundary(entries, last, entries.length, true, start);
            const times = new Array(end - start), values = new Array(end - start), expiry = this.expiry[channel] * 1000;
            let recoveredIndices, syntheticStart = false, length = 0;
            const append = (time, value) => {
                times[length] = time; values[length++] = value;
            };
            const appendRecovered = time => {
                const value = this._estimate(channel, time, true)?.value ?? NaN;
                if (Number.isFinite(value)) (recoveredIndices ??= new Set()).add(length);
                append(time, value);
            };
            const breaks = (left, right) => right.origin?.breakBefore || expiry > 0 && sampleTime(right) - sampleTime(left) >= expiry;
            const boundary = (left, right, time) => {
                if (!left || !right || time <= sampleTime(left) || time >= sampleTime(right) ||
                    right.origin?.breakBefore || !Number.isFinite(left.value) || !Number.isFinite(right.value)) return false;
                let value;
                if (right.origin?.missingBefore) value = this._estimate(channel, time, true)?.value;
                else if (!breaks(left, right)) value = left.value + (right.value - left.value) *
                    (time - sampleTime(left)) / (sampleTime(right) - sampleTime(left));
                if (!Number.isFinite(value)) return false;
                append(time, value);
                return true;
            };
            const fillMissing = (left, right) => {
                const { missingBefore: count, period } = right?.origin ?? {};
                if (!left || !Number.isSafeInteger(count) || count <= 0 || !(period > 0) || right.origin?.breakBefore) return false;
                const leftTime = sampleTime(left), rightTime = sampleTime(right), startTime = rightTime - count * period;
                const timeAt = slot => startTime + slot * period;
                // Compare the timestamps we will plot to avoid dropping a slot on
                // a viewport edge when a fractional period is rounded.
                const lowerBound = accepts => {
                    let low = 0, high = count;
                    while (low < high) {
                        const mid = Math.floor((low + high) / 2);
                        if (accepts(timeAt(mid))) high = mid; else low = mid + 1;
                    }
                    return low;
                };
                const from = lowerBound(time => time >= first && time > leftTime);
                const end = lowerBound(time => time > last || time >= rightTime);
                if (!length && (from >= end || timeAt(from) !== first)) syntheticStart = boundary(left, right, first);
                // Large outages need only a bounded number of display points.
                const stride = Math.max(1, Math.ceil((end - from) / 256));
                for (let slot = from; slot < end; slot += stride) appendRecovered(timeAt(slot));
                if (end > from + 1 && (end - 1 - from) % stride) appendRecovered(timeAt(end - 1));
                return true;
            };
            if (!entries[start]?.origin?.missingBefore) syntheticStart = boundary(entries[start - 1], entries[start], first);
            let previousTime = start ? sampleTime(entries[start - 1]) : NaN;
            for (let i = start; i < end; i++) {
                const entry = entries[i], time = sampleTime(entry), origin = entry.origin;
                const repaired = origin?.missingBefore && fillMissing(entries[i - 1], entry);
                if (!repaired && length && (origin?.breakBefore || expiry > 0 && time - previousTime >= expiry)) append(time, NaN);
                append(time, entry.value);
                previousTime = time;
            }
            fillMissing(entries[end - 1], entries[end]);
            const syntheticEnd = last !== first && times[length - 1] !== last && boundary(entries[end - 1], entries[end], last);
            times.length = values.length = length;
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
            frames.retainedPredecessors = 3;
            frames.waitMs = config.waitMs;
            frames.channelSourceIds = mappings.map(entry => entry.sourceId);
            frames.channelPacketGroups = [];
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

        pauseSection(timestamp, pauses = this.pauses) {
            let lo = 0, hi = pauses.length;
            while (lo < hi) {
                const mid = (lo + hi) >>> 1;
                if (pauses[mid].end <= timestamp) lo = mid + 1; else hi = mid;
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

        changeTimebaseForFuture({ settings, capture }, previousTiming, previousOffset) {
            const id = settings.id, timing = this.timebases[id];
            this.appliedTimebases[id] = timing;
            const engine = capture.dataEngine;
            if (engine.mode === 'Raw_Data' || !this.mappings.some(entry => entry.sourceId === id)) return;
            const source = engine.mode === 'Self_Defined_Frame' ? engine.recordsSource : engine.arraySource;
            if (!source || source.rebuilding) return;
            const frames = source.frames;
            const last = frames.frameOrdinalAt(frames.length - 1);
            const existing = this.cursors.get(id);
            if (!existing && !Number.isFinite(last)) return;
            const cursor = existing ?? this.createCursor(id, source, capture.epoch, previousTiming, previousOffset);
            this.cursors.set(id, cursor);
            const from = Number.isFinite(last) ? last + 1 : (cursor.readFrame ?? -1) + 1;
            const change = { from, timing, offset: settings.timeOffsetMs ?? 0 };
            if (cursor.timebaseChanges.at(-1)?.from === from) cursor.timebaseChanges.pop();
            cursor.timebaseChanges.push(change);
            cursor.timebaseChanged = true;
        }

        setCursorClock(id, cursor, timing, offset) {
            const policy = JSON.stringify(timing);
            let state = this.clockAnchors.get(id);
            if (!state || state.policy !== policy) {
                state = { policy, anchors: new Map() };
                this.clockAnchors.set(id, state);
            }
            cursor.clock = new S.SourceTimebase(timing, { offsetMs: offset, sharedAnchor: this.sharedAnchor,
                anchors: state.anchors, estimateLoss: true });
            if (Number.isFinite(cursor.lastTime)) cursor.clock.lastTime = cursor.lastTime - offset;
            Object.assign(cursor, { timing, batchStamp: null, prunedOrder: null });
        }

        createCursor(id, source, epoch, timing = S.normalizeSourceTimebase(this.timebases[id]), offset = 0) {
            const cursor = { source, generation: source.generation, epoch, readFrame: null, pending: [], timebaseChanges: [] };
            this.setCursorClock(id, cursor, timing, offset);
            return cursor;
        }

        markerIndex(timing, engine) {
            const id = timing.mode === 'fixed' ? timing.sequenceChannelId : timing.mode === 'device' ? timing.timestampChannelId : null;
            const channel = id && engine.globals.channelRecords?.find(entry => entry.type === 'raw' && entry.id === id);
            return channel ? channel.number - 1 : -1;
        }

        alignmentTargets(connections) {
            const mapped = new Set(this.mappings.map(entry => entry.sourceId));
            const targets = new Map();
            for (const { settings: { id }, capture } of connections) {
                if (!mapped.has(id)) continue;
                const source = alignmentInput(capture), frames = source?.frames;
                if (!frames?.length) continue;
                const first = frames.frameOrdinalAt(0), last = frames.frameOrdinalAt(frames.length - 1);
                const cursor = this.cursors.get(id);
                const valid = cursor?.source === source && cursor.generation === source.generation && cursor.epoch === capture.epoch;
                const read = valid ? cursor.readFrame : null;
                const start = Math.max(first, read === null ? last + 1 - this.capacity : read + 1);
                targets.set(id, { source, generation: source.generation, epoch: capture.epoch, start, last });
            }
            return targets;
        }

        collect(connections, cutoff = Infinity, limit = 1024, boundaries = null) {
            const inputs = new Map();
            for (const [index, entry] of this.mappings.entries()) {
                const columns = inputs.get(entry.sourceId) ?? [];
                columns.push([index, entry.number - 1]); inputs.set(entry.sourceId, columns);
            }
            const lanes = [];
            for (const { settings, capture } of connections) {
                const columns = inputs.get(settings.id), engine = capture.dataEngine;
                if (!columns) continue;
                const protocol = engine.mode === 'Self_Defined_Frame', source = alignmentInput(capture);
                if (!source) continue;
                const boundary = boundaries?.get(settings.id);
                if (boundaries && (boundary?.source !== source || boundary.generation !== source.generation ||
                    boundary.epoch !== capture.epoch)) continue;
                const frames = source.frames;
                const previous = this.cursors.get(settings.id);
                if (previous && (source !== previous.source || source.generation !== previous.generation || capture.epoch !== previous.epoch)) {
                    this.clear();
                    return this.collect(connections, cutoff, limit, boundaries);
                }
                const cursor = previous ?? this.createCursor(settings.id, source, capture.epoch,
                    this.timebases[settings.id], settings.timeOffsetMs ?? 0);
                const groups = protocol ? engine.syncSource?.frames.channelPacketGroups : null;
                if (cursor.packetGroups !== groups) {
                    for (const [global, local] of columns)
                        this.numericSource.frames.channelPacketGroups[global] = groups?.[local] ?? null;
                    cursor.packetGroups = groups;
                }
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
                const first = frames.frameOrdinalAt(0);
                if (cursor.readFrame !== null && first > cursor.readFrame + 1) {
                    cursor.evictedUnread = (cursor.evictedUnread ?? 0) + first - cursor.readFrame - 1;
                    cursor.readFrame = first - 1;
                    cursor.retentionGap = true;
                }
                const index = cursor.readFrame === null ? Math.max(0, frames.length - this.capacity)
                    : Math.max(0, cursor.readFrame + 1 - first);
                const end = boundary ? Math.min(frames.length, boundary.last + 1 - first) : frames.length;
                lanes.push({ cursor, columns, frames, protocol, engine, capture, index, end,
                    markerIndex: this.markerIndex(timing, engine), id: settings.id });
            }
            const events = [];
            limit = Math.min(limit, Math.max(1, Math.floor(131072 / Math.max(1, this.mappings.length))));
            let work = limit + lanes.length, scanLimited = false, futureReceipt = Infinity;
            const peek = lane => {
                const { cursor, frames } = lane;
                while (!cursor.pending.length && lane.index < lane.end) {
                    if (work-- <= 0) { scanLimited = true; break; }
                    const index = lane.index, timestamp = frames.timestampAt(index);
                    if (timestamp > cutoff) { futureReceipt = Math.min(futureReceipt, timestamp); break; }
                    const order = frames.orderAt(index);
                    lane.index++;
                    const byteOffset = frames.rawByteOffsetAt(index);
                    const frameIndex = frames.frameOrdinalAt(index);
                    cursor.readFrame = frameIndex;
                    let nextTimebase;
                    while (cursor.timebaseChanges[0]?.from <= frameIndex) nextTimebase = cursor.timebaseChanges.shift();
                    if (nextTimebase) {
                        this.setCursorClock(lane.id, cursor, nextTimebase.timing, nextTimebase.offset);
                        lane.markerIndex = this.markerIndex(nextTimebase.timing, lane.engine);
                    }
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
                        const nextCutover = cursor.timebaseChanges[0]?.from ?? Infinity;
                        let lo = index + 1, hi = Math.min(lane.end, nextCutover - frames.frameOrdinalAt(0));
                        while (lo < hi) {
                            const mid = (lo + hi) >>> 1;
                            if (frames.timestampAt(mid) === timestamp) lo = mid + 1; else hi = mid;
                        }
                        cursor.batchTail = frames.frameOrdinalAt(lo - 1);
                    }
                    const captureTime = this.plotTime(timestamp, section);
                    const sample = cursor.clock.sample({ receiveTime: captureTime,
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
                        captureTime, alignedTime: time, missingBefore: sample.missingBefore, period: sample.period,
                        sampleRate: lane.protocol ? undefined : cursor.timing.mode === 'fixed'
                            ? cursor.timing.sampleRate : cursor.source.sampleRate?.rate,
                        fixedSampleRate: !lane.protocol && cursor.timing.mode === 'fixed' ? cursor.timing.sampleRate : undefined,
                        breakBefore: cursor.retentionGap || sample.breakBefore || time !== sample.time, byteOffset,
                        endByte: frames.frameAt(index, { copyBytes: false })?.endByte
                    } });
                    cursor.retentionGap = false;
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
            // A projected sample may be ahead of the capture clock (offset or
            // fixed-rate batch). Give the other sources their actual wait time.
            const watermark = Math.min(latestTime - remaining, this.plotTime(cutoff) - this.waitMs);
            this.ingest(events, !more || nextTime > latestTime, watermark);
            if (scanLimited || this.pendingGrid) return -Number.MAX_VALUE;
            due = Math.min(due, futureReceipt);
            if (!more && watermark < latestTime) {
                const finishAt = Math.max(this.latestReceipt + this.waitMs, this.receiveTime(latestTime + this.waitMs));
                return Math.min(due, Math.max(cutoff + 1, finishAt));
            }
            return due;
        }

        dispose() { this.disposed = true; this.clear(); }
    }

    const api = { normalizeWorkspaceChannels, planWorkspaceChannels, WorkspaceChannelCapture };
    root.SerialPlotter ??= {}; Object.assign(root.SerialPlotter, api);
    if (typeof module !== 'undefined') module.exports = api;
})(globalThis);
