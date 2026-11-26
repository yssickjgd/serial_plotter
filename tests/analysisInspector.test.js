const test = require('node:test');
const assert = require('node:assert/strict');
const { bootArrayApplication } = require('./helpers/widgetAppHarness');
const { AnalysisSettings: { normalize } } = require('../analysisSettings');

function inspector(t, type, settings, channels = [], options = {}) {
    const f = bootArrayApplication(); t.after(() => f.app.dispose());
    const { render, clear } = f.S.AnalysisInspector;
    const { document } = f, display = document.createElement('div'), bindings = document.createElement('div');
    document.body.append(display, bindings);
    const widget = { id: 'subject', type, settings: normalize(type, settings) };
    const redraw = () => render(document, widget, display, bindings, channels, next => {
        widget.settings = next; redraw();
    }, options);
    redraw();
    const get = name => display.querySelector('#' + name) ?? bindings.querySelector('#' + name);
    function change(name, value) {
        const input = get(name); input.value = value; input.dispatchEvent({ type: 'change' });
    }
    return { document, display, bindings, widget, redraw, get, change, clear: () => clear(display) };
}

test('XY inspector searches high channel numbers, edits one pair and retains focused filter', t => {
    const channels = Array.from({ length: 8000 }, (_, index) => ({ index, name: index === 7999 ? '电机温度' : '输入' }));
    const f = inspector(t, 'xy', {}, channels);
    f.get('xy-add-pair').click();
    for (const axis of ['x', 'y']) {
        const id = 'xy-1-' + axis, picker = f.get(id), filter = f.get(id + '-search');
        const trigger = f.get(id + '-toggle'), popup = f.get(id + '-options');
        assert.equal(picker.hidden, true);
        assert.equal(popup.hidden, true);
        assert.ok(popup.contains(filter));
        assert.equal(picker.parentElement.querySelector('label').getAttribute('for'), trigger.id);
        assert.equal(trigger.getAttribute('aria-controls'), popup.id);
    }
    f.get('xy-1-y-toggle').click();
    const search = f.get('xy-1-y-search'); search.value = '温度'; search.dispatchEvent({ type: 'input' });
    assert.ok(f.get('xy-1-y').options.some(option => option.value === '7999'));
    assert.ok(f.get('xy-1-x').querySelectorAll('option').length < 100);
    f.redraw();
    assert.equal(f.document.activeElement, f.get('xy-1-y-search'));
    assert.equal(f.get('xy-1-y-search').value, '温度');
    const menu = f.get('xy-1-y-options');
    assert.equal(menu.hidden, false);
    menu.querySelectorAll('input').find(input => input.type === 'radio' && input.value === '7999').click();
    assert.equal(f.get('xy-1-y-options').hidden, true);
    assert.equal(f.widget.settings.pairs[1].y, 7999);
    assert.equal(f.widget.settings.pairs[0].y, 1);
    f.get('xy-0-remove').click();
    assert.equal(f.widget.settings.pairs[0].y, 7999);
});

test('changing XY trajectory pages closes the old menu and preserves each field’s search separately', t => {
    const f = inspector(t, 'xy', { pairs: Array.from({ length: 5 }, () => ({})) });
    const oldMenu = f.get('xy-0-x-options');
    f.get('xy-0-x-toggle').click();
    const search = f.get('xy-0-x-search'); search.value = '电流'; search.dispatchEvent({ type: 'input' });
    f.change('xy-pairs-page', '1');
    assert.equal(oldMenu.hidden, true);
    assert.equal(f.get('xy-0-x'), null);
    assert.equal(f.get('xy-4-x-search').value, '');
    f.change('xy-pairs-page', '0');
    assert.equal(f.get('xy-0-x-options').hidden, true);
    assert.equal(f.get('xy-0-x-search').value, '电流');
});

test('switching nearest ties recounts retained samples and survives workspace import', t => {
    const f = bootArrayApplication(); t.after(() => f.app.dispose());
    const h = f.app.widgets.create({ type: 'histogram', settings: { values: [0, 10], match: 'nearest' } });
    h.source.frames.append([5]); h.view.renderNow();
    assert.deepEqual(Array.from(h.view.histogram.counts), [1, 0]);
    f.change('histogram-tieBreak', 'higher'); h.view.renderNow();
    assert.deepEqual(Array.from(h.view.histogram.counts), [0, 1]);
    f.change('histogram-match', 'exact');
    assert.equal(f.get('tab-analysis-display').querySelector('#histogram-tieBreak'), null);
    f.change('histogram-match', 'nearest');
    f.app.applyConfig(JSON.parse(JSON.stringify(f.app.getConfig())));
    assert.equal(f.app.widgets.widgets.get(h.id).settings.tieBreak, 'higher');
});

