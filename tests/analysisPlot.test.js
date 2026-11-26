const test = require('node:test');
const assert = require('node:assert/strict');
const { AnalysisSettings } = require('../analysisSettings');
const { histogramBins, HistogramWindow, readPairs, trajectory, equalRanges, AnalysisPlot } = require('../analysisPlot');
const { FrameBuffer } = require('../frameBuffer');
const { SynchronizedFrames } = require('../engineFrames');
const { WorkspaceChannelCapture } = require('../workspaceChannels');
const { bootArrayApplication } = require('./helpers/widgetAppHarness');

const histogram = input => new HistogramWindow(AnalysisSettings.normalize('histogram', input));

test('XY spectrum modes plot paired gain, phase and coherence at a shared frequency and export the active mode', t => {
    const env = bootArrayApplication(); t.after(() => env.app.dispose());
    const svg = env.document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    const frames = framesWith(Array.from({ length: 64 }, (_, i) => {
        const angle = 2 * Math.PI * i / 8;
        return [Math.cos(angle), .5 * Math.cos(angle + Math.PI / 2)];
    }));
    const settings = { viewMode: 'phase', fftWindow: 'rectangular' };
    const view = new AnalysisPlot(svg, 'xy', frames, settings, 64, () => ({ rate: 800 }));
    t.after(() => view.dispose());
    view.renderNow();
    const axisTitles = />\s*(?:X|Y|幅度比（Y \/ X）|增益（dB）|相位差（[^）]*）|相干度|频率（[^）]*）)\s*<\/text>/u;
    assert.match(svg.textContent, / rad/);
    assert.match(svg.textContent, / Hz/);
    assert.doesNotMatch(view.exportSvg(), axisTitles);
    assert.ok(Math.abs(view.spectra[0].values[4] - Math.PI / 2) < 1e-9);
    assert.equal(view.frequencyAtBin(4), 100);
    assert.equal(view.spectra[0].blocks, 3);
    view.setSettings({ ...settings, viewMode: 'gain' }); view.renderNow();
    assert.ok(Math.abs(view.spectra[0].values[4] - .5) < 1e-9);
    assert.equal(view.frequencyAtBin(4), 100);
    svg.dispatchEvent({ type: 'pointermove', clientX: view.px(view.binToAxis(4)) + .5, clientY: view.py(.5) });
    assert.ok(view.overlay.querySelectorAll('text').some(node => node.textContent.endsWith(': 0.5')));
    assert.doesNotMatch(view.exportSvg(), axisTitles);
    view.setSettings({ ...settings, viewMode: 'gain', gainUnit: 'db', gainDbYAuto: false, gainDbYMin: -30, gainDbYMax: 0 });
    view.renderNow();
    assert.ok(Math.abs(view.spectra[0].values[4] + 6.020599913279624) < 1e-9);
    assert.deepEqual(view.range.slice(2), [-30, 0]);
    assert.doesNotMatch(view.exportSvg(), axisTitles);
    view.setSettings({ ...view.settings, gainUnit: 'db10' }); view.renderNow();
    assert.ok(Math.abs(view.spectra[0].values[4] + 3.010299956639812) < 1e-9);
    assert.deepEqual(view.range.slice(2), [-30, 0]);
    view.setSettings(settings, 32); view.renderNow();
    assert.equal(view.fftSize, 16);
    assert.equal(view.frequencyAtBin(2), 100);
    view.setSettings({ ...settings, viewMode: 'coherence', freqXScale: 'bins-log' });
    view.renderNow();
    assert.ok(Math.abs(view.spectra[0].values[2] - 1) < 1e-9);
    assert.deepEqual(view.range.slice(2), [0, 1]);
    assert.doesNotMatch(view.exportSvg(), axisTitles);
    view.setSettings(settings, 128); view.renderNow();
    assert.equal(view.spectra[0].fftSize, 32);
    assert.ok(Math.abs(view.spectra[0].values[4] - Math.PI / 2) < 1e-9);
    view.setFrames(framesWith([[1, -1]], 2)); view.renderNow();
    assert.match(svg.textContent, /至少需要 2 段/);
    view.setFrames(frames);
    view.setSettings({ viewMode: 'trajectory' }); view.renderNow();
    assert.ok(view.hitPoints.length > 0);
    assert.doesNotMatch(view.exportSvg(), axisTitles);
});

test('switching phase units preserves the current X and Y zoom', t => {
    const env = bootArrayApplication(); t.after(() => env.app.dispose());
    const svg = env.document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    const frames = framesWith(Array.from({ length: 32 }, (_, i) => [Math.cos(i), Math.sin(i)]));
    const settings = { viewMode: 'phase', phaseYAuto: false };
    const view = new AnalysisPlot(svg, 'xy', frames, settings, 64);
    t.after(() => view.dispose());
    view.renderNow();
    view.applyZoom([1, 6, -1, 1]); view.renderNow();
    assert.deepEqual(view.range, [1, 6, -1, 1]);
    view.setSettings({ ...settings, phaseUnit: 'degrees' }); view.renderNow();
    assert.deepEqual(view.range, [1, 6, -180 / Math.PI, 180 / Math.PI]);
    svg.dispatchEvent({ type: 'contextmenu' }); view.renderNow();
    assert.deepEqual(view.range.slice(2), [-180, 180]);
});

