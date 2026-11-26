const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { ChannelOperations } = require('../channelOperations');
const { SystemResponseFrames } = require('../systemResponseFrames');

function createPlotter(responseFrames = null, options = {}) {
    const labels = [];
    const canvasOps = [];
    const markers = [], dots = [];
    const canvasEvents = new Map();
    const ctx = new Proxy({}, { get: (target, key) => key === 'measureText'
        ? text => ({ width: String(text).length * 6 })
        : key === 'fillText' ? text => { labels.push(String(text)); }
            : key === 'clearRect' || key === 'fillRect' ? (...args) => {
                canvasOps.push(key);
                if (key === 'fillRect' && args[2] === 3 && args[3] === 3) dots.push(args);
                assert.ok(args.every(Number.isFinite));
            }
            : key === 'stroke' ? () => { canvasOps.push('stroke:' + target.strokeStyle); }
            : key === 'arc' ? (x, y) => { markers.push({ x, y }); }
            : key === 'moveTo' || key === 'lineTo' ? (x, y) => {
                assert.ok(Number.isFinite(x) && Number.isFinite(y));
            }
            : () => {},
        set(target, key, value) {
            if (key === 'strokeStyle') canvasOps.push(`strokeStyle:${value}`);
            target[key] = value;
            return true;
        } });
    const element = () => ({ style: {}, offsetHeight: 0, clientWidth: 800,
        addEventListener() {}, getBoundingClientRect: () =>
            ({ width: 800, height: 400, left: 0, top: 0 }) });
    const nodes = new Map();
    const canvas = { ...element(), parentElement: element(), getContext: () => ctx,
        addEventListener(name, callback) { canvasEvents.set(name, callback); } };
    nodes.set('waveform-canvas', canvas);
    const document = { getElementById(id) {
        if (!nodes.has(id)) nodes.set(id, element());
        return nodes.get(id);
    }, addEventListener() {} };
    const context = vm.createContext({ document, window: { addEventListener() {} },
        performance, requestAnimationFrame() {}, console });
    for (const file of ['projectLimits.js', 'frameBuffer.js', 'plotMath.js',
        'channelTransform.js', 'spectrum.js', 'systemResponse.js', 'waveSvg.js', 'plotter.js']) {
        vm.runInContext(fs.readFileSync(require.resolve(`../${file}`), 'utf8'), context, { filename: file });
    }
    const { FrameBuffer, Plotter } = context.SerialPlotter;
    const plotter = new Plotter('waveform-canvas', responseFrames ?? new FrameBuffer(1, 1024),
        { viewOnly: !!responseFrames, ...options });
    plotter.setChannelCount(responseFrames?.channelCount ?? 1);
    plotter.setChannelVisible(0, true);
    if (!responseFrames) for (let i = 0; i < 1024; i++)
        plotter.addFrame([Math.sin(2 * Math.PI * 100 * i / 1024)]);
    plotter.setDisplayOptions({ displayMode: 'frequency' });
    return { plotter, labels, canvasEvents, canvasOps, context, markers, dots };
}

test('axis number formats support fixed decimal places and explicit scientific or plain decimal notation', () => {
    const { formatAxisValue, readAxisNumberFormat } = require('../plotMath');
    const format = (value, settings) => formatAxisValue(value, readAxisNumberFormat(settings, 'x'));
    assert.equal(format(51.00000000000001, { xPrecisionMode: 'decimal', xDecimalPlaces: 2, xNumberNotation: 'plain' }), '51.00');
    assert.equal(format(99.6, { xPrecisionMode: 'decimal', xDecimalPlaces: 0 }), '100');
    assert.equal(format(.0012345, { xPrecisionMode: 'decimal', xDecimalPlaces: 2, xNumberNotation: 'scientific' }), '1.23e-3');
    assert.equal(format(2500, { xSignificantDigits: 4, xNumberNotation: 'scientific' }), '2.5e+3');
    assert.equal(format(1.2345e-8, { xSignificantDigits: 3, xNumberNotation: 'plain' }), '0.0000000123');
    assert.equal(format(Number.MAX_VALUE, { xSignificantDigits: 2, xNumberNotation: 'scientific' }), '1.8e+308');
});

test('wave axis precision applies independently to ticks, hover and SVG', () => {
    const { plotter, canvasEvents, labels } = createPlotter();
    plotter.setDisplayOptions({ displayMode: 'time', yScaleModeTime: 'manual',
        yMinTime: 1.23456, yMaxTime: 2.34567, xSignificantDigits: 5, ySignificantDigits: 3 });
    assert.equal(plotter._formatAxisNumber(1.2345678), '1.2346');
    labels.length = 0; plotter.draw();
    assert.equal(labels[0], '1.23');
    assert.match(plotter.exportSvg(), />2\.35</);
    canvasEvents.get('pointermove')({ clientX: 200, clientY: 100 });
    labels.length = 0; plotter.draw();
    assert.ok(labels.some(text => /^Value: \d\.\d{2}$/.test(text)));
    plotter.setDisplayOptions({ xPrecisionMode: 'decimal', xDecimalPlaces: 2, xNumberNotation: 'scientific',
        yPrecisionMode: 'decimal', yDecimalPlaces: 4, yNumberNotation: 'plain' });
    assert.equal(plotter._formatAxisNumber(.0012345678), '1.23e-3');
    labels.length = 0; plotter.draw();
    assert.equal(labels[0], '1.2346');
    assert.match(plotter.exportSvg(), />2\.3457</);
});

test('dB conversion only processes frequency bins inside the visible viewport', () => {
    const { plotter, context } = createPlotter();
    plotter.setDisplayOptions({ magnitudeUnit: 'db' });
    plotter.vp.frequency.scrollOffset = 100;
    plotter.vp.frequency.displayCount = 20;
    let conversions = 0;
    const original = context.SerialPlotter.decibelMagnitude;
    context.SerialPlotter.decibelMagnitude = (...args) => {
        conversions++;
        return original(...args);
    };
    try { plotter.draw(); } finally { context.SerialPlotter.decibelMagnitude = original; }
    assert.equal(conversions, 20);
    context.SerialPlotter.decibelMagnitude = () => { throw new Error('unchanged hover redraws must reuse the converted bins'); };
    try { plotter.draw(); } finally { context.SerialPlotter.decibelMagnitude = original; }
});

