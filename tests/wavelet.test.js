const test = require('node:test');
const assert = require('node:assert/strict');
const { bootArrayApplication } = require('./helpers/widgetAppHarness');

function analyze(values, basis, cuts = [], rate = 1024) {
    const { createWaveletProcessor } = require('../wavelet');
    const processor = createWaveletProcessor({ values, rate, basis, cuts });
    while (!processor.step(4096)) { /* Exercise the sliced fallback. */ }
    return processor.result();
}

test('complex wavelets locate a tone and recover its phase against sample time', () => {
    const values = Float64Array.from({ length: 2048 }, (_, i) => Math.cos(Math.PI * i / 8 + .4));
    for (const basis of ['morlet', 'morse']) {
        const result = analyze(values, basis);
        const column = 1024 / result.hop;
        const magnitudes = Array.from(result.frequencies, (_, i) => result.magnitude[i * result.columns + column]);
        const row = magnitudes.indexOf(Math.max(...magnitudes.filter(Number.isFinite)));
        assert.ok(Math.abs(result.frequencies[row] - 64) < 5);
        assert.ok(Math.abs(magnitudes[row] - 1) < .04);
        assert.ok(Math.abs(result.phase[row * result.columns + column] - .4) < .01);
        assert.ok(result.frequencies.at(-1) <= 512);
    }
});

test('a 5000-point 1 kHz wavelet window resolves 400 Hz and 450 Hz tones', () => {
    for (const frequency of [400, 450]) {
        const values = Float64Array.from({ length: 5000 }, (_, i) => Math.cos(2 * Math.PI * frequency * i / 1000 + .4));
        for (const basis of ['morlet', 'morse', 'mexicanHat']) {
            const result = analyze(values, basis, [], 1000);
            const column = 2000 / result.hop;
            const magnitudes = Array.from(result.frequencies, (_, i) => result.magnitude[i * result.columns + column]);
            const row = magnitudes.indexOf(Math.max(...magnitudes.filter(Number.isFinite)));
            assert.ok(Math.abs(result.frequencies[row] - frequency) < 16, basis + ' ' + frequency);
            const expected = basis === 'mexicanHat' ? Math.cos(.4) : 1;
            assert.ok(Math.abs(magnitudes[row] - expected) < .06);
            if (result.phase) assert.ok(Math.abs(result.phase[row * result.columns + column] - .4) < .015);
        }
    }
});

test('the Nyquist row retains the alternating signal amplitude and leaves its phase blank', () => {
    const { waveletCell, waveletCsv } = require('../waveletPlot');
    const values = Float64Array.from({ length: 5000 }, (_, i) => i % 2 ? -.75 : .75);
    for (const basis of ['morlet', 'morse', 'mexicanHat']) {
        const result = analyze(values, basis, [], 1000);
        assert.equal(result.frequencies.at(-1), 500);
        const snapshot = { result, t0: 0, lastTime: 4.999, rate: 1000 };
        const cell = waveletCell(snapshot, 2, 500);
        assert.ok(Math.abs(cell.magnitude - .75) < .005, basis + ' ' + cell.magnitude);
        assert.ok(Number.isNaN(cell.phase));
        const csvRow = [...waveletCsv(snapshot)].at(-1).split('\r\n').find(line => line.startsWith('2,500,'));
        assert.equal(csvRow?.split(',')[3], '');
        if (result.phase) {
            const next = result.frequencies.at(-2);
            assert.ok(next >= 499 && next < 500);
            assert.ok(Number.isFinite(waveletCell(snapshot, 2, next).phase));
        }
    }
});

test('wavelets leave invalid data and discontinuities blank, with no phase for a real basis', () => {
    const values = Float64Array.from({ length: 1024 }, (_, i) => Math.cos(Math.PI * i / 4));
    values[320] = NaN;
    const real = analyze(values, 'mexicanHat', [640]);
    assert.equal(real.phase, null);
    const offset = (real.frequencies.length - 1) * real.columns;
    for (const index of [0, 320, 640]) assert.ok(Number.isNaN(real.magnitude[offset + index / real.hop]));
    assert.ok(Number.isFinite(real.magnitude[offset + 768 / real.hop]));
});