test('gain log Y uses original ratio ticks, geometric hover and the same zoom as waveform', t => {
    const env = bootArrayApplication(); t.after(() => env.app.dispose());
    const svg = env.document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    const settings = { viewMode: 'gain', gainUnit: 'ratio-log', gainYAuto: false, gainYMin: .01, gainYMax: 100,
        freqXScale: 'bins-linear' };
    const view = new AnalysisPlot(svg, 'xy', framesWith([[0, 0], [1, 1]]), settings, 32);
    t.after(() => view.dispose());
    view.updateSpectra = () => {};
    function publish(values) {
        view.publishSpectra([{ pair: view.settings.pairs[0], fftSize: 16, blocks: 2, gain: Float64Array.from(values) }], 'fixture', 800);
        view.renderNow();
    }
    publish([NaN, .01, 100, NaN, NaN, NaN, NaN, NaN, .01]);
    const { left, right, top, height, bottom } = view.area;
    const center = top + height / 2, x = view.px(1.5);
    assert.equal(view.yScale, 'log');
    assert.ok(Math.abs(view.py(1) - center) < 1e-9);
    svg.dispatchEvent({ type: 'pointermove', clientX: x, clientY: center });
    assert.ok(view.overlay.querySelectorAll('text').some(node => node.textContent.endsWith(': 1')));
    svg.dispatchEvent({ type: 'wheel', deltaY: -1, clientX: right + 10, clientY: center });
    view.renderNow();
    assert.ok(Math.abs(view.coords(left, center)[1] - 1) < 1e-9);
    assert.ok(Math.abs(view.range[2] * view.range[3] - 1) < 1e-9);
    assert.deepEqual(view.range.slice(0, 2), [0, 8]);
    svg.dispatchEvent({ type: 'contextmenu' }); view.renderNow();
    assert.deepEqual(view.range.slice(2), [.01, 100]);

    view.setSettings({ ...settings, gainYMin: 0 });
    publish([NaN, 0, .1, NaN, 100, NaN, NaN, NaN, .01]);
    assert.deepEqual(view.yScale, { type: 'log-linear', linearThreshold: 1 });
    assert.equal(view.py(0), bottom);
    view.applyZoom([0, 3, 0, 50]); view.renderNow();
    assert.deepEqual(view.yScale, { type: 'log-linear', linearThreshold: 1 });
    assert.equal(view.py(0), bottom);
    view.setSettings({ ...settings, gainYAuto: true });
    publish([NaN, 0, .01, NaN, 100, NaN, NaN, NaN, .01]);
    assert.equal(view.yScale, 'log');
    assert.ok(view.range[2] > 0 && view.range[2] < .01 && view.range[3] > 100);
    assert.equal(view.py(0), bottom);
});

test('gapped pairs fall back independently and plot their peaks on the same frequency axis', t => {
    const env = bootArrayApplication(); t.after(() => env.app.dispose());
    const svg = env.document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    const frames = framesWith(Array.from({ length: 64 }, (_, i) => {
        const t = 2 * Math.PI * i / 8;
        const x = Math.cos(t), y = Math.cos(t + Math.PI / 2);
        return [x, y, i < 12 || i >= 52 ? y : NaN];
    }));
    const settings = { viewMode: 'phase', fftWindow: 'rectangular', pairs: [{ x: 0, y: 1 }, { x: 0, y: 2 }] };
    const view = new AnalysisPlot(svg, 'xy', frames, settings, 64, () => ({ rate: 800 }));
    t.after(() => view.dispose());
    view.renderNow();
    assert.deepEqual(view.spectra.map(spectrum => [spectrum.fftSize, spectrum.blocks]), [[32, 3], [8, 4]]);
    assert.ok(view.spectra.every(spectrum => Math.abs(spectrum.values[spectrum.fftSize / 8] - Math.PI / 2) < 1e-9));
    assert.match(svg.textContent, /8 点\/段/);
    assert.equal(view.spectrumBin(1, view.spectra[1]), 4);
    view.setSettings({ ...settings, viewMode: 'coherence', freqXScale: 'bins-log' });
    view.renderNow();
    assert.ok(view.spectra.every(spectrum => Math.abs(spectrum.values[spectrum.fftSize / 8] - 1) < 1e-9));
    assert.doesNotMatch(view.exportSvg(), />频率（参考 Bin）<\/text>/);
    svg.dispatchEvent({ type: 'pointermove', clientX: view.px(view.binToAxis(4)), clientY: view.py(.5) });
    assert.match(view.overlay.textContent, /X 4 参考 Bin/);
});

test('phase difference unwraps to the nearest cycle across undefined bins without drawing across the gap', t => {
    const env = bootArrayApplication(); t.after(() => env.app.dispose());
    const svg = env.document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    const frames = framesWith([[0, 0], [1, 1]]);
    const view = new AnalysisPlot(svg, 'xy', frames, { viewMode: 'phase' }, 32);
    t.after(() => view.dispose());
    view.updateSpectra = () => {};
    const wrapped = [NaN, -170, 170, 10, -150, NaN, NaN, 160, 140];
    const unwrapped = [NaN, -170, -190, -350, -510, NaN, NaN, -560, -580];
    for (const [phaseUnit, phaseUnwrap] of [['radians', true], ['degrees', true], ['degrees', false]]) {
        view.setSettings({ viewMode: 'phase', phaseUnit, phaseUnwrap });
        view.publishSpectra([{
            pair: view.settings.pairs[0], fftSize: 16, blocks: 2, recovered: 0, samples: 32,
            phase: Float64Array.from(wrapped, degrees => degrees * Math.PI / 180)
        }], 'fixture', 800);
        view.renderNow();
        const actual = Array.from(view.spectra[0].values,
            value => Math.round(phaseUnit === 'degrees' ? value : value * 180 / Math.PI));
        assert.deepEqual(actual, phaseUnwrap ? unwrapped : wrapped);
        const trace = svg.querySelectorAll('path').find(path => path.getAttribute('stroke') === view.settings.pairs[0].color);
        const line = trace.getAttribute('d');
        assert.equal((line.match(/M/g) ?? []).length, phaseUnwrap ? 2 : 3);
    }
});

