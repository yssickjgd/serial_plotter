const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

function createPlotter() {
    const labels = [];
    const canvasEvents = new Map();
    const ctx = new Proxy({}, { get: (_, key) => key === 'measureText'
        ? text => ({ width: String(text).length * 6 })
        : key === 'fillText' ? text => { labels.push(String(text)); }
            : key === 'moveTo' || key === 'lineTo' ? (x, y) => {
                assert.ok(Number.isFinite(x) && Number.isFinite(y));
            }
            : () => {} });
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
        'channelTransform.js', 'spectrum.js', 'plotter.js']) {
        vm.runInContext(fs.readFileSync(require.resolve(`../${file}`), 'utf8'), context, { filename: file });
    }
    const { FrameBuffer, Plotter } = context.SerialPlotter;
    const plotter = new Plotter('waveform-canvas', new FrameBuffer(1, 1024));
    plotter.setChannelCount(1);
    plotter.setChannelVisible(0, true);
    for (let i = 0; i < 1024; i++) plotter.addFrame([Math.sin(2 * Math.PI * 100 * i / 1024)]);
    plotter.setDisplayOptions({ displayMode: 'frequency' });
    return { plotter, labels, canvasEvents };
}

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
    assert.ok(labels.includes('0.999 s'));
    plotter.setDisplayOptions({ displayMode: 'frequency', freqXUnit: 'bins',
        freqXScale: 'log', freqYScale: 'log' });
    labels.length = 0;
    plotter.mousePos = { x: (plotter.canvas.width - plotter.pX) / 2, y: 100 };
    plotter.draw();
    assert.equal(plotter._drawState.startIdx, 1, 'log frequency skips DC');
    assert.ok(plotter._drawState.min > 0, 'log amplitude uses positive bounds');
    assert.ok(labels.includes('1'));
    assert.ok(labels.includes('512'));
    assert.ok(labels.some(label => label.includes('Bin 23')),
        'the cursor in the middle of a log axis lands near the geometric mean');
});

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
        plotter.mousePos = { x: (plotter.canvas.width - plotter.pX) / 2, y: 100 };
        labels.length = 0;
        plotter.draw();
        assert.ok(labels.includes('Time: 0.25 s (Sample 250)'));
        assert.ok(labels.some(label => label.startsWith('Value: ')));
    }
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

test('hover preserves sample or bin positions when the sample rate is unknown', () => {
    const { plotter, labels } = createPlotter();
    plotter.mousePos = { x: 0, y: 100 };
    plotter.setDisplayOptions({ displayMode: 'time', timeXUnit: 'samples' });
    plotter.vp.time.autoFollow = false;
    plotter.vp.time.scrollOffset = 200;
    labels.length = 0;
    plotter.draw();
    assert.ok(labels.includes('Time: -- s (Sample 200)'));
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
