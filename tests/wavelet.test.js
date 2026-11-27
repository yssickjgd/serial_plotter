const test = require('node:test');
const assert = require('node:assert/strict');
const { bootArrayApplication } = require('./helpers/widgetAppHarness');

function analyze(values, basis, cuts = [], rate = 1024, edgeExtension) {
    const { createWaveletProcessor } = require('../wavelet');
    const processor = createWaveletProcessor({ values, rate, basis, cuts, edgeExtension });
    while (!processor.step(4096)) { /* Exercise the sliced fallback. */ }
    return processor.result();
}

test('complex wavelets locate a tone and recover its phase against sample time', () => {
    const values = Float64Array.from({ length: 2048 }, (_, i) => Math.cos(Math.PI * i / 8 + .4));
    for (const basis of ['morlet', 'morse']) {
        const result = analyze(values, basis);
        const column = 1024 / result.hop;
        const magnitudes = Array.from(result.frequencies, (_, i) => result.magnitude[i * result.columns + column]);
        const row = magnitudes.indexOf(Math.max(...magnitudes.filter(Number.isFinite)));
        assert.ok(Math.abs(result.frequencies[row] - 64) < 5);
        assert.ok(Math.abs(magnitudes[row] - 1) < .04);
        assert.ok(Math.abs(result.phase[row * result.columns + column] - .4) < .01);
        assert.ok(result.frequencies.at(-1) < 512);
    }
});

test('a 5000-point 1 kHz wavelet window resolves 400 Hz and 450 Hz tones', () => {
    for (const frequency of [400, 450]) {
        const values = Float64Array.from({ length: 5000 }, (_, i) => Math.cos(2 * Math.PI * frequency * i / 1000 + .4));
        for (const basis of ['morlet', 'morse', 'mexicanHat']) {
            const result = analyze(values, basis, [], 1000);
            const column = 2000 / result.hop;
            const magnitudes = Array.from(result.frequencies, (_, i) => result.magnitude[i * result.columns + column]);
            const row = magnitudes.indexOf(Math.max(...magnitudes.filter(Number.isFinite)));
            assert.ok(Math.abs(result.frequencies[row] - frequency) < 16, basis + ' ' + frequency);
            const expected = basis === 'mexicanHat' ? Math.cos(.4) : 1;
            assert.ok(Math.abs(magnitudes[row] - expected) < .06);
            if (result.phase) assert.ok(Math.abs(result.phase[row * result.columns + column] - .4) < .015);
        }
    }
});

test('the highest center is below Nyquist and its coefficient is the same in hover and CSV', () => {
    const { waveletCell, waveletCsv, waveletPalette, heatmapPaths } = require('../waveletPlot');
    const values = Float64Array.from({ length: 5000 }, (_, i) => Math.cos(2 * Math.PI * 499.8 * i / 1000 + .4));
    for (const basis of ['morlet', 'morse', 'mexicanHat']) {
        const result = analyze(values, basis, [], 1000);
        assert.equal(result.frequencies.at(-1), 499.8);
        const snapshot = { result, t0: 0, lastTime: 4.999, rate: 1000 };
        const cell = waveletCell(snapshot, 2, 499.8);
        assert.ok(Number.isFinite(cell.magnitude));
        assert.equal(Number.isFinite(cell.phase), basis !== 'mexicanHat');
        for (const frequency of [499.9, 500]) assert.equal(waveletCell(snapshot, 2, frequency), null);
        const tiles = heatmapPaths({ range: [0, 4.999, 499.81, 500], px: x => x, py: y => 500 - y },
            snapshot, false, waveletPalette('#ffffff', false));
        assert.equal(tiles.length, 0);
        const lastCsv = [...waveletCsv(snapshot)].at(-1);
        const csvRow = lastCsv.split('\r\n').find(line => line.startsWith('2,499.8,')).split(',');
        assert.equal(Number(csvRow[2]), cell.magnitude);
        assert.equal(csvRow[3], Number.isFinite(cell.phase) ? String(cell.phase) : '');
        assert.doesNotMatch(lastCsv, /,500,/);
    }
});

test('wavelet DC removal centers the analysis window and uses the same offset for history and reflected edges', () => {
    const { createWaveletProcessor } = require('../wavelet');
    const input = Float64Array.from({ length: 192 }, (_, i) =>
        i < 64 ? 30 + i % 8 : 8 + (i % 2 ? 1 : -1));
    input[120] = input[121] = NaN;
    const original = input.slice();
    const task = { rate: 256, basis: 'morlet', visibleStart: 64, visibleLength: 128, cuts: [96] };
    const compute = (values, removeDc) => {
        const processor = createWaveletProcessor({ ...task, values, removeDc });
        processor.step(Infinity);
        return processor.result();
    };
    const expected = compute(input.map(value => value - 8), false);
    const actual = compute(input, true);
    assert.deepEqual(input, original);
    assert.deepEqual(actual.reference, expected.reference);
    for (let i = 0; i < actual.magnitude.length; i++) {
        if (Number.isNaN(expected.magnitude[i])) assert.ok(Number.isNaN(actual.magnitude[i]));
        else assert.ok(Math.abs(actual.magnitude[i] - expected.magnitude[i]) < 1e-11);
        if (Number.isFinite(expected.phase[i]) && expected.magnitude[i] > 1e-4) {
            assert.ok(Math.abs(Math.sin((actual.phase[i] - expected.phase[i]) / 2)) < 1e-9);
        }
    }
});