test('spectrum wheels use the right Y scale and preserve fixed bounds when zooming X', t => {
    const env = bootArrayApplication(); t.after(() => env.app.dispose());
    const frames = framesWith([[0, 0], [1, 1]]);
    for (const [mode, scale, fixed, lower, upper] of [
        ['phase', 'hz-linear', [-3, 3], -.6, .6],
        ['coherence', 'hz-log', [0, 1], .2, .6]
    ]) {
        const svg = env.document.createElementNS('http://www.w3.org/2000/svg', 'svg');
        const settings = {
            viewMode: mode, freqXScale: scale, traceMode: 'points',
            phaseUnwrap: false, phaseYAuto: true, phaseYMin: -3, phaseYMax: 3, coherenceYAuto: true
        };
        const view = new AnalysisPlot(svg, 'xy', frames, settings, 32, () => ({ rate: 800 }));
        t.after(() => view.dispose());
        view.updateSpectra = () => {};
        const pair = view.settings.pairs[0];
        const makeSpectrum = (fftSize, values) => ({
            pair, fftSize, blocks: 2, phase: Float64Array.from(values), coherence: Float64Array.from(values)
        });
        const values = mode === 'phase'
            ? [2.5, -.2, -.3, -.4, 0, .25, .3, .4, -2.5]
            : [.9, .9, .3, .35, .4, .45, .5, .8, .95];
        const sparse = mode === 'phase' ? [2.8, -.5, .5, .35, -2.8] : [.88, .25, .55, .5, .99];
        const publish = () => view.publishSpectra([makeSpectrum(16, values), makeSpectrum(8, sparse)], 'fixture', 800);
        const wheelIn = (y = .25) => svg.dispatchEvent({ type: 'wheel', deltaY: -1,
            clientX: view.area.left + view.area.width / 2, clientY: view.area.top + view.area.height * y });
        publish();
        view.renderNow();
        const full = view.range.slice();
        wheelIn(); view.renderNow();
        const zoomed = view.range.slice();
        assert.ok(zoomed[0] > full[0] && zoomed[1] < full[1], mode);
        assert.ok(zoomed[2] > lower && zoomed[3] < upper, mode);
        const known = mode === 'phase' ? [-.5, .5] : [.25, .55];
        assert.ok(zoomed[2] <= known[0] && zoomed[3] >= known[1], mode);
        view.resetZoom(); view.renderNow();
        wheelIn(.8); view.renderNow();
        assert.deepEqual(view.range, zoomed, 'automatic Y follows the frequency band and ignores the cursor height');

        view.setSettings({ ...settings, [mode + 'YAuto']: false });
        publish(); view.renderNow();
        assert.deepEqual(view.range.slice(2), fixed);
        wheelIn(); view.renderNow();
        assert.deepEqual(view.range.slice(2), fixed);
        const frequency = view.range.slice(0, 2);
        assert.ok(svg.querySelectorAll('text').some(label => label.getAttribute('text-anchor') === 'start' &&
            Number(label.getAttribute('x')) > view.area.right && Number(label.getAttribute('y')) > view.area.top));
        const verticalAnchor = view.area.top + view.area.height * .25;
        svg.dispatchEvent({ type: 'wheel', deltaY: -1, clientX: view.area.right + 12, clientY: verticalAnchor });
        view.renderNow();
        assert.deepEqual(view.range.slice(0, 2), frequency);
        assert.ok(view.range[2] > fixed[0] && view.range[3] < fixed[1]);
        const [, value] = view.coords(view.area.left, verticalAnchor);
        assert.ok(Math.abs(value - (fixed[0] * .25 + fixed[1] * .75)) < 1e-12);

        view.setSettings({ ...settings, traceMode: 'line' });
        publish(); view.renderNow();
        view.applyZoom([view.binToAxis(3.25), view.binToAxis(3.75)]); view.renderNow();
        const [min, max] = mode === 'phase' ? [-.4, .5] : [.3, .6];
        assert.ok(view.range[2] > min && view.range[3] < max, 'auto Y fits the clipped lines between bins');
    }
});

test('spectrum hover shows cursor coordinates and each curve value at its plotted position', t => {
    const env = bootArrayApplication(); t.after(() => env.app.dispose());
    const frames = framesWith([[0, 0, 0], [1, 1, 1]]);
    frames.channelNames = ['采样', 'yaw', '参考'];
    for (const [viewMode, freqXScale, mouseY, values, markers, expectedTip] of [
        ['phase', 'hz-log', 0, [[1, 2], [-1, -2]], ['采样 / yaw: 1.5 rad', '采样 / 参考: -1.5 rad'], ['X 122.474 Hz', 'Y 0 rad']],
        ['coherence', 'bins-linear', .9, [[.3, .5], [.5, .7]], ['采样 / 参考: 0.6', '采样 / yaw: 0.4'], ['X 2.5 Bin', 'Y 0.9']]
    ]) {
        const svg = env.document.createElementNS('http://www.w3.org/2000/svg', 'svg');
        const settings = { viewMode, freqXScale, pairs: [{ x: 0, y: 1 }, { x: 0, y: 2 }] };
        const view = new AnalysisPlot(svg, 'xy', frames, settings, 32);
        t.after(() => view.dispose());
        view.updateSpectra = () => {};
        const publish = pairs => {
            view.publishSpectra(pairs.map(([left, right], i) => {
                const data = Float64Array.from([0, NaN, left, right, NaN, NaN, NaN, NaN, 0]);
                return { pair: view.settings.pairs[i], fftSize: 16, blocks: 2, phase: data, coherence: data };
            }), 'fixture', 800);
            view.renderNow();
        };
        publish(values);
        const axis = (view.binToAxis(2) + view.binToAxis(3)) / 2;
        const move = binAxis => svg.dispatchEvent({ type: 'pointermove', clientX: view.px(binAxis), clientY: view.py(mouseY) });
        move(axis);
        const labels = () => view.overlay.querySelectorAll('text').map(node => node.textContent);
        assert.deepEqual(labels(), [...markers, ...expectedTip]);
        assert.equal(view.overlay.querySelectorAll('line').length, 2);
        const circles = view.overlay.querySelectorAll('circle');
        assert.equal(circles.length, 2);
        for (const [i, [left, right]] of values.entries()) {
            const marker = circles.find(node => node.getAttribute('fill') === view.settings.pairs[i].color);
            assert.ok(marker);
            assert.ok(Math.abs(Number(marker.getAttribute('cx')) - view.px(axis)) < 1e-8);
            assert.ok(Math.abs(Number(marker.getAttribute('cy')) - view.py((left + right) / 2)) < 1e-8);
        }
        move(view.binToAxis(4));
        assert.equal(view.overlay.querySelectorAll('circle').length, 0);
        assert.equal(labels().length, 2, 'cursor coordinates remain visible over a gap');

        view.setSettings({ ...settings, traceMode: 'points' });
        publish(values);
        const first = view.binToAxis(2);
        move((first + axis) / 2);
        assert.ok(view.overlay.querySelectorAll('circle').every(marker => Number(marker.getAttribute('cx')) === view.px(first)));
        assert.equal(view.overlay.querySelectorAll('circle').length, 2);

        if (viewMode === 'phase') {
            view.setSettings({ ...settings, phaseUnwrap: false });
            publish([[2.9, -2.9]]);
            move(axis);
            assert.deepEqual(labels(), expectedTip, 'wrapped phase jumps have no interpolated hover values');
        }
    }
});

