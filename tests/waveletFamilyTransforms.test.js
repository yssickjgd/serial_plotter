const test = require('node:test');
const assert = require('node:assert/strict');
const { createWaveletProcessor, createWaveletSource, waveletSupportsPhase, waveletResolutionGrid } = require('../wavelet');
const { fftInPlace, nextPow2 } = require('../spectrum');

const realBases = ['mexicanHat', 'haar', 'gaus1', 'db4', 'sym4', 'coif2', 'meyer'];
const analyticBases = ['morlet', 'morse', 'shannon'];
const values = Float64Array.from({ length: 512 }, (_, i) => Math.cos(i * .24) + .4 * Math.sin(i * .84));
values[250] = NaN;
const options = { rate: 1024, frequencyRows: 16, timeStride: 2 };

function calculate(create, basis, signal, range) {
    const processor = create({ ...options, basis, values: signal }, range);
    processor.step(Infinity);
    return processor.result();
}

test('all real CWT families preserve coefficient sign across polarity inversion and native gaps', () => {
    for (const basis of realBases) {
        assert.equal(waveletSupportsPhase(basis), false, basis);
        const result = calculate(createWaveletProcessor, basis, values);
        const inverted = calculate(createWaveletProcessor, basis, values.map(x => -x));
        assert.ok(result.sign instanceof Int8Array, basis);
        assert.equal(result.phase, null);
        assert.equal(result.sign.length, result.magnitude.length);
        assert.ok(result.sign.includes(-1) && result.sign.includes(1), basis);
        for (let i = 0; i < result.sign.length; i++) {
            assert.equal(result.magnitude[i], inverted.magnitude[i], basis);
            assert.ok(result.sign[i] === -inverted.sign[i], basis);
        }
        assert.ok(Number.isNaN(result.magnitude[125]));
        assert.equal(result.sign[125], 0);
        const grid = waveletResolutionGrid({ ...options, basis, visibleLength: values.length });
        assert.equal(grid.bytes, result.magnitude.byteLength + result.sign.byteLength + result.reference.byteLength);
    }
});

test('each edge extension matches explicit samples after consuming available history', () => {
    const worker = new Function('fftInPlace', 'nextPow2', 'return ' + createWaveletSource())(fftInPlace, nextPow2);
    const signal = Float64Array.from({ length: 61 }, (_, i) => 5 + Math.sin(i * .24));
    const setup = { ...options, basis: 'morlet', visibleStart: 5, visibleLength: 51, timeStride: 1 };
    const pad = 19; // The lowest frequency needs 24 samples; five are already present on each side.
    const run = (task, create = createWaveletProcessor) => {
        const p = create(task);
        p.step(Infinity);
        return p.result();
    };
    for (const edgeExtension of ['mirror', 'zero', 'hold']) {
        const padded = Float64Array.from({ length: signal.length + 2 * pad }, (_, i) => {
            const index = i - pad, end = signal.length - 1;
            if (index >= 0 && index <= end) return signal[index];
            if (edgeExtension === 'zero') return 0;
            if (edgeExtension === 'hold') return signal[index < 0 ? 0 : end];
            return signal[index < 0 ? -index : 2 * end - index];
        });
        const expected = run({ ...setup, values: padded, visibleStart: setup.visibleStart + pad });
        const actual = run({ ...setup, values: signal, edgeExtension });
        assert.deepEqual(actual.magnitude, expected.magnitude, edgeExtension);
        assert.deepEqual(actual.phase, expected.phase, edgeExtension);
        assert.equal(actual.reference[0], 1);
        assert.equal(expected.reference[0], 0);
        assert.deepEqual(run({ ...setup, values: signal, edgeExtension }, worker), actual);
    }
    assert.throws(() => run({ ...setup, values: signal, edgeExtension: 'unknown' }), RangeError);
});

test('serialized workers compute the same CWT rows and polarity as the local processor for every family', () => {
    const create = new Function('fftInPlace', 'nextPow2', 'return ' + createWaveletSource())(fftInPlace, nextPow2);
    for (const basis of [...realBases, ...analyticBases]) {
        const all = calculate(createWaveletProcessor, basis, values);
        const part = calculate(create, basis, values, { rowStart: 4, rowEnd: 13 });
        for (const field of ['magnitude', 'phase', 'reference', 'sign']) {
            assert.deepEqual(part[field], all[field]?.subarray(4 * all.columns, 13 * all.columns) ?? null, basis + ' ' + field);
        }
        if (analyticBases.includes(basis)) {
            assert.equal(waveletSupportsPhase(basis), true, basis);
            assert.ok(all.phase.some(Number.isFinite), basis);
            assert.equal(all.sign, null);
        }
    }
});

test('all nine displayed families and Morse have unit gain for a sinusoid at their center frequency', () => {
    const count = 2048, center = count / 2, row = 10;
    for (const basis of [...realBases, ...analyticBases]) {
        const setup = { rate: 1024, basis, timeStride: 1, frequencyRows: 17, frequencyScale: 'linear' };
        const grid = waveletResolutionGrid({ ...setup, visibleLength: count });
        const frequency = grid.minHz + (grid.maxHz - grid.minHz) * row / 16;
        const coefficient = phase => {
            const signal = Float64Array.from({ length: count }, (_, i) =>
                Math.cos(2 * Math.PI * frequency * (i - center) / setup.rate + phase));
            const p = createWaveletProcessor({ ...setup, values: signal }, { rowStart: row, rowEnd: row + 1 });
            p.step(Infinity);
            const { magnitude, sign } = p.result();
            return magnitude[center] * (sign?.[center] ?? 1);
        };
        const gain = waveletSupportsPhase(basis) ? coefficient(.46) : Math.hypot(coefficient(0), coefficient(Math.PI / 2));
        assert.ok(Math.abs(gain - 1) < .015, basis + ' gain ' + gain);
    }
});

test('Haar and DOG1 correlate rising and falling steps with opposite signed coefficients', () => {
    const step = Float64Array.from({ length: 512 }, (_, i) => Number(i >= 128 && i < 384));
    for (const basis of ['haar', 'gaus1']) {
        const result = calculate(createWaveletProcessor, basis, step);
        const offset = 7 * result.columns;
        for (const [edge, sign] of [[128, -1], [384, 1]]) {
            const center = offset + edge / result.hop;
            assert.equal(result.sign[center], sign, basis);
            assert.ok(result.magnitude[center] > .1, basis);
        }
    }
});
