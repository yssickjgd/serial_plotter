const test = require('node:test');
const assert = require('node:assert/strict');
const { AnalysisSettings: { normalize, equalEdges, spectrumSegmentSize } } = require('../analysisSettings');
const { bootArrayApplication } = require('./helpers/widgetAppHarness');

test('wavelet families and compatible coefficient views persist in workspace settings', () => {
    const complex = ['morlet', 'morse', 'shannon'];
    const real = ['mexicanHat', 'haar', 'gaus1', 'db4', 'sym4', 'coif2', 'meyer'];
    for (const basis of [...real, ...complex]) {
        const modes = complex.includes(basis) ? ['magnitude', 'phase'] : ['magnitude', 'signed'];
        for (const viewMode of modes) {
            const settings = normalize('wavelet', { basis, viewMode, channel: 2 });
            assert.equal(settings.viewMode, viewMode, basis);
            assert.deepEqual(normalize('wavelet', JSON.parse(JSON.stringify(settings))), settings);
        }
        const unsupported = complex.includes(basis) ? 'signed' : 'phase';
        assert.equal(normalize('wavelet', { basis, viewMode: unsupported }).viewMode, 'magnitude');
    }
    assert.deepEqual([normalize('wavelet').basis, normalize('wavelet').viewMode], ['morlet', 'magnitude']);
    assert.throws(() => normalize('wavelet', { basis: 'invalid' }), /小波基/);
});

test('importing a workspace retains the signed wavelet, channel binding and independent display for each widget', t => {
    const f = bootArrayApplication(); t.after(() => f.app.dispose());
    const signed = f.app.widgets.create({ type: 'wavelet', settings: { basis: 'coif2', channel: 1, viewMode: 'signed' } });
    const phase = f.app.widgets.create({ type: 'wavelet', settings: { basis: 'shannon', channel: 0, viewMode: 'phase' } });
    f.app.applyConfig(JSON.parse(JSON.stringify(f.app.getConfig())));
    for (const [widget, basis, channel, mode] of [[signed, 'coif2', 1, 'signed'], [phase, 'shannon', 0, 'phase']]) {
        const restored = f.app.widgets.widgets.get(widget.id).settings;
        assert.deepEqual([restored.basis, restored.channel, restored.viewMode], [basis, channel, mode]);
    }
});

test('wavelet resolution sliders preview without computing, follow the analysed window and persist per widget', t => {
    const f = bootArrayApplication(); t.after(() => f.app.dispose());
    const widget = f.app.widgets.create({ type: 'wavelet' });
    const other = f.app.widgets.create({ type: 'wavelet' });
    f.app.widgets.activate(widget.id);
    const time = f.get('wavelet-timeColumns'), rows = f.get('wavelet-frequencyRows');
    assert.equal(time.closest('.control-group').querySelector('.section-title').textContent, '小波设置');
    assert.equal(rows.closest('.control-group'), time.closest('.control-group'));
    const setWindow = (count, rate) => {
        const info = { count, rate };
        widget.view.wavelet.resolutionInfo = info;
        widget.view.onWaveletResolutionInfo(info);
    };
    setWindow(5000, 1000);
    assert.equal(f.get('wavelet-timeColumns'), time);
    assert.equal(Number(time.max), 5000);
    const rowLimit = f.S.waveletMaxFrequencyRows(5000);
    assert.equal(Number(rows.max), rowLimit);
    const cwt = widget.view.wavelet;
    const oldSnapshot = cwt.snapshot;
    cwt.snapshot = { resolutionKey: cwt.resolutionKey, rate: 1000,
        result: { frequencies: new Float64Array(97), fullColumns: 625, columns: 23 } };
    widget.view.onWaveletResolutionInfo(cwt.resolutionInfo);
    assert.match(f.get(rows.id + '-value').textContent, /当前 97 行/);
    assert.match(f.get(time.id + '-value').textContent, /625 列/);
    cwt.snapshot = oldSnapshot;
    time.value = '1200';
    time.dispatchEvent({ type: 'input' });
    assert.equal(f.get(time.id + '-number').value, '1200');
    assert.match(f.get(time.id + '-value').textContent, /1200 列/);
    assert.equal(widget.settings.timeColumns, 0);
    setWindow(64, 400);
    time.dispatchEvent({ type: 'change' });
    assert.equal(widget.settings.timeColumns, 1200);
    setWindow(5000, 1000);
    f.change(rows.id, String(rowLimit));
    assert.equal(widget.settings.frequencyRows, rowLimit);
    setWindow(1024, 400);
    assert.equal(Number(f.get(rows.id).max), f.S.waveletMaxFrequencyRows(1024));
    assert.equal(f.get(time.id + '-number').value, '1024');
    assert.equal(widget.settings.timeColumns, 1200);
    assert.equal(widget.settings.frequencyRows, rowLimit);
    f.app.applyConfig(JSON.parse(JSON.stringify(f.app.getConfig())));
    const restored = f.app.widgets.widgets.get(widget.id).settings;
    assert.equal(restored.timeColumns, 1200);
    assert.equal(restored.frequencyRows, rowLimit);
    assert.equal(f.app.widgets.widgets.get(other.id).settings.frequencyRows, 0);
    assert.equal(f.app.widgets.widgets.get(other.id).settings.timeColumns, 0);
    assert.equal(normalize('wavelet', { timeStride: 3 }).timeStride, 3);
    for (const invalid of [{ timeStride: 1.5 }, { timeStride: -1 }, { timeStride: 32769 }, { timeColumns: 65537 },
        { timeColumns: -1 }, { timeColumns: 0.5 }, { frequencyRows: 1 }, { frequencyRows: 32770 }])
        assert.throws(() => normalize('wavelet', invalid));
});