test('after clear the log axis starts at the first bin of the available FFT, including a one-point spectrum', t => {
    const env = bootArrayApplication(); t.after(() => env.app.dispose());
    const svg = env.document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    const frames = framesWith(Array.from({ length: 48 }, (_, i) => [Math.cos(i), Math.sin(i)]), 64);
    const view = new AnalysisPlot(svg, 'xy', frames, { viewMode: 'phase', freqXScale: 'hz-log' }, 5000, () => ({ rate: 1024 }));
    t.after(() => view.dispose());
    view.renderNow();
    view.applyZoom([.2, .5, -1, 1]);
    frames.clear();
    view.clear();
    for (const value of [1, -1, 1]) frames.append([value, -value]);
    view.renderNow();
    assert.equal(view.axisFftSize, 2);
    assert.equal(view.frequencyAtBin(1), 512);
    assert.equal(view.px(view.binToAxis(view.spectrumBin(1, view.spectra[0]))), view.area.left);
    assert.equal(view.zoom, null);
    assert.doesNotMatch(view.exportSvg(), /NaN|Infinity/);
    for (let i = 0; i < 100; i++) frames.append([Math.cos(i), Math.sin(i)]);
    view.renderNow();
    assert.equal(view.axisFftSize, 32);
    assert.equal(view.frequencyAtBin(1), 32);
    assert.equal(view.px(view.binToAxis(view.spectrumBin(1, view.spectra[0]))), view.area.left);
});

test('XY spectrum keeps historical grid rates and never joins FFT blocks across a segment boundary', t => {
    const env = bootArrayApplication(); t.after(() => env.app.dispose());
    const svg = env.document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    const frames = new SynchronizedFrames(2, 128, { sampleRate: 1000 });
    const append = (count, start, step) => {
        for (let i = 0; i < count; i++) {
            const angle = 2 * Math.PI * i / 8;
            frames.ingest(start + step * i, [[0, Math.cos(angle)], [1, Math.sin(angle)]], { order: start + i });
        }
    };
    append(64, 0, 1);
    frames.stop();
    append(16, 64, 1);
    frames.stop();
    frames.updateSynchronization({ sampleRate: 500 });
    append(48, 100, 2);
    const view = new AnalysisPlot(svg, 'xy', frames, { viewMode: 'coherence' }, 64);
    t.after(() => view.dispose());
    view.renderNow();
    assert.equal(view.frequencyRate, 500);
    assert.equal(view.spectra[0].blocks, 2);
    view.setPaused(true);
    view.jumpToFrame(79); view.renderNow();
    assert.equal(view.frequencyRate, 1000);
    assert.equal(view.spectra[0].blocks, 2, 'the sixteen samples after restart cannot bridge the previous run');
});

test('spectrum reads a full published synchronization window while live source traces are ahead', t => {
    const env = bootArrayApplication(); t.after(() => env.app.dispose());
    const svg = env.document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    const capture = new WorkspaceChannelCapture({ mappings: [
        { sourceId: 'primary', channelId: 'raw:1', number: 1, name: 'x', color: '#ff0000' },
        { sourceId: 'serial-2', channelId: 'raw:1', number: 1, name: 'y', color: '#00ff00' }
    ], methods: { primary: 'nearest', 'serial-2': 'spline' }, holdMs: 500, waitMs: 500 }, 64);
    t.after(() => capture.dispose());
    capture.ingest(Array.from({ length: 64 }, (_, i) => ({
        time: i, values: [[0, Math.cos(i)], [1, Math.sin(i)]], origin: {}
    })), true, 31);
    const view = new AnalysisPlot(svg, 'xy', capture.numericSource.frames, { viewMode: 'phase' }, 32);
    t.after(() => view.dispose());
    view.renderNow();
    assert.equal(view.spectra[0].samples, 32);
    assert.equal(view.spectra[0].blocks, 3);
});