test('toggling wavelet DC removal on paused data invalidates coefficients without altering samples', () => {
    const { FrameBuffer } = require('../frameBuffer');
    const { WaveletWindow } = require('../waveletPlot');
    const frames = new FrameBuffer(1, 256);
    for (let i = 0; i < 256; i++) frames.append([20], undefined, '', i + 1, i);
    const w = new WaveletWindow(null, () => {});
    const update = removeDc => w.update(frames, 0, 256, i => ({ time: i / 1000, rate: 1000 }),
        { channel: 0, basis: 'morlet', removeDc }, null, true);
    update(false);
    const uncentered = w.snapshot.result;
    assert.ok(uncentered.peak > 0);
    update(true);
    assert.equal(w.snapshot.result.peak, 0);
    assert.ok(w.snapshot.result.phase.every(Number.isNaN));
    update(false);
    assert.deepEqual(w.snapshot.result.magnitude, uncentered.magnitude);
    assert.equal(frames.getValue(0, 0), 20);
});

test('all wavelet extensions isolate each finite run and leave missing samples blank', () => {
    const values = Float64Array.from({ length: 1024 }, (_, i) => Math.cos(Math.PI * i / 4));
    values[320] = NaN;
    const changed = values.slice();
    changed.fill(1000, 640);
    for (const edgeExtension of ['mirror', 'zero', 'hold']) {
        const real = analyze(values, 'mexicanHat', [640], 1024, edgeExtension);
        assert.equal(real.phase, null);
        const offset = (real.frequencies.length - 1) * real.columns;
        assert.ok(Number.isNaN(real.magnitude[offset + 320 / real.hop]));
        for (const index of [0, 640]) {
            assert.ok(Number.isFinite(real.magnitude[offset + index / real.hop]));
            assert.equal(real.reference[offset + index / real.hop], 1);
        }
        assert.equal(real.reference[offset + 768 / real.hop], 0);
        assert.ok(Number.isFinite(real.magnitude[offset + 768 / real.hop]));
        const next = analyze(changed, 'mexicanHat', [640], 1024, edgeExtension);
        const left = offset + 638 / real.hop;
        assert.equal(real.magnitude[left], next.magnitude[left], 'a hard cut isolates the fill on either side');
    }
});

test('a missing input between downsampled columns stays blank in hover and SVG tiles', () => {
    const { waveletCell, heatmapPaths, waveletPalette } = require('../waveletPlot');
    const values = new Float64Array(1024).fill(1);
    values[321] = NaN;
    const result = analyze(values, 'morlet');
    assert.equal(result.hop, 2);
    const snapshot = { result, t0: 0, rate: 1024, lastTime: 1023 / 1024 };
    const highest = result.frequencies.at(-1);
    assert.ok(waveletCell(snapshot, 320 / 1024, highest));
    assert.equal(waveletCell(snapshot, 321 / 1024, highest), null);
    assert.ok(waveletCell(snapshot, 322 / 1024, highest));
    const plot = { range: [0, snapshot.lastTime, 500, 512], px: x => 1024 * x, py: y => 512 - y };
    assert.ok(heatmapPaths(plot, snapshot, false, waveletPalette('#ff0000', false))
        .every(([, paths]) => paths.every(([left, , right]) => right < 321 || left > 321)));
});

test('coarse time centers keep the boundary under the same cursor position in the heatmap and hover', () => {
    const { paintHeatmap, waveletCell, waveletPalette } = require('../waveletPlot');
    const snapshot = { t0: 0, rate: 1000, lastTime: 4.999, result: {
        frequencies: Float64Array.of(1, 500), columns: 2, first: 0, hop: 4096,
        runs: [{ start: 0, end: 5000, from: 0, until: 2 }],
        magnitude: Float64Array.of(0, 1, 0, 1), reference: new Uint8Array(4), peak: 1
    } };
    const plot = { area: { width: 100, height: 1 }, range: [0, 4.999, 1, 500], yAt: () => 50 };
    let pixels;
    const context = { createImageData: (w, h) => ({ data: new Uint8Array(w * h * 4) }),
        putImageData: image => { pixels = image.data; } };
    const canvas = { getContext: () => context, toDataURL: () => '' };
    paintHeatmap(plot, snapshot, false, waveletPalette('#ffffff', false), canvas, { min: 0, max: 1 });
    for (let x = 0; x < 100; x++) {
        const ratio = (x + .5) / 100;
        const light = pixels[Math.floor(ratio * canvas.width) * 4];
        assert.equal(light, waveletCell(snapshot, ratio * 4.999, 50).magnitude ? 255 : 17, 'pixel ' + x);
    }
});