test('frequency views reuse worker-prepared dB and unwrapped phase without repeating heavy transforms', () => {
    const { plotter, context } = createPlotter();
    const spectrum = { mags: Float64Array.of(0, 1, 2), logMags: Float64Array.of(NaN, 0, Math.log10(2)),
        phases: Float64Array.of(NaN, 170, -170), unwrappedPhases: Float64Array.of(NaN, 170, 190), fftSize: 4 };
    const spectra = new Map([[0, spectrum]]);
    context.SerialPlotter.decibelMagnitude = context.SerialPlotter.unwrapPhaseDegrees = () => {
        throw new Error('logarithms and phase unwrapping have already been computed off the UI thread');
    };
    plotter.setDisplayOptions({ displayMode: 'frequency', magnitudeUnit: 'db', dbFactor: 10 });
    const first = plotter._collectWindowSeries(0, 3, spectra)[0].mags;
    assert.deepEqual([...first], [NaN, 0, 10 * Math.log10(2)]);
    assert.equal(plotter._collectWindowSeries(0, 3, spectra)[0].mags, first);
    plotter.setDisplayOptions({ dbFactor: 20 });
    assert.deepEqual([...plotter._collectWindowSeries(1, 3, spectra)[0].mags], [0, 20 * Math.log10(2)]);
    plotter.setDisplayOptions({ displayMode: 'phase', phaseUnwrap: true, phaseUnit: 'radians' });
    assert.deepEqual([...plotter._collectWindowSeries(1, 3, spectra)[0].mags], [170 * Math.PI / 180, 190 * Math.PI / 180]);
    plotter.setDisplayOptions({ phaseUnwrap: false, phaseUnit: 'degrees' });
    assert.deepEqual([...plotter._collectWindowSeries(1, 3, spectra)[0].mags], [170, -170]);
});

test('time cursor redraws reuse the sample snapshot and refresh it after new data or channel edits', () => {
    const { plotter } = createPlotter();
    plotter.setChannelCount(2); plotter.setAllChannelsVisible(true);
    plotter.setDisplayOptions({ displayMode: 'time' });
    for (let i = 0; i < 64; i++) plotter.addFrame([i, -i]);
    let reads = 0;
    const copy = plotter.frames.copyChannel.bind(plotter.frames);
    plotter.frames.copyChannel = (...args) => { reads++; return copy(...args); };
    plotter.draw();
    assert.equal(reads, 2);
    plotter.mousePos = { x: 100, y: 100 };
    plotter.draw();
    assert.equal(reads, 2, 'cursor motion must not copy the unchanged time window again');
    plotter.addFrame([1000, -1000]); plotter.draw();
    assert.equal(reads, 4);
    assert.ok(plotter._drawState.max > 1000 && plotter._drawState.min < -1000);
    plotter.setChannelTransform(0, { gainEnabled: true, gain: -2, offsetEnabled: false, offset: 0 }); plotter.draw();
    assert.equal(reads, 6);
    assert.ok(plotter._drawState.min < -2000);
});

test('GPU waveform draws traces below transparent axes and falls back to Canvas 2D when lost', () => {
    const calls = [];
    const gpu = { available: true, resize(...args) { calls.push(['resize', ...args]); },
        render(traces) { calls.push(['render', traces]); return this.available; }, dispose() {} };
    const { plotter, canvasOps } = createPlotter(null, { gpuRenderer: gpu });
    plotter.setDisplayOptions({ displayMode: 'time' });
    plotter.clear();
    for (let i = 0; i < 64; i++) plotter.addFrame([Math.sin(i)]);
    plotter.vp.time.displayCount = 64;
    calls.length = 0; canvasOps.length = 0;
    plotter.draw();
    const trace = calls.find(call => call[0] === 'render')?.[1]?.[0];
    assert.ok(trace?.points.length > 0);
    assert.equal(trace.dots, true);
    assert.ok(canvasOps.includes('clearRect'));
    assert.equal(canvasOps.includes('fillRect'), false);
    assert.equal(canvasOps.includes('strokeStyle:#1e1e1e'), false,
        'the upper 2D overlay must not paint the minor grid over GPU traces');
    assert.equal(canvasOps.includes('strokeStyle:#2e2e2e'), false,
        'the upper 2D overlay must not paint the major grid over GPU traces');
    calls.length = 0;
    plotter.clear();
    assert.equal(calls.find(call => call[0] === 'render')?.[1]?.length, 0,
        'clearing samples must remove the previous GPU trace');
    for (let i = 0; i < 64; i++) plotter.addFrame([Math.sin(i)]);
    gpu.available = false;
    calls.length = 0; canvasOps.length = 0;
    plotter.draw();
    assert.equal(calls.some(call => call[0] === 'render'), false);
    assert.ok(canvasOps.includes('fillRect'), 'fallback retains individual time-domain points');
    assert.ok(canvasOps.indexOf('strokeStyle:#1e1e1e') >= 0 &&
        canvasOps.indexOf('strokeStyle:#2e2e2e') < canvasOps.indexOf('strokeStyle:#ff0000'),
        'the Canvas 2D fallback still paints its grid before the waveform');
    gpu.available = true;
    gpu.render = () => false;
    canvasOps.length = 0;
    plotter.draw();
    assert.ok(canvasOps.indexOf('strokeStyle:#1e1e1e') >= 0 &&
        canvasOps.indexOf('strokeStyle:#2e2e2e') < canvasOps.indexOf('strokeStyle:#ff0000'),
        'losing the GPU during a frame also restores the grid below the fallback waveform');
    plotter.dispose();
});

test('worker FFT presents only completed spectra and ignores obsolete settings results', async () => {
    const pending = [];
    const pool = { available: true, runTask(task) {
        return new Promise(resolve => pending.push({ task, resolve }));
    } };
    const { plotter } = createPlotter(null, { fftWorkerPool: pool });
    plotter.draw();
    assert.equal(pending.length, 1);
    assert.equal(plotter.completedSpectrumDraws, 0);
    plotter.setDisplayOptions({ fftWindow: 'blackman' });
    pending[0].resolve({ mags: [0, 1], phases: [0, 0], dominantBin: 1, fftSize: 2 });
    await new Promise(resolve => setImmediate(resolve));
    plotter.draw();
    assert.equal(pending.length, 2);
    assert.equal(pending[1].task.windowType, 'blackman');
    assert.equal(plotter.completedSpectrumDraws, 0, 'obsolete spectra never count as presented');
    pending[1].resolve({ mags: [0, 2], phases: [0, 0], dominantBin: 1, fftSize: 2 });
    await new Promise(resolve => setImmediate(resolve));
    plotter.draw();
    assert.equal(plotter.completedSpectrumDraws, 1);
    assert.equal(plotter._frequencyForChannel(0).mags[1], 2);
    plotter.draw();
    assert.equal(plotter.completedSpectrumDraws, 1, 'repainting a cached spectrum is not a new result');
    plotter.dispose();
});

