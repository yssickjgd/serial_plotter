/** Sample windows and heatmap presentation for the shared analysis plot. */
(function (root) {
    const S = root.SerialPlotter ??= {};
    const { createWaveletProcessor } = typeof module !== 'undefined' ? require('./wavelet') : S;
    const clamp = (value, lo, hi) => Math.max(lo, Math.min(hi, value));
    const finite = Number.isFinite;
    const phaseFloor = 1e-4;

    class WaveletWindow {
        constructor(pool, redraw) {
            this.pool = pool;
            this.redraw = redraw;
            this.nextUpdate = 0;
        }
        cancel() {
            const request = this.request;
            this.request = null;
            request?.abort?.abort();
            clearTimeout(this.delay);
            this.delay = null;
            this.nextUpdate = 0;
        }
        clear() {
            this.cancel();
            this.snapshot = null;
            this.error = '';
            this.errorKey = null;
        }
        update(frames, start, end, clock, settings, zoom, paused) {
            const { channel, basis } = settings;
            this.message = channel == null ? '请选择一个输入通道' : '等待有效数值样点';
            if (channel == null || channel >= frames.channelCount || frames.isSignal?.(channel) === false || end <= start)
                return;
            let { rate, time, from = 0 } = clock(end - 1);
            if (frames.segments?.length) {
                const head = frames.head ?? 0, ordinal = head + end - 1;
                const index = frames.segments.findLastIndex(segment => segment.first <= ordinal);
                const segments = frames.segments, segment = segments[index];
                if (segment) {
                    rate = 1000 / segment.step;
                    let first = index;
                    while (first > 0 && segments[first - 1].step === segment.step &&
                        Math.abs(segments[first].time - (segments[first - 1].time +
                            (segments[first].first - segments[first - 1].first) * segment.step)) < segment.step / 4) first--;
                    from = Math.max(from, segments[first].first - head);
                }
            }
            if (!(rate > 0) || !finite(rate)) {
                this.message = '等待来源采样率';
                return;
            }
            this.message = '等待更多有效样点';
            start = Math.max(start, from);
            const count = end - start;
            if (count < 16) return;
            const lastTime = finite(time) ? time : (end - 1) / rate;
            const t0 = lastTime - (count - 1) / rate;
            const first = zoom ? clamp(Math.floor((zoom[0] - t0) * rate) - 1, 0, count - 1) : 0;
            const last = zoom ? clamp(Math.ceil((zoom[1] - t0) * rate) + 1, first, count - 1) : count - 1;
            const minimumHop = paused ? 1 : Math.max(1, count / 8192);
            const key = [frames.version, start, end, channel, basis, rate, t0, first, last, minimumHop].join('|');
            if (this.snapshot?.key === key || this.request || this.errorKey === key) return;
            if (!paused && performance.now() < this.nextUpdate) {
                this.delay ??= setTimeout(() => { this.delay = null; this.redraw(); }, this.nextUpdate - performance.now());
                return;
            }
            const values = frames.copyChannel?.(channel, start, end) ??
                Float64Array.from({ length: count }, (_, i) => frames.getValue(channel, start + i));
            const task = { kind: 'wavelet', values, rate, basis, first, last, minimumHop };
            const snapshot = { key, rate, t0, lastTime };
            const publish = result => {
                this.snapshot = { ...snapshot, result };
                this.error = '';
            };
            if (!this.pool) {
                const processor = createWaveletProcessor(task);
                processor.step(Infinity); publish(processor.result());
                return;
            }
            const abort = typeof AbortController === 'function' ? new AbortController() : null;
            const request = this.request = { abort };
            // Workers process at most one snapshot per widget. Even if the
            // source advances during a job, its published time anchor stays exact.
            const started = performance.now();
            this.pool.runTask(task, { signal: abort?.signal }).then(result => {
                if (this.request !== request) return;
                this.request = null; publish(result);
                if (!paused && this.pool.available) this.nextUpdate = started + 120;
                this.redraw();
            }, error => {
                if (this.request !== request) return;
                this.request = null; this.error = error.message; this.errorKey = key;
                this.redraw();
            });
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
    function waveletPalette(color, phase) {
        const rgb = [1, 3, 5].map(i => parseInt(color.slice(i, i + 2), 16));
        if (!phase) {
            const max = Math.max(...rgb);
            const brightest = max ? rgb.map(value => 255 * value / max) : [255, 255, 255];
            return Array.from({ length: 64 }, (_, i) => tint(brightest, i / 63));
        }
        const hue = channelHue(rgb);
        return Array.from({ length: 64 * 8 }, (_, i) => {
            const color = hueColor((hue + (i % 64) / 64 * 6 + 6) % 6);
            return tint(color, (Math.floor(i / 64) + 1) / 8);
        });
    }
    function cellIndex(result, index, phase) {
        const magnitude = result.magnitude[index], ratio = magnitude / result.peak;
        if (!finite(magnitude)) return -1;
        if (!phase) return result.peak ? Math.round(63 * ratio) : 0;
        if (!(ratio >= phaseFloor) || !finite(result.phase[index])) return -1;
        const hue = Math.round((result.phase[index] / (2 * Math.PI) + 1) * 64) % 64;
        const strength = Math.min(7, Math.floor(8 * ratio ** .25));
        return strength * 64 + hue;
    }
    function frequencyBoundaries(frequencies) {
        const edges = new Float64Array(frequencies.length + 1);
        edges[0] = frequencies[0]; edges[frequencies.length] = frequencies.at(-1);
        for (let i = 1; i < frequencies.length; i++) edges[i] = Math.sqrt(frequencies[i - 1] * frequencies[i]);
        return edges;
    }
    function heatmapPaths(plot, snapshot, phase, palette) {
        const { result, t0, rate } = snapshot, { frequencies, first, hop, columns } = result;
        const edges = frequencyBoundaries(frequencies), paths = new Map();
        const [xMin, xMax, yMin, yMax] = plot.range;
        const x = boundary => t0 + clamp(first + (boundary - .5) * hop, 0, (snapshot.lastTime - t0) * rate) / rate;
        const from = clamp(Math.floor(((xMin - t0) * rate - first) / hop + .5), 0, columns);
        const to = clamp(Math.ceil(((xMax - t0) * rate - first) / hop + .5), from, columns);
        for (let row = 0; row < frequencies.length; row++) {
            if (edges[row + 1] <= yMin || edges[row] >= yMax) continue;
            const top = plot.py(Math.min(yMax, edges[row + 1])), bottom = plot.py(Math.max(yMin, edges[row]));
            for (let begin = from; begin < to;) {
                const color = cellIndex(result, row * columns + begin, phase);
                let end = begin + 1;
                while (end < to && cellIndex(result, row * columns + end, phase) === color) end++;
                if (color >= 0) {
                    let path = paths.get(color);
                    if (!path) paths.set(color, path = []);
                    const left = plot.px(Math.max(xMin, x(begin))), right = plot.px(Math.min(xMax, x(end)));
                    if (right > left) path.push([left, top, right, bottom]);
                }
                begin = end;
            }
        }
        return [...paths].map(([color, paths]) => [palette[color], paths]);
    }
    function heatmapImage(plot, snapshot, phase, palette, canvas) {
        const { result, t0, rate } = snapshot;
        const { first, hop, columns, frequencies } = result;
        const { width: plotWidth, height: plotHeight } = plot.area;
        const width = Math.max(1, Math.min(columns, Math.ceil(plotWidth)));
        const height = Math.max(1, Math.min(512, Math.ceil(plotHeight)));
        const ctx = canvas.getContext?.('2d');
        if (!ctx || typeof canvas.toDataURL !== 'function') return null;
        if (canvas.width !== width) canvas.width = width;
        if (canvas.height !== height) canvas.height = height;
        const image = ctx.createImageData(width, height);
        const edges = frequencyBoundaries(frequencies);
        const [xMin, xMax] = plot.range;
        const left = ((xMin - t0) * rate - first) / hop, right = ((xMax - t0) * rate - first) / hop;
        const indexes = Int32Array.from({ length: width }, (_, i) => Math.round(left + (right - left) * (i + .5) / width));
        let row = frequencies.length - 1;
        for (let y = 0, pixel = 0; y < height; y++) {
            const frequency = plot.yAt(1 - (y + .5) / height);
            while (row >= 0 && frequency < edges[row]) row--;
            if (row < 0) break;
            if (frequency > edges.at(-1)) { pixel += 4 * width; continue; }
            for (let x = 0; x < width; x++, pixel += 4) {
                const column = indexes[x];
                if (column < 0 || column >= columns) continue;
                const color = cellIndex(result, row * columns + column, phase);
                if (color >= 0) {
                    const [r, g, b] = palette[color];
                    image.data[pixel] = r; image.data[pixel + 1] = g; image.data[pixel + 2] = b; image.data[pixel + 3] = 255;
                }
            }
        }
        ctx.putImageData(image, 0, 0);
        return canvas.toDataURL();
    }
    function waveletCell(snapshot, time, frequency) {
        const { result, t0, rate } = snapshot, { frequencies, columns, hop, first } = result;
        if (!frequencies.length || time < t0 || time > snapshot.lastTime ||
            frequency < frequencies[0] || frequency > frequencies.at(-1)) return null;
        let lo = 0, hi = frequencies.length - 1;
        while (lo < hi) {
            const mid = (lo + hi) >>> 1;
            if (frequency >= Math.sqrt(frequencies[mid] * frequencies[mid + 1])) lo = mid + 1;
            else hi = mid;
        }
        const row = lo;
        const column = Math.round(((time - t0) * rate - first) / hop);
        if (column < 0 || column >= columns) return null;
        const index = row * columns + column;
        const magnitude = result.magnitude[index];
        const phase = result.phase && magnitude >= result.peak * phaseFloor ? result.phase[index] : NaN;
        return { magnitude, phase, frequency: frequencies[row] };
    }
    function* waveletCsv(snapshot, onProgress) {
        const { result, t0, rate } = snapshot, { frequencies, columns, hop, first } = result;
        yield 'time_s,frequency_hz,magnitude,phase_rad\r\n';
        for (let row = 0; row < frequencies.length; row++) {
            const lines = [];
            for (let column = 0; column < columns; column++) {
                const index = row * columns + column;
                const magnitude = result.magnitude[index];
                const phase = result.phase?.[index];
                lines.push([t0 + (first + column * hop) / rate, frequencies[row],
                    finite(magnitude) ? magnitude : '', finite(phase) ? phase : ''].join(','));
            }
            yield lines.join('\r\n') + '\r\n';
            onProgress?.(row + 1, frequencies.length);
        }
    }
    S.WaveletPlot = { WaveletWindow, waveletPalette, heatmapPaths, heatmapImage, waveletCell, waveletCsv };
    if (typeof module !== 'undefined') module.exports = S.WaveletPlot;
})(globalThis);
