const test = require('node:test');
const assert = require('node:assert/strict');
const { bootApplication } = require('./helpers/widgetAppHarness');

test('phase units sit above unwrapping and remain independent per waveform through reload', t => {
    const f = bootApplication(); t.after(() => f.app.dispose());
    const wave = f.app.widgets.create({ type: 'wave', settings: { plotViewMode: 'phase' } });
    const unit = f.get('plot-phase-unit'), unwrap = f.get('plot-phase-unwrap');
    assert.ok(unit, 'phase unit selector exists');
    assert.equal(unit.value, 'radians');
    assert.equal(f.get('wrap-phase-unit').hidden, false);
    const vertical = f.get('plot-vertical-settings');
    assert.ok(vertical.children.indexOf(f.get('wrap-phase-unit')) < vertical.children.indexOf(f.get('wrap-phase-options')));
    assert.ok(!unwrap.parentElement.textContent.includes('°'));
    f.change('plot-phase-unit', 'radians');
    assert.equal(wave.view.phaseUnit, 'radians');
    const other = f.app.widgets.create({ type: 'wave' });
    assert.equal(other.settings.plotPhaseUnit, 'radians');
    assert.equal(f.get('wrap-phase-unit').hidden, true);
    f.app.widgets.activate(wave.id);
    const restored = bootApplication(f.app.getConfig()); t.after(() => restored.app.dispose());
    assert.equal(restored.app.widgets.widgets.get(wave.id).view.phaseUnit, 'radians');
    assert.throws(() => f.app.widgets.create({ type: 'wave', settings: { plotPhaseUnit: 'invalid' } }), /相位/);
});

test('phase unit changes convert manual bounds and both live and inactive response zooms', t => {
    const f = bootApplication(); t.after(() => f.app.dispose());
    const wave = f.app.widgets.create({ type: 'wave', settings: { plotViewMode: 'phase', plotPhaseUnit: 'degrees' } });
    wave.source.frames.append([1], Uint8Array.of(1), 't', 1);
    f.change('plot-y-scale-mode', 'manual');
    f.change('plot-y-min', '-90');
    f.change('plot-y-max', '270');
    wave.view._boxZoomY.phase = { min: -45, max: 90 };
    wave.view._zoomBaseY.phase = { min: -90, max: 270, yScale: 'linear' };
    wave.settings.responseViewport = JSON.parse(JSON.stringify(f.app.getConfig().widgets[0].settings.viewport));
    f.change('plot-phase-unit', 'radians');
    const close = (actual, expected) => assert.ok(Math.abs(Number(actual) - expected) < 1e-12, `${actual} versus ${expected}`);
    close(f.get('plot-y-min').value, -Math.PI / 2);
    close(f.get('plot-y-max').value, 3 * Math.PI / 2);
    close(wave.view._boxZoomY.phase.min, -Math.PI / 4);
    close(wave.view._zoomBaseY.phase.max, 3 * Math.PI / 2);
    close(wave.settings.responseViewport.phase.yZoom.max, Math.PI / 2);
    f.change('plot-content', 'response');
    close(wave.view._boxZoomY.phase.max, Math.PI / 2);
    f.change('plot-content', 'samples');
    close(wave.view._boxZoomY.phase.min, -Math.PI / 4);
    const restored = bootApplication(f.app.getConfig()); t.after(() => restored.app.dispose());
    close(restored.app.widgets.widgets.get(wave.id).settings.viewport.phase.yZoom.min, -Math.PI / 4);
    f.change('plot-phase-unit', 'degrees');
    close(wave.view._boxZoomY.phase.max, 90);
    close(wave.settings.plotYMinPhase, -90);
});