test('time plots update dominant frequency at a separate cadence while waveform updates continue', () => {
    const { plotter, context } = createPlotter();
    let now = 0, transforms = 0;
    context.performance = { now: () => now };
    const fft = context.SerialPlotter.prepareFrequencySeries;
    context.SerialPlotter.prepareFrequencySeries = (...args) => { transforms++; return fft(...args); };
    plotter.setDisplayOptions({ displayMode: 'time' });
    const initial = plotter.completedDraws;
    plotter.draw();
    for (now = 10; now <= 90; now += 10) {
        plotter.addFrame([now]);
        plotter.draw();
    }
    assert.equal(transforms, 1);
    assert.equal(plotter.completedDraws - initial, 10);
    assert.ok(plotter._drawState.max >= 90);
    plotter.addFrame([100]); plotter.draw();
    assert.equal(transforms, 2);
    plotter.setDisplayOptions({ displayMode: 'frequency' });
    plotter.addFrame([101]); plotter.draw();
    assert.equal(transforms, 3);
    plotter.dispose();
});

test('Canvas worker FFT starts the latest snapshot without a cooldown or stacked jobs', async () => {
    const pending = [];
    const pool = { runTask(task) { return new Promise(resolve => pending.push({ task, resolve })); } };
    const { plotter } = createPlotter(null, { fftWorkerPool: pool });
    plotter.draw();
    plotter.addFrame([1]);
    plotter.draw();
    assert.equal(pending.length, 1, 'new data must not queue a second FFT while the first runs');
    pending[0].resolve({ mags: [0, 1], phases: [0, 0], dominantBin: 1, fftSize: 2 });
    await new Promise(resolve => setImmediate(resolve));
    plotter.draw();
    assert.equal(pending.length, 2, 'idle workers start the latest snapshot immediately after completion');
    plotter.addFrame([2]);
    plotter.draw();
    assert.equal(pending.length, 2, 'new samples cannot stack a third job behind the pending FFT');
    plotter.dispose();
});

test('GPU spectra start the latest FFT as soon as the previous result is presented without a fixed cooldown', async () => {
    const pending = [];
    const pool = { runTask(task) { return new Promise(resolve => pending.push({ task, resolve })); } };
    const gpuRenderer = { available: true, render: () => true, resize() {}, dispose() {} };
    const { plotter } = createPlotter(null, { fftWorkerPool: pool, gpuRenderer });
    plotter.draw();
    pending[0].resolve({ mags: [0, 1], phases: [0, 0], dominantBin: 1, fftSize: 2 });
    await new Promise(resolve => setImmediate(resolve));
    plotter.addFrame([2]);
    plotter._fftAt = performance.now();
    plotter.draw();
    assert.equal(pending.length, 2, 'GPU presentation must not impose an extra 33 ms rest on idle FFT workers');
    assert.equal(plotter.completedSpectrumDraws, 1);
    plotter.addFrame([3]);
    plotter.draw();
    assert.equal(pending.length, 2, 'fast input still cannot stack work ahead of the pending FFT');
    plotter.dispose();
});

function createResponsePlotter(expression) {
    const frames = new SystemResponseFrames();
    frames.configure({ channelCount: 2, engine: new ChannelOperations(1, [
        { number: 2, type: 'constant', expression }
    ]) }, 64);
    const result = createPlotter(frames);
    result.plotter.setChannelVisible(0, false);
    result.plotter.setChannelVisible(1, true);
    result.plotter.vp.frequency.displayCount = frames.frequencyForChannel(1).mags.length;
    result.plotter.setDisplayOptions({ displayMode: 'frequency', magnitudeUnit: 'amplitude',
        freqXUnit: 'hz', freqXScale: 'log', freqYScale: 'linear' });
    return result;
}

test('wave SVG preserves log coordinates, gaps, sample markers and axis ticks on Canvas and WebGL', () => {
    for (const gpuRenderer of [null, { available: true, resize() {}, render: () => true }]) {
        const { plotter, labels } = createPlotter(null, { gpuRenderer });
        plotter._computeFftForVisibleChannels = () => new Map([[0, {
            mags: [0, 1, 10, NaN, 100], phases: [0, 1, 2, 3, 4], fftSize: 8
        }]]);
        plotter.setSampleRateHz(8);
        plotter.setDisplayOptions({ freqXScale: 'log', freqYScale: 'log',
            yScaleModeFreq: 'manual', yMinFreq: 1, yMaxFreq: 100 });
        plotter.draw();
        const svg = plotter.exportSvg('FFT <A&B>');
        assert.match(svg, /FFT &lt;A&amp;B&gt;/);
        assert.match(svg, /M0 378 L355 189 M710 0/);
        assert.match(svg, /clip-path="url\(#.+?\)"/);
        assert.match(svg, /stroke="#ff0000"/);
        assert.equal((svg.match(/width="3" height="3"/g) ?? []).length, 3);
        for (const label of labels) assert.ok(svg.includes('>' + label + '<'), label);
        assert.doesNotMatch(svg, /<image|data:image|NaN|Infinity/);
    }
});