test('linear and logarithmic frequency cells use their respective midpoint for raster, SVG, hatching, hover and color limits', () => {
    const { paintHeatmap, heatmapColorScale, heatmapPaths, heatmapReferenceAreas, waveletCell, waveletPalette } = require('../waveletPlot');
    const palette = waveletPalette('#ffffff', false);
    const plot = { area: { left: 0, top: 0, width: 1, height: 1 }, range: [0, 1, 3.9, 4.1],
        yAt: () => 4, px: x => x, py: y => (4.1 - y) / .2 };
    for (const [frequencyScale, expected, boundary] of [['linear', 0, 5], ['log', 1, 3], [undefined, 1, 3]]) {
        const result = { frequencies: [1, 9], frequencyScale, first: 0, hop: 1, columns: 2, peak: 1,
            runs: [{ start: 0, end: 2, from: 0, until: 2 }], magnitude: [0, 0, 1, 1], reference: [0, 0, 1, 1] };
        const snapshot = { result, t0: 0, lastTime: 1, rate: 1 };
        assert.equal(waveletCell(snapshot, .5, 4).magnitude, expected);
        assert.equal(waveletCell(snapshot, .5, boundary).frequency, 9);
        assert.deepEqual(heatmapColorScale(plot, snapshot, false), { min: expected, max: expected });
        assert.equal(heatmapReferenceAreas(plot, snapshot, false).length, expected);
        const scale = { min: 0, max: 1 };
        const [[color]] = heatmapPaths(plot, snapshot, false, palette, scale);
        const brightness = expected ? 255 : 17;
        assert.equal(color[0], brightness);
        let pixels;
        const canvas = { getContext: () => ({ createImageData: () => ({ data: new Uint8ClampedArray(4) }),
            putImageData: image => { pixels = image.data; } }) };
        paintHeatmap(plot, snapshot, false, palette, canvas, scale);
        assert.deepEqual(Array.from(pixels), [brightness, brightness, brightness, 255]);
    }
});

test('dense wavelet SVG and reference hatching match the pixels displayed at the widget size', () => {
    const { heatmapPaths, heatmapReferenceAreas, paintHeatmap, waveletPalette } = require('../waveletPlot');
    const columns = 1024, rows = 257, size = columns * rows;
    const result = {
        columns, frequencies: Float64Array.from({ length: rows }, (_, i) => 1 + i),
        magnitude: Float64Array.from({ length: size }, (_, i) => Math.sin(i * .71) ** 2),
        reference: Uint8Array.from({ length: size }, (_, i) => Number(i % 5 === 0)),
        first: 0, hop: 1, runs: [{ from: 0, until: columns, start: 0, end: columns }]
    };
    const width = 53, height = 23, snapshot = { result, t0: 0, rate: 1 };
    const plot = { area: { left: 0, top: 0, width, height }, range: [0, columns - 1, 1, rows],
        yAt: ratio => 1 + (rows - 1) * ratio };
    const palette = waveletPalette('#00ffff', false), scale = { min: 0, max: 1 };
    let pixels;
    const context = { createImageData: (w, h) => ({ data: new Uint8Array(w * h * 4) }),
        putImageData: image => { pixels = image.data; } };
    paintHeatmap(plot, snapshot, false, palette, { getContext: () => context, toDataURL: () => '' }, scale);
    const tiles = heatmapPaths(plot, snapshot, false, palette, scale);
    const reference = heatmapReferenceAreas(plot, snapshot, false);
    let covered = 0;
    for (const [color, rects] of tiles) for (const [x0, y0, x1, y1] of rects) {
        for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) {
            const index = 4 * (y * width + x);
            assert.deepEqual(Array.from(pixels.subarray(index, index + 3)), color);
            covered++;
        }
    }
    assert.equal(covered, width * height);
    assert.ok(reference.length > 0 && reference.length <= width * height);
    for (const [x0, y0, x1] of reference) for (let x = x0; x < x1; x++) {
        const col = Math.round((x + .5) / width * (columns - 1));
        const freq = plot.yAt(1 - (y0 + .5) / height);
        let row = Math.floor(freq) - 1;
        if (freq >= Math.sqrt((row + 1) * (row + 2))) row++;
        assert.equal(result.reference[row * columns + col], 1);
    }
});