test('histogram intervals share one closure and leave invalid edits unpublished', t => {
    const f = inspector(t, 'histogram', { mode: 'equal', count: 3 });
    assert.equal(f.get('histogram-closure').value, 'leftClosed');
    f.change('histogram-closure', 'rightClosed');
    f.change('histogram-mode', 'edges');
    assert.equal(f.get('histogram-closure').value, 'rightClosed');
    f.change('histogram-edges', '-∞, 0, 2, +∞');
    f.change('histogram-edges', '0, 0');
    assert.deepEqual(Array.from(f.widget.settings.edges), ['-Infinity', 0, 2, 'Infinity']);
    assert.ok(f.display.querySelector('[role="alert"]').textContent);
    f.change('histogram-mode', 'equal');
    assert.equal(f.widget.settings.closure, 'rightClosed');
    f.change('histogram-count', '5000');
    assert.ok(f.display.querySelectorAll('select').length < 25);
});

test('manual axes and the global window use separate settings callbacks', t => {
    let window = 300;
    const f = inspector(t, 'xy', { xAuto: false }, [], { windowPoints: window, setWindowPoints(value) { window = value; } });
    f.change('xy-xMin', '10');
    assert.equal(f.widget.settings.xMin, -1);
    assert.ok(f.display.querySelector('[role="alert"]').textContent);
    f.change('xy-xMin', '-4');
    assert.equal(f.widget.settings.xMin, -4);
    f.change('xy-window', '1024');
    assert.equal(window, 1024);
    assert.equal(f.widget.settings.windowPoints, undefined);
});

test('XY inspector switches axis panels while retaining channel bindings and FFT settings', t => {
    const f = inspector(t, 'xy', { pairs: [{ x: 3, y: 7 }] }, [], { windowPoints: 5000, setWindowPoints() {} });
    const sections = () => f.display.querySelectorAll('.section-title').slice(0, 2).map(title => title.textContent);
    assert.deepEqual(sections(), ['显示内容', '采样窗口']);
    const mode = f.get('xy-viewMode');
    assert.ok(mode);
    assert.deepEqual(mode.options.map(option => option.textContent), ['李萨如图', '相位差频谱图', '相干度频谱图']);
    assert.equal(mode.value, 'trajectory');
    assert.ok(f.get('xy-equalAspect'));
    const choices = select => Array.from(select.options, option => [option.value, option.textContent]);
    const reference = id => choices(f.document.getElementById(id));
    assert.equal(f.get('xy-yAuto').tagName, 'SELECT');
    assert.deepEqual(choices(f.get('xy-yAuto')), reference('plot-y-scale-mode'));
    f.change('xy-xAuto', 'manual');
    assert.equal(f.widget.settings.xAuto, false);
    assert.ok(f.get('xy-xMin').parentElement.parentElement === f.get('xy-xMax').parentElement.parentElement);
    assert.equal(f.get('xy-xMin').parentElement.parentElement.className, 'row');
    const pairs = f.get('xy-0-y-toggle');
    f.change('xy-viewMode', 'phase');
    assert.deepEqual(sections(), ['显示内容', '采样窗口']);
    assert.equal(f.get('xy-phaseUnit').value, 'radians');
    assert.equal(f.get('xy-traceMode').value, 'both');
    assert.equal(f.get('xy-phaseUnwrap').checked, true);
    assert.equal(f.get('xy-phaseYAuto').value, 'auto');
    assert.deepEqual(choices(f.get('xy-phaseYAuto')), reference('plot-y-scale-mode'));
    for (const [key, id] of [['freqXScale', 'plot-freq-x-scale'], ['phaseUnit', 'plot-phase-unit'],
        ['traceMode', 'plot-trace-mode'], ['fftWindow', 'plot-fft-window'],
        ['xPrecisionMode', 'plot-x-precision-mode'], ['yNumberNotation', 'plot-y-number-notation']])
        assert.deepEqual(choices(f.get('xy-' + key)), reference(id), key);
    assert.equal(f.get('xy-equalAspect'), null);
    assert.equal(f.get('xy-0-y-toggle'), pairs);
    f.change('xy-freqXScale', 'bins-log');
    f.change('xy-traceMode', 'points');
    assert.equal(f.get('xy-fftSize'), null);
    f.change('xy-fftOverlap', '25');
    f.change('xy-fftWindow', 'hamming');
    f.change('xy-viewMode', 'coherence');
    assert.deepEqual(sections(), ['显示内容', '采样窗口']);
    assert.equal(f.get('xy-phaseUnit'), null);
    assert.equal(f.get('xy-phaseUnwrap'), null);
    assert.equal(f.get('xy-freqXScale').value, 'bins-log');
    assert.equal(f.get('xy-fftWindow').value, 'hamming');
    assert.equal(f.get('xy-traceMode').value, 'points');
    assert.equal(f.widget.settings.fftOverlap, 25);
    assert.equal(f.widget.settings.pairs[0].y, 7);
    f.change('xy-viewMode', 'trajectory');
    assert.equal(f.get('xy-fftSize'), null);
    assert.ok(f.get('xy-equalAspect'));
});

