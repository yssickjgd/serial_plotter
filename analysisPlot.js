/** Native XY trajectories, sliding histogram counts and their interactive SVG view. */
(function (root) {
    const S = root.SerialPlotter ??= {};
    const config = typeof module !== 'undefined' ? require('./analysisSettings').AnalysisSettings : S.AnalysisSettings;
    const navigation = typeof module !== 'undefined' ? require('./frameNavigation') : S.FrameNavigation;
    const { pairSpectrum, countSpectrumBlocks } = typeof module !== 'undefined' ? require('./pairSpectrum') : S;
    const NS = 'http://www.w3.org/2000/svg';
    const background = '#111111', foreground = '#d1d5db', accent = '#38bdf8';
    let nextClip = 0;
    const finite = Number.isFinite;
    const clamp = (x, lo, hi) => Math.max(lo, Math.min(x, hi));
    const eventTime = event => event.traceTime ?? event.timestamp;
    const validChannel = (frames, index) => Number.isInteger(index) && index >= 0 && index < frames.channelCount &&
        (frames.isSignal?.(index) ?? true);
    function boundary(length, before) {
        let lo = 0, hi = length;
        while (lo < hi) {
            const mid = Math.floor((lo + hi) / 2);
            if (before(mid)) lo = mid + 1; else hi = mid;
        }
        return lo;
    }
    const eventBound = (events, time, inclusive = false) => boundary(events.length,
        i => inclusive ? eventTime(events[i]) <= time : eventTime(events[i]) < time);
    const { formatDisplayNumber: numberLabel, maxAxisSignificantDigits, readAxisNumberFormat, axisNumberFieldNames,
        formatAxisValue, customAxisNumberFormat, plotWheelAxis, zoomAxisBounds, positiveLogBounds, adaptiveLogScale,
        axisFraction, axisValueAtFraction, layoutAxisTickLabels, formatPlotAxisCoordinate } = typeof module !== 'undefined' ? require('./plotMath') : S;
    const boundLabel = (value, format, digits) => value === Infinity ? '+∞' : value === -Infinity ? '−∞' : formatAxisValue(value, format, digits);
    const labelWidth = text => Array.from(text).reduce((width, c) => width + (c.charCodeAt(0) > 127 ? 12 : 7), 0);

    function tickLabels(values, format, digits = 6) {
        let count = digits, labels = values.map(value => formatAxisValue(value, format, count));
        while (format.mode === 'significant' && !format.significantDigits && count < maxAxisSignificantDigits &&
            new Set(labels).size < values.length) {
            count++;
            labels = values.map(value => formatAxisValue(value, format, count));
        }
        return labels;
    }
    const channelLabel = (frames, index) => index == null ? '未绑定' :
        (frames.names?.[index] || frames.channelNames?.[index] || 'CH' + String(index + 1).padStart(5, '0'));
    const native = (frames, channel) => frames.events instanceof Map && channel < frames.rawChannelCount;
    function timeBounds(frames, start, end, liveCount) {
        const live = liveCount && frames.liveTimeBounds?.(liveCount);
        if (live) return live;
        if (liveCount && finite(frames.latestNativeTime) && frames.length && frames.sampleRate > 0) {
            const last = Math.max(frames.latestNativeTime, frames.timestampAt(end - 1));
            return { first: Math.max(frames.timestampAt(0), last - (liveCount - 1) * 1000 / frames.sampleRate), last };
        }
        return frames.timeBounds?.(start, end, false) ??
            { first: frames.timestampAt?.(start), last: frames.timestampAt?.(end - 1) };
    }
    function gridRange(frames, start, end, bounds) {
        if (frames.events instanceof Map && finite(bounds.first) && finite(bounds.last)) {
            const indexAt = (time, inclusive) => frames.indexAtTimeBoundary ? frames.indexAtTimeBoundary(time, inclusive) :
                boundary(frames.length, i => inclusive ? frames.timestampAt(i) <= time : frames.timestampAt(i) < time);
            start = Math.max(start, indexAt(bounds.first, false));
            end = Math.min(end, indexAt(bounds.last, true));
        }
        return [Math.min(start, end), end];
    }

    // Within a source, two channels must refer to the very same packet. A batch can
    // have many different packets with one timestamp, and protocol fields may be sparse.
    function compareEvents(x, y) {
        const delta = eventTime(x) - eventTime(y);
        if (delta || x.origin === y.origin) return delta;
        if (!x.origin || !y.origin) return x.origin ? 1 : -1;
        return (x.origin.epoch ?? 0) - (y.origin.epoch ?? 0) ||
            (x.origin.order ?? 0) - (y.origin.order ?? 0) ||
            (x.origin.byteOffset ?? 0) - (y.origin.byteOffset ?? 0);
    }
    function nativePairs(frames, pair, bounds, emit) {
        const xs = frames.events.get(pair.x) ?? [], ys = frames.events.get(pair.y) ?? [];
        let i = Math.max(0, eventBound(xs, bounds.first) - 1), j = Math.max(0, eventBound(ys, bounds.first) - 1);
        const endX = Math.min(xs.length, eventBound(xs, bounds.last, true) + 1);
        const endY = Math.min(ys.length, eventBound(ys, bounds.last, true) + 1);
        let previous = null, gap = true;
        const expiry = Math.min(...[pair.x, pair.y].map(c => frames.expiry?.[c] > 0 ? frames.expiry[c] * 1000 : Infinity));
        while (i < endX && j < endY) {
            const x = xs[i], y = ys[j], order = compareEvents(x, y);
            if (order) {
                if (order < 0) i++; else j++;
                previous = null; gap = true; continue;
            }
            i++; j++;
            const time = eventTime(x), origin = x.origin;
            if (!origin || !finite(x.value) || !finite(y.value)) { gap = true; previous = null; continue; }
            if (origin.breakBefore || previous && origin.epoch !== previous.epoch) gap = true;
            if (previous && !gap && origin.missingBefore > 0 && origin.period > 0) {
                const base = time - origin.missingBefore * origin.period;
                const from = Math.max(0, Math.ceil((bounds.first - base) / origin.period));
                const stop = Math.min(origin.missingBefore, Math.floor((bounds.last - base) / origin.period) + 1);
                const stride = Math.max(1, Math.ceil((stop - from) / 256));
                for (let slot = from; slot < stop; slot += stride) {
                    const t = base + slot * origin.period;
                    if (t <= previous.time || t >= time || t < bounds.first || t > bounds.last) continue;
                    const xv = frames._estimate(pair.x, t, true)?.value, yv = frames._estimate(pair.y, t, true)?.value;
                    if (finite(xv) && finite(yv)) { emit(xv, yv, t, gap, true); gap = false; }
                    else gap = true;
                }
            } else if (previous && time - previous.time >= expiry) gap = true;
            if (time >= bounds.first && time <= bounds.last) { emit(x.value, y.value, time, gap, false); gap = false; }
            // The predecessor may be outside the visible window and still establish
            // the interpolation interval for the first visible recovered sample.
            if (time < bounds.first) gap = false;
            previous = { time, epoch: origin.epoch };
        }
    }
    function readPairs(frames, pair, start, end, bounds, emit, gridOnly = false) {
        if (![pair.x, pair.y].every(c => validChannel(frames, c))) return;
        if (!gridOnly && native(frames, pair.x) && native(frames, pair.y) &&
            frames.channelSourceIds?.[pair.x] === frames.channelSourceIds?.[pair.y] &&
            frames.channelPacketGroups?.[pair.x] === frames.channelPacketGroups?.[pair.y]) {
            nativePairs(frames, pair, bounds, emit);
            return;
        }
        [start, end] = gridRange(frames, start, end, bounds);
        const xs = frames.copyChannel?.(pair.x, start, end), ys = pair.y === pair.x ? xs : frames.copyChannel?.(pair.y, start, end);
        const events = [...new Set([pair.x, pair.y])].filter(c => native(frames, c)).map(channel => {
            const list = frames.events.get(channel) ?? [];
            return { list, cursor: eventBound(list, frames.timestampAt(start)) };
        });
        const sections = gridOnly ? frames.segments : null;
        let section = sections ? boundary(sections.length, i => sections[i].first <= frames.head + start) : 0;
        let gap = true, previousTime = NaN;
        for (let index = start; index < end; index++) {
            const x = xs ? xs[index - start] : frames.getValue(pair.x, index);
            const y = ys ? ys[index - start] : frames.getValue(pair.y, index);
            const time = frames.timestampAt?.(index) ?? index;
            let recovered = false;
            for (const lane of events) {
                while (lane.cursor < lane.list.length && eventTime(lane.list[lane.cursor]) <= time) {
                    if (lane.list[lane.cursor].origin?.breakBefore || !finite(lane.list[lane.cursor].value)) gap = true;
                    lane.cursor++;
                }
                const prev = lane.list[lane.cursor - 1];
                if (!prev?.origin || Math.abs(eventTime(prev) - time) > 1e-8) recovered = true;
            }
            if (frames.segments) {
                const step = 1000 / frames.sampleRate;
                if (sections?.[section]?.first === frames.head + index) { section++; gap = true; }
                if (!gridOnly && time - previousTime > 1.5 * step) gap = true;
            }
            if (finite(x) && finite(y)) { emit(x, y, time, gap, recovered); gap = false; }
            else gap = true;
            previousTime = time;
        }
    }

    function readSpectrumInput(frames, pair, start, end, bounds, preferredSize, overlap) {
        const xValues = new Float64Array(end - start), yValues = new Float64Array(end - start), segments = [];
        let first = 0, recovered = 0, samples = 0;
        const finish = () => {
            if (samples - first >= 2) segments.push({ x: xValues.subarray(first, samples), y: yValues.subarray(first, samples) });
            first = samples;
        };
        readPairs(frames, pair, start, end, bounds, (x, y, time, gap, filled) => {
            if (gap) finish();
            xValues[samples] = x; yValues[samples++] = y;
            if (filled) recovered++;
        }, true);
        finish();
        let fftSize = preferredSize, blocks = countSpectrumBlocks(segments, fftSize, overlap);
        while (blocks < 2 && fftSize > 2) {
            fftSize /= 2;
            blocks = countSpectrumBlocks(segments, fftSize, overlap);
        }
        return { segments, pair, recovered, samples, fftSize, blocks };
    }

    function histogramDigits(length, valueAt) {
        let digits = 6;
        for (let i = 1, previous = valueAt(0); i < length; i++) {
            const value = valueAt(i), step = value - previous;
            if (step > 0 && finite(step)) {
                const magnitude = Math.max(Math.abs(previous), Math.abs(value));
                digits = Math.max(digits, Math.floor(Math.log10(magnitude)) - Math.floor(Math.log10(step)) + 1);
            }
            previous = value;
        }
        return Math.min(digits, maxAxisSignificantDigits);
    }

    function visibleHistogramBins(length, [first, last]) {
        return [Math.max(0, Math.floor(first)), Math.min(length, Math.ceil(last))];
    }

    function histogramBins(settings) {
        if (settings.mode === 'fixed') {
            const order = settings.values.map((value, index) => ({ value, index })).sort((a, b) => a.value - b.value);
            const autoDigits = histogramDigits(order.length, i => order[i].value);
            return { length: order.length, label: i => formatAxisValue(settings.values[i], readAxisNumberFormat(settings, 'x'), autoDigits), classify(value) {
                const pos = boundary(order.length, i => order[i].value < value);
                if (order[pos]?.value === value) return order[pos].index;
                if (settings.match === 'exact') return -1;
                if (!pos) return order[0].index;
                if (pos === order.length) return order[pos - 1].index;
                const lower = order[pos - 1], higher = order[pos];
                const leftDistance = value - lower.value, rightDistance = higher.value - value;
                if (leftDistance === rightDistance) return settings.tieBreak === 'higher' ? higher.index : lower.index;
                return leftDistance < rightDistance ? lower.index : higher.index;
            } };
        }
        const equal = settings.mode === 'equal';
        const edges = equal ? config.equalEdges(settings.min, settings.max, settings.count) : settings.edges.map(Number);
        const leftClosed = settings.closure === 'leftClosed';
        const under = Number(settings.underflow && finite(edges[0])), over = Number(settings.overflow && finite(edges.at(-1)));
        const intervals = edges.length - 1, autoDigits = histogramDigits(edges.length, i => edges[i]);
        return { length: intervals + under + over, classify(value) {
            const i = boundary(edges.length, k => edges[k] < value || edges[k] === value && leftClosed) - 1;
            if (i < 0 && !under || i === intervals && !over) return -1;
            return i + under;
        }, label(bin) {
            const i = bin - under;
            const format = readAxisNumberFormat(settings, 'x');
            if (i < 0) return '(−∞, ' + boundLabel(edges[0], format, autoDigits) + (!leftClosed ? ']' : ')');
            if (i === intervals) return (leftClosed ? '[' : '(') + boundLabel(edges[i], format, autoDigits) + ', +∞)';
            return (finite(edges[i]) && leftClosed ? '[' : '(') + boundLabel(edges[i], format, autoDigits) + ', ' +
                boundLabel(edges[i + 1], format, autoDigits) + (finite(edges[i + 1]) && !leftClosed ? ']' : ')');
        } };
    }

    // Keep the previous window's bin assignments. Expired samples can be
    // subtracted even after the capture ring has overwritten their values.
    class HistogramWindow {
        constructor(settings) {
            this.settings = settings; this.bins = histogramBins(settings);
            this.reset();
        }
        reset() {
            this.counts = new Uint32Array(this.bins.length);
            this.queue = []; this.offset = 0; this.matched = 0; this.missed = 0; this.invalid = 0;
            this.source = null; this.first = 0; this.end = 0;
        }
        adjust(bin, delta) {
            if (bin === -2) this.invalid += delta;
            else if (bin === -1) this.missed += delta;
            else if (bin >= 0) { this.matched += delta; this.counts[bin] += delta; }
        }
        update(frames, start, end, bounds) {
            const channel = this.settings.channel;
            if (!validChannel(frames, channel)) { this.reset(); return; }
            let source, value, base = 0, generation;
            if (native(frames, channel)) {
                source = frames.events.get(channel);
                if (!source) { this.reset(); return; }
                start = eventBound(source, bounds.first); end = eventBound(source, bounds.last, true);
                // Eviction splices the event array. Locate our former last event and
                // keep its logical ordinal stable across that splice.
                if (source === this.source && source[0] !== this.sourceHead && this.tailEvent) {
                    let i = eventBound(source, eventTime(this.tailEvent));
                    while (i < source.length && eventTime(source[i]) === eventTime(this.tailEvent) && source[i] !== this.tailEvent) i++;
                    if (source[i] === this.tailEvent) base = this.end - 1 - i;
                    else this.reset();
                } else if (source === this.source) base = this.base;
                value = i => source[i].origin ? source[i].value : null;
                this.sourceHead = source[0]; this.tailEvent = source[end - 1];
            } else {
                [start, end] = gridRange(frames, start, end, bounds);
                source = frames.columns?.get(channel) && frames.events instanceof Map ?
                    frames.columns.get(channel) : frames.values ?? frames;
                base = frames.frameOrdinalAt?.(0) ?? frames.head ?? 0;
                if (!finite(base)) base = 0;
                generation = frames.generation ?? frames.revision;
                value = i => frames.getValue(channel, i);
            }
            const first = start + base, last = end + base;
            if (source !== this.source || generation !== this.generation || first < this.first || last < this.end ||
                first > this.end || !native(frames, channel) && this.version !== frames.version && last === this.end && first === this.first)
                this.reset();
            if (!this.source) { this.first = first; this.end = first; }
            while (this.first < first) { this.adjust(this.queue[this.offset++], -1); this.first++; }
            if (this.offset > 2048 && this.offset * 2 >= this.queue.length) {
                this.queue = this.queue.slice(this.offset); this.offset = 0;
            }
            for (let i = this.end; i < last; i++) {
                const v = value(i - base);
                const bin = v === null ? -3 : finite(v) ? this.bins.classify(v) : -2;
                this.adjust(bin, 1); this.queue.push(bin);
            }
            this.source = source; this.generation = generation; this.version = frames.version; this.end = last; this.base = base;
        }
        percent(i) { return this.matched ? this.counts[i] * 100 / (this.matched + this.missed) : 0; }
    }

    // Simplify in two-dimensional display space. Time buckets can connect opposite
    // sides of a fast closed orbit with a chord that the source never traversed.
    function trajectory(frames, pair, start, end, bounds, budget, viewport, aspect = .6) {
        let xMin = Infinity, xMax = -Infinity, yMin = Infinity, yMax = -Infinity;
        let small = [], segment = 0, seq = 0;
        readPairs(frames, pair, start, end, bounds, (x, y, time, gap, recovered) => {
            if (gap) segment++;
            if (small && small.length === budget) small = null;
            if (small) small.push({ x, y, time, recovered, segment, seq });
            seq++;
            xMin = Math.min(xMin, x); xMax = Math.max(xMax, x);
            yMin = Math.min(yMin, y); yMax = Math.max(yMax, y);
        });
        const limits = [xMin, xMax, yMin, yMax];
        if (small) return { pair, points: small, samples: small, limits };
        const xr = finite(viewport?.[0]) ? viewport.slice(0, 2) : extent(xMin, xMax);
        const yr = finite(viewport?.[2]) ? viewport.slice(2, 4) : extent(yMin, yMax);
        const points = [], seen = new Set(), samples = [], occupied = new Set(), block = [], pixels = Math.max(64, budget / 3);
        let prior = null, lastDrawn = null;
        function add(p) {
            // A repeated edge already has visible geometry. The next new edge must
            // start at its own origin, even after several complete overlapping turns.
            if (prior && prior.segment === p.segment && prior.seq !== p.seq) {
                const a = prior.key, b = p.key, edge = a < b ? a + '|' + b : b + '|' + a;
                if (!seen.has(edge)) {
                    if (lastDrawn !== prior) { prior.move = true; points.push(prior); }
                    points.push(p); lastDrawn = p;
                    if (seen.size < 65536) seen.add(edge);
                }
            } else if (!prior || prior.segment !== p.segment) {
                p.move = true; points.push(p); lastDrawn = p;
            }
            prior = p;
        }
        function flush() {
            const n = block.length;
            if (!n) return;
            const keep = new Uint8Array(n), stack = [0, n - 1];
            keep[0] = keep[n - 1] = 1;
            // Split at actual vertices with more than half a pixel of deviation.
            // Short blocks bound work on noisy signals and bound temporary storage.
            while (stack.length) {
                const end = stack.pop(), start = stack.pop(), a = block[start], b = block[end];
                const dx = b.sx - a.sx, dy = b.sy - a.sy, length = dx * dx + dy * dy;
                let farthest = -1, maxError = .25;
                for (let i = start + 1; i < end; i++) {
                    const v = block[i], vx = v.sx - a.sx, vy = v.sy - a.sy;
                    const t = length ? clamp((vx * dx + vy * dy) / length, 0, 1) : 0;
                    const error = (vx - t * dx) ** 2 + (vy - t * dy) ** 2;
                    if (error > maxError) { farthest = i; maxError = error; }
                }
                if (farthest >= 0) { keep[farthest] = 1; stack.push(start, farthest, farthest, end); }
            }
            for (let i = 0; i < n; i++) if (keep[i]) add(block[i]);
            block.length = 0;
        }
        seq = 0; segment = 0;
        readPairs(frames, pair, start, end, bounds, (x, y, time, gap, recovered) => {
            if (gap || block.length && block.at(-1).recovered !== recovered) flush();
            if (gap) segment++;
            const sx = clamp(fraction(x, ...xr) * pixels, -1e8, 1e8);
            const sy = clamp(fraction(y, ...yr) * pixels * aspect, -1e8, 1e8);
            const sample = { x, y, time, recovered, segment, seq: seq++, sx, sy, key: Math.round(sx) + ',' + Math.round(sy) };
            const marker = sample.key + (recovered ? 'r' : '');
            if (sx >= -3 && sx <= pixels + 3 && sy >= -3 && sy <= pixels * aspect + 3 && !occupied.has(marker)) {
                occupied.add(marker); samples.push(sample);
            }
            block.push(sample);
            if (block.length === 96) flush();
        });
        flush();
        if (prior && lastDrawn !== prior) { prior.move = true; points.push(prior); }
        return { pair, points, samples, limits };
    }
    function extent(lo, hi) {
        if (lo > hi) return [-1, 1];
        const pad = lo === hi ? Math.max(Math.abs(lo) * .05, 1) : hi * .04 - lo * .04;
        return [finite(lo - pad) ? lo - pad : lo, finite(hi + pad) ? hi + pad : hi];
    }
    function fraction(value, lo, hi) {
        const span = hi - lo;
        return finite(span) ? (value - lo) / span : (value / 2 - lo / 2) / (hi / 2 - lo / 2);
    }
    const mix = (a, b, t) => (1 - t) * a + t * b;
    function equalRanges(range, width, height) {
        const [x0, x1, y0, y1] = range, xScale = (x1 - x0) / width, yScale = (y1 - y0) / height;
        if (!finite(xScale) || !finite(yScale)) return range;
        const dx = Math.max(0, (yScale - xScale) * width / 2), dy = Math.max(0, (xScale - yScale) * height / 2);
        const result = [x0 - dx, x1 + dx, y0 - dy, y1 + dy];
        return result.every(finite) ? result : range;
    }
    function node(parent, tag, attrs = {}, content) {
        const el = parent.ownerDocument.createElementNS(NS, tag);
        for (const [key, value] of Object.entries(attrs)) el.setAttribute(key, value);
        if (content != null) el.textContent = content;
        parent.appendChild(el);
        return el;
    }
    const pixel = n => Math.round(clamp(n, -1e8, 1e8) * 10) / 10;
    const dot = (x, y, r) => 'M' + pixel(x - r) + ' ' + pixel(y) + 'a' + r + ' ' + r + ' 0 1 0 ' +
        (2 * r) + ' 0a' + r + ' ' + r + ' 0 1 0 ' + (-2 * r) + ' 0';
    function path(parent, d, attrs) { if (d.length) node(parent, 'path', { d: d.join(''), ...attrs }); }
    function label(parent, x, y, value, attrs = {}) {
        return node(parent, 'text', { x, y, fill: foreground, 'font-size': 11, ...attrs }, value);
    }

    class AnalysisPlot {
        constructor(svg, type, frames, settings = {}, windowPoints = 5000, getSpectrumClock = () => ({ rate: 0 }), spectrumPool = null,
            getChannelColor = () => null) {
            this.svg = svg; this.type = type; this.frames = frames; this.win = svg.ownerDocument.defaultView ?? root;
            this.visible = true; this.completedDraws = 0; this.cleanups = []; this.historyOrdinal = null;
            this.clipId = 'analysis-clip-' + ++nextClip;
            this.settings = config.normalize(type, settings); this.windowPoints = windowPoints;
            this.getSpectrumClock = getSpectrumClock;
            this.getChannelColor = getChannelColor;
            this.spectrumPool = spectrumPool; this.spectra = [];
            svg.setAttribute('role', 'img'); svg.setAttribute('tabindex', '0');
            svg.setAttribute('aria-label', type === 'xy' ? 'XY 轨迹图' : '直方图');
            svg.setAttribute('font-family', 'Consolas, monospace');
            this.listen('wheel', e => this.wheel(e), { passive: false });
            this.listen('pointerdown', e => this.down(e));
            this.listen('pointermove', e => this.move(e));
            this.listen('pointerup', e => this.up(e));
            this.listen('lostpointercapture', () => { this.drag = null; this.drawOverlay(); });
            this.listen('pointerleave', () => {
                if (!this.drag) { this.pointer = null; this.drawOverlay(); }
            });
            this.listen('dblclick', () => this.resetZoom());
            this.listen('contextmenu', e => { e.preventDefault(); this.resetZoom(); });
            this.listen('keydown', e => {
                if (e.key === 'Home' || e.key === 'Escape') this.resetZoom();
                else if (this.isPaused && ['ArrowLeft', 'ArrowRight', 'End'].includes(e.key)) {
                    if (e.key === 'End') this.followLatest();
                    else this.stepHistory(e.key === 'ArrowLeft' ? -1 : 1);
                } else return;
                e.preventDefault();
            });
            const Observer = this.win.ResizeObserver ?? root.ResizeObserver;
            if (Observer) {
                this.observer = new Observer(() => this.resize()); this.observer.observe(svg);
            }
            this.resize();
        }
        listen(type, listener, options) {
            this.svg.addEventListener(type, listener, options);
            this.cleanups.push(() => this.svg.removeEventListener(type, listener, options));
        }
        resize() {
            const rect = this.svg.getBoundingClientRect();
            this.width = Math.max(1, Math.round(this.svg.clientWidth || rect.width || 480));
            this.height = Math.max(1, Math.round(this.svg.clientHeight || rect.height || 260));
            this.invalidateData();
        }
        setSettings(settings, windowPoints = this.windowPoints) {
            const next = config.normalize(this.type, settings);
            for (const axis of ['x', 'y']) for (const name of axisNumberFieldNames) {
                const key = axis + name;
                if (this.settings[key] !== next[key]) {
                    this.settings[key] = next[key];
                    this.paintKey = null;
                }
            }
            if (this.type === 'histogram' && this.settings.color !== next.color) {
                this.settings.color = next.color;
                this.paintKey = null;
            }
            if (JSON.stringify(next) !== JSON.stringify(this.settings) || this.spectral && windowPoints !== this.windowPoints) {
                const samePhaseView = this.phaseSpectrum && next.viewMode === 'phase' && windowPoints === this.windowPoints &&
                    next.freqXScale === this.settings.freqXScale && next.phaseUnit !== this.settings.phaseUnit;
                const axisSize = this.spectrumAxisSize;
                if (samePhaseView && this.zoom) {
                    const factor = next.phaseUnit === 'degrees' ? 180 / Math.PI : Math.PI / 180;
                    if (this.zoom.y) this.zoom.y = this.zoom.y.map(value => value * factor);
                    if (this.yZoomBase) this.yZoomBase = this.yZoomBase.map(value => value * factor);
                } else { this.zoom = null; this.yZoomBase = null; }
                this.settings = next; this.histogram = null; this.dataKey = null;
                this.resetSpectrum();
                if (samePhaseView && this.zoom?.x) this.spectrumAxisSize = axisSize;
                this.cancelRender();
            }
            this.windowPoints = windowPoints; this.invalidateData();
        }
        setFrames(frames) {
            if (this.frames === frames) return;
            this.frames = frames; this.clear();
        }
        clear() {
            this.histogram = null; this.dataKey = null; this.resetSpectrum();
            this.zoom = null; this.yZoomBase = null; this.drag = null; this.pointer = null; this.followLatest();
        }
        invalidateLabels() { this.paintKey = null; this.invalidateData(); }
        setPaused(paused) {
            if (this.isPaused !== paused) this.cancelSpectrumRequest();
            this.isPaused = paused; this.invalidateData();
        }
        setVisible(visible) {
            this.visible = visible;
            if (visible) this.invalidateData();
            else { this.cancelRender(); this.cancelSpectrumRequest(); }
        }
        cancelRender() {
            if (this.pending == null) return;
            if (this.win.cancelAnimationFrame) this.win.cancelAnimationFrame(this.pending);
            else if (root.cancelAnimationFrame) root.cancelAnimationFrame(this.pending);
            else clearTimeout(this.pending);
            this.pending = null;
        }
        invalidateData() {
            if (!this.visible || this.disposed || this.pending != null) return;
            const render = () => { this.pending = null; this.renderNow(); };
            this.pending = this.win.requestAnimationFrame ? this.win.requestAnimationFrame(render) :
                root.requestAnimationFrame ? root.requestAnimationFrame(render) : setTimeout(render, 16);
        }
        oldestOrdinal() {
            const ordinal = this.frames.frameOrdinalAt?.(0);
            return finite(ordinal) ? ordinal : this.frames.head ?? 0;
        }
        currentFrameIndex() {
            if (!this.frames.length) return -1;
            return this.historyOrdinal == null ? this.frames.length - 1 :
                clamp(this.historyOrdinal - this.oldestOrdinal(), 0, this.frames.length - 1);
        }
        getVisibleFrameIndex() { return this.currentFrameIndex(); }
        getReferenceByteOffset() {
            const index = this.currentFrameIndex();
            return index < 0 ? null : this.frames.rawByteOffsetAt?.(index) ?? null;
        }
        jumpToByteOffset(offset) {
            if (!finite(offset) || !this.frames.length) return false;
            const index = navigation.frameIndexAtByteOffset(this.frames, offset);
            if (!Number.isInteger(index) || index < 0) return false;
            const first = this.frames.rawByteOffsetAt(index);
            const end = this.frames.rawEndByteAt?.(index) ?? this.frames.frameAt(index, { copyBytes: false })?.endByte;
            return offset >= first && offset < end && this.jumpToFrame(index);
        }
        jumpToFrame(index) {
            if (!Number.isInteger(index) || index < 0 || index >= this.frames.length) return false;
            const ordinal = this.oldestOrdinal() + index;
            if (this.spectral && ordinal !== this.historyOrdinal) this.resetSpectrum();
            this.historyOrdinal = ordinal; this.invalidateData(); return true;
        }
        stepHistory(delta) {
            if (this.frames.length) this.jumpToFrame(clamp(this.currentFrameIndex() + delta, 0, this.frames.length - 1));
        }
        followLatest() {
            if (this.spectral && this.historyOrdinal != null) this.resetSpectrum();
            this.historyOrdinal = null; this.setNavigationMarkers({});
        }
        setNavigationMarkers(markers) {
            this.navigationMarkers = { timeOrder: null, matches: [], currentMatch: -1, ...markers };
            this.paintKey = null; this.invalidateData();
        }
        resetZoom() {
            this.zoom = null; this.yZoomBase = null; this.drag = null; this.drawOverlay(); this.invalidateData();
        }
        extentForXY() {
            let xMin = Infinity, xMax = -Infinity, yMin = Infinity, yMax = -Infinity;
            for (const { limits } of this.traces) {
                xMin = Math.min(xMin, limits[0]); xMax = Math.max(xMax, limits[1]);
                yMin = Math.min(yMin, limits[2]); yMax = Math.max(yMax, limits[3]);
            }
            const s = this.settings;
            return [...(s.xAuto ? extent(xMin, xMax) : [s.xMin, s.xMax]), ...(s.yAuto ? extent(yMin, yMax) : [s.yMin, s.yMax])];
        }
        get spectral() { return this.type === 'xy' && this.settings.viewMode !== 'trajectory'; }
        get fftSize() { return config.spectrumSegmentSize(this.windowPoints, this.settings.fftOverlap); }
        get axisFftSize() { return this.spectrumAxisSize ?? this.fftSize; }
        get logFrequency() { return this.settings.freqXScale?.endsWith('-log'); }
        get phaseSpectrum() { return this.settings.viewMode === 'phase'; }
        get gainSpectrum() { return this.settings.viewMode === 'gain'; }
        get gainInDb() { return this.gainSpectrum && this.settings.gainUnit.startsWith('db'); }
        get logGain() { return this.gainSpectrum && this.settings.gainUnit === 'ratio-log'; }
        get phaseSuffix() { return this.phaseSpectrum ? (this.settings.phaseUnit === 'degrees' ? '°' : ' rad') : ''; }
        get maxSpectrumPhaseStep() {
            if (!this.phaseSpectrum || this.settings.phaseUnwrap) return Infinity;
            return this.settings.phaseUnit === 'degrees' ? 180 : Math.PI;
        }
        get frequencyUnit() { return this.settings.freqXScale?.startsWith('hz-') && this.frequencyRate > 0 ? 'Hz' : 'Bin'; }
        frequencyAtBin(bin) { return this.frequencyUnit === 'Hz' ? bin * this.frequencyRate / this.axisFftSize : bin; }
        // Use the finest grid among the displayed spectra. Coarser FFTs are
        // drawn at the same physical frequencies on that grid.
        spectrumBin(bin, spectrum) { return bin * this.axisFftSize / spectrum.fftSize; }
        binToAxis(bin) { return this.logFrequency ? Math.log10(bin) : bin; }
        axisToBin(x) { return this.logFrequency ? 10 ** x : x; }
        spectrumWindow(start, end) {
            const { frames } = this;
            if (!frames.segments?.length || end <= start) {
                const { rate, from = 0 } = this.getSpectrumClock(end - 1);
                return { start: Math.max(start, from), rate };
            }
            const segments = frames.segments;
            const index = boundary(segments.length, i => segments[i].first < frames.head + end) - 1;
            const step = segments[index].step;
            let first = index;
            while (first > 0 && segments[first - 1].step === step) first--;
            return { start: Math.max(start, segments[first].first - frames.head), rate: 1000 / step };
        }
        cancelSpectrumRequest() {
            const request = this.spectrumRequest;
            this.spectrumRequest = null;
            request?.abort?.abort();
        }
        resetSpectrum() {
            this.cancelSpectrumRequest();
            this.spectrumKey = null; this.dataKey = null; this.spectra = []; this.spectrumAxisSize = null;
            this.referenceBins = false;
        }
        publishSpectra(results, key, rate) {
            const s = this.settings;
            const previousSize = this.axisFftSize;
            this.spectra = results.map(data => {
                const values = data[s.viewMode];
                if (this.phaseSpectrum) {
                    let previous = NaN, offset = 0;
                    const scale = s.phaseUnit === 'degrees' ? 180 / Math.PI : 1;
                    for (let i = 0; i < values.length; i++) {
                        const phase = values[i];
                        // Leave invalid bins as gaps, but unwrap against the last valid phase.
                        if (!finite(phase)) continue;
                        if (s.phaseUnwrap && finite(previous)) {
                            if (phase - previous > Math.PI) offset -= 2 * Math.PI;
                            if (phase - previous < -Math.PI) offset += 2 * Math.PI;
                        }
                        previous = phase;
                        values[i] = (phase + offset) * scale;
                    }
                }
                return { ...data, values };
            });
            this.spectrumAxisSize = this.spectra.reduce((size, { fftSize, values }) =>
                fftSize > size && values.some((value, bin) => (!this.logFrequency || bin > 0) && finite(value)) ? fftSize : size, 0) || null;
            this.referenceBins = this.spectra.some(({ fftSize, values }) =>
                fftSize !== this.axisFftSize && values.some((value, bin) => (!this.logFrequency || bin > 0) && finite(value)));
            if (this.zoom?.x && previousSize !== this.axisFftSize) {
                const ratio = this.axisFftSize / previousSize;
                const [lower, upper] = this.zoom.x;
                const [min, max] = this.spectrumXBounds();
                const first = Math.max(min, this.binToAxis(this.axisToBin(lower) * ratio));
                const last = Math.min(max, this.binToAxis(this.axisToBin(upper) * ratio));
                this.zoom.x = first < last ? [first, last] : null;
                if (!this.zoom.x && !this.zoom.y) this.zoom = null;
            }
            this.spectrumKey = key;
            this.spectrumRate = rate;
            this.dataKey = null;
        }
        updateSpectra(start, end, bounds, rate, synchronous) {
            const key = [this.frames.version, start, end, bounds.first, bounds.last, rate].join('|');
            if (this.spectrumKey === key) return;
            if (this.spectrumRequest && !synchronous) return;
            this.cancelSpectrumRequest();
            const { fftWindow, fftOverlap, fftRemoveDc, pairs } = this.settings;
            const preferredSize = this.fftSize;
            const inputs = pairs.filter(pair => pair.visible).map(pair => readSpectrumInput(this.frames, pair, start, end, bounds, preferredSize, fftOverlap));
            const gainUnit = this.gainSpectrum ? (this.gainInDb ? this.settings.gainUnit : 'ratio') : null;
            const parameters = fftSize => ({ fftSize, fftWindow, fftOverlap, fftRemoveDc, gainUnit });
            const empty = info => ({ ...info, [this.settings.viewMode]: [] });
            if (!this.spectrumPool || synchronous || !inputs.some(input => input.blocks >= 2)) {
                const results = inputs.map(({ segments, ...info }) => info.blocks < 2 ? empty(info) :
                    { ...info, ...pairSpectrum(segments, parameters(info.fftSize)) });
                this.publishSpectra(results, key, rate);
                return;
            }
            // While this batch runs, the next animation frame will read the newest window.
            const abort = typeof AbortController === 'function' ? new AbortController() : null;
            const request = { abort };
            this.spectrumRequest = request;
            const jobs = inputs.map(({ segments, ...info }) => {
                if (info.blocks < 2) return empty(info);
                try {
                    return this.spectrumPool.runTask({ kind: 'pairSpectrum', segments, options: parameters(info.fftSize) }, { signal: abort?.signal })
                        .then(result => ({ ...info, ...result }));
                } catch (error) { return Promise.reject(error); }
            });
            Promise.all(jobs).then(results => {
                if (this.spectrumRequest !== request) return;
                this.spectrumRequest = null;
                this.publishSpectra(results, key, rate);
                this.invalidateData();
            }, () => {
                if (this.spectrumRequest !== request) return;
                this.cancelSpectrumRequest();
                this.spectrumPool = null;
                this.invalidateData();
            });
        }
        spectrumXBounds() { return [this.binToAxis(this.logFrequency ? 1 : 0), this.binToAxis(this.axisFftSize / 2)]; }
        spectrumRange() {
            const s = this.settings, key = config.spectrumYRangeKey(s);
            const fixed = [s[key + 'Min'], s[key + 'Max']];
            const [xMin, xMax] = this.zoom?.x ?? this.spectrumXBounds();
            const log = this.logGain, auto = s[key + 'Auto'];
            this.yScale = log ? 'log' : 'linear';
            if (this.zoom?.y) {
                this.yScale = this.yZoomScale;
                return [xMin, xMax, ...this.zoom.y];
            }
            if (!auto && (!log || fixed[0] > 0)) return [xMin, xMax, ...fixed];

            const firstRef = this.axisToBin(xMin), lastRef = this.axisToBin(xMax);
            const wrapThreshold = this.maxSpectrumPhaseStep;
            let min = Infinity, max = -Infinity;
            const include = value => { min = Math.min(min, value); max = Math.max(max, value); };
            for (const { values, fftSize } of this.spectra) {
                const stride = this.axisFftSize / fftSize;
                const first = Math.max(this.logFrequency ? 1 : 0, Math.floor(firstRef / stride));
                const last = Math.min(values.length - 1, Math.ceil(lastRef / stride));
                for (let bin = first; bin <= last; bin++) {
                    const value = values[bin];
                    if (!finite(value) || log && value <= 0) continue;
                    if (bin > first && bin < last) { include(value); continue; }
                    const x = this.binToAxis(bin * stride);
                    if (x >= xMin && x <= xMax) include(value);
                }
                if (s.traceMode === 'points') continue;
                for (const [edge, bin] of [[xMin, first], [xMax, last - 1]]) {
                    if (bin < first || bin >= last) continue;
                    const left = values[bin], right = values[bin + 1];
                    if (!finite(left) || !finite(right) || Math.abs(right - left) > wrapThreshold || log && (left <= 0 || right <= 0)) continue;
                    const lo = this.binToAxis(bin * stride), hi = this.binToAxis((bin + 1) * stride);
                    // Include the clipped part of a line, even when zoomed between two bins.
                    if (lo < edge && edge < hi) {
                        const weight = fraction(edge, lo, hi);
                        include(log ? Math.exp(mix(Math.log(left), Math.log(right), weight)) : mix(left, right, weight));
                    }
                }
            }
            if (log) {
                if (auto) return [xMin, xMax, ...positiveLogBounds(min, max)];
                this.yScale = adaptiveLogScale(Math.max(0, max), fixed[1]);
                return [xMin, xMax, ...fixed];
            }
            if (!finite(min)) return [xMin, xMax, ...fixed];
            if (this.phaseSpectrum) return [xMin, xMax, ...extent(min, max)];
            if (this.gainSpectrum) {
                const [lo, hi] = extent(min, max);
                return [xMin, xMax, this.gainInDb ? lo : Math.max(0, lo), hi];
            }
            const [lo, hi] = min === max ? [min - .05, max + .05] : extent(min, max);
            return [xMin, xMax, Math.max(0, lo), Math.min(1, hi)];
        }
        histogramRange() {
            const { histogram: h, settings: s } = this;
            const x = this.zoom?.x ?? [0, h.bins.length];
            if (this.zoom?.y) return [...x, ...this.zoom.y];
            if (s.yRange === 'manual') return [...x, ...config.histogramYBounds(s, this.windowPoints)];

            const [first, end] = visibleHistogramBins(h.bins.length, x);
            let peak = 0;
            for (let bin = first; bin < end; bin++) peak = Math.max(peak, h.counts[bin]);
            const finiteCount = h.matched + h.missed;
            const yMax = s.scale === 'percent' && finiteCount ? peak * 100 / finiteCount : peak;
            return [...x, 0, Math.max(1, yMax * 1.08)];
        }
        renderNow(synchronousSpectrum = false) {
            if (this.disposed) return;
            this.cancelRender();
            const { frames, settings: s, width, height, svg } = this;
            const end = this.currentFrameIndex() + 1;
            let start = Math.max(0, end - this.windowPoints);
            const xy = this.type === 'xy', spectral = this.spectral;
            let rate = 0;
            if (spectral) {
                const window = this.spectrumWindow(start, end);
                start = window.start; rate = window.rate;
            }
            const bounds = timeBounds(frames, start, end, !spectral && this.historyOrdinal == null && this.windowPoints);
            if (spectral) {
                this.updateSpectra(start, end, bounds, rate, synchronousSpectrum);
                this.frequencyRate = this.spectrumKey ? this.spectrumRate : rate;
            }
            const input = spectral ? [this.spectrumKey, this.frequencyRate, !!this.spectrumRequest] :
                [frames.version, start, end, bounds.first, bounds.last];
            const { x: xZoom, y: yZoom } = this.zoom ?? {};
            const key = [...input, width, height, xy && xZoom, xy && yZoom].join('|');
            if (this.dataKey !== key) {
                if (xy && !spectral) {
                    const viewport = [...(xZoom ?? [s.xAuto ? null : s.xMin, s.xMax]),
                        ...(yZoom ?? [s.yAuto ? null : s.yMin, s.yMax])];
                    this.traces = s.pairs.filter(p => p.visible).map(p =>
                        trajectory(frames, p, start, end, bounds, Math.max(128, width * 3), viewport, height / width));
                }
                else if (!xy) {
                    this.histogram ??= new HistogramWindow(s);
                    this.histogram.update(frames, start, end, bounds);
                }
                this.dataKey = key;
                this.paintKey = null;
            }
            const paintKey = [height, this.windowPoints, this.historyOrdinal, xZoom, yZoom].join('|');
            if (this.paintKey === paintKey) return;
            this.paintKey = paintKey;
            const yFormat = readAxisNumberFormat(s, 'y');
            const digits = yFormat.mode === 'decimal' ? yFormat.decimalPlaces : yFormat.significantDigits;
            const customY = customAxisNumberFormat(yFormat);
            const axisMargin = customY ? Math.max(61, (digits + 7) * 6 + 5) : 61;
            const yGutter = Math.min(axisMargin + labelWidth(this.phaseSuffix), width * (customY ? .4 : .25));
            let top = Math.min(29, height * .15), left = Math.min(25, width * .12);
            const footerHeight = this.historyOrdinal == null ? 22 : 36;
            let right = Math.max(left + 1, width - yGutter), bottom = Math.max(top + 1, height - footerHeight);
            svg.setAttribute('viewBox', [0, 0, width, height].join(' '));
            svg.replaceChildren();
            node(svg, 'rect', { width, height, fill: background });
            let range;
            this.yScale = 'linear';
            if (spectral) range = this.spectrumRange();
            else if (xy) {
                range = this.extentForXY();
                if (this.zoom) {
                    const expanded = s.equalAspect ? equalRanges(range, right - left, bottom - top) : range;
                    range = [...(xZoom ?? (s.xAuto ? expanded : range).slice(0, 2)),
                        ...(yZoom ?? (s.yAuto ? expanded : range).slice(2))];
                }
            } else range = this.histogramRange();
            if (xy && !spectral && s.equalAspect) {
                const expanded = equalRanges(range, right - left, bottom - top);
                // An automatic axis can expand. For a fixed axis or a selected
                // zoom rectangle reduce the plot's pixel area to retain its bounds.
                for (const [axis, auto] of [[0, s.xAuto], [2, s.yAuto]]) {
                    if (auto && !this.zoom || expanded[axis] === range[axis]) continue;
                    const span = fraction(range[axis + 1], expanded[axis], expanded[axis + 1]) -
                        fraction(range[axis], expanded[axis], expanded[axis + 1]);
                    if (axis === 0) { const margin = (right - left) * (1 - span) / 2; left += margin; right -= margin; }
                    else { const margin = (bottom - top) * (1 - span) / 2; top += margin; bottom -= margin; }
                    expanded[axis] = range[axis]; expanded[axis + 1] = range[axis + 1];
                }
                range = expanded;
            }
            this.range = range;
            this.area = { top, left, right, bottom, width: right - left, height: bottom - top };
            const defs = node(svg, 'defs'), clip = node(defs, 'clipPath', { id: this.clipId });
            node(clip, 'rect', { x: left, y: top, width: right - left, height: bottom - top });
            this.axes();
            const group = node(svg, 'g', { 'clip-path': 'url(#' + this.clipId + ')' });
            if (spectral) this.drawSpectrum(group);
            else if (xy) this.drawXY(group);
            else this.drawHistogram(group);
            if (this.historyOrdinal != null) {
                const order = frames.orderAt?.(end - 1), markers = this.navigationMarkers;
                const current = markers?.matches?.[markers.currentMatch];
                const stamp = current && order >= current.startOrder && order <= current.endOrder ? ' · 当前搜索命中' :
                    markers?.timeOrder != null && markers.timeOrder === order ? ' · 时间定位' : '';
                label(svg, left, bottom + 30, '历史样点 ' + end + ' / ' + frames.length + stamp);
            }
            this.overlay = node(svg, 'g', { 'pointer-events': 'none', 'data-overlay': '' });
            this.drawOverlay();
            this.completedDraws++;
        }
        px(x) {
            if (this.range[0] === this.range[1]) return this.area.left;
            return this.area.left + fraction(x, this.range[0], this.range[1]) * this.area.width;
        }
        yAt(ratio) {
            const [, , min, max] = this.range;
            return this.yScale === 'linear' ? mix(min, max, ratio) : axisValueAtFraction(ratio, min, max, this.yScale);
        }
        py(y) {
            const [, , min, max] = this.range;
            const ratio = this.yScale === 'linear' ? fraction(y, min, max) : axisFraction(Math.max(min, y), min, max, this.yScale);
            return this.area.bottom - ratio * this.area.height;
        }
        coords(x, y) {
            const a = this.area, r = this.range;
            return [mix(r[0], r[1], (x - a.left) / a.width), this.yAt((a.bottom - y) / a.height)];
        }
        axes() {
            const { range: r, area: a, svg, settings: s } = this;
            const xFormat = readAxisNumberFormat(s, 'x'), yFormat = readAxisNumberFormat(s, 'y');
            const digits = xFormat.mode === 'decimal' ? xFormat.decimalPlaces : xFormat.significantDigits;
            const labelSpacing = customAxisNumberFormat(xFormat)
                ? Math.max(90, (digits + 7) * (this.type === 'histogram' && s.mode !== 'fixed' ? 14 : 7)) : 90;
            const nx = clamp(Math.floor(a.width / labelSpacing), 1, 12), ny = clamp(Math.floor(a.height / 42), 1, 8);
            const grid = { stroke: '#34383b', 'stroke-width': 1 };
            const xy = this.type === 'xy', yLabelX = a.right + 6, xTicks = [];
            const marks = ['M' + a.left + ' ' + a.bottom + 'H' + a.right + 'V' + a.top];
            const ySuffix = this.phaseSuffix || (!xy && s.scale === 'percent' ? '%' : '');
            const yLabels = tickLabels(Array.from({ length: ny + 1 }, (_, i) => this.yAt(i / ny)), yFormat, this.logGain ? 3 : 6);
            for (let i = 0; i <= ny; i++) {
                const y = a.bottom - a.height * i / ny;
                node(svg, 'line', { x1: a.left, x2: a.right, y1: y, y2: y, ...grid });
                if (yLabels[i] === yLabels[i - 1]) continue;
                marks.push('M' + a.right + ' ' + y + 'h-4');
                label(svg, yLabelX, y, yLabels[i] + ySuffix,
                    { 'text-anchor': 'start', 'dominant-baseline': 'central', fill: '#aaaaaa', 'font-size': 10 });
            }
            if (this.type === 'xy') {
                const divisions = this.spectral ? Math.min(5, nx) : nx;
                const last = r[0] === r[1] ? 0 : divisions;
                const positions = Array.from({ length: last + 1 }, (_, i) => {
                    const value = mix(r[0], r[1], i / divisions);
                    return this.spectral ? this.binToAxis(Math.round(this.axisToBin(value))) : value;
                }).filter((value, i, values) => value >= r[0] && value <= r[1] && value !== values[i - 1]);
                const values = positions.map(value => this.spectral ? this.frequencyAtBin(Math.round(this.axisToBin(value))) : value);
                const hz = this.spectral && this.frequencyUnit === 'Hz', bins = this.spectral && !hz;
                const xLabels = hz ? values.map(value => formatPlotAxisCoordinate(value, xFormat))
                    : bins ? values.map(String) : tickLabels(values, xFormat);
                for (const [i, value] of positions.entries()) {
                    const x = this.px(value), text = xLabels[i] + (hz ? ' Hz' : '');
                    node(svg, 'line', { x1: x, x2: x, y1: a.top, y2: a.bottom, ...grid });
                    xTicks.push({ x: x - a.left, pixels: labelWidth(text), text });
                }
            } else {
                const [first, end] = visibleHistogramBins(this.histogram.bins.length, r);
                const step = Math.max(1, Math.ceil((end - first) / nx));
                const maxChars = Math.max(1, Math.floor((a.width / Math.ceil((end - first) / step) - 6) / 7));
                for (let i = first; i < end; i += step) {
                    const center = (Math.max(i, r[0]) + Math.min(i + 1, r[1])) / 2;
                    const x = this.px(center), value = this.histogram.bins.label(i);
                    node(svg, 'line', { x1: x, x2: x, y1: a.top, y2: a.bottom, ...grid });
                    const text = value.length <= maxChars ? value : value.slice(0, maxChars - 1) + '…';
                    xTicks.push({ x: x - a.left, pixels: labelWidth(text), text });
                }
            }
            for (const { left, text } of layoutAxisTickLabels(xTicks, a.width))
                label(svg, a.left + left, a.bottom + 3, text,
                    { 'dominant-baseline': 'text-before-edge', fill: '#aaaaaa', 'font-size': 10 });
            path(svg, marks, { fill: 'none', stroke: '#888' });
        }
        drawSpectrum(group) {
            const s = this.settings, { left, right } = this.area;
            const firstRef = this.axisToBin(this.range[0]), lastRef = this.axisToBin(this.range[1]);
            const preferredSize = this.fftSize;
            const wrapThreshold = this.maxSpectrumPhaseStep;
            const peaks = [], showPeaks = this.gainSpectrum || this.phaseSpectrum;
            let legendX = left, found = false, complete = false;
            for (const { pair, values, blocks, recovered, samples, fftSize, xDominantBin, yDominantBin } of this.spectra) {
                const name = channelLabel(this.frames, pair.x) + ' / ' + channelLabel(this.frames, pair.y);
                const segment = fftSize + ' 点/段';
                if (legendX < right - 36) {
                    node(node(this.svg, 'line', { x1: legendX, y1: 12, x2: legendX + 12, y2: 12,
                        stroke: pair.color, 'stroke-width': 2 }), 'title', {},
                    name + ' · ' + segment + ' · ' + blocks + ' 段 · 补点 ' + recovered + '/' + samples);
                    const caption = blocks >= 2 && fftSize !== preferredSize ? name + ' · ' + segment : name;
                    label(this.svg, legendX + 16, 16, caption);
                    legendX += 28 + caption.length * 7;
                }
                complete ||= blocks >= 2;
                const stride = this.axisFftSize / fftSize;
                const first = Math.max(this.logFrequency ? 1 : 0, Math.floor(firstRef / stride));
                const end = Math.min(values.length - 1, Math.ceil(lastRef / stride));
                const line = [], dots = [];
                let last = NaN;
                for (let bin = first; bin <= end; bin++) {
                    const value = values[bin];
                    if (!finite(value)) { last = NaN; continue; }
                    found = true;
                    const x = pixel(this.px(this.binToAxis(bin * stride))), y = pixel(this.py(value));
                    const wraps = Math.abs(value - last) > wrapThreshold;
                    if (s.traceMode !== 'points') line.push((finite(last) && !wraps ? 'L' : 'M') + x + ' ' + y);
                    if (s.traceMode !== 'line' || !finite(last) && !finite(values[bin + 1])) dots.push(dot(x, y, 1.7));
                    last = value;
                }
                path(group, line, { fill: 'none', stroke: pair.color, 'stroke-width': 1.4 });
                path(group, dots, { fill: pair.color });
                if (showPeaks) {
                    for (const [axis, bin] of [['x', xDominantBin], ['y', yDominantBin]]) {
                        if (bin == null || this.logFrequency && bin === 0) continue;
                        const refBin = bin * stride, position = this.binToAxis(refBin);
                        if (position < this.range[0] || position > this.range[1]) continue;
                        const radius = axis === 'y' && xDominantBin === yDominantBin ? 6.5 : 4;
                        const valid = finite(values[bin]);
                        const y = valid ? this.py(values[bin]) : this.area.bottom - 8;
                        if (y < this.area.top || y > this.area.bottom) continue;
                        peaks.push({ axis, radius, channel: pair[axis], color: this.getChannelColor(pair[axis]) ?? pair.color,
                            x: this.px(position), y, frequency: this.frequencyAtBin(refBin), value: values[bin], valid });
                    }
                }
            }
            if (peaks.length) {
                const { frequencyUnit } = this, yFormat = readAxisNumberFormat(s, 'y'), xFormat = readAxisNumberFormat(s, 'x');
                const unit = this.phaseSuffix || (this.gainInDb ? ' dB' : '');
                for (const { axis, radius, channel, color, x, y, frequency, value, valid } of peaks) {
                    const marker = node(group, 'circle', { cx: x, cy: y, r: radius, fill: 'none',
                        stroke: color, 'stroke-width': 1.7, 'data-spectrum-peak': axis });
                    if (!valid) marker.setAttribute('stroke-dasharray', '2 2');
                    node(marker, 'title', {}, axis.toUpperCase() + ' 主频 · ' + channelLabel(this.frames, channel) + ' · ' +
                        formatAxisValue(frequency, xFormat) + ' ' + frequencyUnit + ' · ' +
                        (valid ? formatAxisValue(value, yFormat) + unit : '该频点暂无有效谱值'));
                }
            }
            if (!found) {
                const message = !this.spectrumKey && this.spectrumRequest ? '正在计算频谱…' :
                    complete ? '当前频段没有有效谱值' : '至少需要 2 段完整的配对样本';
                this.empty(message);
            }
        }
        drawXY(group) {
            const { area: a, settings: s, svg } = this;
            this.hitPoints = [];
            let legendX = a.left, available = 0;
            for (const { pair, points, samples } of this.traces) {
                const line = [], solid = [], hollow = [];
                const name = channelLabel(this.frames, pair.x) + ' / ' + channelLabel(this.frames, pair.y);
                if (legendX < a.right - 36) {
                    const marker = node(svg, 'line', { x1: legendX, y1: 12, x2: legendX + 12, y2: 12, stroke: pair.color, 'stroke-width': 2 });
                    node(marker, 'title', {}, name);
                    label(svg, legendX + 16, 16, name);
                    legendX += 28 + name.length * 7;
                }
                let previous;
                if (s.traceMode !== 'points') for (const p of points) {
                    const begin = p.move || !previous || previous.segment !== p.segment;
                    line.push((begin ? 'M' : 'L') + pixel(this.px(p.x)) + ' ' + pixel(this.py(p.y)));
                    previous = p;
                }
                previous = null;
                const occupied = new Set();
                for (let i = 0; i < samples.length; i++) {
                    const p = samples[i], x = pixel(this.px(p.x)), y = pixel(this.py(p.y));
                    const begin = !previous || previous.segment !== p.segment;
                    if (x >= a.left - 3 && x <= a.right + 3 && y >= a.top - 3 && y <= a.bottom + 3) {
                        const isolated = begin && samples[i + 1]?.segment !== p.segment;
                        let marker = s.traceMode !== 'line' || isolated;
                        if (p.recovered && !marker) {
                            const neighbor = !begin ? previous : samples[i + 1];
                            const separation = neighbor && Math.hypot(x - this.px(neighbor.x), y - this.py(neighbor.y)) /
                                Math.max(1, Math.abs(p.seq - neighbor.seq));
                            const cell = Math.floor(x / 7) + ',' + Math.floor(y / 7);
                            if (separation >= 6 && !occupied.has(cell)) { marker = true; occupied.add(cell); }
                        }
                        if (marker) (p.recovered ? hollow : solid).push(dot(x, y, p.recovered ? 1.9 : 2.5));
                        this.hitPoints.push({ x, y, p, name, color: pair.color });
                    }
                    previous = p;
                }
                path(group, line, { fill: 'none', stroke: pair.color, 'stroke-width': 1.4, 'stroke-linejoin': 'round' });
                path(group, solid, { fill: pair.color });
                path(group, hollow, { fill: background, stroke: pair.color, 'stroke-width': 1.25 });
                available += points.length;
            }
            if (!available) this.empty('当前窗口没有可配对的有效样本');
        }
        drawHistogram(group) {
            const { histogram: h, area: a, settings: s, svg, range } = this;
            const [first, end] = visibleHistogramBins(h.counts.length, range);
            const bars = [], width = this.px(1) - this.px(0), gap = Math.min(5, width * .08);
            for (let i = first; i < end; i++) {
                if (!h.counts[i]) continue;
                const y = pixel(this.py(s.scale === 'percent' ? h.percent(i) : h.counts[i]));
                const x = pixel(this.px(i) + gap / 2), right = pixel(this.px(i + 1) - gap / 2);
                bars.push('M' + x + ' ' + pixel(this.py(0)) + 'V' + y + 'H' + right + 'V' + pixel(this.py(0)) + 'Z');
            }
            path(group, bars, { fill: s.color });
            label(svg, a.left, 16, '已归类 ' + h.matched + '  ·  未匹配 ' + h.missed + '  ·  无效 ' + h.invalid);
            if (!(h.matched || h.missed || h.invalid)) this.empty('当前窗口没有样本');
        }
        empty(message) { label(this.svg, (this.area.left + this.area.right) / 2, (this.area.top + this.area.bottom) / 2,
            message, { 'text-anchor': 'middle', fill: '#9ca3af' }); }
        localPoint(e) {
            const rect = this.svg.getBoundingClientRect(), a = this.area;
            if (!a || !rect.width || !rect.height) return null;
            const rawX = (e.clientX - rect.left) * this.width / rect.width;
            const rawY = (e.clientY - rect.top) * this.height / rect.height;
            return { x: clamp(rawX, a.left, a.right), y: clamp(rawY, a.top, a.bottom), rawX, rawY,
                inside: rawX >= a.left && rawX <= a.right && rawY >= a.top && rawY <= a.bottom };
        }
        wheel(e) {
            if (e.ctrlKey || e.metaKey || !e.deltaY) return;
            const p = this.localPoint(e);
            if (!p) return;
            if (e.shiftKey) {
                if (!p.inside || !this.isPaused) return;
                this.stepHistory(Math.sign(e.deltaY) * Math.max(1, Math.floor(this.windowPoints / 10)));
            } else {
                const { left, right, top, bottom, width, height } = this.area;
                const axis = plotWheelAxis(p.rawX, p.rawY, { left, right, top, width: this.width, height: this.height });
                if (!axis) return;
                const [xMin, xMax, yMin, yMax] = this.range;
                if (axis === 'x') {
                    const bounds = zoomAxisBounds(xMin, xMax, (p.x - left) / width, e.deltaY, this.horizontalZoomLimits());
                    if (bounds) this.setZoom(bounds, this.zoom?.y);
                } else {
                    const base = this.yZoomBase ?? [yMin, yMax];
                    const bounds = zoomAxisBounds(yMin, yMax, (bottom - p.y) / height, e.deltaY, base, this.yScale);
                    if (bounds) this.setZoom(this.zoom?.x, bounds[0] === base[0] && bounds[1] === base[1] ? null : bounds);
                }
            }
            e.preventDefault(); e.stopPropagation();
        }
        horizontalZoomLimits() {
            if (this.spectral) return this.spectrumXBounds();
            if (this.histogram) return [0, this.histogram.bins.length];
        }
        applyZoom(bounds) {
            this.setZoom(bounds.slice(0, 2), bounds.length === 4 ? bounds.slice(2) : null);
        }
        setZoom(x = null, y = null) {
            const limits = x && this.horizontalZoomLimits();
            if (limits) x = [Math.max(x[0], limits[0]), Math.min(x[1], limits[1])];
            if ([x, y].some(range => range && (!range.every(finite) || !(range[0] < range[1])))) return;
            this.yZoomBase = y ? this.yZoomBase ?? this.range.slice(2) : null;
            this.yZoomScale = y ? this.yScale : null;
            this.zoom = x || y ? { x, y } : null;
            this.invalidateData();
        }
        down(e) {
            const p = this.localPoint(e);
            if (e.ctrlKey || e.metaKey || e.button !== 0 || !p?.inside) return;
            this.drag = p; this.pointer = p; this.svg.focus?.({ preventScroll: true });
            this.svg.setPointerCapture?.(e.pointerId); e.preventDefault();
        }
        move(e) {
            this.pointer = this.localPoint(e);
            this.drawOverlay();
        }
        drawOverlay() {
            const p = this.pointer;
            if (!this.overlay) return;
            this.overlay.replaceChildren();
            if (!p) return;
            if (this.drag) {
                node(this.overlay, 'rect', { x: Math.min(p.x, this.drag.x), y: Math.min(p.y, this.drag.y),
                    width: Math.abs(p.x - this.drag.x), height: Math.abs(p.y - this.drag.y),
                    fill: accent, 'fill-opacity': .16, stroke: accent, 'stroke-dasharray': '4 3' });
            } else if (p.inside) this.hover(p);
        }
        up(e) {
            const p = this.localPoint(e), start = this.drag;
            if (!start) return;
            this.drag = null; this.pointer = p; this.drawOverlay();
            if (this.svg.hasPointerCapture?.(e.pointerId)) this.svg.releasePointerCapture(e.pointerId);
            if (!p || Math.abs(p.x - start.x) < 5 || Math.abs(p.y - start.y) < 5) return;
            const lo = this.coords(Math.min(p.x, start.x), Math.max(p.y, start.y));
            const hi = this.coords(Math.max(p.x, start.x), Math.min(p.y, start.y));
            this.applyZoom([lo[0], hi[0], lo[1], hi[1]]);
        }
        hoverSpectrum(p) {
            const { left, right, top, bottom } = this.area;
            const [axis, cursorY] = this.coords(p.x, p.y);
            const xFormat = readAxisNumberFormat(this.settings, 'x'), yFormat = readAxisNumberFormat(this.settings, 'y');
            const reference = this.axisToBin(axis), minBin = this.logFrequency ? 1 : 0;
            const unit = this.phaseSuffix || (this.gainInDb ? ' dB' : '');
            const yDigits = this.logGain ? 4 : 6;
            const onRight = p.x <= (left + right) / 2;
            const guide = { stroke: 'rgba(255,255,255,0.45)', 'stroke-dasharray': '4 4' };
            node(this.overlay, 'line', { x1: p.x, x2: p.x, y1: top, y2: bottom, ...guide });
            node(this.overlay, 'line', { x1: left, x2: right, y1: p.y, y2: p.y, ...guide });
            const points = [], maxStep = this.maxSpectrumPhaseStep;
            for (const { fftSize, pair, values } of this.spectra) {
                const stride = this.axisFftSize / fftSize;
                const bin = reference / stride, nearest = Math.round(bin);
                const exact = Math.abs(bin - nearest) <= 8 * Number.EPSILON * Math.max(1, bin);
                let lo = exact ? nearest : Math.floor(bin), hi = exact ? nearest : Math.ceil(bin);
                if (this.settings.traceMode === 'points') {
                    const lowX = this.binToAxis(lo * stride), highX = this.binToAxis(hi * stride);
                    lo = hi = lo < minBin || axis - lowX > highX - axis ? hi : lo;
                }
                if (lo < minBin || !finite(values[lo]) || !finite(values[hi]) || Math.abs(values[hi] - values[lo]) > maxStep) {
                    // A valid point next to a gap still needs a small hit area.
                    // Read the point itself without interpolating across the gap.
                    let index = -1, distance = 3;
                    for (const candidate of [lo, hi]) {
                        if (candidate < minBin || !finite(values[candidate])) continue;
                        const offset = Math.abs(this.px(this.binToAxis(candidate * stride)) - p.x);
                        if (offset < distance) { index = candidate; distance = offset; }
                    }
                    if (index === -1) continue;
                    lo = hi = index;
                }
                const a = values[lo], b = values[hi];
                const first = this.binToAxis(lo * stride), last = this.binToAxis(hi * stride);
                const sampleAxis = lo === hi ? first : axis;
                if (sampleAxis < this.range[0] || sampleAxis > this.range[1]) continue;
                const weight = lo === hi ? 0 : fraction(axis, first, last);
                const x = this.px(sampleAxis), y = lo === hi ? this.py(a) : mix(this.py(a), this.py(b), weight);
                const value = lo === hi || a === b ? a : this.logGain ? this.yAt((bottom - y) / this.area.height) : mix(a, b, weight);
                if (!finite(y) || y < top || y > bottom) continue;
                const name = channelLabel(this.frames, pair.x) + ' / ' + channelLabel(this.frames, pair.y);
                points.push({ x, y, color: pair.color, text: name + ': ' + formatAxisValue(value, yFormat, yDigits) + unit });
            }
            points.sort((a, b) => a.y - b.y);
            const height = 16, spacing = Math.min(height, (bottom - top) / Math.max(1, points.length));
            let nextY = top;
            points.forEach(({ x, y, color, text }, i) => {
                const width = labelWidth(text) + 10;
                const lx = clamp(onRight ? x + 8 : x - width - 8, 0, Math.max(0, this.width - width));
                const ly = clamp(y - height / 2, nextY, bottom - height - (points.length - 1 - i) * spacing);
                nextY = ly + spacing;
                node(this.overlay, 'circle', { cx: x, cy: y, r: 4, fill: color, stroke: background });
                node(this.overlay, 'rect', { x: lx, y: ly, width, height, fill: background, 'fill-opacity': .85, stroke: color });
                label(this.overlay, lx + 5, ly + height / 2, text, { fill: color, 'dominant-baseline': 'central' });
            });
            const xUnit = this.frequencyUnit === 'Bin' && this.referenceBins ? '参考 Bin' : this.frequencyUnit;
            return ['X ' + formatAxisValue(this.frequencyAtBin(reference), xFormat) + ' ' + xUnit,
                'Y ' + formatAxisValue(cursorY, yFormat, yDigits) + unit];
        }
        hover(p) {
            const xFormat = readAxisNumberFormat(this.settings, 'x'), yFormat = readAxisNumberFormat(this.settings, 'y');
            let lines;
            if (this.spectral) lines = this.hoverSpectrum(p);
            else if (this.type === 'xy') {
                let nearest, distance = Infinity;
                for (const hit of this.hitPoints ?? []) {
                    const d = (p.x - hit.x) ** 2 + (p.y - hit.y) ** 2;
                    if (d < distance) { distance = d; nearest = hit; }
                }
                if (!nearest) return;
                const sample = nearest.p;
                node(this.overlay, 'circle', { cx: nearest.x, cy: nearest.y, r: 4, fill: 'none', stroke: nearest.color });
                lines = [nearest.name + (sample.recovered ? ' · 补点' : ''),
                    'X ' + formatAxisValue(sample.x, xFormat) + '   Y ' + formatAxisValue(sample.y, yFormat),
                    't ' + numberLabel(sample.time, 15) + ' ms'];
            } else {
                const h = this.histogram, index = Math.floor(this.coords(p.x, p.y)[0]);
                if (index < 0 || index >= h.counts.length) return;
                lines = [channelLabel(this.frames, this.settings.channel) + ' · ' + h.bins.label(index),
                    '频数 ' + h.counts[index] + '  ·  ' + formatAxisValue(h.percent(index), yFormat) + '%'];
            }
            const width = Math.min(this.width, Math.max(...lines.map(labelWidth)) + 14);
            const height = lines.length * 16 + 7;
            const oppositeCurveLabels = this.spectral && p.x <= (this.area.left + this.area.right) / 2;
            const x = clamp(oppositeCurveLabels ? p.x - width - 12 : p.x + 12, 0, Math.max(0, this.width - width));
            const y = clamp(p.y + 10, 0, Math.max(0, this.height - height));
            node(this.overlay, 'rect', { x, y, width, height, rx: 3, fill: '#1b2026', stroke: '#59636e' });
            lines.forEach((line, i) => label(this.overlay, x + 6, y + 15 + i * 16, line));
        }
        exportSvg(title = this.type === 'xy' ? '李萨如图' : '频度直方图') {
            this.renderNow(true);
            const output = this.svg.ownerDocument.createElementNS(NS, 'svg'), band = 26;
            output.setAttribute('width', this.width); output.setAttribute('height', this.height + band);
            output.setAttribute('viewBox', [0, 0, this.width, this.height + band].join(' '));
            output.setAttribute('font-family', 'Consolas, monospace');
            node(output, 'title', {}, title);
            node(output, 'rect', { width: this.width, height: band, fill: background });
            label(output, 8, 18, title, { 'font-size': 14 });
            const chart = node(output, 'g', { transform: 'translate(0 ' + band + ')' });
            for (const child of this.svg.children) if (child !== this.overlay) chart.appendChild(child.cloneNode(true));
            const Serializer = this.win.XMLSerializer ?? root.XMLSerializer;
            return new Serializer().serializeToString(output);
        }
        dispose() {
            this.disposed = true; this.cancelRender(); this.cancelSpectrumRequest(); this.observer?.disconnect();
            this.cleanups.splice(0).forEach(f => f()); this.traces = null; this.histogram = null; this.hitPoints = null; this.spectra = null;
        }
    }
    S.AnalysisPlot = AnalysisPlot;
    if (typeof module !== 'undefined') module.exports = { AnalysisPlot, HistogramWindow, histogramBins, readPairs, trajectory, equalRanges };
})(globalThis);