test('time SVG uses the selected window and explicit y bounds with hidden channels excluded', () => {
    const { plotter } = createPlotter();
    plotter.clear(); plotter.setChannelCount(2); plotter.setChannelVisible(1, false);
    for (const value of [99, 5, NaN, 15, 99]) plotter.addFrame([value, 27]);
    plotter.setDisplayOptions({ displayMode: 'time', yScaleModeTime: 'manual', yMinTime: 0, yMaxTime: 10 });
    Object.assign(plotter.vp.time, { autoFollow: false, scrollOffset: 1, displayCount: 3 });
    const svg = plotter.exportSvg('时域');
    assert.match(svg, /d="M0 189 M710 -189"/);
    assert.match(svg, /10\.000000</);
    assert.equal((svg.match(/width="3" height="3"/g) ?? []).length, 2);
    assert.doesNotMatch(svg, /#00ff00/i);
});

test('wave trace styles select the same geometry on Canvas and SVG across domains', () => {
    const { plotter, canvasOps, dots } = createPlotter();
    plotter.clear();
    for (const value of [0, 1, 0, -1, 0, 1, 0, -1]) plotter.addFrame([value]);
    for (const displayMode of ['time', 'frequency', 'phase']) {
        for (const traceMode of ['line', 'points', 'both']) {
            plotter.setDisplayOptions({ displayMode, traceMode });
            canvasOps.length = dots.length = 0;
            plotter.draw();
            const svg = plotter.exportSvg('轨迹');
            const label = displayMode + '/' + traceMode;
            assert.equal(canvasOps.includes('stroke:#ff0000'), traceMode !== 'points', label);
            assert.equal(dots.length > 0, traceMode !== 'line', label);
            assert.equal(svg.includes('<path fill="none" stroke="#ff0000"'), traceMode !== 'points', label);
            assert.equal(svg.includes('width="3" height="3"'), traceMode !== 'line', label);
        }
    }
});

test('system response SVG uses the same visible ticks as the waveform', () => {
    const { plotter } = createResponsePlotter('[0]=1,[1]=0.001');
    for (const [options, tick] of [
        [{ displayMode: 'time' }, />\[\d+\]<\/text>/],
        [{ displayMode: 'frequency' }, / cycles\/sample<\/text>/],
        [{ responseSampleRate: 512, magnitudeUnit: 'db' }, / Hz<\/text>/],
        [{ displayMode: 'phase', phaseUnit: 'radians', phaseUnwrap: true }, / rad<\/text>/],
        [{ phaseUnit: 'degrees', phaseUnwrap: false }, /°<\/text>/]
    ]) {
        plotter.setDisplayOptions(options);
        const svg = plotter.exportSvg('响应');
        assert.match(svg, tick);
        assert.doesNotMatch(svg, />(?:采样点|数值|频率 \(|幅值 \(|相位 \()/);
        if (options.magnitudeUnit === 'db') assert.ok(Math.abs(plotter._drawState.min) < .1);
    }
});

test('automatic linear magnitude fits the visible system response instead of forcing zero', () => {
    const { plotter } = createResponsePlotter('[0]=1,[1]=0.001');
    plotter.draw();
    const magnitudes = plotter.frames.frequencyForChannel(1).mags.slice(1);
    const low = Math.min(...magnitudes), high = Math.max(...magnitudes);
    assert.ok(plotter._drawState.min > 0.9);
    assert.ok(plotter._drawState.min < low && plotter._drawState.max > high);
    assert.ok(plotter._drawState.max < 1.1);
});

test('automatic logarithmic magnitude also fits a nearly flat response', () => {
    const { plotter, labels } = createResponsePlotter('[0]=1,[1]=0.001');
    plotter.setDisplayOptions({ freqYScale: 'log' });
    labels.length = 0;
    plotter.draw();
    assert.ok(plotter._drawState.min > 0.95);
    assert.ok(plotter._drawState.max < 1.05);
    assert.equal(new Set(labels.slice(0, 9)).size, 9, 'narrow logarithmic ticks remain distinct');
});

test('automatic magnitude ticks keep useful precision after fitting a tiny variation', () => {
    const { plotter, labels } = createResponsePlotter('[0]=1,[1]=0.00000001');
    labels.length = 0;
    plotter.draw();
    assert.ok(plotter._drawState.min > 0.999);
    assert.equal(new Set(labels.slice(0, 9)).size, 9);
});

test('a narrow time-domain auto range also keeps distinct Y tick labels', () => {
    const { plotter, labels } = createPlotter();
    plotter.clear();
    for (let i = 0; i < 64; i++) plotter.addFrame([1 + i * 1e-8]);
    plotter.setDisplayOptions({ displayMode: 'time' });
    labels.length = 0;
    plotter.draw();
    assert.equal(new Set(labels.slice(0, 9)).size, 9);
});

test('automatic linear magnitude fits a positive-only sampled spectrum window', () => {
    const { plotter } = createPlotter();
    plotter.clear();
    for (let i = 0; i < 64; i++) plotter.addFrame([i === 0 ? 1 : 0]);
    plotter.setDisplayOptions({ fftWindow: 'rectangular', freqYScale: 'linear' });
    Object.assign(plotter.vp.frequency, { scrollOffset: 1, displayCount: 30, autoFollow: false });
    plotter.draw();
    assert.ok(plotter._drawState.min > 0);
    assert.ok(plotter._drawState.max > plotter._drawState.min);
});

test('sampled logarithmic spectra keep their numerical-noise floor', () => {
    const { plotter } = createPlotter();
    plotter.setDisplayOptions({ freqYScale: 'log' });
    plotter.draw();
    const peak = Math.max(...plotter._frequencyForChannel(0).mags);
    assert.ok(plotter._drawState.min >= peak / 1e6 / 1.3);
});

test('phase radians convert FFT series after unwrapping and label the axis and hover', () => {
    const { plotter, labels } = createPlotter();
    plotter.setDisplayOptions({ displayMode: 'phase', phaseUnit: 'radians', phaseUnwrap: false });
    const cached = { mags: [1, 1, 1, 1], phases: [90, 170, -170, NaN], fftSize: 8 };
    const results = new Map([[0, cached]]);
    let series = plotter._collectWindowSeries(0, 4, results);
    assert.ok(Math.abs(series[0].mags[0] - Math.PI / 2) < 1e-12);
    assert.ok(Number.isNaN(series[0].mags[3]));
    assert.equal(cached.phases[0], 90, 'cached phases stay in degrees');
    plotter.mousePos = { x: 100, y: 100 };
    plotter.draw();
    assert.equal(plotter._drawState.min, -Math.PI);
    assert.equal(plotter._drawState.max, Math.PI);
    assert.ok(labels.includes('3.141593 rad'));
    assert.ok(labels.some(label => label.startsWith('Phase:') && label.endsWith(' rad')));
    plotter.setDisplayOptions({ phaseUnwrap: true });
    series = plotter._collectWindowSeries(0, 4, results);
    assert.ok(Math.abs(series[0].mags[2] - 190 * Math.PI / 180) < 1e-12);
    plotter.setDisplayOptions({ phaseUnit: 'degrees', phaseUnwrap: false });
    labels.length = 0; plotter.draw();
    assert.equal(plotter._drawState.max, 180);
    assert.ok(labels.includes('180.000000°'));
});

test('frequency axis and cursor show hertz after a measured sample rate is available', () => {
    const { plotter, labels } = createPlotter();
    plotter.setSampleRateHz(1024);
    plotter.draw();
    assert.ok(plotter._drawState.min >= 0, 'linear magnitude axis has no negative amplitudes');
    assert.ok(labels.includes('0 Hz'));
    assert.ok(labels.includes('512 Hz'), 'rightmost label includes the Nyquist bin');
    labels.length = 0;
    plotter.vp.frequency.scrollOffset = 100;
    plotter.vp.frequency.displayCount = 100;
    plotter.mousePos = { x: 0, y: 100 };
    plotter.draw();
    assert.ok(labels.includes('100 Hz'), 'zoomed axis keeps the absolute bin offset');
    assert.ok(labels.some(label => label.includes('100 Hz') && label.includes('Bin 100')),
        'cursor frequency and bin refer to the same sample');
});

test('wheel zoom keeps the cursor near the same frequency on a log axis', () => {
    const { plotter, canvasEvents } = createPlotter();
    plotter.setDisplayOptions({ displayMode: 'frequency', freqXScale: 'log' });
    plotter.vp.frequency.displayCount = 400;
    plotter.draw();
    const plotW = plotter.canvas.width - plotter.pX;
    canvasEvents.get('wheel')({ clientX: plotW / 2, clientY: 100,
        deltaY: -1, preventDefault() {} });
    assert.ok(plotter.vp.frequency.scrollOffset <= 2);
});

for (const mode of ['frequency', 'phase']) {
    test('logarithmic ' + mode + ' wheel zoom keeps the frequency under the cursor', () => {
        const { plotter, labels, canvasEvents } = createPlotter();
        plotter.setSampleRateHz(1024);
        plotter.setDisplayOptions({ displayMode: mode, freqXUnit: 'hz', freqXScale: 'log' });
        let geometry;
        const hoveredFrequency = () => {
            labels.length = 0;
            plotter.draw();
            return Number.parseFloat(labels.find(label => label.startsWith('Freq: '))?.slice(6));
        };
        plotter.draw();
        geometry = plotter._drawState;
        const x = geometry.plotW * .5, y = geometry.plotH / 2;
        plotter.mousePos = { x, y };
        const initial = hoveredFrequency();
        const count = plotter._drawState.visibleCnt;
        canvasEvents.get('wheel')({ clientX: x, clientY: y, deltaY: -1, preventDefault() {} });
        assert.ok(Math.abs(hoveredFrequency() - initial) <= .002);
        assert.ok(plotter._drawState.visibleCnt < count);
        canvasEvents.get('wheel')({ clientX: x, clientY: y, deltaY: 1, preventDefault() {} });
        assert.ok(Math.abs(hoveredFrequency() - initial) <= .002);
    });
}

function createUnevenReceivePlot() {
    const { plotter, labels, canvasEvents } = createPlotter();
    plotter.clear();
    plotter.receiveTimeAxis = true;
    plotter.setDisplayOptions({ displayMode: 'time', timeXUnit: 's' });
    for (let i = 0; i < 200; i++) {
        plotter.addFrame([i], undefined, '', i + 1, 100000 + (i < 100 ? i : 100 + (i - 100) * 10));
    }
    plotter.draw();
    return { plotter, labels, canvasEvents };
}

test('receive-time wheel zoom anchors on the shown time even with uneven arrivals', () => {
    const { plotter, labels, canvasEvents } = createUnevenReceivePlot();
    const { plotW, plotH } = plotter._drawState;
    plotter.mousePos = { x: plotW * .75, y: plotH / 2 };
    const hoveredTime = () => {
        labels.length = 0;
        plotter.draw();
        return Number.parseFloat(labels.find(label => label.startsWith('Time: '))?.slice(6));
    };
    const initial = hoveredTime();
    canvasEvents.get('wheel')({ clientX: plotter.mousePos.x, clientY: plotter.mousePos.y, deltaY: -1, preventDefault() {} });
    assert.ok(Math.abs(hoveredTime() - initial) <= .01);
    assert.equal(plotter._drawState.visibleCnt, 160);
});

test('sample-index wheel zoom retains the plotted anchor within one sample', () => {
    const { plotter, canvasEvents } = createPlotter();
    plotter.setDisplayOptions({ displayMode: 'time', timeXUnit: 'samples' });
    plotter.draw();
    const prior = plotter._drawState, ratio = .71;
    const anchor = state => state.xFirst + ratio * (state.xLast - state.xFirst);
    canvasEvents.get('wheel')({
        clientX: prior.plotW * ratio, clientY: prior.plotH / 2, deltaY: -1, preventDefault() {}
    });
    plotter.draw();
    assert.ok(plotter._drawState.visibleCnt < prior.visibleCnt);
    assert.ok(Math.abs(anchor(plotter._drawState) - anchor(prior)) <= .5);
});

test('time rectangle zoom selects the sample range within the drawn timestamps', () => {
    const { plotter, canvasEvents } = createUnevenReceivePlot();
    const { plotW, plotH } = plotter._drawState;
    const fire = (event, x, y) => canvasEvents.get(event)({
        button: 0, pointerId: 1, clientX: x, clientY: y, preventDefault() {}
    });
    fire('pointerdown', plotW * .4, plotH * .25);
    fire('pointerup', plotW * .8, plotH * .75);
    // The plotted interval is 0–1090 ms. The box covers 436–872 ms.
    assert.equal(plotter._drawState.startIdx, 134);
    assert.equal(plotter._drawState.visibleCnt, 44);
});

test('wheel over a logarithmic Y axis zooms magnitude without changing frequency bins', () => {
    const { plotter, canvasEvents } = createPlotter();
    plotter.setDisplayOptions({ displayMode: 'frequency', freqYScale: 'log' });
    plotter.draw();
    const original = { ...plotter._drawState };
    const count = plotter.vp.frequency.displayCount;
    canvasEvents.get('wheel')({ clientX: original.plotW + 20,
        clientY: original.plotH / 2, deltaY: -1, preventDefault() {} });
    plotter.draw();
    assert.equal(plotter.vp.frequency.displayCount, count);
    assert.ok(plotter._drawState.min > original.min);
    assert.ok(plotter._drawState.max < original.max);
    assert.ok(plotter._drawState.min > 0);
});

test('rectangle zoom follows both logarithmic axis transforms', () => {
    const { plotter, canvasEvents } = createPlotter();
    plotter.setDisplayOptions({ displayMode: 'frequency',
        freqXScale: 'log', freqYScale: 'log' });
    plotter.draw();
    const plotW = plotter.canvas.width - plotter.pX;
    const plotH = plotter.canvas.height - plotter.pY;
    const fire = (name, x, y) => canvasEvents.get(name)({
        button: 0, pointerId: 1, clientX: x, clientY: y, preventDefault() {}
    });
    fire('pointerdown', 0, plotH / 4);
    fire('pointerup', plotW / 2, plotH * 3 / 4);
    assert.equal(plotter.vp.frequency.scrollOffset, 1);
    assert.ok(plotter.vp.frequency.displayCount >= 20 &&
        plotter.vp.frequency.displayCount <= 24);
    assert.ok(plotter._boxZoomY.frequency.min > 0);
});

test('time seconds, frequency bins, and logarithmic axes use their selected units', () => {
    const { plotter, labels } = createPlotter();
    plotter.setSampleRateHz(1024);
    plotter.setDisplayOptions({ displayMode: 'time', timeXUnit: 's' });
    labels.length = 0;
    plotter.draw();
    assert.ok(labels.includes('0.9 s'), 'the time axis shows stable second ticks inside the visible range');
    plotter.setDisplayOptions({ displayMode: 'frequency', freqXUnit: 'bins',
        freqXScale: 'log', freqYScale: 'log' });
    labels.length = 0;
    plotter.mousePos = { x: (plotter.canvas.width - plotter.pX) / 2, y: 100 };
    plotter.draw();
    assert.equal(plotter._drawState.startIdx, 1, 'log frequency skips DC');
    assert.ok(plotter._drawState.min > 0, 'log amplitude uses positive bounds');
    assert.ok(labels.includes('1'));
    assert.ok(labels.includes('512'));
    assert.ok(labels.includes('Freq: 22.627 Hz (Bin 22.627)'),
        'the cursor in the middle of a log axis lands near the geometric mean');
});

test('single-source receive-time traces, cursor and zoom use visible capture intervals', () => {
    const { plotter, labels } = createPlotter();
    plotter.clear();
    plotter.receiveTimeAxis = true;
    plotter.projectReceiveTime = stamp => stamp - 1000 - (stamp >= 11030 ? 10000 : 0);
    plotter.setDisplayOptions({ displayMode: 'time', timeXUnit: 's' });
    const stamps = [1010, 1020, 11030, 11040];
    stamps.forEach((stamp, index) => plotter.addFrame([index], undefined, '', index + 1, stamp));
    plotter.mousePos = { x: (plotter.canvas.width - plotter.pX) / 2, y: 100 };
    labels.length = 0;
    plotter.draw();
    assert.equal(plotter._drawState.aligned.first, 10);
    assert.equal(plotter._drawState.aligned.last, 40);
    assert.deepEqual(Array.from(plotter._timeSeriesCache.series[0].times), [10, 20, 30, 40]);
    assert.ok(labels.includes('Time: 0.015 s'));
    assert.equal(plotter._timeBoundaryIndex(30, false), 2);
    assert.equal(plotter._timeZoomStart(35, .5, 2), 2);
    assert.deepEqual(stamps.map((_, i) => plotter.frames.timestampAt(i)), stamps);
});

test('timebase changes keep fixed-rate sections and fold hidden spans in receive-time sections', () => {
    const { SourcePlotTimeline } = require('../sourceTimebase');
    const { FrameBuffer } = require('../frameBuffer');
    const frames = new FrameBuffer(1, 10);
    const append = stamp => frames.append([1], undefined, '', frames.length + 1, stamp);
    append(1010);
    append(11020);
    const project = stamp => stamp - 1000 - (stamp >= 11020 ? 10000 : 0) - (stamp >= 31050 ? 20000 : 0);
    const timeline = new SourcePlotTimeline({ frames, generation: 1 }, { mode: 'receive' }, project);
    timeline.change({ mode: 'fixed', sampleRate: 100 });
    append(11030);
    append(11035);
    timeline.change({ mode: 'receive' });
    append(31050);
    assert.deepEqual(Array.from({ length: frames.length }, (_, i) => timeline.timestampAt(i)), [0, 10, 20, 30, 45]);
    assert.equal(frames.timestampAt(4), 31050);
});

for (const mode of ['sample index', 'fixed rate', 'receive time']) {
    test('live time ticks retain their values as the ' + mode + ' window moves', () => {
        const { plotter, labels } = createPlotter();
        plotter.clear();
        plotter.setMaxPoints(4096);
        plotter.setPlotWindowPoints(1000);
        plotter.setSampleRateHz(1000);
        plotter.receiveTimeAxis = mode === 'receive time';
        plotter.fixedTimeRate = mode === 'fixed rate' ? 1000 : null;
        plotter.setDisplayOptions({ displayMode: 'time', timeXUnit: mode === 'sample index' ? 'samples' : 's' });

        const timestamp = 1700000000000;
        const append = (first, end, receiptOffset = 0) => {
            for (let i = first; i < end; i++) {
                const arrival = timestamp + Math.floor(i / 8) * 8 + receiptOffset;
                plotter.addFrame([Math.sin(i / 50)], undefined, '', i + 1, arrival);
            }
        };
        const axis = () => {
            labels.length = 0;
            plotter.draw();
            return labels.filter(label => mode === 'sample index' ? /^\d+$/.test(label) : label.endsWith(' s'));
        };
        append(0, 2048);
        const initial = axis();
        append(2048, 2056, 2);
        const next = axis();
        assert.equal(plotter._drawState.startIdx, 1056);
        assert.ok(initial.length >= 3 && next.length >= 3, 'both frames show multiple ticks');
        const shared = next.filter(label => initial.includes(label));
        assert.ok(shared.length >= Math.min(initial.length, next.length) - 2,
            'only ticks at the viewport edges should change: ' + initial.join(', ') + ' -> ' + next.join(', '));
    });
}

test('frequency axis does not invent hertz when sample rate is unknown', () => {
    const { plotter, labels } = createPlotter();
    plotter.draw();
    assert.ok(labels.includes('-- Hz'));
});

test('small nonzero sample intervals remain visible in seconds', () => {
    const { plotter } = createPlotter();
    plotter.setSampleRateHz(5000);
    plotter.setDisplayOptions({ timeXUnit: 's' });
    assert.equal(plotter._formatTimeIndex(1), '0.0002 s');
});

test('time hover shows seconds and sample position regardless of the axis unit', () => {
    const { plotter, labels } = createPlotter();
    plotter.setSampleRateHz(1000);
    for (const timeXUnit of ['samples', 's']) {
        plotter.setDisplayOptions({ displayMode: 'time', timeXUnit });
        plotter.vp.time.autoFollow = false;
        plotter.vp.time.scrollOffset = 200;
        plotter.vp.time.displayCount = 101;
        const plotW = plotter.canvas.width - plotter.pX;
        for (const [position, seconds] of [[50, '0.25'], [50.25, '0.25025'], [50.5, '0.2505']]) {
            plotter.mousePos = { x: plotW * position / 100, y: 100 };
            labels.length = 0;
            plotter.draw();
            assert.ok(labels.includes('Time: ' + seconds + ' s (Sample ' + (200 + position) + ')'));
            assert.ok(labels.some(label => label.startsWith('Value: ')));
        }
    }
});

test('time system response hover interpolates the sample position from the visible left edge', () => {
    const { plotter, labels } = createResponsePlotter('[0]=1,[1]=3,[2]=5');
    plotter.setDisplayOptions({ displayMode: 'time' });
    Object.assign(plotter.vp.time, { scrollOffset: 1, displayCount: 3, autoFollow: false });
    plotter.draw();
    assert.equal(plotter._drawState.startIdx, 1);
    plotter.mousePos = { x: plotter._drawState.plotW / 4, y: 100 };
    labels.length = 0;
    plotter.draw();
    assert.ok(labels.includes('Sample: [0.5]'));
    assert.ok(labels.includes('CH00002: 4.000000'));
});

test('frequency hover retains hertz alongside the bin when the axis displays bins', () => {
    const { plotter, labels } = createPlotter();
    plotter.setSampleRateHz(2048);
    plotter.setDisplayOptions({ freqXUnit: 'bins' });
    plotter.vp.frequency.scrollOffset = 100;
    plotter.vp.frequency.displayCount = 101;
    plotter.mousePos = { x: (plotter.canvas.width - plotter.pX) / 2, y: 100 };
    labels.length = 0;
    plotter.draw();
    assert.ok(labels.includes('Freq: 300 Hz (Bin 150)'));
    assert.ok(labels.some(label => label.startsWith('Mag: ')));
});

test('sparse spectra show true bin markers and hover between bins in GPU and Canvas rendering', () => {
    let traces;
    const gpu = { available: true, resize() {}, dispose() {}, render(items) { traces = items; return true; } };
    const { plotter, labels, markers, dots } = createPlotter(null, { gpuRenderer: gpu });
    const freq = { mags: [1, 3, 5, 7], fftSize: 8 };
    plotter._computeFftForVisibleChannels = () => new Map([[0, freq]]);
    plotter.setSampleRateHz(8);
    plotter.setDisplayOptions({ freqXScale: 'linear', freqYScale: 'linear' });
    plotter.draw();
    const { plotW } = plotter._drawState;
    assert.equal(traces[0].dots, true);
    assert.deepEqual(Array.from(traces[0].points, point => point.index), [0, 1, 2, 3]);
    plotter.mousePos = { x: plotW / 2, y: 100 };
    labels.length = 0;
    plotter.draw();
    assert.ok(labels.includes('Freq: 1.5 Hz (Bin 1.5)'));
    assert.ok(labels.includes('CH00001: 4.000000'));
    const [, left, right] = traces[0].points;
    assert.ok(Math.abs(markers.at(-1).y - (left.y + right.y) / 2) < 1e-9);

    gpu.available = false;
    plotter.draw();
    assert.equal(dots.length, 4, 'the Canvas fallback paints all four frequency markers');
    assert.ok(dots.every((dot, index) => dot[0] === traces[0].points[index].x - 1.5));

    gpu.available = true;
    plotter.setDisplayOptions({ magnitudeUnit: 'db', dbFactor: 20 });
    labels.length = 0;
    plotter.draw();
    assert.ok(labels.includes('CH00001: ' + (10 * Math.log10(15)).toFixed(6) + ' dB'));

    plotter.mousePos = null;
    plotter._computeFftForVisibleChannels = () => new Map([[0, { mags: Array(1025).fill(1), fftSize: 2048 }]]);
    plotter.draw();
    assert.equal(traces[0].dots, true, 'dense spectra mark the extrema retained for display');
    assert.ok(traces[0].points.length < 1025, 'dense markers reuse the pixel buckets');
});

test('logarithmic frequency hover interpolates along the plotted segment on both axes', () => {
    const { plotter, labels, markers } = createPlotter();
    const freq = { mags: [0, 1, 100, 10000], fftSize: 8 };
    plotter._computeFftForVisibleChannels = () => new Map([[0, freq]]);
    plotter.setSampleRateHz(8);
    plotter.setDisplayOptions({ freqXScale: 'log', freqYScale: 'log',
        yScaleModeFreq: 'manual', yMinFreq: 1, yMaxFreq: 10000 });
    plotter.draw();
    const { plotW, plotH } = plotter._drawState;
    plotter.mousePos = { x: plotW * Math.log(2) / (2 * Math.log(3)), y: 100 };
    labels.length = 0;
    plotter.draw();
    assert.ok(labels.includes('Freq: 1.414 Hz (Bin 1.414)'));
    assert.ok(labels.includes('CH00001: 10'));
    assert.ok(Math.abs(markers.at(-1).y - plotH * .75) < 1e-9);
});

test('phase hover respects wrapped discontinuities and missing bins but interpolates unwrapped phase', () => {
    let traces;
    const gpu = { available: true, resize() {}, dispose() {}, render(items) { traces = items; return true; } };
    const { plotter, labels, markers } = createPlotter(null, { gpuRenderer: gpu });
    const freq = { mags: [1, 1, 1, 1, 1], phases: [90, 170, -170, NaN, -123], fftSize: 8 };
    plotter._computeFftForVisibleChannels = () => new Map([[0, freq]]);
    plotter.setDisplayOptions({ displayMode: 'phase', freqXScale: 'linear',
        phaseUnwrap: false, phaseUnit: 'radians' });
    plotter.draw();
    const { plotW } = plotter._drawState;
    const hover = fraction => {
        labels.length = markers.length = 0;
        plotter.mousePos = { x: plotW * fraction, y: 100 };
        plotter.draw();
    };
    hover(3 / 8);
    assert.equal(traces[0].dots, true);
    assert.equal(traces[0].points.find(point => point.index === 2).break, true);
    assert.equal(markers.length, 0);
    assert.ok(labels.every(label => !label.startsWith('CH00001:')));

    plotter.setDisplayOptions({ phaseUnwrap: true });
    hover(3 / 8);
    assert.ok(labels.includes('CH00001: 3.141593 rad'));
    assert.ok(markers.length > 0);
    hover(5 / 8);
    assert.equal(markers.length, 0);
    assert.ok(labels.every(label => !label.startsWith('CH00001:')));
    hover(1);
    assert.ok(markers.length > 0, 'the exact bin remains readable after a gap');
});

test('hover preserves sample or bin positions when the sample rate is unknown', () => {
    const { plotter, labels } = createPlotter();
    plotter.mousePos = { x: 0, y: 100 };
    plotter.setDisplayOptions({ displayMode: 'time', timeXUnit: 'samples' });
    plotter.vp.time.autoFollow = false;
    plotter.vp.time.scrollOffset = 200;
    plotter.vp.time.displayCount = 101;
    labels.length = 0;
    plotter.draw();
    assert.ok(labels.includes('Time: -- s (Sample 200)'));
    plotter.mousePos.x = plotter._drawState.plotW / 200;
    labels.length = 0;
    plotter.draw();
    assert.ok(labels.includes('Time: -- s (Sample 200.5)'));
    plotter.mousePos.x = 0;
    plotter.setDisplayOptions({ displayMode: 'frequency', freqXUnit: 'bins' });
    labels.length = 0;
    plotter.draw();
    assert.ok(labels.includes('Freq: -- Hz (Bin 0)'));
});

test('log amplitude renders a silent spectrum with finite coordinates', () => {
    const { plotter } = createPlotter();
    plotter.clear();
    for (let i = 0; i < 64; i++) plotter.addFrame([0]);
    plotter.setDisplayOptions({ displayMode: 'frequency',
        freqXScale: 'log', freqYScale: 'log' });
    plotter.draw();
    assert.ok(plotter._drawState.min > 0);
});

test('manual log amplitude includes zero and keeps FFT and hover values in original units', () => {
    const { plotter, labels } = createPlotter();
    plotter.setDisplayOptions({ displayMode: 'frequency', freqYScale: 'log',
        yScaleModeFreq: 'manual', yMinFreq: 0, yMaxFreq: 2 });
    plotter.mousePos = { x: 100, y: plotter.canvas.height - plotter.pY };
    labels.length = 0;
    plotter.draw();
    assert.equal(plotter._drawState.min, 0);
    assert.equal(plotter._drawState.max, 2);
    assert.ok(plotter._drawState.yScale.linearThreshold > 0);
    assert.ok(labels.includes('0'));
    assert.ok(labels.includes('Mag: 0'));
    const threshold = plotter._drawState.yScale.linearThreshold;
    plotter.setChannelTransform(0, { gainEnabled: true, gain: 0.1, offsetEnabled: false, offset: 0 });
    plotter.draw();
    assert.ok(Math.abs(plotter._drawState.yScale.linearThreshold / threshold - 0.1) < 1e-12);
    plotter.setDisplayOptions({ yMinFreq: 0.001 });
    plotter.draw();
    assert.equal(plotter._drawState.yScale, 'log');
    assert.equal(plotter._drawState.min, 0.001);
});

test('zero-inclusive logarithmic silent spectra use a finite linear range', () => {
    const { plotter } = createPlotter();
    plotter.clear();
    for (let i = 0; i < 64; i++) plotter.addFrame([0]);
    plotter.setDisplayOptions({ displayMode: 'frequency', freqYScale: 'log',
        yScaleModeFreq: 'manual', yMinFreq: 0, yMaxFreq: 0.5 });
    plotter.draw();
    assert.equal(plotter._drawState.min, 0);
    assert.equal(plotter._drawState.max, 0.5);
    assert.equal(plotter._drawState.yScale.linearThreshold, 0.5);
});

test('small magnitude and phase plots render fewer vertices while preserving bins, gaps and hover', () => {
    let trace;
    const gpu = { available: true, resize() {}, dispose() {},
        render(traces) { trace = traces[0]; return true; } };
    const { plotter, labels } = createPlotter(null, { gpuRenderer: gpu });
    const count = 5001, cursorBin = 401;
    const mags = Float64Array.from({ length: count }, (_, i) => i % 2 ? 5 + i % 29 : 2 + i % 17);
    const phases = Float64Array.from({ length: count }, (_, i) => i % 2 ? i % 23 : -(i % 19));
    mags[31] = 400; mags[32] = .001; mags[2500] = NaN;
    phases[1001] = 178; phases[1002] = -178; phases[2500] = NaN;
    const spectra = new Map([[0, { mags, phases, fftSize: 10000 }]]);
    plotter._computeFftForVisibleChannels = () => spectra;
    plotter.setSampleRateHz(10000);
    let zoom = 1;
    const rect = () => ({ width: 800 * zoom, height: 400 * zoom, left: 0, top: 0 });
    plotter.canvas.closest = () => ({ dataset: { workspaceZoom: String(zoom) } });
    plotter.canvas.getBoundingClientRect = plotter.canvas.parentElement.getBoundingClientRect = rect;

    function draw(scale, mode) {
        zoom = scale;
        plotter.resize();
        plotter.setDisplayOptions({ displayMode: mode, freqXScale: 'linear', freqYScale: 'linear',
            phaseUnwrap: false, phaseUnit: 'degrees' });
        plotter.vp[mode].displayCount = count;
        plotter.mousePos = { x: (800 - plotter.pX) * cursorBin / (count - 1), y: 100 };
        labels.length = 0;
        plotter.draw();
        const { startIdx, visibleCnt, min, max } = plotter._drawState;
        assert.deepEqual([startIdx, visibleCnt], [0, count]);
        return { points: trace.points, bounds: [min, max],
            hover: labels.find(label => label.startsWith('CH00001:')) };
    }

    for (const [mode, values] of [['frequency', mags], ['phase', phases]]) {
        const full = draw(1, mode);
        const small = draw(.39, mode);
        assert.ok(small.points.length < full.points.length / 2);
        assert.ok(small.points.length <= 568, `drew ${small.points.length} vertices in ${mode} mode`);
        assert.deepEqual(small.bounds, full.bounds);
        assert.equal(small.hover, full.hover);
        assert.ok(small.hover.includes(values[cursorBin].toFixed(6)));
        assert.equal(small.points.find(point => point.index > 2500)?.break, true);
        assert.equal(small.points[0].index, 0);
        assert.equal(small.points.at(-1).index, count - 1);
        if (mode === 'phase') assert.equal(small.points.find(point => point.index === 1002)?.break, true);
        else assert.equal(small.points.find(point => point.index === 31)?.value, 400);
    }
});