test('response time count stays independent through object switches capacity changes and reload', t => {
    const f = bootApplication(); t.after(() => f.app.dispose());
    const wave = f.app.widgets.create({ type: 'wave' });
    f.app.widgets.addChannel('constant');
    f.change('plot-window-points', '128');
    f.change('plot-content', 'response');
    assert.equal(f.get('plot-window-control').hidden, false);
    assert.equal(f.get('plot-window-points').value, '1000');
    assert.equal(wave.responseFrames.length, 1000);
    assert.equal(wave.view.plotWindowPoints, 1000);
    f.change('plot-window-points', '64');
    f.change('plot-content', 'samples');
    assert.equal(wave.view.plotWindowPoints, 128);
    assert.equal(f.get('plot-window-points').value, '128');
    f.change('plot-content', 'response');
    f.change('max-points', '32');
    assert.equal(wave.responseFrames.length, 64);
    assert.equal(f.get('plot-window-points').value, '64');
    assert.match(f.get('plot-window-label').textContent, /当前控件/);
    assert.equal(Object.hasOwn(wave.settings, 'plotResponsePoints'), false);
    const restored = bootApplication(f.app.getConfig()); t.after(() => restored.app.dispose());
    const saved = restored.app.widgets.widgets.get(wave.id);
    assert.equal(restored.app.getConfig().global.plotWindowPoints, '32');
    assert.equal(Object.hasOwn(saved.settings, 'plotWindowPoints'), false);
    assert.equal(saved.responseFrames.length, 64);
    assert.equal(saved.settings.plotResponseTimePoints, '64');
    assert.equal(Object.hasOwn(saved.settings, 'plotResponsePoints'), false);
});

test('switching response spectral modes or changing their grid preserves the independent time zoom', t => {
    const f = bootApplication(); t.after(() => f.app.dispose());
    const wave = f.app.widgets.create({ type: 'wave', settings: { plotContent: 'response', plotResponseTimePoints: '128' } });
    f.app.widgets.addChannel('constant');
    wave.view.vp.time.displayCount = 32;
    f.change('plot-view-mode', 'frequency');
    assert.equal(wave.view.vp.time.displayCount, 32);
    f.change('plot-window-points', '64');
    assert.equal(wave.responseFrames.gridSize, 64);
    assert.equal(wave.view.vp.time.displayCount, 32);
    f.change('plot-view-mode', 'time');
    assert.equal(f.get('plot-window-points').value, '128');
    assert.equal(wave.view.vp.time.displayCount, 32);
});

test('sampled and response spectra share global count while response time remains per widget', t => {
    const f = bootApplication(); t.after(() => f.app.dispose());
    const first = f.app.widgets.create({ type: 'wave' });
    f.app.widgets.addChannel('constant');
    const second = f.app.widgets.create({ type: 'wave', settings: { plotContent: 'response', plotViewMode: 'frequency' } });
    f.change('plot-window-points', '128');
    assert.equal(first.view.plotWindowPoints, 128);
    assert.equal(second.view.plotWindowPoints, 1000);
    assert.equal(second.responseFrames.gridSize, 128);
    assert.equal(second.responseFrames.count, 1000);
    f.app.widgets.activate(first.id);
    assert.equal(f.get('plot-window-points').value, '128');
    f.change('plot-window-points', '64');
    assert.equal(second.responseFrames.gridSize, 64);
    const third = f.app.widgets.create({ type: 'wave' });
    assert.equal(third.view.plotWindowPoints, 64);
    f.change('max-points', '32');
    for (const widget of [first, third]) assert.equal(widget.view.plotWindowPoints, 32);
    assert.equal(second.responseFrames.gridSize, 32);
    const config = f.app.getConfig();
    assert.equal(config.global.plotWindowPoints, '32');
    assert.ok(config.widgets.every(widget => !Object.hasOwn(widget.settings, 'plotWindowPoints')));
    const restored = bootApplication(config); t.after(() => restored.app.dispose());
    for (const widget of restored.app.widgets.widgets.values())
        assert.equal(widget.view.plotWindowPoints, widget.id === second.id ? 1000 : 32);
    restored.app.widgets.activate(second.id);
    restored.change('plot-view-mode', 'time');
    restored.change('plot-window-points', '256');
    assert.equal(restored.app.getConfig().global.plotWindowPoints, '32');
    assert.equal(restored.app.widgets.widgets.get(second.id).responseFrames.count, 256);
    restored.change('plot-view-mode', 'phase');
    assert.equal(restored.get('plot-window-points').value, '32');
    assert.equal(restored.app.widgets.widgets.get(second.id).responseFrames.frequencyForChannel(1).fftSize, 32);
});

