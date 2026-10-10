const test = require('node:test');
const assert = require('node:assert/strict');
const { prepareFrequencySeries } = require('../spectrum');

test('FFT identifies a sampled sine peak and DC removal suppresses a constant input', () => {
    const samples = Array.from({ length: 64 }, (_, i) => Math.sin(2 * Math.PI * 4 * i / 64));
    const sine = prepareFrequencySeries(samples, false);
    assert.equal(sine.dominantBin, 4);
    assert.equal(sine.fftSize, 64);
    const constant = prepareFrequencySeries(new Array(64).fill(10), true);
    assert.ok(Math.max(...constant.mags) < 1e-10);
    assert.ok(prepareFrequencySeries([1, NaN, Infinity, 0], false).mags.every(Number.isFinite));
});

test('FFT exposes phase relative to its first input sample without changing amplitude', () => {
    const cosine = prepareFrequencySeries(Array.from({ length: 64 }, (_, i) =>
        2 * Math.cos(2 * Math.PI * 4 * i / 64 + Math.PI / 4)), false, 'rectangular');
    assert.ok(Array.isArray(cosine.phases));
    assert.ok(Math.abs(cosine.phases[4] - 45) < 1e-10);
    assert.ok(Math.abs(cosine.mags[4] - 2) < 1e-10);
    const silent = prepareFrequencySeries(Array(64).fill(0), false, 'rectangular');
    assert.ok(silent.phases.every(Number.isNaN));
});

test('an entirely invalid computed signal does not manufacture a zero spectrum', () => {
    assert.deepEqual(prepareFrequencySeries([NaN, Infinity, NaN, NaN]), { mags: [], dominantBin: 0, fftSize: 0 });
});

test('one-sided Hann spectrum preserves bin-centred sine, DC and Nyquist amplitudes', () => {
    const size = 64;
    const sine = prepareFrequencySeries(Array.from({ length: size }, (_, i) =>
        2 * Math.sin(2 * Math.PI * 4 * i / size)));
    assert.ok(Math.abs(sine.mags[4] - 2) < 0.01);
    const constant = prepareFrequencySeries(new Array(size).fill(3));
    assert.ok(Math.abs(constant.mags[0] - 3) < 1e-12);
    assert.equal(constant.dominantBin, 0);
    const nyquist = prepareFrequencySeries(Array.from({ length: size }, (_, i) =>
        i % 2 ? -1.5 : 1.5));
    assert.ok(Math.abs(nyquist.mags[size / 2] - 1.5) < 1e-12);
    assert.equal(nyquist.dominantBin, size / 2);
});

test('empty and two-sample signals never report a phantom peak', () => {
    assert.equal(prepareFrequencySeries(new Array(64).fill(0)).dominantBin, 0);
    const two = prepareFrequencySeries([1, -1]);
    assert.ok(Math.abs(two.mags[1] - 1) < 1e-12);
    assert.equal(two.dominantBin, 1);
});

test('DC removal suppresses floating point residue from a fractional constant', () => {
    const spectrum = prepareFrequencySeries(new Array(64).fill(0.1), true);
    assert.equal(Math.max(...spectrum.mags), 0);
    assert.equal(spectrum.dominantBin, 0);
});

test('FFT zero padding changes bin spacing without changing amplitude normalization', () => {
    const spectrum = prepareFrequencySeries(Array.from({ length: 1000 }, (_, i) =>
        2 * Math.sin(2 * Math.PI * 20 * i / 1024)));
    assert.equal(spectrum.fftSize, 1024);
    assert.equal(spectrum.mags.length, 513);
    assert.equal(spectrum.dominantBin, 20);
    assert.ok(Math.abs(spectrum.mags[20] - 2) < 0.01);
});

test('FFT bins match an independent discrete Fourier transform', () => {
    const values = [0.4, -2, 1.7, 3, -0.2, 0.8, -1.1];
    const spectrum = prepareFrequencySeries(values);
    const gain = (values.length - 1) / 2;
    for (let bin = 0; bin < spectrum.mags.length; bin++) {
        let real = 0, imaginary = 0;
        for (let sample = 0; sample < values.length; sample++) {
            const window = 0.5 - 0.5 * Math.cos(2 * Math.PI * sample / (values.length - 1));
            const angle = -2 * Math.PI * bin * sample / spectrum.fftSize;
            real += values[sample] * window * Math.cos(angle);
            imaginary += values[sample] * window * Math.sin(angle);
        }
        const oneSidedFactor = bin === 0 || bin === spectrum.fftSize / 2 ? 1 : 2;
        assert.ok(Math.abs(spectrum.mags[bin] -
            Math.hypot(real, imaginary) * oneSidedFactor / gain) < 1e-12);
    }
});

test('selectable windows preserve centred sine amplitude and DC gain', () => {
    const size = 256;
    const samples = Array.from({ length: size }, (_, i) =>
        2 * Math.sin(2 * Math.PI * 8 * i / size));
    for (const windowType of ['rectangular', 'hann', 'hamming', 'blackman', 'flatTop']) {
        const sine = prepareFrequencySeries(samples, false, windowType);
        assert.equal(sine.dominantBin, 8, windowType);
        assert.ok(Math.abs(sine.mags[8] - 2) < 0.02, windowType);
        const dc = prepareFrequencySeries(new Array(size).fill(3), false, windowType);
        assert.ok(Math.abs(dc.mags[0] - 3) < 1e-10, windowType);
        const removed = prepareFrequencySeries(new Array(size).fill(3), true, windowType);
        assert.ok(Math.max(...removed.mags) < 1e-10, windowType);
    }
});

test('window choice changes leakage and short signals remain finite', () => {
    const samples = Array.from({ length: 256 }, (_, i) =>
        Math.sin(2 * Math.PI * 8.5 * i / 256));
    const rectangular = prepareFrequencySeries(samples, false, 'rectangular');
    const blackman = prepareFrequencySeries(samples, false, 'blackman');
    assert.ok(blackman.mags[40] < rectangular.mags[40]);
    for (const windowType of ['rectangular', 'hann', 'hamming', 'blackman', 'flatTop'])
        assert.ok(prepareFrequencySeries([1, -1], false, windowType).mags.every(Number.isFinite));
    assert.throws(() => prepareFrequencySeries([1, 2, 3], false, 'unknown'), /窗函数/);
});
