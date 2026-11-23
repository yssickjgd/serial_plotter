const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

test('plotter uses the full sample window for CSV and bounds draw work to pixels', () => {
    let lineToCount = 0;
    const markerCalls = [];
    const ctx = new Proxy({}, { get: (state, key) => key === 'measureText'
        ? () => ({ width: 50 })
        : key === 'lineTo' ? (x, y) => {
            assert.ok(Number.isFinite(x) && Number.isFinite(y)); lineToCount++;
        } : key === 'fillRect' ? (x, y, w, h) => {
            assert.ok([x, y, w, h].every(Number.isFinite));
            markerCalls.push(['fillRect', x, y, w, h]);
        } : key === 'arc' ? (...args) => markerCalls.push(['arc', ...args, state.lineWidth]) : () => {} });
    const element = () => ({ style: {}, offsetHeight: 12, clientWidth: 800,
        addEventListener() {}, getBoundingClientRect: () => ({ width: 800, height: 400 }) });
    const elements = new Map();
    const canvas = { ...element(), parentElement: element(), getContext: () => ctx };
    elements.set('waveform-canvas', canvas);
    const document = { getElementById: id => {
        if (!elements.has(id)) elements.set(id, element());
        return elements.get(id);
    }, addEventListener() {} };
    const context = vm.createContext({
        document, window: { addEventListener() {} }, performance, requestAnimationFrame() {}, console
    });
    for (const file of ['projectLimits.js', 'frameBuffer.js', 'plotMath.js', 'channelTransform.js',
        'spectrum.js', 'csvExport.js', 'plotter.js']) {
        vm.runInContext(fs.readFileSync(require.resolve(`../${file}`), 'utf8'), context, { filename: file });
    }
    const { Plotter, FrameBuffer, exportFrameCsv } = context.SerialPlotter;
    const frames = new FrameBuffer(1, 1000);
    const plotter = new Plotter('waveform-canvas', frames);
    assert.equal(plotter.frames, frames, 'the application-owned buffer is shared with the view');
    plotter.setChannelCount(2);
    let batchDraws = 0;
    const drawBeforeBatch = plotter.draw.bind(plotter);
    plotter.draw = () => { batchDraws++; };
    plotter.setChannelSettings([
        { name: 'first', color: '#112233', visible: true },
        { name: 'CH00002', color: '#445566', visible: false }
    ]);
    assert.equal(batchDraws, 1);
    assert.equal(plotter.getChannelMeta().map(ch => ch.name).join(','), 'first,CH00002');
    plotter.draw = drawBeforeBatch;
    plotter.setChannelVisible(0, true);
    plotter.setChannelVisible(1, true);
    plotter.setChannelName(0, 'a,b');
    plotter.setMaxPoints(5000);
    for (let i = 0; i < 6000; i++) plotter.addFrame([i, -i], Uint8Array.of(i & 255), 't');
    plotter.draw();
    assert.equal(plotter.frames.length, 5000);
    assert.equal(plotter.frames.getValue(0, 0), 1000);
    assert.ok(exportFrameCsv(frames, plotter.getChannelMeta()).startsWith('Index,"a,b",CH00002\r\n0,1000,-1000\r\n'));
    assert.ok(lineToCount < 10000, `draw called lineTo ${lineToCount} times`);
    plotter.setDisplayOptions({ displayMode: 'frequency' });
    const start = performance.now();
    plotter.draw();
    assert.equal(plotter._drawState.startIdx, 0);
    assert.equal(plotter._drawState.visibleCnt, 513,
        'the live spectrum uses the latest 1000 samples and includes DC through Nyquist');
    console.log(`two-channel FFT draw in ${(performance.now() - start).toFixed(1)} ms`);
    assert.equal(elements.get('plot-scrollbar-thumb').style.width, '100%');
    plotter.setChannelCount(23);
    plotter.setAllChannelsVisible(true);
    for (let i = 0; i < 5000; i++) plotter.addFrame(Array.from({ length: 23 }, (_, c) => i + c));
    const allStart = performance.now();
    plotter.draw();
    console.log(`23-channel FFT draw in ${(performance.now() - allStart).toFixed(1)} ms`);
    const cachedStart = performance.now();
    const linesBeforeCachedDraw = lineToCount;
    plotter.draw();
    console.log(`23-channel cached draw in ${(performance.now() - cachedStart).toFixed(1)} ms`);
    assert.ok(lineToCount - linesBeforeCachedDraw < 40000,
        `frequency drawing used ${lineToCount - linesBeforeCachedDraw} line segments`);
    plotter.clear();
    assert.equal(plotter._scrollTotal(), 0);
    plotter.setDisplayOptions({ displayMode: 'time' });
    plotter.addFrame(new Array(23).fill(NaN));
    plotter.addFrame(new Array(23).fill(1));
    plotter.draw();
    let summary;
    plotter.onStatsUpdate = value => { summary = value; };
    plotter.setAllChannelsVisible(false);
    plotter.setChannelVisible(0, true);
    plotter.draw();
    assert.equal(summary.mean, 1);

    const trace = { points: [{ x: 5, y: 5, synthetic: true }, { x: 15, y: 10 },
        { x: 25, y: 20, recovered: true }, { x: 35, y: 30 }], color: '#112233', dots: true };
    markerCalls.length = 0;
    plotter._drawTrace2D(trace);
    assert.deepEqual(markerCalls, [['fillRect', 13.5, 8.5, 3, 3], ['fillRect', 33.5, 28.5, 3, 3]]);
    plotter._drawRecoveredMarkers([trace], 100, 80);
    const recoveredMarker = markerCalls.at(-1);
    assert.deepEqual(recoveredMarker.slice(0, 3), ['arc', 25, 20]);
    assert.equal(2 * recoveredMarker[3] + recoveredMarker.at(-1), markerCalls[0][3],
        'the outline including its stroke fits the same width as a measured sample marker');

    const drawsBefore = plotter.completedDraws;
    plotter.draw();
    assert.equal(plotter.completedDraws, drawsBefore + 1);
    plotter.setChannelSettings([{ name: 'scaled', color: '#112233', visible: true,
        gainEnabled: true, gain: -2, offsetEnabled: true, offset: 4 }]);
    plotter.draw();
    assert.equal(summary.mean, 2);
    assert.equal(plotter._collectWindowSeries(0, 2, null)[0].rawValues[1], 2);
    const transformedSlice = plotter._transformedChannelSlice(0, 0, 2);
    assert.equal(ArrayBuffer.isView(transformedSlice), true,
        'plot and FFT input should use a compact numeric buffer instead of a boxed-number array');
    assert.deepEqual([...transformedSlice], [NaN, 2]);
    assert.equal(frames.getValue(0, 1), 1);
    assert.ok(exportFrameCsv(frames, plotter.getChannelMeta()).includes('1,2,'));

    plotter.clear();
    plotter.setChannelCount(1);
    plotter.setChannelVisible(0, true);
    for (let i = 0; i < 64; i++) plotter.addFrame([Math.sin(2 * Math.PI * 4 * i / 64)]);
    plotter.setDisplayOptions({ displayMode: 'frequency', fftWindow: 'rectangular',
        removeDcForFft: true });
    const rectangleSpectrum = plotter._frequencyForChannel(0);
    plotter.setDisplayOptions({ fftWindow: 'flatTop' });
    const flatSpectrum = plotter._frequencyForChannel(0);
    assert.notEqual(flatSpectrum, rectangleSpectrum, 'changing the window invalidates the FFT cache');
    assert.ok(Math.abs(flatSpectrum.mags[4] - 2) < 0.02,
        'the enabled gain is applied before FFT and the window preserves amplitude');
    plotter.setChannelSettings([{ visible: true, gainEnabled: true, gain: 0,
        offsetEnabled: true, offset: 3 }]);
    plotter.setDisplayOptions({ removeDcForFft: false });
    const offsetSpectrum = plotter._frequencyForChannel(0);
    assert.ok(Math.abs(offsetSpectrum.mags[0] - 3) < 1e-10);
    assert.equal(frames.getValue(0, 0), 0);
    const visibleSpectra = plotter.completedSpectrumDraws;
    plotter.addFrame([1]);
    assert.notEqual(plotter._frequencyForChannel(0), offsetSpectrum);
    plotter.draw();
    assert.equal(plotter.completedSpectrumDraws, visibleSpectra + 1,
        'a spectrum computed for inspection counts when it is first presented');
    plotter.draw();
    assert.equal(plotter.completedSpectrumDraws, visibleSpectra + 1,
        'repainting unchanged data does not compute or count another spectrum');
    plotter.setChannelSettings([{ name: 'legacy', visible: true }]);
    const legacy = plotter.getChannelMeta()[0];
    assert.deepEqual([legacy.gainEnabled, legacy.gain, legacy.offsetEnabled, legacy.offset],
        [false, 1, false, 0]);

    // New input can refresh on the next animation tick without a fixed waiting interval.
    let clockMs = 1000;
    context.performance = { now: () => clockMs };
    plotter._fftVersion = -1;
    plotter._lastDraw = 0;
    plotter.addFrame([1]);
    const firstDraw = plotter.completedDraws;
    const firstSpectrum = plotter.completedSpectrumDraws;
    plotter.renderLoop();
    assert.equal(plotter.completedSpectrumDraws, firstSpectrum + 1);
    assert.equal(plotter.completedDraws, firstDraw + 1);

    clockMs += 40;
    plotter.addFrame([2]);
    plotter.renderLoop();
    assert.equal(plotter.completedDraws, firstDraw + 2);
    assert.equal(plotter.completedSpectrumDraws, firstSpectrum + 2,
        'new samples refresh the spectrum immediately, even within 100 ms');

    clockMs += 65;
    plotter.renderLoop();
    assert.equal(plotter.completedSpectrumDraws, firstSpectrum + 2,
        'elapsed time without new samples does not refresh a cached spectrum');
    assert.equal(plotter.completedDraws, firstDraw + 2);

    clockMs += 40;
    plotter.addFrame([3]);
    plotter.setChannelName(0, 'renamed');
    plotter.renderLoop();
    assert.equal(plotter.completedDraws, firstDraw + 3,
        'a display change redraws promptly while the frequency cache is fresh');
    assert.equal(plotter.completedSpectrumDraws, firstSpectrum + 3);
});