test('wavelet frequency scale and mean removal use the selected widget settings across a workspace round trip', t => {
    const f = bootArrayApplication(); t.after(() => f.app.dispose());
    const widget = f.app.widgets.create({ type: 'wavelet' });
    f.app.widgets.activate(widget.id);
    const sectionTitles = () => Array.from(f.get('tab-analysis-display').querySelectorAll('.section-title'),
        title => title.textContent);
    const expectedSections = ['显示内容', '采样窗口', '横轴设置', '纵轴设置', '小波设置'];
    assert.deepEqual(sectionTitles(), expectedSections);
    assert.equal(f.get('wavelet-frequencyScale').value, 'log');
    assert.deepEqual(Array.from(f.get('wavelet-frequencyScale').options, option => option.textContent), ['Hz-线性', 'Hz-对数']);
    assert.equal(f.get('wavelet-removeDc').checked, false);
    assert.equal(f.get('wavelet-edgeExtension').value, 'mirror');
    f.change('wavelet-frequencyScale', 'linear');
    f.change('wavelet-removeDc', true);
    f.change('wavelet-edgeExtension', 'hold');
    f.change('wavelet-viewMode', 'phase');
    assert.deepEqual(sectionTitles(), expectedSections);
    f.app.applyConfig(JSON.parse(JSON.stringify(f.app.getConfig())));
    const settings = f.app.widgets.widgets.get(widget.id).settings;
    assert.equal(settings.frequencyScale, 'linear');
    assert.equal(settings.removeDc, true);
    assert.equal(settings.edgeExtension, 'hold');
    assert.equal(settings.viewMode, 'phase');
    assert.equal(normalize('wavelet', { frequencyScale: 'log' }).frequencyScale, 'log');
    assert.equal(normalize('wavelet', { yAuto: false, yMin: 0, yMax: 500 }).frequencyScale, 'linear');
    assert.throws(() => normalize('wavelet', { removeDc: 'false' }), /Boolean 值/);
    assert.throws(() => normalize('wavelet', { edgeExtension: 'invalid' }), /时域延拓策略/);
});

test('analysis bindings distinguish missing and explicitly unbound channels', () => {
    assert.equal(normalize('xy').traceMode, 'both');
    assert.equal(normalize('xy').equalAspect, true);
    const explicit = normalize('xy', { traceMode: 'line', equalAspect: false });
    assert.equal(explicit.traceMode, 'line');
    assert.equal(explicit.equalAspect, false);
    assert.deepEqual(normalize('xy').pairs[0], { x: 0, y: 1, color: '#ff0000', visible: true });
    assert.deepEqual(normalize('xy', { pairs: [{}, {}, {}, {}, { color: '#123456' }] }).pairs.map(pair => pair.color),
        ['#ff0000', '#00ff00', '#00ffff', '#ff0000', '#123456']);
    assert.equal(normalize('xy', { pairs: [{ x: null, y: 65534 }] }).pairs[0].x, null);
    assert.equal(normalize('histogram', { channel: null }).channel, null);
    assert.throws(() => normalize('xy', { pairs: [{ x: -1 }] }));
    assert.throws(() => normalize('xy', { pairs: [{ color: 'bogus' }] }));
    assert.throws(() => normalize('xy', { xMin: 1, xMax: 1 }));
    assert.equal(normalize('xy', { engineSource: 'value' }).engineSource, undefined);
});