test('a two-row heatmap colors each displayed coefficient once and reuses the bitmap for the next snapshot', () => {
    const { paintHeatmap, waveletPalette } = require('../waveletPlot');
    const columns = 20, signal = Array(2 * columns).fill(.5);
    let reads = 0, allocations = 0, image;
    const magnitude = new Proxy(signal, { get(target, key) { reads++; return target[key]; } });
    const result = { first: 0, hop: 1, columns, magnitude, frequencies: [1, 500],
        runs: [{ start: 0, end: columns, from: 0, until: columns }], peak: 1 };
    const plot = { area: { width: 1000, height: 400 }, range: [0, columns - 1, 1, 500], yAt: r => 1 + 499 * r };
    const ctx = { createImageData(w, h) { allocations++; return { data: new Uint8ClampedArray(w * h * 4) }; },
        putImageData(value) { image = value; } };
    const canvas = { getContext: () => ctx, toDataURL() { throw new Error('live rendering must not encode PNG'); } };
    const paint = () => paintHeatmap(plot, { result, rate: 1, t0: 0 }, false, waveletPalette('#00ffff', false), canvas, { min: 0, max: 1 });
    assert.ok(paint());
    assert.equal(reads, 2 * columns);
    assert.equal(image.data[3], 255);
    signal.fill(NaN);
    assert.ok(paint());
    assert.equal(reads, 4 * columns);
    assert.equal(allocations, 1);
    assert.equal(image.data[3], 0);
    assert.equal(image.data.at(-1), 0);
});

test('a pending replacement and mouse hover keep the published heatmap and axes on screen', t => {
    const f = bootArrayApplication(); t.after(() => f.app.dispose());
    const widget = f.app.widgets.create({ type: 'wavelet' }), { view, source } = widget;
    source.sampleRate.rate = 1000;
    view.setPaused(true);
    view.wavelet.pool = null;
    const append = (from, to) => {
        for (let i = from; i < to; i++) source.frames.append([Math.cos(i / 10)], undefined, '', i + 1, i);
    };
    const canvas = view.waveletCanvas = f.document.createElement('canvas');
    let paints = 0;
    const ctx = { createImageData: (w, h) => ({ data: new Uint8ClampedArray(w * h * 4) }), putImageData() { paints++; } };
    canvas.getContext = () => ctx;
    append(0, 256); view.renderNow();
    const layer = view.svg.querySelector('[data-wavelet-canvas]'), draws = view.completedDraws;
    assert.ok(layer);
    view.wavelet.request = {};
    const firstPaints = paints;
    append(256, 272); view.renderNow();
    view.hover({ x: view.area.left + 10, y: view.area.top + 10 });
    view.renderNow();
    assert.equal(view.completedDraws, draws);
    assert.equal(paints, firstPaints);
    view.wavelet.request = null;
    view.renderNow();
    assert.equal(view.wavelet.snapshot.lastTime, .271);
    assert.equal(view.completedDraws, draws + 1);
    assert.equal(paints, firstPaints + 1);
    assert.equal(view.svg.querySelector('[data-wavelet-canvas]'), layer);
    view.invalidateLabels(); view.renderNow();
    assert.equal(paints, firstPaints + 1, 'updating labels preserves the already painted bitmap');
});

test('manual rounded column centers drive CSV, canvas, SVG and hover on each side of a real gap', () => {
    const { waveletCsv, paintHeatmap, heatmapPaths, waveletCell, waveletPalette } = require('../waveletPlot');
    const result = {
        positions: Int32Array.of(0, 3, 7, 10), first: 0, hop: 10 / 3, columns: 4,
        frequencies: Float64Array.of(1, 10), magnitude: Float64Array.of(0, 1, 0, 1, 0, 1, 0, 1),
        peak: 1, reference: new Uint8Array(8), runs: [
            { start: 0, end: 5, from: 0, until: 2 }, { start: 6, end: 11, from: 2, until: 4 }
        ]
    };
    const snapshot = { t0: 0, rate: 1, lastTime: 10, result };
    const csv = [...waveletCsv(snapshot)][1].trimEnd().split('\r\n');
    assert.deepEqual(csv.map(line => Number(line.split(',')[0])), [0, 3, 7, 10]);
    const width = 100, plot = { area: { width, height: 1 }, range: [0, 10, 1, 10],
        yAt: () => 5, px: t => t * 10, py: f => (10 - f) / 9 };
    let pixels;
    const context = { createImageData: (w, h) => ({ data: new Uint8Array(w * h * 4) }),
        putImageData: image => { pixels = image.data; } };
    const palette = waveletPalette('#ffffff', false), scale = { min: 0, max: 1 };
    paintHeatmap(plot, snapshot, false, palette, { getContext: () => context, toDataURL: () => '' }, scale);
    const tiles = heatmapPaths(plot, snapshot, false, palette, scale);
    for (let x = 0; x < width; x++) {
        const time = (x + .5) / 10;
        const actual = waveletCell(snapshot, time, 5)?.magnitude;
        const expected = time < 1.5 ? 0 : time < 4.5 ? 1 : time < 5.5 ? undefined : time < 8.5 ? 0 : 1;
        assert.equal(actual, expected);
        const tile = tiles.find(([, rects]) => rects.some(([left,, right]) => x + .5 >= left && x + .5 < right));
        assert.equal(tile?.[0][0], expected === undefined ? undefined : expected ? 255 : 17);
        assert.equal(pixels[4 * x + 3], expected === undefined ? 0 : 255);
        if (expected !== undefined) assert.equal(pixels[4 * x], expected ? 255 : 17);
    }
    assert.equal(waveletCell(snapshot, 1.5, 5).magnitude, 1);
});