test('a 39% waveform budgets vertices and backing pixels for its displayed size', () => {
    let zoom = 1;
    const rect = () => ({ width: 800 * zoom, height: 400 * zoom, top: 0, left: 0 });
    const widths = [];
    const ctx = new Proxy({}, { get: (state, key) => {
        if (key === 'measureText') return () => ({ width: 20 });
        if (key === 'stroke') return () => {
            if (state.strokeStyle === '#00FF7F') widths.push(state.lineWidth);
        };
        return () => {};
    } });
    const document = { defaultView: { devicePixelRatio: 2 } };
    const canvas = { ownerDocument: document, parentElement: { getBoundingClientRect: rect },
        getContext: () => ctx, getBoundingClientRect: rect,
        closest: () => ({ dataset: { workspaceZoom: String(zoom) } }) };
    const gpu = { available: true, resize(...size) { this.size = size; },
        render(traces) { this.trace = traces[0]; return true; } };
    const context = vm.createContext({ document, window: document.defaultView, performance,
        requestAnimationFrame() {}, console });
    for (const file of ['projectLimits.js', 'frameBuffer.js', 'plotMath.js', 'channelTransform.js',
        'spectrum.js', 'plotter.js']) {
        vm.runInContext(fs.readFileSync(require.resolve(`../${file}`), 'utf8'), context, { filename: file });
    }
    const { Plotter, FrameBuffer } = context.SerialPlotter;
    const frames = new FrameBuffer(1, 5000);
    const plotter = new Plotter(canvas, frames, { gpuRenderer: gpu });
    plotter.setChannelCount(1);
    plotter.setChannelVisible(0, true);
    plotter.setMaxPoints(5000);
    plotter.setPlotWindowPoints(5000);
    for (let i = 0; i < 5000; i++) plotter.addFrame([i === 1000 ? 100 : i === 1001 ? -100
        : i === 2500 ? NaN : i % 2 ? i % 29 : -(i % 31)]);

    plotter.draw();
    const largeTraceSize = gpu.trace.points.length;
    assert.ok(largeTraceSize > 1000);
    zoom = .39;
    plotter.resize();
    plotter.draw();
    assert.equal(plotter._drawState.visibleCnt, 5000);
    assert.equal(frames.length, 5000);
    assert.equal(frames.getValue(0, 1), 1);
    assert.ok(gpu.trace.points.length <= 560, `sent ${gpu.trace.points.length} vertices for a 277 px plot`);
    assert.ok(gpu.trace.points.length < largeTraceSize / 2);
    assert.equal(gpu.trace.points[0].index, 0);
    assert.equal(gpu.trace.points.at(-1).index, 4999);
    for (const [index, value] of [[1000, 100], [1001, -100]]) {
        assert.equal(gpu.trace.points.find(point => point.index === index)?.value, value);
    }
    assert.equal(gpu.trace.points.find(point => point.index === 2501)?.break, true);
    assert.deepEqual(gpu.size, [800, 388, 312, 151]);
    assert.equal(canvas.width, 624, 'the axes retain screen device-pixel density');

    const interior = first => Array.from(gpu.trace.points, point => point.index + first)
        .filter(index => index >= 100 && index < 4900);
    const beforeScroll = interior(0);
    plotter.addFrame([42]);
    plotter.draw();
    assert.equal(frames.frameOrdinalAt(0), 1);
    assert.deepEqual(interior(1), beforeScroll, 'the interior shape survives live ring-buffer eviction');

    gpu.available = false;
    plotter.draw();
    assert.ok(Math.abs(widths.at(-1) * zoom - 1) < 1e-9,
        'the Canvas fallback renders a one-CSS-pixel stroke at this zoom');

    document.defaultView.devicePixelRatio = .8;
    plotter.resize();
    plotter.draw();
    assert.ok(widths.at(-1) * zoom * document.defaultView.devicePixelRatio >= 1 - 1e-9,
        'browser zoom also leaves at least one physical pixel for the fallback stroke');
});
