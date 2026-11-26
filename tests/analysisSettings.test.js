const test = require('node:test');
const assert = require('node:assert/strict');
const { AnalysisSettings: { normalize, equalEdges, spectrumSegmentSize } } = require('../analysisSettings');

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
        ['trajectory', 'hz-linear', 'radians', true, true, -Math.PI, Math.PI, false, 0, 1, 50, 'hann', true]);
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