test('a single manual column fills just its finite run and exports only the measured center', () => {
    const { WaveletWindow, waveletCsv, waveletCell } = require('../waveletPlot');
    const { FrameBuffer } = require('../frameBuffer');
    const frames = new FrameBuffer(1, 65);
    for (let i = 0; i < 65; i++) frames.append([i === 10 || i === 60 ? NaN : Math.cos(i)], undefined, '', i + 1, i);
    const job = new WaveletWindow(null, () => {});
    job.update(frames, 0, 65, i => ({ time: i / 100, rate: 100 }),
        { channel: 0, basis: 'morlet', timeColumns: 1, frequencyRows: 3 }, null, true);
    const snapshot = job.snapshot;
    assert.deepEqual(Array.from(snapshot.result.positions), [32]);
    for (const time of [.11, .23, .32, .59]) assert.ok(waveletCell(snapshot, time, 40));
    for (const time of [0, .1, .6, .64]) assert.equal(waveletCell(snapshot, time, 40), null);
    const lines = [...waveletCsv(snapshot)].slice(1);
    assert.equal(lines.length, 3);
    for (const line of lines) assert.match(line, /^0\.32,/);
});

test('the visible window borrows real history and replaces references as future samples arrive', () => {
    const { FrameBuffer } = require('../frameBuffer');
    const { WaveletWindow, waveletCell, waveletCsv } = require('../waveletPlot');
    const frames = new FrameBuffer(1, 4000);
    function fill(from, to) {
        for (let i = from; i < to; i++) frames.append([Math.cos(2 * Math.PI * 10 * i / 1000 + .4)], undefined, '', i + 1, i);
    }
    fill(0, 2000);
    const window = new WaveletWindow(null, () => {});
    const clock = i => ({ time: i / 1000, rate: 1000 });
    const settings = { channel: 0, basis: 'morlet' };
    const sample = (time, frequency) => waveletCell(window.snapshot, time, frequency);
    window.update(frames, 1000, 2000, clock, settings, null, false);
    assert.equal(window.snapshot.t0, 1);
    assert.equal(window.snapshot.lastTime, 1.999);
    assert.ok(Math.abs(window.snapshot.result.frequencies[0] - 3.96) < 1e-12);
    assert.equal(sample(1, 10).reference, false);
    assert.equal(sample(1.999, 10).reference, true);
    assert.ok(Number.isFinite(sample(1.999, 10).magnitude));
    assert.match([...waveletCsv(window.snapshot)].at(-1), /,reference\r\n/);
    fill(2000, 2600);
    window.update(frames, 1000, 2000, clock, settings, null, true);
    assert.equal(window.snapshot.lastTime, 1.999);
    assert.equal(sample(1.999, 10).reference, false);
    assert.ok(Math.abs(sample(1.999, 10).magnitude - 1) < .03);
    const split = new WaveletWindow(null, () => {});
    split.update(frames, 1000, 2000, i => ({ ...clock(i), from: 1000, until: 2000 }), settings, null, true);
    assert.equal(waveletCell(split.snapshot, 1, 10).reference, true);
    assert.equal(waveletCell(split.snapshot, 1.999, 10).reference, true);
});

test('wavelet colors reach the brightest channel hue and wrap phase at both ends', () => {
    const { waveletPalette, waveletCell } = require('../waveletPlot');
    assert.deepEqual(waveletPalette('#800000', false).at(-1), [255, 0, 0]);
    assert.deepEqual(waveletPalette('#008040', false).at(-1), [0, 255, 128]);
    const palette = waveletPalette('#800000', true);
    assert.deepEqual(palette[7 * 64], [255, 0, 0]);
    const result = analyze(Float64Array.from({ length: 512 }, (_, i) => Math.cos(Math.PI * i / 8)), 'morlet');
    assert.equal(waveletCell({ result, t0: 0, lastTime: 511 / 1024, rate: 1024 }, -1, 64), null);
});

test('wavelet brightness ignores cells outside the current zoom', () => {
    const { heatmapColorScale } = require('../waveletPlot');
    const result = { first: 0, hop: 1, columns: 4, frequencies: Float64Array.of(1, 4, 16),
        runs: [{ start: 0, end: 4, from: 0, until: 4 }], magnitude: Float64Array.of(90, 80, 70, 60, 50, 2, 5, 40, 30, 20, 10, 100) };
    const snapshot = { result, t0: 0, lastTime: 3, rate: 1 };
    const plot = { range: [.6, 2.4, 3, 5] };
    assert.deepEqual(heatmapColorScale(plot, snapshot, false), { min: 2, max: 5 });
});