test('wavelet colors reach the brightest channel hue and wrap phase at both ends', () => {
    const { waveletPalette, waveletCell } = require('../waveletPlot');
    assert.deepEqual(waveletPalette('#800000', false).at(-1), [255, 0, 0]);
    assert.deepEqual(waveletPalette('#008040', false).at(-1), [0, 255, 128]);
    const palette = waveletPalette('#800000', true);
    assert.deepEqual(palette[7 * 64], [255, 0, 0]);
    const result = analyze(Float64Array.from({ length: 512 }, (_, i) => Math.cos(Math.PI * i / 8)), 'morlet');
    assert.equal(waveletCell({ result, t0: 0, lastTime: 511 / 1024, rate: 1024 }, -1, 64), null);
});

test('wavelet widget accepts one channel, switches phase, exports, and restores settings', async t => {
    const f = bootArrayApplication({ version: 3, global: { channelsCount: '2' }, dataEngine: { mode: 'Data_Array' },
        widgets: [], workspace: { step: 10, rects: {} }, nextNumber: 1 });
    t.after(() => f.app.dispose());
    assert.ok(f.document.querySelector('[data-add-widget="wavelet"]'));
    const widget = f.app.widgets.create({ type: 'wavelet', settings: { channel: 1 } });
    f.app.widgets.activate(widget.id);
    for (let i = 0; i < 1024; i++) {
        const samples = new Float64Array(widget.source.frames.rawChannelCount);
        samples[1] = 10 * Math.cos(Math.PI * i / 8);
        widget.source.frames.append(samples, undefined, '', i + 1, 2000 + i);
    }
    widget.source.sampleRate.rate = 1000;
    await f.tick();
    await f.tick();
    await f.tick();
    assert.ok(widget.view.wavelet.snapshot, JSON.stringify({ message: widget.view.wavelet.message, error: widget.view.wavelet.error,
        pending: Boolean(widget.view.wavelet.request), rate: widget.source.sampleRate.rate, frames: widget.source.frames.length,
        plotted: widget.view.frames.length, tasks: f.app.service.workerPool.jobs.size }));
    const coefficients = widget.view.wavelet.snapshot.result;
    f.change('wavelet-viewMode', 'phase');
    await f.tick();
    assert.equal(widget.settings.viewMode, 'phase');
    assert.equal(widget.view.wavelet.snapshot.result, coefficients);
    const view = widget.view, originalRange = [...view.range], a = view.area;
    assert.equal(originalRange[3], 500);
    const warning = view.svg.querySelector('[data-wavelet-nyquist-band]');
    assert.ok(warning);
    assert.ok(Number(warning.getAttribute('height')) > 0);
    view.svg.dispatchEvent({ type: 'wheel', clientX: a.left + a.width / 2, clientY: a.top + a.height / 2, deltaY: -120 });
    await f.tick();
    assert.ok(view.range[0] > originalRange[0] && view.range[1] < originalRange[1]);
    assert.deepEqual([...view.range.slice(2)], originalRange.slice(2));
    async function exportData() {
        let exported;
        const saving = f.app.exportWidgetData().then(result => { exported = result; });
        for (let i = 0; i < 1000 && exported === undefined; i++) await f.tick(0);
        assert.equal(exported, true, f.get('widget-export-source-status').textContent);
        await saving;
    }
    f.change('widget-export-format', 'svg');
    await exportData();
    const svg = await f.blobs.at(-1).text();
    assert.match(svg, /小波相位图/);
    assert.match(svg, /data-wavelet-tiles/);
    assert.match(svg, /data-wavelet-nyquist-band/);
    assert.doesNotMatch(svg, /<image\b/);
    f.change('widget-export-format', 'wavelet-csv');
    await exportData();
    const csv = await f.blobs.at(-1).text();
    assert.match(csv, /^time_s,frequency_hz,magnitude,phase_rad\r\n/);
    assert.ok(csv.split('\r\n').some(line => line.split(',')[3]?.match(/^-?\d/)));
    f.change('wavelet-basis', 'mexicanHat');
    assert.equal(widget.settings.viewMode, 'magnitude');
    assert.ok(f.get('wavelet-viewMode').options.find(option => option.value === 'phase').disabled);
    f.app.applyConfig(JSON.parse(JSON.stringify(f.app.getConfig())));
    assert.equal(f.app.widgets.widgets.get(widget.id).settings.channel, 1);
    assert.equal(f.app.widgets.widgets.get(widget.id).settings.basis, 'mexicanHat');
});
