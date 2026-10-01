const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

function createPlotter() {
    const ctx = new Proxy({}, { get: (_, key) => key === 'measureText'
        ? () => ({ width: 20 }) : () => {} });
    const element = () => ({ style: {}, offsetHeight: 0, clientWidth: 800,
        addEventListener() {}, getBoundingClientRect: () => ({ width: 800, height: 400 }) });
    const nodes = new Map();
    nodes.set('waveform-canvas', {
        ...element(), parentElement: element(), getContext: () => ctx
    });
    const document = { getElementById(id) {
        if (!nodes.has(id)) nodes.set(id, element());
        return nodes.get(id);
    }, addEventListener() {} };
    const context = vm.createContext({ document, window: { addEventListener() {} },
        performance, requestAnimationFrame() {}, console });
    for (const file of ['projectLimits.js', 'frameBuffer.js', 'plotMath.js',
        'channelTransform.js', 'spectrum.js', 'plotter.js']) {
        vm.runInContext(fs.readFileSync(require.resolve(`../${file}`), 'utf8'),
            context, { filename: file });
    }
    const { FrameBuffer, Plotter } = context.SerialPlotter;
    const plotter = new Plotter('waveform-canvas', new FrameBuffer(1, 128));
    plotter.setChannelCount(1);
    plotter.setMaxPoints(128);
    plotter.setChannelVisible(0, true);
    plotter.setDisplayOptions({ fftWindow: 'rectangular' });
    return plotter;
}

test('paused FFT follows the time viewport and resumes the full live buffer', () => {
    const plotter = createPlotter();
    let summary;
    plotter.onStatsUpdate = value => { summary = value; };
    for (let i = 0; i < 128; i++) {
        const bin = i < 64 ? 4 : 12;
        const amplitude = i < 64 ? 1 : 2;
        plotter.addFrame([amplitude * Math.sin(2 * Math.PI * bin * (i % 64) / 64)]);
    }
    plotter.vp.time.scrollOffset = 0;
    plotter.vp.time.displayCount = 64;
    plotter.vp.time.autoFollow = false;
    plotter.setDisplayOptions({ displayMode: 'frequency' });
    assert.equal(plotter._frequencyForChannel(0).fftSize, 128,
        'live FFT keeps using every retained sample');

    plotter.togglePause();
    plotter.draw();
    const first = plotter._frequencyForChannel(0);
    assert.equal(first.fftSize, 64);
    assert.equal(first.dominantBin, 4);
    assert.equal(plotter._frequencyForChannel(0), first,
        'unchanged paused windows reuse the spectrum');
    assert.ok(Math.abs(summary.max - 1) < 1e-10);
    assert.equal(summary.freq, 4 / 64);

    plotter.setDisplayOptions({ displayMode: 'time' });
    plotter.vp.time.scrollOffset = 64;
    plotter.draw();
    const presentedBefore = plotter.completedSpectrumDraws;
    plotter.setDisplayOptions({ displayMode: 'frequency' });
    const second = plotter._frequencyForChannel(0);
    assert.equal(second.fftSize, 64);
    assert.equal(second.dominantBin, 12,
        'changing the time window invalidates the paused spectrum cache');
    assert.notEqual(second, first);
    assert.equal(plotter.completedSpectrumDraws, presentedBefore + 1,
        'a spectrum prepared by time statistics counts when frequency view presents it');
    assert.ok(Math.abs(summary.max - 2) < 1e-10);
    assert.equal(summary.freq, 12 / 64);

    plotter.togglePause();
    assert.equal(plotter._frequencyForChannel(0).fftSize, 128);
});

test('the time viewport keeps following samples while the live frequency plot is open', () => {
    const plotter = createPlotter();
    plotter.vp.time.displayCount = 32;
    plotter.setDisplayOptions({ displayMode: 'frequency' });
    for (let i = 0; i < 160; i++) plotter.addFrame([i]);
    assert.equal(plotter.frames.length, 128);
    assert.equal(plotter.vp.time.scrollOffset, 96);
    plotter.togglePause();
    assert.equal(plotter._frequencyForChannel(0).fftSize, 32);
});