test('frozen wavelet selections keep full coverage while capture advances and scrollbars pan', async t => {
    const f = bootArrayApplication(); t.after(() => f.app.dispose());
    const { source, view, refs } = f.app.widgets.create({ type: 'wavelet', settings: { freezeXOnZoom: true } });
    source.sampleRate.rate = 1000;
    const fill = (from, stop) => {
        for (let i = from; i < stop; i++) {
            const samples = new Float64Array(source.frames.rawChannelCount);
            samples[0] = Math.cos(Math.PI * i / 25);
            source.frames.append(samples, undefined, '', i + 1, 1000 + i);
        }
    };
    const read = () => { view.renderNow(); };
    const settle = async () => { for (let i = 0; i < 4; i++) await f.tick(); };
    fill(0, 1500); read(); await settle();
    assert.ok(view.waveletDrawSnapshot);
    const end = view.range[1];
    view.setZoom([end - .3, end - .01], [5, 80]); read(); await settle();
    const initial = [...view.range];
    fill(1500, 2100); read(); await settle();
    assert.deepEqual([...view.range], initial);
    const cellAt = time => f.S.WaveletPlot.waveletCell(view.waveletDrawSnapshot, time, 20);
    assert.ok(Number.isFinite(cellAt(initial[1] - .02)?.magnitude));
    assert.equal(refs['plot-y-scrollbar-wrap'].hidden, false);
    assert.ok(parseFloat(refs['plot-scrollbar-thumb'].style.width) < refs['plot-scrollbar-wrap'].clientWidth);
    view.panScrollbar('x', 0); read();
    assert.ok(Number.isFinite(cellAt(view.range[0] + .02)?.magnitude), 'the full baseline covers fast pans before the worker finishes');
    view.resetZoom();
    await settle();
    assert.ok(view.range[1] > end);
});

test('a live wavelet zoom follows incoming samples and its scrollbar navigates retained history before the default window', async t => {
    const f = bootArrayApplication({ version: 3, global: { plotWindowPoints: '400' }, dataEngine: { mode: 'Data_Array' },
        widgets: [], workspace: { step: 10, rects: {} } }); t.after(() => f.app.dispose());
    const { source, view } = f.app.widgets.create({ type: 'wavelet' });
    source.sampleRate.rate = 1000;
    view.setSettings(view.settings, 400);
    const fill = (from, to) => {
        for (let i = from; i < to; i++)
            source.frames.append([Math.cos(Math.PI * i / 25)], undefined, '', i + 1, 1000 + i);
    };
    const settle = async () => { view.renderNow(); for (let i = 0; i < 4; i++) await f.tick(); };
    fill(0, 1400); await settle();
    const initial = [...view.range], near = (actual, expected) => assert.ok(Math.abs(actual - expected) < 1e-8, actual + ' vs ' + expected);
    near(initial[1] - initial[0], .399);
    near(view.horizontalZoomLimits()[0], initial[1] - 1.399);
    view.panScrollbar('x', 0); await settle();
    near(view.range[0], initial[1] - 1.399);
    near(view.range[1] - view.range[0], .399);
    assert.ok(view.waveletDrawSnapshot);
    assert.equal(view.getVisibleFrameIndex(), 399, 'navigation uses the displayed historical window');
    view.stepHistory(-1);
    assert.equal(view.currentFrameIndex(), 398);
    view.resetZoom(); await settle();
    view.setZoom([initial[0] + .1, initial[1] - .02], [10, 80]); await settle();
    const zoom = [...view.range];
    fill(1400, 1600); await settle();
    near(view.range[0] - zoom[0], .2);
    near(view.range[1] - zoom[1], .2);
    assert.ok(view.waveletDrawSnapshot);
    assert.deepEqual([...view.range.slice(2)], zoom.slice(2));
    view.setZoom([initial[0] - .5, initial[1]], null); await settle();
    near(view.range[1] - view.range[0], .899);
    assert.ok(view.waveletDrawSnapshot);
});

test('wavelet uses raw packet order instead of reading a synchronized table for the selected channel', () => {
    const { SynchronizedFrames } = require('../engineFrames');
    const { WaveletWindow } = require('../waveletPlot');
    const frames = new SynchronizedFrames(1, 256, { sampleRate: 1000 });
    for (let i = 0; i < 128; i++) frames.ingest(Math.floor(i / 8) * 10,
        [[0, Math.cos(Math.PI * i / 4)]], { order: i, sampleRate: 800 });
    frames.copyChannel = () => { throw new Error('A native wavelet must skip the synchronized grid'); };
    const window = new WaveletWindow(null, () => {});
    window.update(frames, 0, frames.length, () => ({ rate: 1000 }), { channel: 0, basis: 'morlet' },
        null, false, { windowPoints: 128 });
    const { rate, lastTime, result } = window.snapshot;
    assert.equal(rate, 800);
    assert.equal(lastTime, 127 / 800);
    assert.equal(result.columns, 128);
    assert.equal(result.frequencies.at(-1), 400 - 800 / 128);
    frames.dispose();
});

