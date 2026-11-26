const test = require('node:test');
const assert = require('node:assert/strict');
const { pairSpectrum } = require('../pairSpectrum');

const fftSize = 64;
const toneBin = 5;
const rectangular = { fftSize, fftWindow: 'rectangular', fftRemoveDc: false, fftOverlap: 0 };

function tone(length, bin = toneBin, phase = 0) {
    return Array.from({ length }, (_, i) => Math.cos(2 * Math.PI * bin * i / fftSize + phase));
}

test('cross-spectrum phase measures the signed phase of Y relative to X', () => {
    const x = tone(fftSize * 2);
    const y = tone(fftSize * 2, toneBin, Math.PI / 3);
    for (const [reference, response, expected] of [[x, y, Math.PI / 3], [y, x, -Math.PI / 3]]) {
        const { phase, coherence } = pairSpectrum([{ x: reference, y: response }], rectangular);
        assert.ok(phase instanceof Float64Array);
        assert.ok(coherence instanceof Float64Array);
        assert.ok(Math.abs(phase[toneBin] - expected) < 1e-12);
        assert.ok(coherence[toneBin] > 1 - 1e-12 && coherence[toneBin] <= 1);
    }
});

test('H1 magnitude recovers different gains at two frequencies and reverses with the channel order', () => {
    const slow = tone(fftSize * 2), fast = tone(fftSize * 2, 13);
    const shifted = tone(fftSize * 2, toneBin, -0.7);
    const x = slow.map((value, i) => value + fast[i]);
    const y = shifted.map((value, i) => .5 * value + 2 * fast[i]);
    const input = [{ x, y }];
    const ratio = pairSpectrum(input, { ...rectangular, gainUnit: 'ratio' }).gain;
    const db = pairSpectrum(input, { ...rectangular, gainUnit: 'db' }).gain;
    const db10 = pairSpectrum(input, { ...rectangular, gainUnit: 'db10' }).gain;
    assert.ok(Math.abs(ratio[toneBin] - .5) < 1e-12);
    assert.ok(Math.abs(ratio[13] - 2) < 1e-12);
    assert.ok(Math.abs(db[toneBin] + 6.020599913279624) < 1e-12);
    assert.ok(Math.abs(db[13] - 6.020599913279624) < 1e-12);
    assert.ok(Math.abs(db10[toneBin] + 3.010299956639812) < 1e-12);
    assert.ok(Math.abs(db10[13] - 3.010299956639812) < 1e-12);
    assert.ok(Number.isNaN(ratio[9]));
    const inverse = pairSpectrum([{ x: y, y: x }], { ...rectangular, gainUnit: 'ratio' }).gain;
    assert.ok(Math.abs(inverse[toneBin] - 2) < 1e-12);
    assert.ok(Math.abs(inverse[13] - .5) < 1e-12);
    const { xDominantBin, yDominantBin } = pairSpectrum([{ x: slow.map((v, i) => v + .25 * fast[i]), y }], rectangular);
    assert.deepEqual([xDominantBin, yDominantBin], [toneBin, 13]);
});

test('H1 averages the cross-spectrum first and preserves zero response in linear units', () => {
    const x = tone(fftSize), inverted = x.map(value => -value), zero = x.map(() => 0);
    const silent = [{ x, y: zero }, { x, y: zero }];
    const cancel = [{ x, y: x }, { x, y: inverted }];
    for (const input of [silent, cancel]) {
        const ratio = pairSpectrum(input, { ...rectangular, gainUnit: 'ratio' }).gain;
        const db = pairSpectrum(input, { ...rectangular, gainUnit: 'db' }).gain;
        assert.equal(ratio[toneBin], 0);
        assert.ok(Number.isNaN(db[toneBin]));
    }
    const noInput = [{ x: zero, y: x }, { x: zero, y: x }];
    assert.ok(pairSpectrum(noInput, { ...rectangular, gainUnit: 'ratio' }).gain.every(Number.isNaN));
    const silentInput = pairSpectrum(noInput, rectangular);
    assert.deepEqual([silentInput.xDominantBin, silentInput.yDominantBin], [null, toneBin]);
});

test('changing overlap preserves gain and phase of a stable, aligned tone', () => {
    const x = tone(4 * fftSize), delay = Math.PI / 3;
    const y = tone(x.length, toneBin, -delay).map(value => value * .5);
    for (const fftOverlap of [0, 25, 50, 75]) {
        const { phase, gain } = pairSpectrum([{ x, y }], { ...rectangular, gainUnit: 'ratio', fftOverlap });
        assert.ok(Math.abs(phase[toneBin] + delay) < 1e-12);
        assert.ok(Math.abs(gain[toneBin] - .5) < 1e-12);
    }
});

