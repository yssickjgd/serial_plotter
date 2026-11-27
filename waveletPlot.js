/** Sample windows and heatmap presentation for the shared analysis plot. */
(function (root) {
    const S = root.SerialPlotter ??= {};
    const { createWaveletProcessor, waveletContextSamples, maxWaveletWindowPoints, waveletResolutionGrid,
        maxWaveletGridBytes, waveletColumnSample } = typeof module !== 'undefined' ? require('./wavelet') : S;
    const { nativeChannelEvents, nativeEventEnd, nativeEventRate } =
        typeof module !== 'undefined' ? require('./analysisSamples') : S.AnalysisSamples;
    const clamp = (value, lo, hi) => Math.max(lo, Math.min(hi, value));
    const finite = Number.isFinite;
    const phaseFloor = 1e-4;

    function firstIndex(length, matches, first = 0) {
        let end = length;
        while (first < end) {
            const mid = (first + end) >>> 1;
            if (matches(mid)) end = mid;
            else first = mid + 1;
        }
        return first;
    }

    // An interactive selection is stored in the coordinate system of the image clicked.
    // Apply the live offset only when picking a new, complete frame for display.
    function selectedTimeRange(range, retained, offset, rate) {
        if (!range) return null;
        const span = Math.min(range[1] - range[0], retained[1] - retained[0], (maxWaveletWindowPoints - 1) / rate);
        const first = clamp(range[0] + offset, retained[0], retained[1] - span);
        return [first, first + span];
    }

    function nativeWaveletInput(events, points, time, selectedTime) {
        let stop = nativeEventEnd(events, time);
        const retainedFrom = events.length ? events[0].sampleOrdinal - Number(Boolean(events[0].origin)) : 0;
        if (finite(selectedTime)) {
            // Find the rate section containing this time without scanning all retained packets.
            stop = Math.max(1, firstIndex(events.length, i => (events[i].sampleSection?.time ?? 0) > selectedTime));
        }
        while (stop && !events[stop - 1].origin) stop--;
        const packet = events[stop - 1];
        if (!packet) return null;
        const section = packet.sampleSection, end = packet.sampleOrdinal;
        const from = Math.max(retainedFrom, section?.first ?? 0), start = Math.max(from, end - points);
        const sectionEnd = firstIndex(events.length, i => events[i].sampleSection !== section, stop);
        const until = events[sectionEnd - 1].sampleOrdinal;
        const lower = sample => firstIndex(events.length, i => events[i].sampleOrdinal > sample);
        const rate = section?.fixedRate || nativeEventRate(events[lower(start)], packet, end - start);
        const timeAt = sample => (section?.time ?? 0) + (sample - (section?.first ?? 0)) / rate;
        const firstSection = events[0].sampleSection;
        const firstTime = (firstSection?.time ?? 0) + (retainedFrom - (firstSection?.first ?? 0)) /
            (firstSection?.fixedRate || events[0].origin?.sampleRate || rate);
        return { start, end, from, until, rate, firstTime, timeAt, time: timeAt(end - 1),
            indexAt: seconds => (section?.first ?? 0) + (seconds - (section?.time ?? 0)) * rate,
            timestampAt(index) { const event = events[lower(index)]; return event?.traceTime ?? event?.timestamp; },
            read(first, last) {
                const values = new Float64Array(last - first).fill(NaN), cuts = [];
                let previous = null, gap = false;
                for (let i = lower(first); i < events.length && events[i].sampleOrdinal <= last; i++) {
                    const { origin, value, sampleOrdinal } = events[i];
                    if (!origin) { gap = true; continue; }
                    const index = sampleOrdinal - first - 1;
                    if (previous && (gap || origin.breakBefore || origin.missingBefore || origin.epoch !== previous.epoch ||
                        origin.generation !== previous.generation || origin.fixedSampleRate !== previous.fixedSampleRate)) cuts.push(index);
                    values[index] = value;
                    previous = origin;
                    gap = false;
                }
                return { values, cuts };
            } };
    }

    // Amplitude and phase are obtained from the same transform. Share only in-flight
    // work for the same source and window; each view owns its viewport and presentation.
    const pendingByPool = new WeakMap();
    function acquireTransform(pool, source, key, makeTask) {
        let sources = pendingByPool.get(pool);
        if (!sources) pendingByPool.set(pool, sources = new WeakMap());
        let jobs = sources.get(source);
        if (!jobs) sources.set(source, jobs = new Map());
        let job = jobs.get(key);
        if (!job) {
            const abort = typeof AbortController === 'function' ? new AbortController() : null;
            const promise = pool.runTask(makeTask(), { signal: abort?.signal });
            job = { promise, abort, users: 0 };
            jobs.set(key, job);
            const forget = () => { if (jobs.get(key) === job) jobs.delete(key); };
            promise.then(forget, forget);
        }
        job.users++;
        return { promise: job.promise, release() {
            if (--job.users || jobs.get(key) !== job) return;
            jobs.delete(key);
            job.abort?.abort();
        } };
    }

    class WaveletWindow {
        constructor(pool, redraw, onResolutionInfo) {
            this.pool = pool;
            this.redraw = redraw;
            this.onResolutionInfo = onResolutionInfo;
        }
        setResolutionInfo(count, rate) {
            if (this.resolutionInfo?.count === count && this.resolutionInfo?.rate === rate) return;
            this.resolutionInfo = count > 0 && rate > 0 ? { count, rate } : null;
            this.onResolutionInfo?.(this.resolutionInfo);
        }
        cancel() {
            const request = this.request;
            this.request = null;
            request?.release?.();
            clearTimeout(request?.timer);
        }
        resumeFullWindow() {
            this.cancel();
            this.snapshot = null;
            this.requestedWindow = null;
            this.error = '';
            this.errorKey = null;
            // update() validates the retained full window against the current source before displaying it.
        }
        clear() {
            this.cancel();
            this.snapshot = null;
            this.fullSnapshot = null;
            this.sourceEvents = null;
            this.error = '';
            this.errorKey = null;
            this.resolutionKey = null;
            this.requestedWindow = null;
            this.setResolutionInfo();
        }
        setResolution(settings) {
            const frequencyScale = settings.frequencyScale ?? 'log';
            const key = [frequencyScale, settings.frequencyRows || 0, settings.timeColumns || 0, settings.timeStride || 0].join('/');
            if (this.resolutionKey === key) return;
            this.cancel();
            this.resolutionKey = key;
            this.error = '';
            this.errorKey = null;
            if (this.snapshot && this.snapshot.result.frequencyScale !== frequencyScale) this.snapshot = null;
            this.fullSnapshot = null;
        }
        displaySnapshot(range, allowPrevious = false) {
            const covers = s => s && (allowPrevious || !this.error && s.resolutionKey === this.resolutionKey) &&
                (!range || s.coverage[0] <= range[0] + 1e-9 && s.coverage[1] >= range[1] - 1e-9);
            if (!range) return !this.snapshot?.selection && covers(this.snapshot) ? this.snapshot : null;
            return covers(this.snapshot) ? this.snapshot : covers(this.fullSnapshot) ? this.fullSnapshot : null;
        }
        update(frames, start, end, clock, settings, zoom, paused,
            { historical, followFrom, windowPoints = end - start } = {}) {
            const { channel, basis, edgeExtension = 'mirror', removeDc = false, frequencyScale = 'log',
                frequencyRows = 0, timeColumns = 0, timeStride = 0 } = settings;
            this.message = channel == null ? '请选择一个输入通道' : '等待有效数值样点';
            if (channel == null || channel >= frames.channelCount || frames.isSignal?.(channel) === false) {
                this.clear();
                return;
            }
            const events = nativeChannelEvents(frames, channel);
            if (this.sourceEvents !== events) {
                this.clear();
                this.sourceEvents = events;
            }
            this.setResolution(settings);
            windowPoints = Math.min(maxWaveletWindowPoints, windowPoints);
            const liveInput = events && nativeWaveletInput(events, windowPoints, Infinity);
            let input = liveInput && historical ? nativeWaveletInput(events, windowPoints, frames.timestampAt(end - 1)) : liveInput;
            if (events && !input || !events && end <= start) {
                this.clear();
                return;
            }
            const liveClock = liveInput ?? clock(frames.length - 1);
            let liveRate = liveClock.rate;
            if (!(liveRate > 0) && frames.length > 1) {
                const first = Math.max(0, frames.length - windowPoints);
                const elapsed = frames.timestampAt(frames.length - 1) - frames.timestampAt(first);
                if (elapsed > 0) liveRate = (frames.length - first - 1) * 1000 / elapsed;
            }
            if (!(liveRate > 0)) { this.setResolutionInfo(); this.message = '等待来源采样率'; return; }
            const frameTime = index => {
                const { time } = clock(index);
                return finite(time) ? time : (frames.frameOrdinalAt?.(index) ?? (frames.head ?? 0) + index) / liveRate;
            };
            const liveTime = liveInput ? liveInput.time : frameTime(frames.length - 1);
            const retained = [liveInput ? liveInput.firstTime : frameTime(0), liveTime];
            let selection = selectedTimeRange(zoom, retained, finite(followFrom) ? liveTime - followFrom : 0, liveRate);
            if (input && selection) input = nativeWaveletInput(events, windowPoints, Infinity, selection[1]);
            if (input) { start = input.start; end = input.end; }
            if (selection) {
                // Locate the end of the requested region and only transform its sample window and support.
                if (input) end = clamp(Math.ceil(input.indexAt(selection[1])) + 1, input.from + 1, input.until);
                else end = Math.min(frames.length, firstIndex(frames.length, i => frameTime(i) >= selection[1]) + 1);
            }
            let { rate, time, from = 0, until = frames.length } = input ?? clock(end - 1);
            if (!(rate > 0)) rate = liveRate;
            if (!input) until = Math.min(until, frames.length);
            if (!input && frames.segments?.length) {
                const head = frames.head ?? 0, ordinal = head + end - 1;
                const index = frames.segments.findLastIndex(segment => segment.first <= ordinal);
                const segments = frames.segments, segment = segments[index];
                if (segment) {
                    rate = 1000 / segment.step;
                    const contiguous = (a, b) => a.step === b.step &&
                        Math.abs(b.time - (a.time + (b.first - a.first) * a.step)) < a.step / 4;
                    let first = index, stop = index + 1;
                    while (first > 0 && contiguous(segments[first - 1], segments[first])) first--;
                    while (stop < segments.length && contiguous(segments[stop - 1], segments[stop])) stop++;
                    from = Math.max(from, segments[first].first - head);
                    if (stop < segments.length) until = Math.min(until, segments[stop].first - head);
                }
            }
            const ordinal = input ? 0 : frames.frameOrdinalAt?.(0) ?? frames.head ?? 0;
            if (selection) {
                // Cropping a displayed window must keep its sample grid, mean and wavelet scales.
                const anchor = this.snapshot ?? this.requestedWindow;
                const shift = anchor && finite(followFrom) ? Math.round((liveTime - anchor.liveTime) * rate) : 0;
                const anchoredStart = anchor && anchor.windowOrdinal - ordinal + shift;
                const anchoredEnd = anchor && anchoredStart + anchor.windowCount;
                const tolerance = 1e-6 / rate;
                if (anchor && rate === anchor.rate && anchoredStart >= from && anchoredEnd <= until &&
                    selection[0] >= anchor.t0 + shift / rate - tolerance &&
                    selection[1] <= anchor.lastTime + shift / rate + tolerance) {
                    start = anchoredStart; end = anchoredEnd;
                } else {
                    const selectedPoints = Math.ceil((selection[1] - selection[0]) * rate) + 1;
                    const points = Math.min(maxWaveletWindowPoints, Math.max(windowPoints, selectedPoints + 1));
                    end = Math.min(until, Math.max(end, from + points));
                    start = Math.max(from, end - points);
                }
                time = input ? input.timeAt(end - 1) : frameTime(end - 1);
            } else if (end - start > windowPoints) {
                start = end - windowPoints;
            }
            if (!(rate > 0) || !finite(rate)) {
                this.message = '等待来源采样率';
                return;
            }
            this.message = '等待更多有效样点';
            start = Math.max(start, from);
            const count = end - start;
            this.setResolutionInfo(count, rate);
            if (count < 16) return;
            const lastTime = finite(time) ? time : (frames.frameOrdinalAt?.(end - 1) ?? end - 1) / rate;
            const t0 = lastTime - (count - 1) / rate;
            if (selection) selection = selectedTimeRange(selection, [t0, lastTime], 0, rate);
            const first = selection ? clamp(Math.floor((selection[0] - t0) * rate) - 1, 0, count - 1) : 0;
            const last = selection ? clamp(Math.ceil((selection[1] - t0) * rate) + 1, first, count - 1) : count - 1;
            const minimumHop = paused ? 1 : Math.max(1, count / 8192);
            const context = waveletContextSamples(count);
            const inputStart = Math.max(0, from, start - context), inputEnd = Math.min(until, end + context, input ? Infinity : frames.length);
            const stableHistory = (selection && !finite(followFrom) || historical) && !frames.rebuilding &&
                finite(frames.generation) && (events || frames.raw || frames.segments);
            const revision = stableHistory ? [frames.generation, frames.revision, frames.storageRevision] : frames.version;
            const key = [revision, ordinal + start, ordinal + end, ordinal + inputStart, ordinal + inputEnd,
                channel, basis, edgeExtension, removeDc, rate, t0, first, last, minimumHop, this.resolutionKey].join('|');
            const viewIndex = selection ? start + clamp(Math.round((selection[1] - t0) * rate), 0, count - 1) : end - 1;
            const viewNativeTime = input?.timestampAt(viewIndex);
            const viewOrdinal = input ? null : frames.frameOrdinalAt?.(viewIndex) ?? ordinal + viewIndex;
            const position = { liveTime, retained, zoom, followFrom, selection, viewNativeTime, viewOrdinal,
                windowOrdinal: ordinal + start, windowCount: count };
            if (!zoom && this.fullSnapshot?.key === key && this.snapshot !== this.fullSnapshot) {
                this.cancel();
                this.snapshot = this.fullSnapshot;
                this.onResolutionInfo?.(this.resolutionInfo);
            } else if (!zoom && !this.snapshot) this.fullSnapshot = null;
            if (this.snapshot?.key === key) {
                this.error = '';
                this.errorKey = null;
                Object.assign(this.snapshot, position);
                return;
            }
            if (this.request || this.errorKey === key) return;
            const gridOptions = { rate, basis, first, last, visibleLength: count, minimumHop, timeColumns, timeStride, frequencyRows, frequencyScale };
            const grid = waveletResolutionGrid(gridOptions);
            this.requestedWindow = { ...position, rate, t0, lastTime, frequencyRange: grid.rows ? [grid.minHz, grid.nyquist] : null };
            if (grid.bytes > maxWaveletGridBytes) {
                this.error = '当前网格需要 ' + Math.ceil(grid.bytes / 1048576) +
                    ' MiB，单次上限为 ' + maxWaveletGridBytes / 1048576 + ' MiB。请框选较短时间范围或降低分辨率。';
                this.errorKey = key;
                return;
            }
            this.error = '';
            this.errorKey = null;
            const makeTask = () => {
                const samples = input ? input.read(inputStart, inputEnd) : {
                    values: frames.copyChannel?.(channel, inputStart, inputEnd) ??
                        Float64Array.from({ length: inputEnd - inputStart }, (_, i) => frames.getValue(channel, inputStart + i)) };
                return { kind: 'wavelet', ...samples, ...gridOptions, edgeExtension, removeDc, visibleStart: start - inputStart };
            };
            const snapshot = { key, rate, t0, lastTime, resolutionKey: this.resolutionKey, ...position,
                coverage: [t0 + first / rate, t0 + last / rate] };
            const publish = result => {
                const previous = this.snapshot;
                this.snapshot = { ...snapshot, result };
                if (!zoom) this.fullSnapshot = this.snapshot;
                else if (this.fullSnapshot && this.fullSnapshot.result.magnitude.byteLength > 32 * 1024 * 1024)
                    this.fullSnapshot = null;
                this.error = '';
                if (previous?.resolutionKey !== snapshot.resolutionKey || previous.rate !== rate ||
                    previous.result.frequencies.length !== result.frequencies.length || previous.result.hop !== result.hop ||
                    previous.result.columns !== result.columns || previous.result.fullColumns !== result.fullColumns)
                    this.onResolutionInfo?.(this.resolutionInfo);
            };
            // Each scale transforms the whole input even when only a few output columns are requested.
            if (!this.pool && grid.rows * grid.columns <= 100000 && grid.rows * (inputEnd - inputStart) <= 800000 && count <= 8192) {
                const processor = createWaveletProcessor(makeTask());
                processor.step(Infinity); publish(processor.result());
                return;
            }
            const request = this.request = {};
            // Each widget keeps one transform in flight. The next animation frame
            // picks the latest input, so intermediate windows never build up.
            const complete = result => {
                if (this.request !== request) return;
                this.request = null; publish(result);
                this.redraw();
            };
            const fail = error => {
                if (this.request !== request) return;
                this.request = null; this.error = error.message; this.errorKey = key;
                this.redraw();
            };
            if (this.pool) {
                try {
                    const shared = acquireTransform(this.pool, events ?? frames, key, makeTask);
                    request.release = shared.release;
                    shared.promise.then(complete, fail);
                } catch (error) { fail(error); }
                return;
            }
            // A browser without a worker still gets input/render turns between FFT rows.
            const task = makeTask();
            let processor;
            const advance = () => {
                if (request !== this.request) return;
                try {
                    processor ??= createWaveletProcessor(task);
                    const until = performance.now() + 6;
                    do {
                        if (processor.step(1)) { complete(processor.result()); return; }
                    } while (performance.now() < until);
                    request.timer = setTimeout(advance, 0);
                } catch (error) { fail(error); }
            };
            request.timer = setTimeout(advance, 0);
        }
    }

    function channelHue(rgb) {
        const [r, g, b] = rgb, max = Math.max(...rgb), min = Math.min(...rgb), delta = max - min;
        if (!delta) return 0;
        return ((max === r ? (g - b) / delta : max === g ? (b - r) / delta + 2 : (r - g) / delta + 4) + 6) % 6;
    }
    function hueColor(hue) {
        const x = Math.round(255 * (1 - Math.abs(hue % 2 - 1)));
        return [[255, x, 0], [x, 255, 0], [0, 255, x], [0, x, 255], [x, 0, 255], [255, 0, x]][Math.floor(hue)];
    }
    function tint(rgb, level) {
        return rgb.map(value => Math.round(17 + level * (value - 17)));
    }
    function waveletPalette(color, mode) {
        const rgb = [1, 3, 5].map(i => parseInt(color.slice(i, i + 2), 16));
        if (mode !== 'phase' && mode !== true) {
            const max = Math.max(...rgb);
            const brightest = max ? rgb.map(value => 255 * value / max) : [255, 255, 255];
            if (mode === 'signed') {
                const min = Math.min(...brightest);
                // A half-turn in HSV preserves the channel's saturation. Gray has no hue.
                const negative = min === 255 ? [0, 170, 255] : brightest.map(value => 255 + min - value);
                return Array.from({ length: 127 }, (_, i) => tint(i < 63 ? negative : brightest, Math.abs(i - 63) / 63));
            }
            return Array.from({ length: 64 }, (_, i) => tint(brightest, i / 63));
        }
        const hue = channelHue(rgb);
        return Array.from({ length: 64 * 8 }, (_, i) => {
            const color = hueColor((hue + (i % 64) / 64 * 6 + 6) % 6);
            return tint(color, Math.floor(i / 64) / 7);
        });
    }
    function visibleMagnitude(result, index, phase) {
        const magnitude = result.magnitude[index];
        return phase && (!(magnitude >= result.peak * phaseFloor) || !finite(result.phase[index])) ? NaN : magnitude;
    }
    function cellIndex(result, index, mode, scale) {
        const phase = mode === true || mode === 'phase';
        const magnitude = visibleMagnitude(result, index, phase);
        if (!finite(magnitude)) return -1;
        if (mode === 'signed') {
            if (!result.sign) return -1;
            const level = scale.max > 0 ? Math.round(63 * Math.min(1, magnitude / scale.max)) : 0;
            return 63 + result.sign[index] * level;
        }
        const ratio = scale.max > scale.min ? clamp((magnitude - scale.min) / (scale.max - scale.min), 0, 1) : Number(magnitude > 0);
        if (!phase) return Math.round(63 * ratio);
        const hue = Math.round((result.phase[index] / (2 * Math.PI) + 1) * 64) % 64;
        const strength = Math.min(7, Math.floor(8 * ratio ** .25));
        return strength * 64 + hue;
    }
    function frequencyMidpoint(result, lowerRow) {
        const low = result.frequencies[lowerRow], high = result.frequencies[lowerRow + 1];
        return result.frequencyScale === 'linear' ? low + (high - low) / 2 : Math.sqrt(low * high);
    }
    function frequencyBoundaries(result) {
        const { frequencies } = result;
        const edges = new Float64Array(frequencies.length + 1);
        edges[0] = frequencies[0]; edges[frequencies.length] = frequencies.at(-1);
        for (let i = 1; i < frequencies.length; i++) edges[i] = frequencyMidpoint(result, i - 1);
        return edges;
    }
    function columnBoundary(result, column) {
        return (waveletColumnSample(result, column - 1) + waveletColumnSample(result, column)) / 2;
    }
    function nearestColumn(result, run, sample, tiesRight) {
        if (!result.positions) {
            const offset = (sample - result.first) / result.hop;
            return clamp(tiesRight ? Math.floor(offset + .5) : Math.ceil(offset - .5), run.from, run.until - 1);
        }
        let lo = run.from, hi = run.until - 1;
        while (lo < hi) {
            const mid = (lo + hi) >>> 1, boundary = columnBoundary(result, mid + 1);
            if (sample > boundary || tiesRight && sample === boundary) lo = mid + 1;
            else hi = mid;
        }
        return lo;
    }
    function timeLane(result, sample) {
        const { runs, first, hop } = result;
        let low = 0, high = runs.length;
        while (low < high) {
            const mid = (low + high) >>> 1;
            if (sample >= runs[mid].end - .5) low = mid + 1;
            else high = mid;
        }
        const run = runs[low];
        if (!run || sample < run.start - .5) return -1;
        if (!result.positions && (sample < first + (run.from - 1) * hop || sample > first + run.until * hop)) return -1;
        return nearestColumn(result, run, sample, true);
    }
    function heatmapLanes(plot, { result, t0, rate, coverage }) {
        const { first, hop, runs, positions } = result;
        const [xMin, xMax] = plot.range;
        const low = (Math.max(xMin, positions && coverage ? coverage[0] : -Infinity) - t0) * rate;
        const high = (Math.min(xMax, positions && coverage ? coverage[1] : Infinity) - t0) * rate;
        return runs.flatMap(run => {
            const left = Math.max(low, run.start - .5, positions ? -Infinity : first + (run.from - 1) * hop);
            const right = Math.min(high, run.end - .5, positions ? Infinity : first + run.until * hop);
            if (left >= right) return [];
            const from = nearestColumn(result, run, left, true);
            const until = nearestColumn(result, run, right, false) + 1;
            return [{ left, right, from, until, run }];
        });
    }
    function hasWaveletCoefficients(result) {
        return result && (result.minMagnitude === undefined ? result.magnitude.some(finite) : finite(result.minMagnitude));
    }
    function heatmapColorScale(plot, snapshot, phase) {
        const { result } = snapshot, { frequencies, columns } = result;
        const [xMin, xMax, yMin, yMax] = plot.range;
        if (!phase && finite(result.minMagnitude) && xMin <= snapshot.t0 + waveletColumnSample(result, 0) / snapshot.rate + 1e-10 &&
            xMax >= snapshot.t0 + waveletColumnSample(result, columns - 1) / snapshot.rate - 1e-10 &&
            yMin <= frequencies[0] && yMax >= frequencies.at(-1))
            return { min: result.minMagnitude, max: result.peak };
        const key = [phase, xMin, xMax, yMin, yMax].join('|');
        if (snapshot.scaleKey === key) return snapshot.visibleScale;
        const edges = frequencyBoundaries(result), lanes = heatmapLanes(plot, snapshot);
        const { blockWidth, blockMin, blockMax } = result;
        const blocksPerRow = blockWidth ? Math.ceil(columns / blockWidth) : 0;
        const threshold = result.peak * phaseFloor;
        let min = Infinity, max = -Infinity;
        for (let row = 0; row < frequencies.length; row++) {
            if (edges[row + 1] <= yMin || edges[row] >= yMax) continue;
            for (const lane of lanes) {
                let col = lane.from;
                while (col < lane.until) {
                    const nextBlock = blocksPerRow ? Math.min(columns, (Math.floor(col / blockWidth) + 1) * blockWidth) : lane.until;
                    const end = Math.min(nextBlock, lane.until);
                    if (blocksPerRow && col % blockWidth === 0 && end === nextBlock) {
                        const block = row * blocksPerRow + col / blockWidth;
                        const lo = blockMin[block], hi = blockMax[block];
                        if (!finite(lo) || phase && (hi < threshold || hi === 0)) { col = end; continue; }
                        if (!phase || lo >= threshold && lo > 0) {
                            min = Math.min(min, lo); max = Math.max(max, hi);
                            col = end;
                            continue;
                        }
                    }
                    for (; col < end; col++) {
                        const magnitude = visibleMagnitude(result, row * columns + col, phase);
                        if (finite(magnitude)) { min = Math.min(min, magnitude); max = Math.max(max, magnitude); }
                    }
                }
            }
        }
        snapshot.scaleKey = key;
        return snapshot.visibleScale = finite(min) ? { min, max } : { min: 0, max: 0 };
    }
    // Use the same cell centers for canvas pixels, dense SVG tiles and their reference hatching.
    function heatmapPixelGrid(plot, snapshot) {
        const { result, t0, rate, coverage } = snapshot;
        const width = Math.max(1, Math.ceil(plot.area.width));
        const height = Math.max(1, Math.min(512, Math.ceil(plot.area.height)));
        const key = [width, height, plot.yScale, ...plot.range].join('|');
        if (snapshot.gridAxis === plot.yAt && snapshot.gridKey === key) return snapshot.pixelGrid;
        const [xMin, xMax] = plot.range;
        const left = (xMin - t0) * rate, span = (xMax - xMin) * rate;
        const low = result.positions && coverage ? (coverage[0] - t0) * rate : -Infinity;
        const high = result.positions && coverage ? (coverage[1] - t0) * rate : Infinity;
        const columns = Int32Array.from({ length: width }, (_, i) => {
            const sample = left + span * (i + .5) / width;
            return sample < low || sample > high ? -1 : timeLane(result, sample);
        });
        const edges = frequencyBoundaries(result);
        let row = result.frequencies.length - 1;
        const rows = Int32Array.from({ length: height }, (_, i) => {
            const frequency = plot.yAt(1 - (i + .5) / height);
            while (row >= 0 && frequency < edges[row]) row--;
            return frequency <= edges.at(-1) ? row : -1;
        });
        snapshot.gridKey = key;
        snapshot.gridAxis = plot.yAt;
        return snapshot.pixelGrid = { width, height, columns, rows };
    }
    function pixelAreas(plot, snapshot, keyAt) {
        const grid = heatmapPixelGrid(plot, snapshot), paths = new Map();
        const { left, top, width, height } = plot.area;
        const dx = width / grid.width, dy = height / grid.height;
        for (let y = 0; y < grid.height;) {
            const row = grid.rows[y], topY = y++;
            while (y < grid.height && grid.rows[y] === row) y++;
            if (row < 0) continue;
            const offset = row * snapshot.result.columns;
            let begin = 0, color = -1, previousColumn = -2;
            for (let x = 0; x <= grid.width; x++) {
                const col = grid.columns[x];
                if (col === previousColumn) continue;
                previousColumn = col;
                const next = col >= 0 ? keyAt(offset + col) : -1;
                if (next === color) continue;
                if (color >= 0) {
                    if (!paths.has(color)) paths.set(color, []);
                    paths.get(color).push([left + begin * dx, top + topY * dy, left + x * dx, top + y * dy]);
                }
                begin = x;
                color = next;
            }
        }
        return paths;
    }
    function heatmapAreas(plot, snapshot, keyAt, referencesOnly = false) {
        const { result, t0, rate } = snapshot, { frequencies, columns } = result;
        if (plot.area && frequencies.length * columns > Math.max(65536, 2 * plot.area.width * plot.area.height))
            return pixelAreas(plot, snapshot, keyAt);
        const edges = frequencyBoundaries(result), paths = new Map(), lanes = heatmapLanes(plot, snapshot);
        const [, , yMin, yMax] = plot.range;
        const x = sample => plot.px(t0 + sample / rate);
        for (let row = 0; row < frequencies.length; row++) {
            if (edges[row + 1] <= yMin || edges[row] >= yMax) continue;
            const top = plot.py(Math.min(yMax, edges[row + 1])), bottom = plot.py(Math.max(yMin, edges[row]));
            for (const lane of lanes) for (let begin = lane.from; begin < lane.until;) {
                if (referencesOnly && result.reference.subarray && !result.reference[row * columns + begin]) {
                    const offset = row * columns;
                    const skip = result.reference.subarray(offset + begin, offset + lane.until).indexOf(1);
                    if (skip < 0) break;
                    begin += skip;
                }
                const color = keyAt(row * columns + begin);
                let end = begin + 1;
                while (end < lane.until && keyAt(row * columns + end) === color) end++;
                if (color >= 0) {
                    let path = paths.get(color);
                    if (!path) paths.set(color, path = []);
                    const left = x(begin === lane.run.from ? lane.left : Math.max(lane.left, columnBoundary(result, begin)));
                    const right = x(end === lane.run.until ? lane.right : Math.min(lane.right, columnBoundary(result, end)));
                    if (right > left) path.push([left, top, right, bottom]);
                }
                begin = end;
            }
        }
        return paths;
    }
    function heatmapPaths(plot, snapshot, mode, palette, scale = heatmapColorScale(plot, snapshot, mode === true || mode === 'phase')) {
        const paths = heatmapAreas(plot, snapshot, index => cellIndex(snapshot.result, index, mode, scale));
        return [...paths].map(([color, paths]) => [palette[color], paths]);
    }
    function heatmapReferenceAreas(plot, snapshot, phase) {
        const { result } = snapshot;
        const a = plot.area;
        const key = [phase, plot.yScale, ...plot.range, a?.left, a?.top, a?.width, a?.height].join('|');
        if (key === snapshot.hatchingKey && snapshot.hatchingX === plot.px && snapshot.hatchingY === plot.py)
            return snapshot.hatchingAreas;
        const areas = result.reference.length <= 65536 && !result.reference.includes(1) ? [] :
            heatmapAreas(plot, snapshot, index => result.reference[index] && finite(visibleMagnitude(result, index, phase)) ? 0 : -1,
                true).get(0) ?? [];
        // Avoid retaining large vector paths in an old full-window fallback snapshot.
        snapshot.hatchingKey = areas.length <= 8192 ? key : null;
        snapshot.hatchingAreas = snapshot.hatchingKey ? areas : null;
        snapshot.hatchingX = plot.px; snapshot.hatchingY = plot.py;
        return areas;
    }
    const imageBuffers = new WeakMap();
    const pixelPalettes = new WeakMap();
    function packedPalette(palette) {
        let colors = pixelPalettes.get(palette);
        if (colors) return colors;
        const rgba = new Uint8Array(palette.length * 4);
        palette.forEach((rgb, i) => {
            rgba.set(rgb, i * 4);
            rgba[i * 4 + 3] = 255;
        });
        colors = new Uint32Array(rgba.buffer);
        pixelPalettes.set(palette, colors);
        return colors;
    }
    function paintHeatmap(plot, snapshot, mode, palette, canvas, scale) {
        const ctx = canvas.getContext?.('2d');
        if (!ctx?.createImageData || !ctx.putImageData) return false;
        const { result } = snapshot, { columns } = result;
        const grid = heatmapPixelGrid(plot, snapshot);
        const { width, height, rows, columns: indexes } = grid;
        const resized = canvas.width !== width || canvas.height !== height;
        if (canvas.width !== width) canvas.width = width;
        if (canvas.height !== height) canvas.height = height;
        let buffer = imageBuffers.get(canvas);
        if (!resized && buffer?.grid === grid && buffer.mode === mode && buffer.palette === palette &&
            buffer.minimum === scale.min && buffer.maximum === scale.max) return true;
        if (!buffer || buffer.width !== width || buffer.height !== height) {
            const image = ctx.createImageData(width, height);
            if (!image?.data) return false;
            const pixels = new Uint32Array(image.data.buffer, image.data.byteOffset, width * height);
            imageBuffers.set(canvas, buffer = { width, height, image, pixels });
        }
        const { image, pixels } = buffer, colors = packedPalette(palette);
        for (let y = 0; y < height;) {
            const row = rows[y], start = y * width;
            let bottom = y + 1;
            while (bottom < height && rows[bottom] === row) bottom++;
            if (row < 0) pixels.fill(0, start, bottom * width);
            else {
                const offset = row * columns;
                let previous = -2, rgba = 0;
                for (let x = 0; x < width; x++) {
                    const column = indexes[x];
                    if (column !== previous) {
                        const color = column >= 0 ? cellIndex(result, offset + column, mode, scale) : -1;
                        rgba = color >= 0 ? colors[color] : 0;
                        previous = column;
                    }
                    pixels[start + x] = rgba;
                }
                // A coarse frequency row often fills hundreds of screen scanlines.
                for (let dest = start + width; dest < bottom * width; dest += width)
                    pixels.copyWithin(dest, start, start + width);
            }
            y = bottom;
        }
        ctx.putImageData(image, 0, 0);
        Object.assign(buffer, { grid, mode, palette, minimum: scale.min, maximum: scale.max });
        return true;
    }
    function waveletCell(snapshot, time, frequency) {
        const { result, t0, rate } = snapshot, { frequencies, columns } = result;
        if (!frequencies.length || time < t0 || time > snapshot.lastTime ||
            frequency < frequencies[0] || frequency > frequencies.at(-1)) return null;
        if (result.positions && snapshot.coverage && (time < snapshot.coverage[0] || time > snapshot.coverage[1])) return null;
        let lo = 0, hi = frequencies.length - 1;
        while (lo < hi) {
            const mid = (lo + hi) >>> 1;
            if (frequency >= frequencyMidpoint(result, mid)) lo = mid + 1;
            else hi = mid;
        }
        const row = lo;
        const column = timeLane(result, (time - t0) * rate);
        if (column < 0) return null;
        const index = row * columns + column;
        const magnitude = result.magnitude[index];
        const phase = result.phase && magnitude >= result.peak * phaseFloor ? result.phase[index] : NaN;
        const signed = result.sign ? magnitude * result.sign[index] : NaN;
        return { magnitude, phase, signed, frequency: frequencies[row], reference: Boolean(result.reference[index]) };
    }
    function* waveletCsv(snapshot, onProgress) {
        const { result, t0, rate } = snapshot, { frequencies, columns } = result;
        yield 'time_s,frequency_hz,magnitude,phase_rad,status' + (result.sign ? ',signed_coefficient' : '') + '\r\n';
        for (let row = 0; row < frequencies.length; row++) {
            const lines = [];
            for (let column = 0; column < columns; column++) {
                const index = row * columns + column;
                const magnitude = result.magnitude[index];
                const phase = result.phase?.[index];
                const status = finite(magnitude) ? result.reference[index] ? 'reference' : 'observed' : 'missing';
                const fields = [t0 + waveletColumnSample(result, column) / rate, frequencies[row],
                    finite(magnitude) ? magnitude : '', finite(phase) ? phase : '', status];
                if (result.sign) fields.push(finite(magnitude) ? magnitude * result.sign[index] : '');
                lines.push(fields.join(','));
                if (lines.length === 4096) {
                    yield lines.join('\r\n') + '\r\n';
                    lines.length = 0;
                }
            }
            if (lines.length) yield lines.join('\r\n') + '\r\n';
            onProgress?.(row + 1, frequencies.length);
        }
    }
    S.WaveletPlot = { WaveletWindow, selectedTimeRange, maxWaveletWindowPoints, waveletPalette, heatmapColorScale, hasWaveletCoefficients,
        heatmapPaths, heatmapReferenceAreas, paintHeatmap, waveletCell, waveletCsv };
    if (typeof module !== 'undefined') module.exports = S.WaveletPlot;
})(globalThis);