test('retained native samples keep their own frequency section when panning backwards from 1 kHz to 400 Hz', () => {
    const { SynchronizedFrames } = require('../engineFrames');
    const { WaveletWindow } = require('../waveletPlot');
    const frames = new SynchronizedFrames(1, 3000);
    for (let i = 0; i < 900; i++) {
        const rate = i < 400 ? 400 : 1000;
        const time = i < 400 ? i * 2.5 : 1000 + i - 400;
        frames.ingest(time, [[0, Math.sin(2 * Math.PI * 10 * time / 1000)]],
            { order: i, fixedSampleRate: rate, sampleRate: rate });
    }
    const job = new WaveletWindow(null, () => {}), settings = { channel: 0, basis: 'morlet' };
    const update = zoom => job.update(frames, 0, frames.length, () => ({ rate: 1000 }), settings, zoom, true, { windowPoints: 200 });
    update(null);
    assert.equal(job.snapshot.liveTime, 1.499);
    assert.equal(job.snapshot.result.frequencies.at(-1), 495);
    update([.1, .3]);
    assert.equal(job.snapshot.result.frequencies.at(-1), 198);
    assert.equal(job.snapshot.rate, 400);
    assert.ok(job.displaySnapshot([.1, .3]));
    const before = job.snapshot.result;
    frames.ingest(1500, [[0, 0]], { order: 900, fixedSampleRate: 1000, sampleRate: 1000 });
    update([.1, .3]);
    assert.equal(job.snapshot.result, before);
    assert.equal(job.snapshot.liveTime, 1.5);
    frames.dispose();
});

test('a frozen wavelet drag keeps the axis seen on pointer down while capture continues', async t => {
    const f = bootArrayApplication(); t.after(() => f.app.dispose());
    const { source, view } = f.app.widgets.create({ type: 'wavelet', settings: { freezeXOnZoom: true } });
    source.sampleRate.rate = 1000;
    const fill = (from, to) => {
        for (let i = from; i < to; i++) source.frames.append([i % 9], undefined, '', i + 1, i);
    };
    const settle = async () => { view.renderNow(); for (let i = 0; i < 4; i++) await f.tick(); };
    fill(0, 1100); await settle();
    const display = [...view.range];
    const { left, top, width, height } = view.area;
    const pointer = (type, x, y) => view.svg.dispatchEvent({ type, button: 0, pointerId: 1, clientX: left + x * width, clientY: top + y * height });
    pointer('pointerdown', .1, .2);
    fill(1100, 1600); await settle();
    assert.deepEqual([...view.range], display);
    pointer('pointerup', .8, .9); await settle();
    for (const [index, fraction] of [[0, .1], [1, .8]]) {
        const expected = display[0] + fraction * (display[1] - display[0]);
        assert.ok(Math.abs(view.range[index] - expected) < 1e-8);
    }
});

test('eviction slides an unavailable historical selection to the earliest retained samples', () => {
    const { FrameBuffer } = require('../frameBuffer');
    const { WaveletWindow } = require('../waveletPlot');
    const frames = new FrameBuffer(1, 256), job = new WaveletWindow(null, () => {});
    const clock = i => ({ rate: 1000, time: frames.frameOrdinalAt(i) / 1000 });
    const fill = (begin, end) => {
        for (let i = begin; i < end; i++) frames.append([Math.sin(i)], undefined, '', i + 1, i);
    };
    const update = zoom => job.update(frames, frames.length - 64, frames.length, clock,
        { channel: 0, basis: 'morlet' }, zoom, false, { windowPoints: 64 });
    fill(0, 256); update(null);
    const old = job.snapshot.retained[0], selected = [old, old + .04]; update(selected);
    fill(256, 356); update(selected);
    const { selection, retained, result } = job.snapshot;
    assert.ok(Math.abs(retained[0] - old - .1) < 1e-8);
    assert.ok(Math.abs(selection[0] - retained[0]) < 1e-8);
    assert.ok(Math.abs(selection[1] - selection[0] - .04) < 1e-8);
    assert.ok(job.displaySnapshot(selection));
    assert.ok(result.columns <= 64);
});