test('phase checkbox defaults to unwrapped and keeps each waveform choice through reload', t => {
    const f = bootApplication(); t.after(() => f.app.dispose());
    const wave = f.app.widgets.create({ type: 'wave', settings: { plotViewMode: 'phase' } });
    assert.equal(f.get('plot-phase-unwrap').type, 'checkbox');
    assert.equal(f.get('plot-phase-unwrap').checked, true);
    assert.equal(wave.view.phaseUnwrap, true);
    f.change('plot-phase-unwrap', false);
    assert.equal(wave.view.phaseUnwrap, false);
    assert.equal(wave.settings.plotPhaseUnwrap, false);
    const other = f.app.widgets.create({ type: 'wave', settings: { plotViewMode: 'phase', plotPhaseUnwrap: true } });
    f.app.widgets.activate(wave.id);
    assert.equal(f.get('plot-phase-unwrap').checked, false);
    f.app.widgets.activate(other.id);
    assert.equal(f.get('plot-phase-unwrap').checked, true);
    const restored = bootApplication(f.app.getConfig()); t.after(() => restored.app.dispose());
    restored.app.widgets.activate(wave.id);
    assert.equal(restored.get('plot-phase-unwrap').checked, false);
});

test('display setting groups hide inapplicable axes and FFT controls for each plotting object', t => {
    const f = bootApplication(); t.after(() => f.app.dispose());
    f.app.widgets.create({ type: 'wave' });
    assert.ok(f.get('plot-time-x-unit').closest('#plot-horizontal-settings'));
    assert.ok(f.get('plot-freq-y-scale').closest('#plot-vertical-settings'));
    assert.ok(f.get('plot-y-min').closest('#plot-vertical-settings'));
    assert.ok(f.get('plot-fft-window').closest('#plot-spectrum-settings'));
    assert.ok(f.get('plot-fft-remove-dc').closest('#plot-spectrum-settings'));
    assert.equal(f.get('plot-spectrum-settings').hidden, true);
    f.change('plot-view-mode', 'phase');
    assert.equal(f.get('plot-spectrum-settings').hidden, false);
    assert.equal(f.get('wrap-phase-options').hidden, false);
    f.change('plot-content', 'response');
    assert.equal(f.get('plot-spectrum-settings').hidden, true);
    assert.equal(f.get('plot-horizontal-settings').hidden, false);
    f.change('plot-view-mode', 'time');
    assert.equal(f.get('plot-horizontal-settings').hidden, true);
    f.change('plot-content', 'samples');
    assert.equal(f.get('plot-horizontal-settings').hidden, false);
});

test('one vertical scale choice drives magnitude conversion and amplitude spacing', t => {
    const f = bootApplication(); t.after(() => f.app.dispose());
    const wave = f.app.widgets.create({ type: 'wave', settings: {
        plotViewMode: 'frequency', plotMagnitudeUnit: 'amplitude', plotFreqYScale: 'log', channels: [{ visible: true }]
    } });
    assert.equal(f.get('plot-freq-y-scale').value, 'amplitude-log');
    assert.equal(f.get('plot-freq-y-scale').disabled, false);
    wave.source.frames.append([0.1], Uint8Array.of(1), 't', 1);
    for (const [unit, factor, expected] of [['db10', 10, -10], ['db20', 20, -20]]) {
        f.change('plot-freq-y-scale', unit);
        assert.equal(wave.view.magnitudeUnit, 'db');
        assert.equal(wave.view.dbFactor, factor);
        assert.equal(f.get('wrap-magnitude-scale').hidden, false);
        assert.equal(f.get('plot-freq-y-scale').value, unit);
        assert.equal(f.get('plot-freq-y-scale').disabled, false);
        assert.equal(wave.view._logY, false);
        const series = wave.view._collectWindowSeries(0, 1, new Map([[0, { mags: [0.1], phases: [0] }]]));
        assert.equal(series[0].mags[0], expected);
        assert.equal(wave.settings.plotFreqYScale, 'log');
    }
    f.change('plot-freq-y-scale', 'amplitude-linear');
    assert.equal(wave.view.magnitudeUnit, 'amplitude');
    assert.equal(f.get('plot-freq-y-scale').value, 'amplitude-linear');
    assert.equal(f.get('plot-freq-y-scale').disabled, false);
    assert.equal(wave.view._logY, false);
    f.change('plot-freq-y-scale', 'amplitude-log');
    assert.equal(wave.view._logY, true);
});

