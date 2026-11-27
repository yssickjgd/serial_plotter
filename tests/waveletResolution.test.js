const test = require('node:test');
const assert = require('node:assert/strict');
const {
    createWaveletProcessor, waveletMaxFrequencyRows, waveletTimeStrides, waveletResolutionGrid, maxWaveletGridBytes,
    waveletColumnSample, createWaveletSource
} = require('../wavelet');
const { fftInPlace, nextPow2 } = require('../spectrum');

function processor(count, options) {
    const values = Float64Array.from({ length: count }, (_, i) => Math.cos(2 * Math.PI * i / 8));
    return createWaveletProcessor({ values, rate: 1000, basis: 'morse', ...options });
}

test('pruned inverse FFTs retain the dense transform coefficients at every requested center', () => {
    const factory = new Function('fftInPlace', 'nextPow2', 'return ' + createWaveletSource());
    const dense = factory((re, im, plan, stages, repeat) => {
        if (plan?.reordered) for (let i = 0; i < re.length; i += repeat) {
            re.fill(0, i + 1, i + repeat); im.fill(0, i + 1, i + repeat);
        }
        fftInPlace(re, im, plan);
    }, nextPow2);
    let projected = 0, repeated = 0;
    const pruned = factory((re, im, plan, stages, repeat) => {
        if (stages) projected++;
        if (repeat > 1) repeated++;
        fftInPlace(re, im, plan, stages, repeat);
    }, nextPow2);
    const values = Float64Array.from({ length: 1500 }, (_, i) => i > 950 && i < 999 ? NaN :
        132 + .7 * Math.sin(.113 * i) - .4 * Math.cos(.299 * i) + .11 * (-1) ** i);
    for (const basis of ['morse', 'morlet', 'mexicanHat']) for (const frequencyScale of ['log', 'linear']) {
        for (const time of [{ timeColumns: 47 }, { timeColumns: 997 }, { timeStride: 8 }]) {
            const options = { values, rate: 1000, basis, frequencyScale, visibleLength: 1400, visibleStart: 54,
                cuts: [400], removeDc: true, frequencyRows: 12, ...time };
            const expected = dense(options), actual = pruned(options);
            expected.step(Infinity); actual.step(Infinity);
            for (const field of ['magnitude', 'phase', 'reference'])
                assert.deepEqual(actual.result()[field], expected.result()[field]);
        }
    }
    assert.ok(projected > 0 && repeated > 0, 'exercise output pruning and sparse-input stages');
});

test('row partitions preserve the complete filter grid, edge support and block statistics', () => {
    const values = Float64Array.from({ length: 1220 }, (_, i) => i >= 135 && i <= 900 ? NaN :
        .3 * Math.sin(i / 7) + .8 * Math.cos(i * .75));
    const options = { values, rate: 1000, basis: 'morse', cuts: [975], visibleStart: 10, visibleLength: 1200,
        removeDc: true, frequencyRows: 1025, timeColumns: 1101 };
    const calculate = range => {
        const job = createWaveletProcessor(options, range);
        job.step(Infinity);
        return job.result();
    };
    const all = calculate();
    for (const [start, end] of [[0, 3], [599, 605], [1024, 1025]]) {
        const part = calculate({ rowStart: start, rowEnd: end });
        assert.deepEqual([part.rowStart, part.fullRows, part.blockWidth], [start, 1025, 128]);
        assert.deepEqual(part.frequencies, all.frequencies.subarray(start, end));
        assert.deepEqual(part.runs, all.runs);
        assert.deepEqual(part.positions, all.positions);
        for (const field of ['magnitude', 'phase', 'reference', 'blockMin', 'blockMax']) {
            const width = all[field].length / all.frequencies.length;
            assert.deepEqual(part[field], all[field].subarray(start * width, end * width));
        }
    }
});