test('XY overlap slider previews whole percentages and stays in sync with typed input', t => {
    const f = inspector(t, 'xy', { viewMode: 'phase' });
    const slider = () => f.get('xy-fftOverlap-slider'), number = () => f.get('xy-fftOverlap');
    assert.equal(slider().value, '50');
    slider().value = '37'; slider().dispatchEvent({ type: 'input' });
    assert.equal(number().value, '37');
    assert.equal(f.widget.settings.fftOverlap, 50);
    slider().dispatchEvent({ type: 'change' });
    assert.equal(f.widget.settings.fftOverlap, 37);
    number().value = '63'; number().dispatchEvent({ type: 'input' });
    assert.equal(slider().value, '63');
    number().dispatchEvent({ type: 'keydown', key: 'Enter' });
    assert.equal(f.widget.settings.fftOverlap, 63);
    f.change('xy-fftOverlap', '80');
    assert.equal(f.widget.settings.fftOverlap, 63);
    assert.match(f.display.querySelector('[role="alert"]').textContent, /0 至 75/);
});

test('XY spectral modes keep independent manual bounds and convert phase bounds on unit changes', t => {
    const f = inspector(t, 'xy', { viewMode: 'phase', phaseUnit: 'degrees', phaseYAuto: false, phaseYMin: 45, phaseYMax: 180 });
    assert.equal(f.get('xy-phaseYMin')?.value, '45');
    f.change('xy-phaseUnit', 'radians');
    assert.equal(f.widget.settings.phaseYMin, Math.PI / 4);
    assert.equal(f.widget.settings.phaseYMax, Math.PI);
    f.change('xy-phaseYAuto', 'auto');
    assert.equal(f.get('xy-phaseYMin'), null);
    f.change('xy-viewMode', 'coherence');
    assert.equal(f.get('xy-coherenceYAuto').value, 'manual');
    f.change('xy-coherenceYMin', '0.25');
    f.change('xy-coherenceYMax', '0.8');
    f.change('xy-viewMode', 'phase');
    f.change('xy-phaseUnit', 'degrees');
    assert.equal(f.widget.settings.phaseYMin, 45);
    assert.equal(f.widget.settings.phaseYMax, 180);
    assert.deepEqual([f.widget.settings.coherenceYMin, f.widget.settings.coherenceYMax], [0.25, 0.8]);
});

test('histogram uses the waveform Y dropdown and remembers editable bounds for each unit', t => {
    const f = inspector(t, 'histogram', { scale: 'percent' }, [], { windowPoints: 5000 });
    const choices = select => Array.from(select.options, option => [option.value, option.textContent]);
    assert.deepEqual(choices(f.get('histogram-yRange')), choices(f.document.getElementById('plot-y-scale-mode')));
    assert.equal(f.get('histogram-yRange').value, 'auto');
    assert.equal(f.get('histogram-yMin'), null);
    f.change('histogram-yRange', 'manual');
    const bounds = () => [f.get('histogram-yMin').value, f.get('histogram-yMax').value];
    assert.deepEqual(bounds(), ['0', '100']);
    f.change('histogram-yMin', '12.5');
    f.change('histogram-yMax', '45');
    f.change('histogram-yMax', '10');
    assert.equal(f.widget.settings.yPercentMax, 45);
    assert.match(f.display.querySelector('[role="alert"]').textContent, /两个递增的有限数值/);
    f.change('histogram-scale', 'count');
    assert.deepEqual(bounds(), ['0', '5000']);
    f.change('histogram-yMax', '250');
    f.change('histogram-scale', 'percent');
    assert.deepEqual(bounds(), ['12.5', '45']);
    f.change('histogram-yRange', 'auto');
    assert.equal(f.get('histogram-yMin'), null);
    f.change('histogram-yRange', 'manual');
    assert.deepEqual(bounds(), ['12.5', '45']);
    f.change('histogram-scale', 'count');
    assert.deepEqual(bounds(), ['0', '250']);
    f.change('histogram-yMin', '300');
    assert.equal(f.widget.settings.yCountMin, 0);
    f.change('histogram-yMax', '450');
    assert.deepEqual(bounds(), ['300', '450']);
});

test('closing the shared inspector removes its controls and resets its temporary state', t => {
    const f = inspector(t, 'histogram', {});
    const filter = f.get('histogram-channel-search');
    const oldCountMode = f.get('histogram-scale');
    const oldMenu = f.get('histogram-channel-options');
    f.get('histogram-channel-toggle').click();
    filter.value = '电流'; filter.dispatchEvent({ type: 'input' });
    f.clear();
    assert.equal(oldMenu.hidden, true);
    assert.equal(f.display.children.length, 0);
    assert.equal(f.bindings.children.length, 0);
    f.clear();
    f.redraw();
    oldCountMode.value = 'percent';
    oldCountMode.dispatchEvent({ type: 'change' });
    assert.equal(f.widget.settings.scale, 'count');
    assert.equal(f.bindings.querySelector('[role="alert"]').textContent, '');
    assert.equal(f.get('histogram-channel-search').value, '');
});