test('one horizontal scale choice updates unit and spacing together for amplitude and phase plots', t => {
    const f = bootApplication(); t.after(() => f.app.dispose());
    const wave = f.app.widgets.create({ type: 'wave', settings: {
        plotViewMode: 'frequency', plotFreqXUnit: 'bins', plotFreqXScale: 'log'
    } });
    assert.equal(f.get('plot-freq-x-scale').value, 'bins-log');
    for (const [choice, unit, scale] of [['bins-linear', 'bins', 'linear'], ['bins-log', 'bins', 'log'],
        ['hz-linear', 'hz', 'linear'], ['hz-log', 'hz', 'log']]) {
        f.change('plot-freq-x-scale', choice);
        assert.equal(wave.view.freqXUnit, unit);
        assert.equal(wave.view.freqXScale, scale);
        assert.equal(wave.settings.plotFreqXUnit, unit);
        assert.equal(wave.settings.plotFreqXScale, scale);
    }
    f.change('plot-view-mode', 'phase');
    assert.equal(f.get('plot-freq-x-scale').value, 'hz-log');
    f.change('plot-freq-x-scale', 'bins-linear');
    f.change('plot-view-mode', 'frequency');
    assert.equal(f.get('plot-freq-x-scale').value, 'bins-linear');
    const restored = bootApplication(f.app.getConfig()); t.after(() => restored.app.dispose());
    restored.app.widgets.activate(wave.id);
    assert.equal(restored.get('plot-freq-x-scale').value, 'bins-linear');
});

test('amplitude and dB bounds stay independent across unit changes and configuration reload', t => {
    const f = bootApplication(); t.after(() => f.app.dispose());
    const wave = f.app.widgets.create({ type: 'wave', settings: { plotViewMode: 'frequency', plotMagnitudeUnit: 'amplitude' } });
    f.change('plot-y-scale-mode', 'manual');
    f.change('plot-y-max', '3');
    f.change('plot-y-min', '0.2');
    f.change('plot-freq-y-scale', 'db10');
    f.change('plot-y-scale-mode', 'manual');
    f.change('plot-y-min', '-50');
    f.change('plot-y-max', '10');
    f.change('plot-freq-y-scale', 'amplitude-linear');
    assert.equal(f.get('plot-y-min').value, '0.2');
    assert.equal(f.get('plot-y-max').value, '3');
    f.change('plot-freq-y-scale', 'db20');
    assert.equal(f.get('plot-y-min').value, '-50');
    assert.equal(f.get('plot-y-max').value, '10');
    const restored = bootApplication(f.app.getConfig()); t.after(() => restored.app.dispose());
    restored.app.workspace.activate(wave.id);
    assert.equal(restored.get('plot-freq-y-scale').value, 'db20');
    assert.equal(restored.get('plot-freq-y-scale').disabled, false);
    assert.equal(restored.get('plot-y-min').value, '-50');
});

test('legacy dB coefficients and automatic defaults map to combined choices without changing phase settings', t => {
    const f = bootApplication(); t.after(() => f.app.dispose());
    const wave = f.app.widgets.create({ type: 'wave', settings: { plotViewMode: 'frequency', plotMagnitudeUnit: 'db', plotDbFactor: '10' } });
    assert.equal(f.get('plot-freq-y-scale').value, 'db10');
    const automatic = f.app.widgets.create({ type: 'wave', settings: { plotViewMode: 'frequency', plotContent: 'response', plotMagnitudeUnit: 'auto', plotDbFactor: '20' } });
    assert.equal(f.get('plot-freq-y-scale').value, 'db20');
    f.change('plot-content', 'samples');
    assert.equal(f.get('plot-freq-y-scale').value, 'amplitude-linear');
    f.change('plot-view-mode', 'phase');
    assert.equal(f.get('wrap-magnitude-scale').hidden, true);
    assert.equal(automatic.view.displayMode, 'phase');
    f.app.workspace.activate(wave.id);
    assert.equal(f.get('plot-freq-y-scale').value, 'db10');
});