test('repeated same-grid worker jobs reuse response weights while transforming each new signal', () => {
    let exponentials = 0;
    const math = Object.create(Math);
    math.exp = value => { exponentials++; return Math.exp(value); };
    const create = new Function('Math', 'fftInPlace', 'nextPow2', 'return ' + createWaveletSource())(math, fftInPlace, nextPow2);
    const options = { rate: 1000, basis: 'morse', frequencyRows: 12, timeColumns: 51 };
    const calculate = scale => {
        const values = Float64Array.from({ length: 200 }, (_, i) => scale * Math.cos(i / 4));
        exponentials = 0;
        const processor = create({ ...options, values });
        processor.step(Infinity);
        return { work: exponentials, output: processor.result() };
    };
    const cold = calculate(1), warm = calculate(2);
    assert.ok(cold.work > warm.work * 3);
    assert.equal(warm.output.peak, cold.output.peak * 2);
    assert.deepEqual(warm.output.phase, cold.output.phase);
});

test('frequency and time sliders use the one-sided FFT bin count and sample-aligned strides', () => {
    assert.equal(waveletMaxFrequencyRows(5000), 4097);
    assert.equal(waveletMaxFrequencyRows(4096), 2049);
    assert.equal(waveletMaxFrequencyRows(65536), 32769);
    assert.deepEqual(waveletTimeStrides(8), [4, 2, 1]);
    assert.deepEqual(waveletTimeStrides(9), [8, 4, 2, 1]);
    assert.deepEqual(waveletTimeStrides(1), [1]);
});

test('each vertical scale selects the matching wavelet filter centers, including on a worker row partition', () => {
    const options = { rate: 1024, basis: 'morse', frequencyRows: 9, timeColumns: 3 };
    const minHz = 2.2 * 2.2, maxHz = 511, midHz = (minHz + maxHz) / 2;
    const values = Float64Array.from({ length: 1024 }, (_, i) => Math.cos(2 * Math.PI * midHz * (i - 512) / 1024 + .37));
    const workerCreate = new Function('fftInPlace', 'nextPow2', 'return ' + createWaveletSource())(fftInPlace, nextPow2);
    const evaluate = (frequencyScale, create = createWaveletProcessor, range) => {
        const job = create({ ...options, values, frequencyScale }, range);
        job.step(Infinity);
        return job.result();
    };
    const linear = evaluate('linear'), log = evaluate('log');
    assert.equal(linear.frequencyScale, 'linear');
    assert.equal(log.frequencyScale, 'log');
    const legacy = evaluate();
    assert.equal(legacy.frequencyScale, 'log');
    assert.deepEqual(legacy.frequencies, log.frequencies);
    for (let row = 0; row < 9; row++) {
        assert.ok(Math.abs(linear.frequencies[row] - (minHz + row / 8 * (maxHz - minHz))) < 1e-12);
        assert.ok(Math.abs(log.frequencies[row] - minHz * (maxHz / minHz) ** (row / 8)) < 1e-12);
    }
    const center = 4 * linear.columns + 1;
    assert.ok(Math.abs(linear.magnitude[center] - 1) < 1e-4);
    assert.ok(Math.abs(linear.phase[center] - .37) < 1e-4);
    assert.ok(log.magnitude[center] < 1e-4);
    const slice = evaluate('linear', workerCreate, { rowStart: 3, rowEnd: 6 });
    assert.equal(slice.frequencyScale, 'linear');
    assert.deepEqual(slice.frequencies, linear.frequencies.subarray(3, 6));
    assert.deepEqual(slice.magnitude, linear.magnitude.subarray(3 * linear.columns, 6 * linear.columns));
    assert.deepEqual(evaluate('linear').magnitude, linear.magnitude);
    assert.throws(() => evaluate('unsupported'), /纵轴刻度/);
});