test('live XY spectra keep one job in flight and skip superseded input windows', async t => {
    const env = bootArrayApplication(); t.after(() => env.app.dispose());
    const svg = env.document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    const frames = framesWith(Array.from({ length: 32 }, (_, i) => [i, -i]), 64);
    const jobs = [];
    const pool = { runTask(task) { return new Promise(resolve => jobs.push({ task, resolve })); } };
    const view = new AnalysisPlot(svg, 'xy', frames, { viewMode: 'coherence' }, 32, () => ({ rate: 800 }), pool);
    t.after(() => view.dispose());
    view.renderNow();
    assert.equal(jobs.length, 1);
    assert.equal(jobs[0].task.segments[0].x.length, 32, 'single-source data uses the received samples directly');
    assert.match(svg.textContent, /正在计算/);
    frames.append([32, -32]); view.renderNow();
    frames.append([33, -33]); view.renderNow();
    assert.equal(jobs.length, 1);
    const result = value => ({ blocks: 3, phase: new Float64Array(9), coherence: new Float64Array(9).fill(value) });
    jobs[0].resolve(result(.25));
    await new Promise(setImmediate);
    view.renderNow();
    assert.equal(jobs.length, 2);
    assert.equal(jobs[1].task.segments[0].x.at(-1), 33);
    assert.equal(view.spectra[0].values[1], .25);
    assert.equal(view.spectra[0].recovered, 0);
    view.setSettings({ viewMode: 'phase' });
    jobs[1].resolve(result(.5));
    await new Promise(setImmediate);
    assert.equal(view.spectra.length, 0, 'a stale result cannot overwrite a new mode');
    assert.match(view.exportSvg(), / rad<\/text>/);
    assert.ok(view.spectra[0].blocks >= 2);
});
function points(frames, pair, start = 0, end = frames.length, bounds = { first: -Infinity, last: Infinity }) {
    const out = []; readPairs(frames, pair, start, end, bounds, (...row) => out.push(row)); return out;
}
function framesWith(rows, capacity = rows.length) {
    const frames = new FrameBuffer(rows[0].length, capacity);
    rows.forEach((row, i) => frames.append(row, new Uint8Array(0), '', i, i));
    return frames;
}
test('fixed histogram keeps configured order, resolves nearest ties and includes misses in the percentage denominator', () => {
    const frames = framesWith([[2], [4], [1], [1], [NaN], [Infinity]]);
    const hist = histogram({ values: [4, 1] });
    hist.update(frames, 0, 6, {});
    assert.deepEqual([...hist.counts], [1, 2]);
    assert.deepEqual([hist.matched, hist.missed, hist.invalid, hist.percent(1)], [3, 1, 2, 50]);
    const nearest = histogramBins(AnalysisSettings.normalize('histogram', { values: [8, 2, -6], match: 'nearest' }));
    assert.deepEqual([-100, -2, 5, 8, 100].map(n => nearest.classify(n)), [2, 2, 1, 0, 0]);
    const higher = histogramBins(AnalysisSettings.normalize('histogram', { values: [8, 2, -6], match: 'nearest', tieBreak: 'higher' }));
    assert.deepEqual([-100, -2, 4, 5, 8, 100].map(n => higher.classify(n)), [2, 1, 1, 0, 0, 0]);
});
test('interval equality has one owner including outer bounds, underflow/overflow and infinite endpoints', () => {
    for (const mode of ['edges', 'equal']) for (const closure of ['leftClosed', 'rightClosed']) {
        const options = { mode, closure, min: 0, max: 2, count: 2, edges: [0, 1, 2] };
        const bins = histogram({ ...options, underflow: true, overflow: true }).bins;
        const left = closure === 'leftClosed';
        assert.deepEqual([-1, 0, .5, 1, 1.5, 2, 4].map(n => bins.classify(n)), left ? [0, 1, 1, 2, 2, 3, 3] : [0, 0, 1, 1, 2, 2, 3]);
        assert.deepEqual([0, 1, 2, 3].map(i => bins.label(i)), left
            ? ['(−∞, 0)', '[0, 1)', '[1, 2)', '[2, +∞)'] : ['(−∞, 0]', '(0, 1]', '(1, 2]', '(2, +∞)']);
        const limited = histogram(options).bins;
        assert.deepEqual([0, 1, 2].map(n => limited.classify(n)), left ? [0, 1, -1] : [-1, 0, 1]);
        const open = histogram({ mode: 'edges', closure, edges: ['-Infinity', 0, 'Infinity'] }).bins;
        assert.equal(open.length, 2); assert.equal(open.classify(0), left ? 1 : 0);
    }
});
test('histogram rounds display labels without altering bin classification or percent calculations', t => {
    const env = bootArrayApplication(); t.after(() => env.app.dispose());
    const svg = env.document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    const frames = framesWith([[50.5], [55.5], [149.5]]);
    const settings = { mode: 'equal', min: 0, max: 150, count: 150, yRange: 'fixed', scale: 'percent' };
    const view = new AnalysisPlot(svg, 'histogram', frames, settings, 32);
    t.after(() => view.dispose());
    view.renderNow();
    assert.equal(view.histogram.bins.label(50), '[50, 51)');
    assert.equal(view.histogram.bins.classify(51), 51, 'the integer boundary belongs to the next left-closed bin');
    const move = (bin, y) => svg.dispatchEvent({ type: 'pointermove', clientX: view.px(bin + .5), clientY: view.py(y) });
    move(50, 25);
    assert.ok(view.overlay.textContent.includes('[50, 51)'));
    const counts = view.histogram.counts, percentage = view.histogram.percent(50);
    view.setSettings({ ...settings, ySignificantDigits: 2 });
    view.renderNow();
    assert.equal(view.histogram.counts, counts);
    assert.equal(view.histogram.percent(50), percentage);
    assert.ok(view.overlay.textContent.includes('33%'));
    view.setSettings({ ...settings, xPrecisionMode: 'decimal', xDecimalPlaces: 2, xNumberNotation: 'plain',
        yPrecisionMode: 'decimal', yDecimalPlaces: 1, yNumberNotation: 'scientific' });
    view.renderNow();
    assert.equal(view.histogram.counts, counts);
    assert.ok(view.overlay.textContent.includes('[50.00, 51.00)'));
    assert.ok(view.overlay.textContent.includes('3.3e+1%'));
    assert.doesNotMatch(view.exportSvg(), /51\.0000000/);
    const rounded = histogramBins(AnalysisSettings.normalize('histogram', { mode: 'edges', edges: [50, 51.00000000000001] }));
    assert.equal(rounded.label(0), '[50, 51)');
    const close = histogramBins(AnalysisSettings.normalize('histogram', { mode: 'edges', edges: [1, 1.00000001, 1.00000002] }));
    assert.equal(close.label(0), '[1, 1.00000001)');
    const configured = histogramBins(AnalysisSettings.normalize('histogram', { values: [12.3456], xSignificantDigits: 3 }));
    assert.equal(configured.label(0), '12.3');
    assert.equal(configured.classify(12.3456), 0);
    assert.equal(configured.classify(12.3), -1);
});