test('histogram settings migrate legacy boundary owners and infinity through JSON', () => {
    const settings = normalize('histogram', { mode: 'edges', edges: [-Infinity, 0, 1, Infinity],
        edgeSides: ['right', 'left', 'right', 'left'], count: 2, equalSides: ['left', 'right', 'right'] });
    assert.deepEqual(settings.edges, ['-Infinity', 0, 1, 'Infinity']);
    assert.deepEqual(normalize('histogram', JSON.parse(JSON.stringify(settings))), settings);
    assert.equal(settings.closure, 'leftClosed');
    assert.equal('edgeSides' in settings, false);
    assert.equal(normalize('histogram', { mode: 'edges', edges: ['-Infinity', 3, 'Infinity'], edgeSides: ['right', 'left', 'right'] }).closure, 'rightClosed');
    assert.equal(normalize('histogram', { count: 1, equalSides: ['left', 'left'] }).closure, 'rightClosed');
    for (const invalid of [{ edges: [0, 0] }, { edges: [0, Infinity, Infinity] }, { edges: [null, 1] },
        { count: 0 }, { values: [1, 1] }, { values: [] }, { edgeSides: ['left'] },
        { equalSides: null }, { min: 2, max: 1 }, { scale: 'auto' }, { closure: 'both' }, { yRange: 'bad' }])
        assert.throws(() => normalize('histogram', invalid), JSON.stringify(invalid));
});

test('XY spectrum settings default old workspaces to trajectory and preserve independent ranges through JSON', () => {
    const defaults = normalize('xy', { xAuto: false, xMin: -8, xMax: 8 });
    const spectralKeys = ['viewMode', 'freqXScale', 'phaseUnit', 'phaseUnwrap', 'phaseYAuto', 'phaseYMin', 'phaseYMax',
        'coherenceYAuto', 'coherenceYMin', 'coherenceYMax', 'fftOverlap', 'fftWindow', 'fftRemoveDc'];
    assert.deepEqual(spectralKeys.map(key => defaults[key]),
        ['trajectory', 'hz-log', 'radians', true, true, -Math.PI, Math.PI, false, 0, 1, 50, 'hann', true]);
    assert.equal(normalize('xy', { viewMode: 'gain', freqXScale: 'hz-linear' }).freqXScale, 'hz-linear');
    const custom = normalize('xy', { ...defaults, viewMode: 'coherence', freqXScale: 'bins-log', phaseUnit: 'radians',
        phaseUnwrap: true, phaseYAuto: true, phaseYMin: -5, phaseYMax: 2, coherenceYMin: -0.05, coherenceYMax: 1.05,
        fftSize: 8192, fftOverlap: 75, fftWindow: 'flatTop', fftRemoveDc: false });
    assert.deepEqual(spectralKeys.map(key => custom[key]),
        ['coherence', 'bins-log', 'radians', true, true, -5, 2, false, -0.05, 1.05, 75, 'flatTop', false]);
    assert.equal('fftSize' in custom, false);
    assert.equal(custom.xMin, -8);
    assert.deepEqual(normalize('xy', JSON.parse(JSON.stringify(custom))), custom);
    const saved = normalize('xy', { traceMode: 'line', phaseUnit: 'degrees', phaseUnwrap: false, phaseYAuto: false });
    assert.deepEqual([saved.traceMode, saved.phaseUnit, saved.phaseUnwrap, saved.phaseYAuto, saved.phaseYMin, saved.phaseYMax],
        ['line', 'degrees', false, false, -180, 180]);
});

test('XY settings reject invalid FFT parameters and spectrum axes before publishing', () => {
    for (const invalid of [{ viewMode: 'both' }, { freqXScale: 'log' }, { phaseUnit: 'hz' }, { phaseUnwrap: 'true' },
        { phaseYAuto: null }, { phaseYMin: 180 }, { phaseYMax: Infinity }, { coherenceYAuto: 1 },
        { coherenceYMin: 0.4, coherenceYMax: 0.3 }, { coherenceYMax: NaN },
        { fftOverlap: -1 }, { fftOverlap: 76 }, { fftOverlap: 20.5 }, { fftOverlap: '25' },
        { fftWindow: 'unknown' }, { fftRemoveDc: 0 }]) {
        assert.throws(() => normalize('xy', invalid), JSON.stringify(invalid));
    }
    assert.equal(normalize('xy', { fftOverlap: 0, fftWindow: 'rectangular' }).fftOverlap, 0);
    assert.equal(normalize('xy', { fftOverlap: 37 }).fftOverlap, 37);
});

test('XY derives a stable power-of-two segment length from window samples and overlap', () => {
    assert.equal(spectrumSegmentSize(5000, 50), 2048);
    assert.equal(spectrumSegmentSize(3071, 50), 1024);
    assert.equal(spectrumSegmentSize(3072, 50), 2048);
    assert.equal(spectrumSegmentSize(3072, 0), 1024);
    assert.equal(spectrumSegmentSize(65536, 75), 32768);
});
test('equal edges span opposite extremes without overflow and reject collapsed interior bins', () => {
    assert.deepEqual(equalEdges(-Number.MAX_VALUE, Number.MAX_VALUE, 2), [-Number.MAX_VALUE, 0, Number.MAX_VALUE]);
    assert.throws(() => equalEdges(1, 1 + Number.EPSILON, 2));
});
