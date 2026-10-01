const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

test('plotter uses the full sample window for CSV and bounds draw work to pixels', () => {
    let lineToCount = 0;
    const ctx = new Proxy({}, { get: (_, key) => key === 'measureText'
        ? () => ({ width: 50 })
        : key === 'lineTo' ? (x, y) => {
            assert.ok(Number.isFinite(x) && Number.isFinite(y)); lineToCount++;
        } : key === 'fillRect' ? (x, y, w, h) => {
            assert.ok([x, y, w, h].every(Number.isFinite));
        } : () => {} });
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
        { name: 'CH2', color: '#445566', visible: false }
    ]);
    assert.equal(batchDraws, 1);
    assert.equal(plotter.getChannelMeta().map(ch => ch.name).join(','), 'first,CH2');
    plotter.draw = drawBeforeBatch;
    plotter.setChannelVisible(0, true);
    plotter.setChannelVisible(1, true);
    plotter.setChannelName(0, 'a,b');
    plotter.setMaxPoints(5000);
    for (let i = 0; i < 6000; i++) plotter.addFrame([i, -i], Uint8Array.of(i & 255), 't');
    plotter.draw();
    assert.equal(plotter.frames.length, 5000);
    assert.equal(plotter.frames.getValue(0, 0), 1000);
    assert.ok(exportFrameCsv(frames, plotter.getChannelMeta()).startsWith('Index,"a,b",CH2\r\n0,1000,-1000\r\n'));
    assert.ok(lineToCount < 10000, `draw called lineTo ${lineToCount} times`);
    plotter.setDisplayOptions({ displayMode: 'frequency' });
    const start = performance.now();
    plotter.draw();
    assert.equal(plotter._drawState.startIdx, 0);
    assert.equal(plotter._drawState.visibleCnt, 4097,
        'the default frequency view includes DC through Nyquist');
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

    const drawsBefore = plotter.completedDraws;
    plotter.draw();
    assert.equal(plotter.completedDraws, drawsBefore + 1);
    plotter.setChannelSettings([{ name: 'scaled', color: '#112233', visible: true,
        gainEnabled: true, gain: -2, offsetEnabled: true, offset: 4 }]);
    plotter.draw();
    assert.equal(summary.mean, 2);
    assert.equal(plotter._collectWindowSeries(0, 2, null)[0].rawValues[1], 2);
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
    plotter.draw();
    assert.equal(plotter.completedSpectrumDraws, visibleSpectra,
        'redrawing a cached spectrum does not represent a new frequency frame');
    plotter._fftAt -= 300;
    plotter.draw();
    assert.equal(plotter.completedSpectrumDraws, visibleSpectra + 1);
    plotter.setChannelSettings([{ name: 'legacy', visible: true }]);
    const legacy = plotter.getChannelMeta()[0];
    assert.deepEqual([legacy.gainEnabled, legacy.gain, legacy.offsetEnabled, legacy.offset],
        [false, 1, false, 0]);

    // Live samples should advance the frequency plot only when a fresh spectrum is due.
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
    assert.equal(plotter.completedDraws, firstDraw + 1,
        'fresh samples alone must not redraw the same cached spectrum');

    clockMs += 65;
    plotter.renderLoop();
    assert.equal(plotter.completedSpectrumDraws, firstSpectrum + 2,
        'a new spectrum is drawn after 100 ms of incoming data');

    clockMs += 40;
    plotter.addFrame([3]);
    plotter.setChannelName(0, 'renamed');
    plotter.renderLoop();
    assert.equal(plotter.completedDraws, firstDraw + 3,
        'a display change redraws promptly while the frequency cache is fresh');
    assert.equal(plotter.completedSpectrumDraws, firstSpectrum + 2);
});