test('all frequency rows have distinct scale centers below Nyquist at automatic and manual resolutions', () => {
    for (const basis of ['morse', 'morlet', 'mexicanHat']) {
        const auto = processor(5000, { basis }).result();
        assert.equal(auto.frequencies.length, 96);
        assert.equal(auto.frequencies.at(-1), 499.8);
        for (const rows of [2, 3, 9, 4097]) {
            const result = processor(5000, { basis, frequencyRows: rows, first: 2000, last: 2015 }).result();
            assert.equal(result.frequencies.length, rows);
            assert.equal(result.frequencies[0], auto.frequencies[0]);
            assert.equal(result.frequencies.at(-1), 499.8);
            assert.ok(result.frequencies.slice(1).every((hz, index) => hz > result.frequencies[index]));
        }
    }
    // With a partially filled buffer, the stored setting is capped by the available FFT bins.
    assert.equal(processor(20, { frequencyRows: 4097 }).result().frequencies.length, 17);
    assert.equal(processor(16, { basis: 'mexicanHat' }).result().frequencies.length, 9);
});

test('arbitrary integer time strides sample the same coefficients and preserve missing input samples', () => {
    const values = Float64Array.from({ length: 336 }, (_, i) => i >= 140 && i < 173
        ? NaN : Math.cos(i * .3) + .5 * Math.sin(i * 1.7));
    const options = { values, cuts: [269], frequencyRows: 10, first: 21, last: 315 };
    const dense = processor(values.length, { ...options, first: 0, last: values.length - 1, timeStride: 1 });
    dense.step(Infinity);
    for (const stride of [3, 6, 7]) {
        const sparse = processor(values.length, { ...options, timeStride: stride });
        sparse.step(Infinity);
        const result = sparse.result(), all = dense.result();
        assert.equal(result.hop, stride);
        assert.equal(result.first, Math.floor(21 / stride) * stride);
        assert.equal(result.columns, Math.floor((315 - result.first) / stride) + 1);
        for (let column = 0; column < result.columns; column++) {
            const sample = result.first + column * stride;
            const row = 7, expected = all.magnitude[row * all.columns + sample];
            const index = row * result.columns + column;
            if (Number.isFinite(expected)) {
                assert.ok(Math.abs(result.magnitude[index] - expected) < 1e-8);
                assert.ok(Math.abs(result.phase[index] - all.phase[row * all.columns + sample]) < 1e-7);
            } else {
                assert.ok(Number.isNaN(result.magnitude[index]));
            }
            assert.equal(result.reference[index], all.reference[row * all.columns + sample]);
        }
    }
});

test('manual time resolution computes the requested centers using all input samples', () => {
    const settings = { frequencyRows: 13, minimumHop: 64, columnLimit: 32 };
    const dense = processor(256, { ...settings, timeStride: 1 });
    const coarse = processor(256, { ...settings, timeStride: 8 });
    dense.step(Infinity); coarse.step(Infinity);
    const a = dense.result(), b = coarse.result();
    assert.deepEqual([a.columns, a.hop, b.columns, b.hop], [256, 1, 32, 8]);
    const magnitudes = a.magnitude.filter(Number.isFinite);
    assert.equal(a.minMagnitude, Math.min(...magnitudes));
    const row = 9;
    for (let i = 4; i < 24; i++) {
        assert.ok(Math.abs(a.magnitude[row * 256 + i * 8] - b.magnitude[row * 32 + i]) < 1e-11);
    }
});

test('column count selects exactly K sample centers over the whole window, including during zoom', () => {
    const base = { rate: 1000, basis: 'morse', visibleLength: 20 };
    const result = (count, options) => waveletResolutionGrid({ ...base, timeColumns: count, ...options });
    const full = result(7);
    assert.deepEqual(Array.from(full.positions), [0, 3, 6, 10, 13, 16, 19]);
    assert.equal(full.fullColumns, 7);
    assert.equal(full.hop, 19 / 6);
    const cropped = result(7, { first: 7, last: 14 });
    assert.deepEqual(Array.from(cropped.positions), [6, 10, 13, 16]);
    assert.equal(cropped.columns, 4);
    assert.equal(cropped.fullColumns, 7);
    assert.equal(waveletColumnSample(cropped, 2), 13);
    assert.deepEqual(Array.from(result(7, { first: 3, last: 6 }).positions), [3, 6]);
    assert.deepEqual(Array.from(result(7, { first: 4, last: 5 }).positions), [3, 6]);
    assert.deepEqual(Array.from(result(1).positions), [10]);
    assert.deepEqual(Array.from(result(2).positions), [0, 19]);
    assert.deepEqual(Array.from(result(40).positions), Array.from({ length: 20 }, (_, i) => i));
    const legacy = result(0, { timeStride: 4, first: 5, last: 15 });
    assert.equal(waveletColumnSample(legacy, 1), 8);
    assert.equal(legacy.fullColumns, 5);
});

