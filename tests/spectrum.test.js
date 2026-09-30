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