test('histogram manual Y initializes legacy ranges and restores edited bounds after a zoom reset', t => {
    const env = bootArrayApplication(); t.after(() => env.app.dispose());
    const svg = env.document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    const frames = framesWith([[0], [1], [1]]);
    const view = new AnalysisPlot(svg, 'histogram', frames, { yRange: 'fixed' }, 1000);
    t.after(() => view.dispose());
    view.setPaused(true); view.renderNow();
    assert.deepEqual(view.range.slice(2), [0, 1000]);
    view.applyZoom([.2, 1.6, 12, 18]); view.renderNow();
    assert.deepEqual(view.range, [.2, 1.6, 12, 18]);
    view.resetZoom();
    view.setSettings({ yRange: 'fixed' }, 5000); view.renderNow();
    assert.deepEqual(view.range.slice(2), [0, 5000]);
    view.setSettings({ yRange: 'fixed', scale: 'percent' }); view.renderNow();
    assert.deepEqual(view.range.slice(2), [0, 100]);
    view.setSettings({ yRange: 'manual', scale: 'percent', yPercentMin: 10, yPercentMax: 80 }); view.renderNow();
    assert.deepEqual(view.range.slice(2), [10, 80]);
    view.applyZoom([.2, 1.6, 25, 50]); view.renderNow();
    assert.deepEqual(view.range, [.2, 1.6, 25, 50]);
    svg.dispatchEvent({ type: 'contextmenu', clientX: 100, clientY: 100 }); view.renderNow();
    assert.deepEqual(view.range, [0, 2, 10, 80]);
    view.setSettings({ yRange: 'manual', yCountMin: 1, yCountMax: 7 }, 100); view.renderNow();
    assert.deepEqual(view.range.slice(2), [1, 7]);
    view.setSettings({ yRange: 'manual', yCountMin: 1, yCountMax: 7 }, 200); view.renderNow();
    assert.deepEqual(view.range.slice(2), [1, 7]);
    view.setSettings({ yRange: 'auto', scale: 'count' }); view.renderNow();
    assert.ok(view.range[3] >= 2 && view.range[3] < 3);
});
test('histogram draws right-side Y and shares independent X and Y wheel zoom', t => {
    const env = bootArrayApplication(); t.after(() => env.app.dispose());
    const svg = env.document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    const frames = framesWith([[0], [0], [0], [4], [5], [9]]);
    const settings = { mode: 'equal', min: 0, max: 10, count: 10, yRange: 'fixed', scale: 'percent' };
    const view = new AnalysisPlot(svg, 'histogram', frames, settings, 32);
    t.after(() => view.dispose());
    view.renderNow();
    const fixed = [0, 100];
    const wheel = (clientX, clientY, deltaY = -1) => {
        svg.dispatchEvent({ type: 'wheel', clientX, clientY, deltaY });
        view.renderNow();
    };
    const { left, right, top, height, bottom } = view.area;
    const centerX = (left + right) / 2, centerY = top + height / 2;
    const yTicks = svg.querySelectorAll('text').filter(node => Number(node.getAttribute('x')) > right &&
        node.getAttribute('text-anchor') === 'start');
    assert.ok(yTicks.some(node => node.textContent === '100%'));
    const xTicks = svg.querySelectorAll('text').filter(node => Number(node.getAttribute('y')) > bottom);
    assert.ok(xTicks.length && xTicks.every(node => /^\[/.test(node.textContent)));

    wheel(centerX, centerY);
    assert.deepEqual(view.range, [1, 9, ...fixed]);
    wheel(centerX, bottom + 10);
    assert.deepEqual(view.range.slice(2), fixed);
    const horizontal = view.range.slice(0, 2);
    assert.ok(horizontal[0] > 1 && horizontal[1] < 9);
    wheel(right + 10, centerY);
    assert.deepEqual(view.range.slice(0, 2), horizontal);
    assert.deepEqual(view.range.slice(2), [10, 90]);
    wheel(right + 10, centerY, 1);
    assert.deepEqual(view.range, [...horizontal, ...fixed]);
    for (let i = 0; i < 6; i++) wheel(centerX, centerY, 1);
    assert.deepEqual(view.range, [0, 10, ...fixed]);
    assert.doesNotMatch(view.exportSvg(), /占比 \(%\)| · 分组/);

    view.setSettings({ ...settings, yRange: 'auto', scale: 'count' }); view.renderNow();
    assert.ok(view.range[3] > 3);
    view.applyZoom([4, 6]); view.renderNow();
    assert.ok(view.range[3] > 1 && view.range[3] < 2, 'auto Y only considers visible bars');
    assert.equal(view.histogram.matched, 6, 'the shared zoom does not change the data window');
});

test('sliding counts remove evicted samples and read only newly appended values, including after a ring wrap', () => {
    const frames = framesWith([[1], [2], [1], [NaN], [0]], 5), h = histogram({ values: [0, 1] });
    const get = frames.getValue.bind(frames); let reads = 0;
    frames.getValue = (c, i) => { reads++; return get(c, i); };
    h.update(frames, 1, 5, {});
    assert.equal(reads, 4);
    frames.append([0]); h.update(frames, 1, 5, {});
    assert.equal(reads, 5);
    assert.deepEqual([[...h.counts], h.missed, h.invalid], [[2, 1], 0, 1]);
    h.update(frames, 0, 2, {});
    assert.deepEqual([[...h.counts], h.missed, h.invalid], [[0, 1], 1, 0]);
    frames.clear(); frames.append([1]); h.update(frames, 0, 1, {});
    assert.deepEqual([...h.counts], [0, 1]);
});
function workspace(channelDefinitions = []) {
    const mappings = [0, 1, 2].map((c, i) => ({ sourceId: c === 2 ? 'serial-1' : 'primary',
        channelId: 'raw:' + i, number: i + 1, name: 'CH' + i, color: '#123abc' }));
    return new WorkspaceChannelCapture({ mappings, channelDefinitions, holdMs: 100, methods: { primary: 'linear' } }, 40);
}
function event(time, order, values, extra = {}) {
    return { time, values, origin: { sourceId: 'primary', epoch: 1, order, byteOffset: order, ...extra } };
}
test('same-source XY pairs native packet identities at duplicated timestamps, preserves time order, marks recovered slots and gaps', () => {
    const ws = workspace();
    ws.ingest([event(0, 1, [[0, -1], [1, 0]]), event(0, 2, [[0, -1], [1, 2]]),
        event(1, 3, [[0, 1], [1, 3]]), event(3, 5, [[0, -1], [1, 1]], { missingBefore: 1, period: 1 }),
        event(4, 6, [[0, 0], [1, 0]], { breakBefore: true })]);
    const rows = points(ws.numericSource.frames, { x: 0, y: 1 });
    assert.deepEqual(rows, [[-1, 0, 0, true, false], [-1, 2, 0, false, false], [1, 3, 1, false, false],
        [0, 2, 2, false, true], [-1, 1, 3, false, false], [0, 0, 4, true, false]]);
    const nativeHist = histogram({ values: [-1, 0, 1] });
    nativeHist.update(ws.numericSource.frames, 0, 5, { first: 0, last: 4 });
    assert.deepEqual([...nativeHist.counts], [3, 1, 1]);
});
test('cross-source XY and separate protocol messages share grid time, and raw histograms skip held grid copies', () => {
    const ws = workspace();
    ws.ingest([event(0, 1, [[0, 1]]), event(1, 2, [[2, 4]], { sourceId: 'serial-1' }), event(3, 3, [[0, 5]])]);
    const frames = ws.numericSource.frames; frames.sampleMethods[0] = 'hold';
    const cross = points(frames, { x: 0, y: 2 }, 0, frames.length, { first: 0, last: 3 });
    assert.deepEqual(cross.map(p => p.slice(0, 3)), [[1, 4, 1], [1, 4, 2], [5, 4, 3]]);
    assert.ok(cross.every(p => p[4]), 'at least one held coordinate on each grid tick');
    ws.ingest([event(4, 4, [[0, 6]]), event(4, 5, [[2, 7]], { sourceId: 'serial-1' })]);
    assert.equal(points(frames, { x: 0, y: 2 }, 4, 5, { first: 4, last: 4 })[0][4], false);
    const sync = new SynchronizedFrames(2, 30);
    sync.channelPacketGroups = ['one', 'two'];
    sync.ingest(0, [[0, 5]], { order: 1 });
    sync.ingest(2, [[1, 7]], { order: 2 });
    sync.ingest(5, [[0, 8]], { order: 3 });
    const result = points(sync, { x: 0, y: 1 }, 0, 6, { first: 0, last: 5 });
    assert.deepEqual(result.map(p => p.slice(0, 3)), [[5, 7, 2], [5, 7, 3], [5, 7, 4], [8, 7, 5]]);
    const h = histogram({ values: [5, 8] }); h.update(sync, 0, 6, { first: 0, last: 5 });
    assert.deepEqual([...h.counts], [1, 1]);
});
test('native histogram uses packet identity across array eviction and identical timestamps', () => {
    const ws = workspace(), frames = ws.numericSource.frames, h = histogram({ values: [0, 1] });
    const samples = Array.from({ length: 8 }, (_, i) => event(Math.floor(i / 2), i, [[0, i % 2]]));
    ws.ingest(samples);
    h.update(frames, 0, frames.length, { first: 1, last: 3 });
    assert.deepEqual([...h.counts], [3, 3]);
    frames.events.get(0).splice(0, 3);
    ws.ingest([event(4, 8, [[0, 1]])]);
    h.update(frames, 1, frames.length, { first: 2, last: 4 });
    assert.deepEqual([...h.counts], [2, 3]);
});
test('live bounds exclude lagging synchronized grid values and retain native observations until formulas catch up', () => {
    const ws = workspace([{ number: 4, type: 'formula', expression: 'CH1*2' }]);
    const frames = ws.numericSource.frames;
    ws.ingest([event(0, 1, [[0, 1], [1, 1]]), event(0, 2, [[2, 5]], { sourceId: 'serial-1' }),
        event(10, 3, [[0, 3], [1, 3]])], true, 3);
    const bounds = frames.liveTimeBounds(2);
    assert.deepEqual(bounds, { first: 9, last: 10 });
    assert.equal(frames.timestampAt(frames.length - 1), 3);
    assert.equal(points(frames, { x: 0, y: 2 }, 2, 4, bounds).length, 0);
    assert.equal(points(frames, { x: 0, y: 1 }, 2, 4, bounds).length, 1);
    const grid = histogram({ channel: 3, values: [2, 6], match: 'nearest' });
    grid.update(frames, 2, 4, bounds); assert.equal(grid.matched, 0);
    ws.ingest([], true, 10);
    grid.update(frames, 9, 11, frames.liveTimeBounds(2)); assert.equal(grid.matched, 2);
    grid.update(frames, 2, 4, { first: 2, last: 3 }); assert.equal(grid.matched, 2);
});
test('XY simplification preserves both-axis excursions, ordering and disconnections through invalid values', () => {
    const rows = Array.from({ length: 1000 }, (_, i) => [i % 2, 0]);
    rows[215] = [-45, 0]; rows[216] = [32, 0]; rows[651] = [1, NaN]; rows[654] = [1, 99];
    const frames = framesWith(rows);
    const { points: trace } = trajectory(frames, { x: 0, y: 1 }, 0, 1000, {}, 120);
    assert.ok(trace.length < 140); assert.equal(Math.max(...trace.map(p => p.y)), 99);
    assert.equal(Math.min(...trace.map(p => p.x)), -45); assert.equal(Math.max(...trace.map(p => p.x)), 32);
    assert.ok(trace.every((p, i) => !i || p.seq > trace[i - 1].seq));
    assert.equal(trace[0].segment + 1, trace.at(-1).segment);
    assert.deepEqual(equalRanges([-1, 1, -1, 1], 200, 100), [-2, 2, -1, 1]);
});
test('dense overlapping XY orbits keep their original contour without introducing chords', () => {
    const circle = Array.from({ length: 8 }, (_, i) => [Math.cos(i * Math.PI / 4), Math.sin(i * Math.PI / 4)]);
    const frames = framesWith(Array.from({ length: 5000 }, (_, i) => circle[i % 8]));
    const trace = trajectory(frames, { x: 0, y: 1 }, 0, 5000, {}, 150).points;
    assert.ok(trace.length < 30);
    for (let i = 1; i < trace.length; i++) if (!trace[i].move) {
        const a = trace[i - 1], b = trace[i];
        assert.ok(Math.hypot((a.x + b.x) / 2, (a.y + b.y) / 2) > .91);
    }
});
test('XY trajectory keeps unit aspect and fixed Y when zooming X in the plot or its tick band', t => {
    const env = bootArrayApplication(); t.after(() => env.app.dispose());
    const svg = env.document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    const view = new AnalysisPlot(svg, 'xy', framesWith([[0, 1], [1, 2], [2, 2]]),
        { xAuto: false, xMin: -5, xMax: 5, yAuto: false, yMin: 0, yMax: 4 }, 3);
    t.after(() => view.dispose());
    view.renderNow();
    const wheel = (clientX, clientY, deltaY = -1) => {
        svg.dispatchEvent({ type: 'wheel', clientX, clientY, deltaY });
        view.renderNow();
    };
    wheel(view.area.left + view.area.width / 2, view.area.top + view.area.height / 2);
    assert.deepEqual(view.range, [-4, 4, 0, 4]);
    wheel(view.area.left + view.area.width / 2, view.area.bottom + 8);
    assert.deepEqual(view.range, [-3.2, 3.2, 0, 4]);
    wheel(view.area.right + 10, view.area.top + view.area.height / 2);
    assert.deepEqual(view.range.slice(0, 2), [-3.2, 3.2]);
    assert.ok(view.range[2] > 0 && view.range[3] < 4);
    const expected = (view.range[1] - view.range[0]) / (view.range[3] - view.range[2]);
    assert.ok(Math.abs(view.area.width / view.area.height - expected) < 1e-9);
    wheel(view.area.right + 10, view.area.top + view.area.height / 2, 1);
    assert.deepEqual(view.range, [-3.2, 3.2, 0, 4]);
});

test('interactive SVG retains XY zoom, inspects a paused history window and clears stale ranges and counts', () => {
    const env = bootArrayApplication(), svg = env.document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    const frames = framesWith([[0, 1], [1, 2], [3, 2], [4, 3]]);
    const view = new AnalysisPlot(svg, 'xy', frames, { traceMode: 'both' }, 2);
    view.renderNow();
    assert.equal(view.currentFrameIndex(), 3); assert.equal(view.hitPoints.length, 2);
    const initial = [...view.range], dispatch = (type, x, y, props = {}) => svg.dispatchEvent({
        type, clientX: x, clientY: y, pointerId: 1, button: 0, ...props });
    dispatch('wheel', 400, 300, { deltaY: -1 }); view.renderNow();
    assert.ok(view.range[1] - view.range[0] < initial[1] - initial[0]);
    dispatch('pointerdown', 200, 100); dispatch('pointermove', 500, 400); dispatch('pointerup', 500, 400); view.renderNow();
    assert.ok(view.range[1] - view.range[0] < (initial[1] - initial[0]) * .6);
    dispatch('contextmenu', 200, 200); view.renderNow(); assert.deepEqual(view.range, initial);
    dispatch('pointermove', 400, 200); assert.match(view.overlay.textContent, /X .*Y .*ms/);
    frames.append([3, 2]); view.renderNow(); assert.match(view.overlay.textContent, /X .*Y .*ms/);
    dispatch('pointerleave', 801, 601); frames.append([6, 5]); view.renderNow(); assert.equal(view.overlay.textContent, '');
    dispatch('pointerdown', 120, 120, { ctrlKey: true }); assert.ok(!view.drag);
    dispatch('pointerdown', 200, 110); dispatch('pointermove', 300, 150);
    frames.append([4, 3]); view.renderNow(); assert.equal(view.overlay.firstElementChild.getAttribute('width'), '100');
    dispatch('pointerup', 300, 150); dispatch('contextmenu', 200, 200);
    view.setSettings({ xAuto: false, xMin: -7, xMax: 7, yAuto: false, yMin: -2, yMax: 2, equalAspect: true });
    view.renderNow(); assert.deepEqual(view.range, [-7, 7, -2, 2]);
    assert.ok(Math.abs(view.area.width / view.area.height - 14 / 4) < 1e-8);
    view.setPaused(true); view.jumpToFrame(1); view.renderNow();
    assert.equal(view.getVisibleFrameIndex(), 1); assert.deepEqual(view.hitPoints.map(hit => hit.p.x), [3]);
    view.setVisible(false); view.invalidateData(); assert.equal(view.pending, null);
    view.clear(); view.setVisible(true); view.renderNow(); assert.equal(view.currentFrameIndex(), 3);
    view.dispose();
    const histogramView = new AnalysisPlot(svg, 'histogram', frames, { values: [0, 1, 3, 4] }, 3);
    histogramView.renderNow(); assert.deepEqual([...histogramView.histogram.counts], [0, 0, 1, 1]);
    histogramView.clear(); frames.clear(); histogramView.renderNow();
    assert.deepEqual([...histogramView.histogram.counts], [0, 0, 0, 0]);
    const protocol = new SynchronizedFrames(1, 30);
    protocol.ingest(0, [[0, 1]], { order: 1 });
    histogramView.setFrames(protocol); histogramView.renderNow();
    protocol.ingest(.25, [[0, 3]], { order: 2 });
    histogramView.renderNow();
    assert.equal(protocol.timestampAt(protocol.length - 1), 0);
    assert.deepEqual([...histogramView.histogram.counts], [0, 1, 1, 0]);
    histogramView.dispose();
});