test('irregular and regular column grids match the dense coefficients, references and native gaps', () => {
    const values = Float64Array.from({ length: 300 }, (_, i) => i >= 126 && i < 159 ? NaN : Math.cos(.5 * i));
    const options = { values, visibleStart: 8, visibleLength: 265, cuts: [215], frequencyRows: 17 };
    const analyze = resolution => {
        const job = processor(300, { ...options, ...resolution });
        job.step(Infinity);
        return job.result();
    };
    const dense = analyze({ timeStride: 1 });
    for (const columns of [1, 2, 34, 67, 64, 265]) {
        const full = analyze({ timeColumns: columns });
        const crop = analyze({ timeColumns: columns, first: 40, last: 190 });
        assert.equal(full.columns, columns);
        for (const result of [full, crop]) {
            for (let row = 0; row < result.frequencies.length; row++) {
                result.positions.forEach((sample, column) => {
                    const idx = row * result.columns + column, expected = row * dense.columns + sample;
                    if (Number.isNaN(dense.magnitude[expected])) assert.ok(Number.isNaN(result.magnitude[idx]));
                    else assert.ok(Math.abs(result.magnitude[idx] - dense.magnitude[expected]) < 1e-9);
                    assert.equal(result.reference[idx], dense.reference[expected]);
                    if (dense.magnitude[expected] > 1e-6) {
                        const delta = result.phase[idx] - dense.phase[expected];
                        assert.ok(Math.abs(Math.atan2(Math.sin(delta), Math.cos(delta))) < 1e-7);
                    }
                });
            }
        }
    }
});

test('high-resolution estimates match typed-array storage before allocation, including cropped grids', () => {
    const options = { basis: 'morse', rate: 1000, timeStride: 1, frequencyRows: 4097 };
    const typical = waveletResolutionGrid({ ...options, visibleLength: 5000 });
    const blockBytes = 4097 * Math.ceil(5000 / 128) * 16;
    assert.deepEqual([typical.rows, typical.columns, typical.bytes], [4097, 5000, 4097 * 5000 * 17 + blockBytes]);
    assert.ok(typical.bytes <= maxWaveletGridBytes);
    const maximum = { ...options, frequencyRows: 32769 };
    assert.throws(() => processor(65536, maximum), /384 MiB/);
    const crop = processor(65536, { ...maximum, first: 7000, last: 7003 }).result();
    assert.deepEqual([crop.first, crop.columns, crop.frequencies.length], [7000, 4, 32769]);
    assert.equal(crop.magnitude.byteLength + crop.phase.byteLength + crop.reference.byteLength, 32769 * 4 * 17);
});

test('large grids index exact magnitude extrema in each time block, including runs with gaps', () => {
    const values = Float64Array.from({ length: 1800 }, (_, i) => i < 90 || i > 1500 ? Math.sin(i / 10) : NaN);
    const job = processor(1800, { values, frequencyRows: 612, timeStride: 1 });
    job.step(Infinity);
    const { columns, frequencies, magnitude, blockWidth, blockMin, blockMax } = job.result();
    assert.equal(blockWidth, 128);
    const blocks = Math.ceil(columns / blockWidth);
    assert.equal(blockMin.length, frequencies.length * blocks);
    for (const row of [0, 300, frequencies.length - 1]) {
        for (let block = 0; block < blocks; block++) {
            const start = block * blockWidth;
            const samples = magnitude.subarray(row * columns + start,
                row * columns + Math.min(start + blockWidth, columns)).filter(Number.isFinite);
            assert.equal(blockMin[row * blocks + block], Math.min(...samples));
            assert.equal(blockMax[row * blocks + block], Math.max(...samples));
        }
    }
});