test('wavelet widget accepts one channel, switches phase, exports, and restores settings', async t => {
    const f = bootArrayApplication({ version: 3, global: { channelsCount: '2' }, dataEngine: { mode: 'Data_Array' },
        widgets: [], workspace: { step: 10, rects: {} }, nextNumber: 1 });
    t.after(() => f.app.dispose());
    assert.ok(f.document.querySelector('[data-add-widget="wavelet"]'));
    const widget = f.app.widgets.create({ type: 'wavelet', settings: { channel: 1 } });
    const canvas = widget.view.waveletCanvas = f.document.createElement('canvas');
    canvas.getContext = () => ({ createImageData: (w, h) => ({ data: new Uint8ClampedArray(w * h * 4) }), putImageData() {} });
    canvas.toDataURL = () => { throw new Error('live rendering must not encode PNG'); };
    f.app.widgets.activate(widget.id);
    assert.equal(f.get('wavelet-freezeXOnZoom').checked, false);
    assert.equal(f.get('wavelet-showEdgeHatching').checked, true);
    for (let i = 0; i < 1024; i++) {
        const samples = new Float64Array(widget.source.frames.rawChannelCount);
        samples[1] = 10 * Math.cos(Math.PI * i / 8);
        widget.source.frames.append(samples, undefined, '', i + 1, 2000 + i);
    }
    widget.source.sampleRate.rate = 1000;
    await f.tick();
    await f.tick();
    await f.tick();
    assert.ok(widget.view.wavelet.snapshot, JSON.stringify({ message: widget.view.wavelet.message, error: widget.view.wavelet.error,
        pending: Boolean(widget.view.wavelet.request), rate: widget.source.sampleRate.rate, frames: widget.source.frames.length,
        plotted: widget.view.frames.length, tasks: f.app.service.workerPool.jobs.size }));
    const coefficients = widget.view.wavelet.snapshot.result;
    f.change('wavelet-viewMode', 'phase');
    await f.tick();
    assert.equal(widget.settings.viewMode, 'phase');
    assert.equal(widget.view.wavelet.snapshot.result, coefficients);
    const view = widget.view, originalRange = [...view.range], a = view.area;
    assert.equal(view.svg.querySelector('[data-wavelet-canvas]').children[0], canvas);
    assert.equal(originalRange[3], 500);
    const warning = view.svg.querySelector('[data-wavelet-nyquist-band]');
    assert.ok(warning);
    assert.ok(Number(warning.getAttribute('height')) > 0);
    assert.ok(Number(warning.getAttribute('y')) > a.top);
    view.hover({ x: a.left + a.width / 2, y: a.top });
    assert.match(view.overlay.textContent, /高于最高小波中心频率/);
    view.svg.dispatchEvent({ type: 'wheel', clientX: a.left + a.width / 2, clientY: a.top + a.height / 2, deltaY: -120 });
    await f.tick();
    assert.ok(view.range[0] > originalRange[0] && view.range[1] < originalRange[1]);
    assert.deepEqual([...view.range.slice(2)], originalRange.slice(2));
    async function exportData() {
        let exported;
        const saving = f.app.exportWidgetData().then(result => { exported = result; });
        for (let i = 0; i < 1000 && exported === undefined; i++) await f.tick(0);
        assert.equal(exported, true, f.get('widget-export-source-status').textContent);
        await saving;
    }
    f.change('widget-export-format', 'svg');
    await exportData();
    const svg = await f.blobs.at(-1).text();
    assert.match(svg, /小波相位图/);
    assert.match(svg, /data-wavelet-tiles/);
    assert.doesNotMatch(svg, /foreignObject|data-wavelet-canvas|data:image\/png/i);
    assert.match(svg, /data-wavelet-reference/);
    assert.match(svg, /data-wavelet-nyquist-band/);
    assert.doesNotMatch(svg, /<image\b/);
    const displayed = view.waveletDrawSnapshot.result;
    f.change('wavelet-showEdgeHatching', false);
    await f.tick();
    assert.equal(view.svg.querySelector('[data-wavelet-reference]'), null);
    assert.equal(view.svg.querySelector('[data-wavelet-nyquist-band]'), null);
    assert.equal(view.waveletDrawSnapshot.result, displayed);
    await exportData();
    const unhatched = await f.blobs.at(-1).text();
    assert.doesNotMatch(unhatched, /data-wavelet-reference/);
    assert.match(unhatched, /data-wavelet-tiles/);
    assert.doesNotMatch(unhatched, /data-wavelet-nyquist-band/);
    f.change('wavelet-showEdgeHatching', true);
    await f.tick();
    assert.ok(view.svg.querySelector('[data-wavelet-reference]'));
    assert.ok(view.svg.querySelector('[data-wavelet-nyquist-band]'));
    assert.equal(view.waveletDrawSnapshot.result, displayed);
    await exportData();
    const marked = await f.blobs.at(-1).text();
    assert.match(marked, /data-wavelet-reference/);
    assert.match(marked, /data-wavelet-nyquist-band/);
    f.change('wavelet-showEdgeHatching', false);
    f.change('widget-export-format', 'wavelet-csv');
    await exportData();
    const csv = await f.blobs.at(-1).text();
    assert.match(csv, /^time_s,frequency_hz,magnitude,phase_rad,status\r\n/);
    assert.ok(csv.split('\r\n').some(line => line.split(',')[3]?.match(/^-?\d/)));
    assert.match(csv, /,reference\r\n/);
    f.change('wavelet-freezeXOnZoom', true);
    f.change('wavelet-basis', 'mexicanHat');
    assert.equal(widget.settings.viewMode, 'magnitude');
    assert.ok(f.get('wavelet-viewMode').options.find(option => option.value === 'phase').disabled);
    f.app.applyConfig(JSON.parse(JSON.stringify(f.app.getConfig())));
    assert.equal(f.app.widgets.widgets.get(widget.id).settings.channel, 1);
    assert.equal(f.app.widgets.widgets.get(widget.id).settings.basis, 'mexicanHat');
    assert.equal(f.app.widgets.widgets.get(widget.id).settings.freezeXOnZoom, true);
    assert.equal(f.app.widgets.widgets.get(widget.id).settings.showEdgeHatching, false);
});