test('opposite cross-spectra cancel before magnitude-squared coherence is calculated', () => {
    const x = tone(fftSize);
    const inverted = x.map(value => -value);
    const { coherence } = pairSpectrum([{ x, y: x }, { x, y: inverted }], rectangular);
    assert.equal(coherence[toneBin], 0);
});

test('Welch blocks retain their relative powers across runs', () => {
    const x = tone(fftSize);
    const inverted = x.map(value => -2 * value);
    const { coherence } = pairSpectrum([{ x, y: x }, { x, y: inverted }], rectangular);
    assert.ok(Math.abs(coherence[toneBin] - 0.1) < 1e-12);
});

test('complete FFT blocks stay within their runs', () => {
    const full = tone(96);
    const short = tone(63);
    const { blocks, phase, coherence } = pairSpectrum([
        { x: full, y: full }, { x: short, y: short }, { x: full, y: full }
    ], { ...rectangular, fftOverlap: 50 });
    assert.equal(blocks, 4);
    assert.equal(phase.length, 33);
    assert.equal(coherence.length, 33);
    assert.equal(phase[toneBin], 0);
    assert.ok(coherence[toneBin] > 1 - 1e-12);
});

test('overlap changes the step between complete FFT blocks', () => {
    const x = tone(160);
    for (const [fftOverlap, expectedBlocks] of [[0, 2], [25, 3], [50, 4], [75, 7]]) {
        assert.equal(pairSpectrum([{ x, y: x }], { ...rectangular, fftOverlap }).blocks, expectedBlocks);
    }
});

test('fewer than two blocks leave all bins invalid', () => {
    for (const length of [63, 64]) {
        const x = tone(length);
        const { blocks, phase, coherence } = pairSpectrum([{ x, y: x }], rectangular);
        assert.equal(blocks, length === 64 ? 1 : 0);
        assert.ok(phase.every(Number.isNaN));
        assert.ok(coherence.every(Number.isNaN));
    }
});

test('a bin with negligible power in either channel has undefined phase and coherence', () => {
    const x = tone(fftSize * 2);
    const second = tone(fftSize * 2, 13);
    const weak = x.map((value, i) => value + 1e-8 * second[i]);
    const strong = x.map((value, i) => value + second[i]);
    for (const [reference, response] of [[weak, strong], [strong, weak]]) {
        const { phase, coherence } = pairSpectrum([{ x: reference, y: response }], rectangular);
        assert.ok(Number.isNaN(phase[13]));
        assert.ok(Number.isNaN(coherence[13]));
        assert.ok(Number.isFinite(coherence[toneBin]));
    }
});

test('removing each block mean eliminates constant signals at different offsets', () => {
    const x = [...Array(fftSize).fill(0.1), ...Array(fftSize).fill(-0.3)];
    const y = tone(fftSize * 2);
    const { blocks, phase, coherence } = pairSpectrum([{ x, y }], {
        ...rectangular, fftWindow: 'hann', fftRemoveDc: true
    });
    assert.equal(blocks, 2);
    assert.ok(phase.every(Number.isNaN));
    assert.ok(coherence.every(Number.isNaN));
});

test('the selected taper changes the energy in adjacent bins', () => {
    const x = tone(fftSize * 2);
    const segment = [{ x, y: x }];
    const rectangularResult = pairSpectrum(segment, rectangular);
    const hannResult = pairSpectrum(segment, { ...rectangular, fftWindow: 'hann' });
    assert.ok(Number.isNaN(rectangularResult.coherence[toneBin + 1]));
    assert.ok(hannResult.coherence[toneBin + 1] > 1 - 1e-12);
});

test('finite extreme channel amplitudes retain phase and coherence', () => {
    const x = Array.from({ length: 2 * fftSize }, (_, i) => [1.6e308, 0, -1.6e308, 0][i % 4]);
    const y = Array.from({ length: 2 * fftSize }, (_, i) => [0, -1e-310, 0, 1e-310][i % 4]);
    for (const fftRemoveDc of [false, true]) {
        const { phase, coherence } = pairSpectrum([{ x, y }], { ...rectangular, fftRemoveDc });
        assert.ok(Math.abs(phase[16] - Math.PI / 2) < 1e-12);
        assert.ok(coherence[16] > 1 - 1e-12);
    }
});

test('a removed DC offset does not obscure a quiet tone in other blocks', () => {
    const constant = Array(fftSize).fill(1.6e308);
    const x = tone(fftSize * 2).map(value => value * 1e-310);
    const { phase, coherence } = pairSpectrum([{ x: constant, y: constant }, { x, y: x }], {
        ...rectangular, fftRemoveDc: true
    });
    assert.equal(phase[toneBin], 0);
    assert.ok(coherence[toneBin] > 1 - 1e-12);
});
