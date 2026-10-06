const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function bootWithConfig(original, fixedDate) {
    const root = path.resolve(__dirname, '..');
    const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
    const scripts = [...html.matchAll(/<script src="([^"]+)"/g)].map(match => match[1]);
    const groups = [...html.matchAll(/<div class="choice-group" data-plot-choice="([^"]+)"[^>]*>([\s\S]*?)<\/div>/g)]
        .map(([, id, markup]) => ({ id, values: [...markup.matchAll(/<input type="radio"[^>]*value="([^"]+)"/g)]
            .map(match => match[1]) }));
    const defaults = {
        'conn-type': 'serial', 'channels-count': '1', 'max-points': '1000',
        'plot-window-points': '1000',
        'data-type': 'float32', endianness: 'little',
        'plot-view-mode': 'time', 'plot-y-scale-mode': 'auto',
        'plot-time-x-unit': 'samples', 'plot-freq-x-unit': 'hz',
        'plot-freq-x-scale': 'linear', 'plot-freq-y-scale': 'linear',
        'plot-fft-window': 'hann',
        'plot-y-min': '-1', 'plot-y-max': '1',
        'serial-baud': '115200', 'serial-data': '8', 'serial-stop': '1',
        'serial-parity': 'none', 'net-port': '9000', 'net-local': '9000',
        'frame-header': 'AB', 'frame-footer': '0D 0A',
        'monitor-display-mode': 'hex',
        'send-mode': 'hex', 'send-interval-unit': 's'
    };
    const elements = new Map();
    const makeElement = () => ({
        listeners: {},
        style: {}, dataset: {}, classList: { add() {}, remove() {}, replace() {} },
        textContent: '', innerHTML: '', value: '', checked: false,
        children: [],
        clientWidth: 800, clientHeight: 600, offsetWidth: 200, offsetHeight: 20,
        scrollHeight: 0, scrollTop: 0,
        addEventListener(name, callback) { this.listeners[name] = callback; },
        dispatchEvent(event) { this.listeners[event.type]?.(event); },
        append(...items) { this.children.push(...items); },
        appendChild(item) { this.children.push(item); },
        replaceChildren(...items) { this.children = items; },
        getBoundingClientRect() { return { width: 800, height: 600, left: 0 }; },
        getContext() { return new Proxy({}, { get: () => () => {} }); }
    });
    const getElement = id => {
        if (!elements.has(id)) {
            const element = makeElement();
            element.value = defaults[id] ?? '';
            if (id === 'chk-header') element.checked = true;
            element.parentElement = makeElement();
            elements.set(id, element);
        }
        return elements.get(id);
    };
    const choiceGroups = new Map(groups.map(({ id, values }) => {
        const group = makeElement();
        group.dataset.plotChoice = id;
        group.radios = values.map(value => ({ value, checked: value === defaults[id] }));
        group.querySelectorAll = () => group.radios;
        return [id, group];
    }));
    let ready;
    const document = {
        getElementById: getElement,
        createElement: makeElement,
        createDocumentFragment: makeElement,
        querySelector: () => makeElement(),
        querySelectorAll: selector => selector === '[data-plot-choice]'
            ? [...choiceGroups.values()] : [],
        addEventListener(name, callback) { if (name === 'DOMContentLoaded') ready = callback; },
        body: { style: {} }
    };
    let stored = original;
    let writes = 0;
    let now = 0;
    const intervals = [];
    const timeouts = [];
    const alerts = [];
    const resizeObservers = [];
    class ResizeObserverForTest {
        constructor(callback) { this.callback = callback; this.elements = []; resizeObservers.push(this); }
        observe(element) { this.elements.push(element); }
    }
    const localStorage = {
        getItem() { return stored; },
        setItem(_key, value) { writes++; stored = value; }
    };
    const DateForTest = fixedDate ? class extends Date {
        constructor(...args) { super(...(args.length ? args : [fixedDate])); }
    } : Date;
    const context = vm.createContext({
        document, window: { addEventListener() {} }, localStorage, navigator: {},
        performance: { now: () => now }, TextEncoder, TextDecoder, Event, Date: DateForTest,
        setInterval(callback) { intervals.push(callback); }, clearInterval() {},
        setTimeout(callback) { timeouts.push(callback); }, clearTimeout() {},
        requestAnimationFrame() {}, ResizeObserver: ResizeObserverForTest,
        console: { ...console, warn() {} },
        alert(message) { alerts.push(message); },
        FileReader: class {
            readAsText(file) { this.onload({ target: { result: file.text } }); }
        }
    });
    for (const file of scripts) {
        vm.runInContext(fs.readFileSync(path.join(root, file), 'utf8'), context, { filename: file });
    }
    let plotter, parser, monitor;
    const OriginalParser = context.SerialPlotter.DataParser;
    context.SerialPlotter.DataParser = class extends OriginalParser {
        constructor(...args) { super(...args); parser = this; }
    };
    const OriginalPlotter = context.SerialPlotter.Plotter;
    context.SerialPlotter.Plotter = class extends OriginalPlotter {
        constructor(...args) { super(...args); plotter = this; }
    };
    const OriginalMonitor = context.SerialPlotter.MonitorView;
    context.SerialPlotter.MonitorView = class extends OriginalMonitor {
        constructor(...args) { super(...args); monitor = this; }
    };
    ready();
    const fireCanvas = (name, x, y) => getElement('waveform-canvas').listeners[name]({
        button: 0, pointerId: 1, clientX: x, clientY: y,
        preventDefault() {}
    });
    return { getElement, getStored: () => stored, getWrites: () => writes,
        getChoiceGroup: id => choiceGroups.get(id),
        flushTimeouts() {
            for (let count = 0; timeouts.length && count < 1000; count++) timeouts.shift()();
            assert.equal(timeouts.length, 0);
        },
        tick(ms = 1000) { now += ms; intervals.forEach(callback => callback()); },
        notifyResize(id) {
            const element = getElement(id);
            for (const observer of resizeObservers) {
                if (observer.elements.includes(element)) observer.callback();
            }
        },
        fireCanvas, plotter, parser, monitor, alerts };
}

test('page bootstrap restores saved config without overwriting it', () => {
    const original = JSON.stringify({ connType: 'udp', channelsCount: '23',
        maxPoints: '5000', enableHeader: false });
    const { getElement, getStored, getWrites } = bootWithConfig(original);
    assert.equal(getElement('conn-type').value, 'udp');
    assert.equal(getElement('channels-count').value, '23');
    assert.equal(getWrites(), 0);
    assert.equal(getStored(), original);
});

test('invalid partial config leaves the initial frame controls intact', () => {
    const { getElement } = bootWithConfig(JSON.stringify({ headerHex: 'GG' }));
    assert.equal(getElement('frame-header').value, 'AB');
    assert.equal(getElement('chk-header').checked, true);
});

test('rectangle zoom leaves persisted Y settings unchanged', () => {
    const { getElement, getStored, getWrites, fireCanvas, plotter } = bootWithConfig(null);
    plotter.setChannelVisible(0, true);
    for (let i = 0; i <= 100; i++) plotter.addFrame([i]);
    plotter.draw();
    const plotW = plotter.canvas.width - plotter.pX;
    const plotH = plotter.canvas.height - plotter.pY;
    const writes = getWrites();
    fireCanvas('pointerdown', plotW / 4, plotH / 4);
    fireCanvas('pointerup', plotW * 3 / 4, plotH * 3 / 4);
    assert.equal(plotter.vp.time.displayCount, 51);
    assert.equal(getElement('plot-y-scale-mode').value, 'auto');
    assert.equal(getElement('plot-y-min').value, '-1');
    assert.equal(getElement('plot-y-max').value, '1');
    assert.equal(getWrites(), writes);
    assert.equal(getStored(), null);
});

test('axis controls switch with view mode and persist their selected scales', () => {
    const { getElement, getStored, plotter } = bootWithConfig(null);
    const view = getElement('plot-view-mode');
    view.value = 'frequency';
    view.listeners.change();
    assert.equal(getElement('wrap-plot-time-axis').style.display, 'none');
    assert.equal(getElement('wrap-plot-frequency-axis').style.display, '');
    for (const [id, value] of [
        ['plot-freq-x-unit', 'bins'], ['plot-freq-x-scale', 'log'],
        ['plot-freq-y-scale', 'log']
    ]) {
        const select = getElement(id);
        select.value = value;
        select.listeners.change();
    }
    assert.equal(plotter.freqXUnit, 'bins');
    assert.equal(plotter.freqXScale, 'log');
    assert.equal(plotter.freqYScale, 'log');
    const strategy = getElement('plot-y-scale-mode');
    strategy.value = 'manual';
    strategy.listeners.change();
    assert.equal(strategy.value, 'manual', 'invalid bounds remain editable');
    assert.equal(getElement('wrap-plot-y-bounds').style.display, '');
    const min = getElement('plot-y-min');
    const max = getElement('plot-y-max');
    min.value = '0.01';
    min.listeners.change();
    max.value = '2';
    max.listeners.change();
    assert.equal(strategy.value, 'manual');
    view.value = 'time';
    view.listeners.change();
    assert.equal(getElement('wrap-plot-time-axis').style.display, '');
    assert.equal(getElement('wrap-plot-frequency-axis').style.display, 'none');
    const timeUnit = getElement('plot-time-x-unit');
    timeUnit.value = 's';
    timeUnit.listeners.change();
    assert.equal(plotter.timeXUnit, 's');
    const saved = JSON.parse(getStored());
    assert.equal(saved.plotTimeXUnit, 's');
    assert.equal(saved.plotFreqXUnit, 'bins');
    assert.equal(saved.plotFreqXScale, 'log');
    assert.equal(saved.plotFreqYScale, 'log');
});

test('time and frequency Y strategies and bounds remain independent across mode switches', () => {
    const { getElement, getStored, plotter } = bootWithConfig(null);
    const strategy = getElement('plot-y-scale-mode');
    strategy.value = 'manual';
    strategy.listeners.change();
    getElement('plot-y-min').value = '-5';
    getElement('plot-y-max').value = '5';
    getElement('plot-y-max').listeners.change();
    const view = getElement('plot-view-mode');
    view.value = 'frequency';
    view.listeners.change();
    assert.equal(strategy.value, 'auto');
    assert.equal(plotter.yScaleMode, 'auto');
    strategy.value = 'manual';
    strategy.listeners.change();
    getElement('plot-y-min').value = '0.01';
    getElement('plot-y-max').value = '2';
    getElement('plot-y-max').listeners.change();
    view.value = 'time';
    view.listeners.change();
    assert.equal(strategy.value, 'manual');
    assert.equal(getElement('plot-y-min').value, '-5');
    assert.equal(getElement('plot-y-max').value, '5');
    strategy.value = 'auto';
    strategy.listeners.change();
    view.value = 'frequency';
    view.listeners.change();
    assert.equal(strategy.value, 'manual');
    assert.equal(getElement('plot-y-min').value, '0.01');
    assert.equal(getElement('plot-y-max').value, '2');
    const saved = JSON.parse(getStored());
    assert.equal(saved.plotYScaleModeTime, 'auto');
    assert.equal(saved.plotYScaleModeFreq, 'manual');
});

test('invalid logarithmic Y bounds show an actionable message and valid bounds apply', () => {
    const { getElement, parser, plotter } = bootWithConfig(null);
    plotter.setChannelVisible(0, true);
    for (let i = 0; i < 32; i++) parser.onFrameParsed([Math.sin(i)], `t${i}`, Uint8Array.of(i), i);
    getElement('btn-pause').listeners.click();
    getElement('plot-view-mode').value = 'frequency';
    getElement('plot-view-mode').listeners.change();
    getElement('plot-freq-y-scale').value = 'log';
    getElement('plot-freq-y-scale').listeners.change();
    getElement('plot-y-scale-mode').value = 'manual';
    getElement('plot-y-scale-mode').listeners.change();
    getElement('plot-y-min').value = '0';
    getElement('plot-y-min').listeners.change();
    assert.match(getElement('plot-y-range-status').textContent, /正/);
    getElement('plot-y-min').value = '0.001';
    getElement('plot-y-max').value = '3';
    getElement('plot-y-max').listeners.change();
    assert.equal(getElement('plot-y-range-status').textContent, '');
    assert.equal(plotter._drawState.min, 0.001);
    assert.equal(plotter._drawState.max, 3);
});

test('restoring a configuration preserves distinct Y strategies and the legacy fallback', () => {
    const { getElement, plotter } = bootWithConfig(JSON.stringify({ plotViewMode: 'frequency',
        plotYScaleMode: 'manual', plotYScaleModeTime: 'auto', plotYScaleModeFreq: 'manual',
        plotYMinTime: '-5', plotYMaxTime: '5', plotYMinFreq: '0.01', plotYMaxFreq: '2' }));
    assert.equal(plotter.yScaleMode, 'manual');
    getElement('plot-view-mode').value = 'time';
    getElement('plot-view-mode').listeners.change();
    assert.equal(plotter.yScaleMode, 'auto');
    const legacy = bootWithConfig(JSON.stringify({ plotYScaleMode: 'manual',
        plotYMinTime: '-2', plotYMaxTime: '2', plotYMinFreq: '0', plotYMaxFreq: '10' }));
    legacy.getElement('plot-view-mode').value = 'frequency';
    legacy.getElement('plot-view-mode').listeners.change();
    assert.equal(legacy.plotter.yScaleMode, 'manual');
});

test('legacy shared manual Y settings do not discard a valid hidden-log configuration', () => {
    const { getElement, plotter } = bootWithConfig(JSON.stringify({ connType: 'udp', channelsCount: '3',
        plotViewMode: 'time', plotYScaleMode: 'manual', plotFreqYScale: 'log',
        plotYMinTime: '-2', plotYMaxTime: '2', plotYMinFreq: '-1', plotYMaxFreq: '1' }));
    assert.equal(getElement('conn-type').value, 'udp');
    assert.equal(getElement('channels-count').value, '3');
    assert.equal(plotter.yScaleMode, 'manual');
    getElement('plot-view-mode').value = 'frequency';
    getElement('plot-view-mode').listeners.change();
    assert.equal(plotter.yScaleMode, 'auto');
});

test('imported legacy Y bounds override invalid unsaved range fields', () => {
    const { getElement, plotter, alerts } = bootWithConfig(null);
    getElement('plot-y-scale-mode').value = 'manual';
    getElement('plot-y-scale-mode').listeners.change();
    getElement('plot-y-min').value = '3';
    getElement('plot-y-max').value = '2';
    getElement('plot-y-max').listeners.change();
    const target = { files: [{ text: JSON.stringify({ plotYScaleMode: 'manual',
        plotYMin: '-5', plotYMax: '5' }) }], value: 'legacy.json' };
    getElement('cfg-file-input').listeners.change({ target });
    assert.deepEqual(alerts, []);
    assert.equal(getElement('plot-y-min').value, '-5');
    assert.equal(plotter.yBounds.time.max, 5);
});

test('radio choices persist and dependent controls follow their parent selection', () => {
    const { getElement, getChoiceGroup, getStored, plotter } = bootWithConfig(null);
    const choose = (id, value) => {
        const group = getChoiceGroup(id);
        const radio = group.radios.find(item => item.value === value);
        radio.checked = true;
        group.listeners.change({ target: radio });
    };
    choose('plot-view-mode', 'frequency');
    choose('plot-fft-window', 'flatTop');
    assert.equal(plotter.displayMode, 'frequency');
    assert.equal(plotter.fftWindow, 'flatTop');
    assert.equal(getElement('wrap-plot-frequency-axis').style.display, '');
    assert.equal(getElement('wrap-plot-time-axis').style.display, 'none');
    choose('plot-y-scale-mode', 'manual');
    assert.equal(getElement('wrap-plot-y-bounds').style.display, '');
    choose('plot-y-scale-mode', 'auto');
    assert.equal(getElement('wrap-plot-y-bounds').style.display, 'none');
    assert.equal(JSON.parse(getStored()).plotFftWindow, 'flatTop');
});

test('waveform statistic counts completed draws and returns to zero when idle', () => {
    const { getElement, tick, plotter } = bootWithConfig(null);
    const label = getElement('stat-plot-fps');
    plotter.draw();
    tick();
    assert.equal(label.textContent, '绘图帧率: 1.0 FPS');
    tick();
    assert.equal(label.textContent, '绘图帧率: 0.0 FPS');
    getElement('btn-pause').listeners.click();
    tick();
    assert.equal(label.textContent, '绘图帧率: 1.0 FPS');
    tick();
    assert.equal(label.textContent, '绘图帧率: 0.0 FPS');
});

test('pausing capture reports the incomplete RX tail only once', () => {
    const config = JSON.stringify({ enableHeader: false, enableFooter: true,
        footerHex: 'EE', dataType: 'uint8', channelsCount: '1' });
    const { getElement, parser, monitor } = bootWithConfig(config);
    parser.appendData(Uint8Array.of(0x10, 0x20));
    getElement('btn-pause').listeners.click();
    assert.deepEqual(Array.from(monitor.extras, row => [row.reason, ...row.bytes]), [
        ['帧尾不匹配', 0x10], ['帧未完整', 0x20]
    ]);
    assert.equal(parser.writeOffset, 0);
});

test('frequency FPS counts refreshed spectra rather than cached redraws', () => {
    const { getElement, tick, plotter } = bootWithConfig(null);
    plotter.setChannelVisible(0, true);
    for (let i = 0; i < 64; i++) plotter.addFrame([Math.sin(i)]);
    plotter.setDisplayOptions({ displayMode: 'frequency' });
    plotter.draw();
    tick();
    plotter.addFrame([1]);
    plotter.draw();
    plotter.addFrame([2]);
    plotter.draw();
    tick();
    assert.equal(getElement('stat-plot-fps').textContent, '绘图帧率: 1.0 FPS');
});

test('channel calibration controls expand only after clicking the CH button', () => {
    const { getElement } = bootWithConfig(null);
    const row = getElement('channel-config-list').children[0];
    const toggle = row.children[0].children[0];
    const controls = row.children[1];
    assert.equal(toggle.textContent, 'CH1');
    assert.equal(controls.hidden, true);
    toggle.listeners.click();
    assert.equal(controls.hidden, false);
    assert.equal(toggle.ariaExpanded, 'true');
    toggle.listeners.click();
    assert.equal(controls.hidden, true);
    assert.equal(toggle.ariaExpanded, 'false');
});

test('inactive CH label is gray on first render and after toggling visibility', () => {
    const { getElement } = bootWithConfig(null);
    const row = getElement('channel-config-list').children[0];
    const main = row.children[0];
    const toggle = main.children[0];
    const visible = main.children[3];
    assert.equal(visible.checked, false);
    assert.equal(toggle.style.opacity, '0.4');
    visible.checked = true;
    visible.listeners.change();
    assert.equal(toggle.style.opacity, '1');
    visible.checked = false;
    visible.listeners.change();
    assert.equal(toggle.style.opacity, '0.4');
});

test('plot FPS occupies the title row without displacing channel statistics', () => {
    const html = fs.readFileSync(path.resolve(__dirname, '..', 'index.html'), 'utf8');
    const titleRow = html.match(/<div class="plot-title-row monitor-title-row">([\s\S]*?)<\/div>/)?.[1];
    const statsRow = html.match(/<div class="plot-info-row monitor-stats-row"[^>]*>([\s\S]*?)<\/div>/)?.[1];
    assert.match(titleRow, /id="stat-plot-fps"/);
    assert.doesNotMatch(titleRow, /右键绘图区重置缩放/);
    assert.doesNotMatch(statsRow, /id="stat-plot-fps"/);
    assert.match(statsRow, /id="plot-channel-stats"/);
    assert.ok(html.indexOf('id="plot-info-row"') < html.indexOf('id="waveform-canvas"'));
});

test('wave statistics row appears only when single-channel statistics exist', () => {
    const { getElement, plotter } = bootWithConfig(null);
    const row = getElement('plot-info-row');
    plotter.onStatsUpdate(null);
    assert.equal(row.hidden, true);
    plotter.onStatsUpdate({ channelLabel: 'CH1', max: 1, min: -1, pp: 2,
        mean: 0, stdDev: 0.5, freq: null, period: null });
    assert.equal(row.hidden, false);
    assert.equal(getElement('plot-channel-stats').children.length, 8);
    plotter.onStatsUpdate(null);
    assert.equal(row.hidden, true);
});

test('wave statistic labels keep their cells while numeric values change length', () => {
    const { getElement, plotter } = bootWithConfig(null);
    const first = { channelLabel: 'CH1', max: 9, min: -1, pp: 10,
        mean: 4, stdDev: 2, freq: null, period: null };
    plotter.onStatsUpdate(first);
    const cells = getElement('plot-channel-stats').children;
    assert.equal(cells[1].children[0].textContent, '最大值:');
    assert.equal(cells[1].children[1].textContent.trim(), '9.000000');
    plotter.onStatsUpdate({ ...first, max: -1234567.125 });
    assert.equal(getElement('plot-channel-stats').children[1], cells[1]);
    assert.equal(cells[1].children[0].textContent, '最大值:');
    assert.equal(cells[1].children[1].textContent.trim(), '-1234567.125000');
});

test('dominant frequency and period statistics follow their respective axis units in both views', () => {
    const { getElement, plotter, tick } = bootWithConfig(null);
    plotter.setChannelVisible(0, true);
    plotter.setDisplayOptions({ fftWindow: 'rectangular' });
    plotter.setSampleRateHz(128);
    for (let i = 0; i < 64; i++) plotter.addFrame([Math.sin(2 * Math.PI * 4 * i / 64)]);
    const select = (id, value) => {
        const control = getElement(id);
        control.value = value;
        control.dispatchEvent(new Event('change'));
    };
    const cases = [
        ['hz', 'samples', '8.000000 Hz', '16 Sample'],
        ['bins', 'samples', '4 Bin', '16 Sample'],
        ['bins', 's', '4 Bin', '0.125000 s'],
        ['hz', 's', '8.000000 Hz', '0.125000 s']
    ];
    for (const mode of ['time', 'frequency']) {
        select('plot-view-mode', mode);
        for (const [freqUnit, timeUnit, frequency, period] of cases) {
            select('plot-freq-x-unit', freqUnit);
            select('plot-time-x-unit', timeUnit);
            plotter.draw();
            const cells = getElement('plot-channel-stats').children;
            assert.equal(cells[6].children[1].textContent, frequency);
            assert.equal(cells[7].children[1].textContent, period);
        }
    }
    getElement('btn-pause').listeners.click();
    tick();
    plotter.draw();
    assert.equal(getElement('plot-channel-stats').children[7].children[1].textContent, '0.125000 s');
    select('plot-view-mode', 'time');
    plotter.vp.time.scrollOffset = 0;
    plotter.vp.time.displayCount = 32;
    select('plot-freq-x-unit', 'bins');
    plotter.draw();
    assert.equal(getElement('plot-channel-stats').children[6].children[1].textContent, '2 Bin',
        'a shorter paused FFT window changes the bin while preserving the frequency');
    select('plot-freq-x-unit', 'hz');
    plotter.draw();
    assert.equal(getElement('plot-channel-stats').children[6].children[1].textContent, '8.000000 Hz');
});

test('Bin and Sample statistics remain available without a measured sample rate', () => {
    const { getElement, plotter } = bootWithConfig(null);
    plotter.setChannelVisible(0, true);
    plotter.setDisplayOptions({ fftWindow: 'rectangular', freqXUnit: 'bins', timeXUnit: 'samples' });
    for (let i = 0; i < 64; i++) plotter.addFrame([Math.sin(2 * Math.PI * 4 * i / 64)]);
    plotter.draw();
    const cells = getElement('plot-channel-stats').children;
    assert.equal(cells[6].children[1].textContent, '4 Bin');
    assert.equal(cells[7].children[1].textContent, '16 Sample');
    plotter.setDisplayOptions({ freqXUnit: 'hz', timeXUnit: 's' });
    plotter.draw();
    assert.equal(cells[6].children[1].textContent, '-- Hz');
    assert.equal(cells[7].children[1].textContent, '-- s');
});

test('byte statistic updates the value without rebuilding its label', () => {
    const { getElement, parser, tick } = bootWithConfig(null);
    const fpsValue = getElement('stat-fps-value');
    tick();
    assert.equal(fpsValue.textContent, '0 f/s');
    parser.frameCount += 12;
    tick();
    assert.equal(fpsValue.textContent, '12 f/s');
});

test('monitor height responds when header rows grow after a width change', () => {
    const { getElement, notifyResize } = bootWithConfig(null);
    const header = getElement('monitor-header');
    const monitor = getElement('monitor-panel');
    const before = Number.parseInt(monitor.style.height, 10);
    header.offsetHeight += 260;
    notifyResize('monitor-header');
    assert.ok(Number.parseInt(monitor.style.height, 10) > before);
    assert.ok(Number.parseInt(getElement('canvas-wrapper').style.height, 10) < 340);
});

test('changing retained capacity clamps the plot window field and reset range', () => {
    const { getElement, plotter } = bootWithConfig(null);
    const capacity = getElement('max-points');
    const window = getElement('plot-window-points');
    window.value = '800';
    window.listeners.change();
    assert.equal(plotter.plotWindowPoints, 800);
    capacity.value = '500';
    capacity.listeners.change();
    assert.equal(window.value, '500');
    assert.equal(plotter.plotWindowPoints, 500);
    assert.match(fs.readFileSync(path.resolve(__dirname, '..', 'index.html'), 'utf8'),
        /id="plot-window-points"/);
});

test('time jumps, waveform visibility, and decoded-value search are wired to the UI', () => {
    const { getElement, parser, plotter, monitor } = bootWithConfig(null);
    for (let i = 0; i < 5; i++)
        parser.onFrameParsed([i], `t${i}`, Uint8Array.of(0x41 + i), 1000 + i * 1000);
    getElement('btn-pause').listeners.click();
    getElement('nav-jump-mode').value = 'relative';
    getElement('nav-jump-mode').listeners.change();
    getElement('nav-jump-relative').value = '2';
    getElement('nav-jump-button').listeners.click();
    assert.equal(plotter._timeCenterOrder, 3);
    assert.equal(monitor.anchor.order, 3);
    assert.equal(monitor.cursorOrder, 3);
    assert.equal(plotter.navigationMarkers.timeOrder, 3);

    getElement('show-waveform').checked = false;
    getElement('show-waveform').listeners.change();
    assert.equal(plotter.isVisible, false);
    assert.equal(getElement('canvas-wrapper').hidden, true);
    getElement('show-waveform').checked = true;
    getElement('show-waveform').listeners.change();
    assert.equal(plotter.isVisible, true);

    getElement('monitor-display-mode-number').checked = true;
    getElement('monitor-display-mode-number').listeners.change();
    getElement('monitor-search-query').value = '2';
    getElement('monitor-search-tolerance').value = '0';
    getElement('monitor-search-nearest').listeners.click();
    assert.equal(monitor.matches.length, 1);
    assert.equal(monitor.mode, 'number');
    assert.equal(monitor.anchor.order, 3);
    assert.equal(monitor.currentMatch, 0);
    assert.equal(plotter._timeCenterOrder, 3);
    assert.equal(plotter.navigationMarkers.timeOrder, 3);
    assert.equal(plotter.navigationMarkers.matches.length, 1);
    assert.equal(plotter.navigationMarkers.currentMatch, 0);
    assert.equal(monitor.cursorOrder, 3);
    getElement('monitor-search-next').listeners.click();
    assert.equal(monitor.currentMatch, 0);
    assert.equal(monitor.anchor.order, 3);
    getElement('nav-jump-relative').value = '4';
    getElement('nav-jump-button').listeners.click();
    assert.equal(monitor.anchor.order, 5);
    assert.equal(monitor.cursorOrder, 5);
    assert.equal(plotter._timeCenterOrder, 5);
    assert.equal(plotter.navigationMarkers.timeOrder, 5);
    assert.equal(plotter.navigationMarkers.currentMatch, 0);
});

test('absolute system-time jump selects the nearest retained frame in both monitors', () => {
    const { getElement, parser, monitor, plotter } = bootWithConfig(null);
    const entered = '2026-10-02T10:30:00.500';
    const start = new Date(entered).getTime();
    for (let i = 0; i < 3; i++)
        parser.onFrameParsed([i], `t${i}`, Uint8Array.of(i), start + i * 1000);
    getElement('btn-pause').listeners.click();
    getElement('nav-jump-mode').value = 'absolute';
    getElement('nav-jump-absolute').value = '2026-10-02T10:30:01.400';
    getElement('nav-jump-button').listeners.click();
    assert.equal(monitor.anchor.order, 2);
    assert.equal(monitor.cursorOrder, 2);
    assert.equal(plotter._timeCenterOrder, 2);
    assert.equal(plotter.navigationMarkers.timeOrder, 2);
});

test('time tools default to local milliseconds and are available only while paused', () => {
    const { getElement, parser, plotter } = bootWithConfig(null);
    const timestamp = Date.now();
    parser.onFrameParsed([1], 't', Uint8Array.of(1), timestamp);
    assert.equal(getElement('nav-jump-button').disabled, true);
    assert.equal(getElement('monitor-search-prev').disabled, true);
    assert.equal(getElement('monitor-search-next').disabled, true);
    assert.equal(getElement('monitor-search-origin-wave').disabled, true);
    assert.equal(getElement('monitor-search-nearest').disabled, true);
    getElement('nav-jump-relative').value = '0';
    getElement('nav-jump-mode').value = 'relative';
    getElement('nav-jump-button').listeners.click();
    assert.equal(plotter._timeCenterOrder, null);

    getElement('btn-pause').listeners.click();
    const before = Date.now();
    assert.equal(getElement('nav-jump-button').disabled, false);
    const value = getElement('nav-jump-absolute').value;
    assert.match(value, /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}$/);
    assert.ok(Math.abs(new Date(value).getTime() - before) < 1000);
    assert.equal(new Date(value).getMilliseconds(), timestamp % 1000);
    assert.equal(getElement('monitor-search-prev').disabled, false);
    assert.equal(getElement('monitor-search-next').disabled, false);
    assert.equal(getElement('monitor-search-origin-wave').disabled, false);
    assert.equal(getElement('monitor-search-nearest').disabled, false);
    getElement('btn-pause').listeners.click();
    assert.equal(getElement('nav-jump-button').disabled, true);
    assert.equal(getElement('monitor-search-prev').disabled, true);
    assert.equal(getElement('monitor-search-next').disabled, true);
    assert.equal(getElement('monitor-search-origin-wave').disabled, true);
    assert.equal(getElement('monitor-search-nearest').disabled, true);
});

test('pausing defaults the shared time locator to the latest retained frame timestamp', () => {
    const { getElement, parser } = bootWithConfig(null, '2026-10-02T11:00:00.000');
    for (const time of ['2026-10-02T10:29:59.120', '2026-10-02T10:30:01.347'])
        parser.onFrameParsed([1], 't', Uint8Array.of(1), new Date(time).getTime());
    getElement('btn-pause').listeners.click();
    assert.equal(getElement('nav-jump-absolute').value, '2026-10-02T10:30:01.347');
});

test('receive display, time jump, and search are three rows inside the byte monitor', () => {
    const html = fs.readFileSync(path.resolve(__dirname, '..', 'index.html'), 'utf8');
    assert.match(html, /<section class="navigation-panel" id="navigation-panel"[^>]*>/);
    assert.match(html, /<div class="monitor-tool-row" id="nav-receive-tools">\s*<span class="tool-label">接收显示<\/span>/);
    assert.match(html, /<div class="monitor-tool-row" id="nav-time-tools">\s*<span class="tool-label">时间定位<\/span>\s*<div class="jump-toolbar"/);
    assert.match(html, /<div class="monitor-tool-row" id="nav-search-tools">\s*<span class="tool-label">搜索<\/span>\s*<div class="monitor-search-toolbar"/);
    assert.ok(html.indexOf('id="v-resizer"') < html.indexOf('id="monitor-panel"'));
    assert.ok(html.indexOf('id="monitor-panel"') < html.indexOf('id="send-panel"'));
    assert.ok(html.indexOf('id="send-panel"') < html.indexOf('id="navigation-panel"'));
    assert.ok(html.indexOf('id="navigation-panel"') < html.indexOf('</main>'));
    assert.match(html, /<\/section>\s*<\/div>\s*<\/main>/);
    assert.doesNotMatch(html, /id="monitor-search-button"/);
    assert.doesNotMatch(html, /id="(?:wave-tools|byte-tools|byte-search-tools)"/);
    assert.doesNotMatch(html, /<details class="monitor-tools"|<summary id="(?:wave|byte)-tools-summary"/);
});

test('receive display format determines search type and numeric fields', () => {
    const { getElement } = bootWithConfig(null);
    assert.equal(getElement('monitor-display-mode-hex').checked, true);
    getElement('btn-pause').listeners.click();
    const number = getElement('monitor-display-mode-number');
    number.checked = true;
    number.listeners.change();
    assert.equal(getElement('monitor-display-mode').value, 'number');
    assert.equal(getElement('monitor-search-tolerance').hidden, false);
    assert.equal(getElement('monitor-search-channel').hidden, false);
    const ascii = getElement('monitor-display-mode-ascii');
    ascii.checked = true;
    ascii.listeners.change();
    assert.equal(getElement('monitor-display-mode').value, 'ascii');
    assert.equal(getElement('monitor-search-tolerance').hidden, true);
    assert.equal(getElement('monitor-search-channel').hidden, true);
});

test('numeric search supports selecting multiple channels without searching the others', () => {
    const { getElement, parser, monitor } = bootWithConfig(JSON.stringify({ channelsCount: '3' }));
    parser.onFrameParsed([1, 1, 1], 't1', Uint8Array.of(1), 1000);
    parser.onFrameParsed([2, 1, 1], 't2', Uint8Array.of(2), 1001);
    getElement('btn-pause').listeners.click();
    const numeric = getElement('monitor-display-mode-number');
    numeric.checked = true;
    numeric.listeners.change();

    const picker = getElement('monitor-search-channel-options');
    assert.equal(picker.children.length, 4, 'all channels plus three channel checkboxes');
    const first = picker.children[1].children[0];
    const third = picker.children[3].children[0];
    first.checked = true;
    first.listeners.change();
    third.checked = true;
    third.listeners.change();
    getElement('monitor-search-query').value = '1';
    getElement('monitor-search-nearest').listeners.click();
    assert.deepEqual(Array.from(monitor.matches, match => [match.startFrame, match.channel]),
        [[0, 0], [0, 2], [1, 2]]);
    assert.equal(getElement('monitor-search-channel-toggle').textContent, 'CH1、CH3');

    const second = picker.children[2].children[0];
    second.checked = true;
    second.listeners.change();
    getElement('monitor-search-nearest').listeners.click();
    assert.deepEqual(Array.from(monitor.matches, match => [match.startFrame, match.channel]),
        [[0, 0], [0, 1], [0, 2], [1, 1], [1, 2]],
        'changing the checkbox selection must rescan rather than reuse cached matches');
    getElement('btn-pause').listeners.click();
    assert.equal(getElement('monitor-search-channel-toggle').disabled, true);
    assert.equal(second.disabled, true);
});

test('switching receive display format clears prior matches and changes search parsing', () => {
    const { getElement, parser, monitor } = bootWithConfig(null);
    parser.onFrameParsed([2], 't', Uint8Array.of(0x41), Date.now());
    getElement('btn-pause').listeners.click();
    const numeric = getElement('monitor-display-mode-number');
    numeric.checked = true;
    numeric.listeners.change();
    getElement('monitor-search-query').value = '2';
    getElement('monitor-search-nearest').listeners.click();
    assert.equal(monitor.matches.length, 1);

    const ascii = getElement('monitor-display-mode-ascii');
    ascii.checked = true;
    ascii.listeners.change();
    assert.equal(monitor.matches.length, 0);
    assert.equal(getElement('monitor-search-status').textContent, '');
    getElement('monitor-search-query').value = 'A';
    getElement('monitor-search-nearest').listeners.click();
    assert.equal(monitor.matches.length, 1);
    assert.equal(monitor.mode, 'ascii');
});

test('nearest origin selects the wave center or byte center and reuses the matches', () => {
    const { getElement, parser, plotter, monitor } = bootWithConfig(null);
    for (let index = 0; index < 10; index++)
        parser.onFrameParsed([index === 1 || index === 7 ? 42 : index], `t${index}`,
            Uint8Array.of(index), 1000 + index);
    getElement('btn-pause').listeners.click();
    const numeric = getElement('monitor-display-mode-number');
    numeric.checked = true;
    numeric.listeners.change();
    getElement('monitor-search-query').value = '42';
    plotter.vp.time.displayCount = 4;
    plotter.vp.time.scrollOffset = 3; // visible frame indexes 3..6, centered near order 6
    plotter.vp.time.autoFollow = false;
    monitor.cursorOrder = 2;
    const origin = getElement('monitor-search-origin-wave');
    origin.checked = true;
    origin.listeners.change();
    getElement('monitor-search-nearest').listeners.click();
    assert.equal(monitor.matches[monitor.currentMatch].startOrder, 8);
    assert.equal(plotter._timeCenterOrder, 8);
    const cachedMatches = monitor.matches;

    monitor.jumpToFrame(1);
    const byteOrigin = getElement('monitor-search-origin-byte');
    byteOrigin.checked = true;
    byteOrigin.listeners.change();
    getElement('monitor-search-nearest').listeners.click();
    assert.equal(monitor.matches, cachedMatches);
    assert.equal(monitor.matches[monitor.currentMatch].startOrder, 2);
    assert.equal(plotter._timeCenterOrder, 2);
});

test('first previous skips the nearest result then uses the normal direction and cache', () => {
    const { getElement, parser, monitor, plotter } = bootWithConfig(null);
    for (const [index, byte] of [0x41, 0x42, 0x41, 0x42].entries())
        parser.onFrameParsed([index], `t${index}`, Uint8Array.of(byte), 1000 + index);
    getElement('btn-pause').listeners.click();
    getElement('monitor-search-query').value = '41';
    getElement('monitor-search-prev').listeners.click();
    assert.equal(monitor.anchor.order, 1);
    assert.equal(plotter._timeCenterOrder, 1);
    assert.equal(monitor.currentMatch, 0);
    const cachedMatches = monitor.matches;
    getElement('monitor-search-next').listeners.click();
    assert.equal(monitor.anchor.order, 3);
    assert.equal(monitor.currentMatch, 1);
    assert.equal(monitor.matches, cachedMatches);
    getElement('monitor-search-prev').listeners.click();
    assert.equal(monitor.anchor.order, 1);
    getElement('monitor-search-query').value = '42';
    getElement('monitor-search-next').listeners.click();
    assert.equal(monitor.anchor.order, 4);
    assert.equal(monitor.currentMatch, 1);
});

test('first next uses the window center rather than a clicked byte-row cursor', () => {
    const { getElement, parser, monitor } = bootWithConfig(null);
    for (const [index, byte] of [0x41, 0x42, 0x41, 0x42].entries())
        parser.onFrameParsed([index], `t${index}`, Uint8Array.of(byte), 1000 + index);
    getElement('btn-pause').listeners.click();
    monitor.cursorOrder = 2;
    monitor.jumpToFrame(0);
    getElement('monitor-search-query').value = '41';
    getElement('monitor-search-next').listeners.click();
    assert.equal(monitor.anchor.order, 3);
    assert.equal(monitor.currentMatch, 1);
});

test('moving the window or clicking a row preserves the selected search result', () => {
    const { getElement, parser, monitor } = bootWithConfig(null);
    for (const [index, byte] of [0x41, 0x42, 0x41, 0x42, 0x41].entries())
        parser.onFrameParsed([index], `t${index}`, Uint8Array.of(byte), 1000 + index);
    getElement('btn-pause').listeners.click();
    getElement('monitor-search-query').value = '41';
    getElement('monitor-search-next').listeners.click();
    assert.equal(monitor.anchor.order, 3);
    monitor.cursorOrder = 4;
    monitor.jumpToFrame(3);
    getElement('monitor-search-prev').listeners.click();
    assert.equal(monitor.anchor.order, 1);
});

function numericSearchFixture(matchingFrames, count = 310, config = null) {
    const fixture = bootWithConfig(config);
    const { parser, getElement } = fixture;
    for (let index = 0; index < count; index++)
        parser.onFrameParsed([matchingFrames.includes(index + 1) ? 42 : 0], `t${index}`,
            Uint8Array.of(index & 255), 1000 + index);
    getElement('btn-pause').listeners.click();
    const numeric = getElement('monitor-display-mode-number');
    numeric.checked = true;
    numeric.listeners.change();
    getElement('monitor-search-query').value = '42';
    return fixture;
}

test('first direction is reversed only before a result is selected', () => {
    for (const [action, firstFrame, secondFrame] of [['prev', 300, 200], ['next', 100, 200],
        ['nearest', 200, 200]]) {
        const { getElement, plotter, monitor } = numericSearchFixture([100, 200, 300]);
        plotter.jumpToFrame(209);
        const origin = getElement('monitor-search-origin-wave');
        origin.checked = true;
        origin.listeners.change();
        getElement(`monitor-search-${action}`).listeners.click();
        assert.equal(monitor.matches[monitor.currentMatch].startFrame + 1, firstFrame);
        getElement(`monitor-search-${action}`).listeners.click();
        assert.equal(monitor.matches[monitor.currentMatch].startFrame + 1, secondFrame);
    }
});

test('nearest uses the latest frame by default and the time viewport in frequency mode', () => {
    const { getElement, plotter, monitor } = numericSearchFixture([100, 200, 300]);
    assert.equal(getElement('monitor-search-origin-byte').checked, true);
    getElement('monitor-search-nearest').listeners.click();
    assert.equal(monitor.matches[monitor.currentMatch].startFrame, 299);
    plotter.jumpToFrame(109);
    plotter.setDisplayOptions({ displayMode: 'frequency' });
    const origin = getElement('monitor-search-origin-wave');
    origin.checked = true;
    origin.listeners.change();
    getElement('monitor-search-nearest').listeners.click();
    assert.equal(monitor.matches[monitor.currentMatch].startFrame, 99);
});

test('nearest resolves an equal distance toward the earlier frame', () => {
    const { getElement, plotter, monitor } = numericSearchFixture([100, 200, 300]);
    plotter.jumpToFrame(249);
    const origin = getElement('monitor-search-origin-wave');
    origin.checked = true;
    origin.listeners.change();
    getElement('monitor-search-nearest').listeners.click();
    assert.equal(monitor.matches[monitor.currentMatch].startFrame, 199);
});

test('an even-sized time window chooses the earlier result at its midpoint', () => {
    const { getElement, plotter, monitor } = numericSearchFixture([4, 7], 10);
    plotter.vp.time.displayCount = 4;
    plotter.vp.time.scrollOffset = 3;
    plotter.vp.time.autoFollow = false;
    const origin = getElement('monitor-search-origin-wave');
    origin.checked = true;
    origin.listeners.change();
    getElement('monitor-search-nearest').listeners.click();
    assert.equal(monitor.matches[monitor.currentMatch].startFrame, 3);
});

test('selected results cycle normally across both ends and survive changing the origin', () => {
    const { getElement, plotter, monitor } = numericSearchFixture([100, 200, 300]);
    getElement('monitor-search-nearest').listeners.click();
    const matches = monitor.matches;
    plotter.jumpToFrame(99);
    const origin = getElement('monitor-search-origin-wave');
    origin.checked = true;
    origin.listeners.change();
    getElement('monitor-search-next').listeners.click();
    assert.equal(monitor.matches[monitor.currentMatch].startFrame, 99);
    getElement('monitor-search-prev').listeners.click();
    assert.equal(monitor.matches[monitor.currentMatch].startFrame, 299);
    assert.equal(monitor.matches, matches);
});

test('single-result and empty searches handle all three operations', () => {
    for (const action of ['nearest', 'prev', 'next']) {
        const single = numericSearchFixture([100]);
        single.getElement(`monitor-search-${action}`).listeners.click();
        assert.equal(single.monitor.currentMatch, 0);
        single.getElement(`monitor-search-${action}`).listeners.click();
        assert.equal(single.monitor.currentMatch, 0);
        const empty = numericSearchFixture([]);
        empty.getElement(`monitor-search-${action}`).listeners.click();
        assert.equal(empty.monitor.currentMatch, -1);
        assert.equal(empty.getElement('monitor-search-status').textContent, '无匹配结果');
    }
});

test('nearest preserves same-frame result order and selects its first channel', () => {
    const { getElement, parser, plotter, monitor } = bootWithConfig(JSON.stringify({ channelsCount: '2' }));
    for (let index = 0; index < 3; index++)
        parser.onFrameParsed([index === 1 ? 42 : 0, index === 1 ? 42 : 0], `t${index}`,
            Uint8Array.of(index), 1000 + index);
    getElement('btn-pause').listeners.click();
    getElement('monitor-display-mode-number').checked = true;
    getElement('monitor-display-mode-number').listeners.change();
    getElement('monitor-search-query').value = '42';
    getElement('monitor-search-nearest').listeners.click();
    assert.equal(monitor.currentMatch, 0);
    assert.equal(monitor.matches[0].channel, 0);
    getElement('monitor-search-next').listeners.click();
    assert.equal(monitor.matches[monitor.currentMatch].channel, 1);
    getElement('nav-jump-relative').value = '0';
    getElement('nav-jump-mode').value = 'relative';
    getElement('nav-jump-button').listeners.click();
    getElement('monitor-search-prev').listeners.click();
    assert.equal(monitor.matches[monitor.currentMatch].channel, 0);
    assert.equal(plotter.navigationMarkers.currentMatch, 0);
});

test('search input changes clear the selected result immediately', () => {
    const { getElement, monitor, plotter } = numericSearchFixture([100, 200, 300]);
    getElement('monitor-search-nearest').listeners.click();
    assert.equal(monitor.currentMatch, 2);
    getElement('monitor-search-query').value = '0';
    getElement('monitor-search-query').listeners.input();
    assert.equal(monitor.currentMatch, -1);
    assert.equal(monitor.matches.length, 0);
    assert.equal(plotter.navigationMarkers.currentMatch, -1);
});

test('asynchronous search uses the position captured when the button was clicked', () => {
    const { getElement, plotter, monitor, flushTimeouts } = numericSearchFixture([100, 4900],
        5000, JSON.stringify({ maxPoints: '6000', plotWindowPoints: '100' }));
    plotter.jumpToFrame(109);
    const origin = getElement('monitor-search-origin-wave');
    origin.checked = true;
    origin.listeners.change();
    getElement('monitor-search-nearest').listeners.click();
    assert.equal(monitor.matches.length, 0);
    plotter.jumpToFrame(4899);
    flushTimeouts();
    assert.equal(monitor.matches[monitor.currentMatch].startFrame, 99);
});

test('numeric tolerance shows a hint while its default remains empty', () => {
    const html = fs.readFileSync(path.resolve(__dirname, '..', 'index.html'), 'utf8');
    const input = html.match(/<input id="monitor-search-tolerance"[^>]*>/)?.[0];
    assert.ok(input);
    assert.match(input, /placeholder="±误差"/);
    assert.doesNotMatch(input, /\bvalue=/);
});

test('shared time-mode choices switch the paired time input', () => {
    const { getElement } = bootWithConfig(null);
    const relativeChoice = getElement('nav-jump-mode-relative');
    relativeChoice.checked = true;
    relativeChoice.listeners.change();
    assert.equal(getElement('nav-jump-mode').value, 'relative');
    assert.equal(getElement('nav-jump-relative').hidden, false);
    assert.equal(getElement('nav-jump-absolute').hidden, true);
    const absoluteChoice = getElement('nav-jump-mode-absolute');
    absoluteChoice.checked = true;
    absoluteChoice.listeners.change();
    assert.equal(getElement('nav-jump-mode').value, 'absolute');
    assert.equal(getElement('nav-jump-relative').hidden, true);
    assert.equal(getElement('nav-jump-absolute').hidden, false);
});

test('pausing preserves the exact millisecond fraction', () => {
    const { getElement } = bootWithConfig(null, '2026-10-02T10:30:00.005');
    getElement('btn-pause').listeners.click();
    assert.equal(getElement('nav-jump-absolute').value, '2026-10-02T10:30:00.005');
});

test('receive, send, and interval radio choices update their existing controls', () => {
    const { getElement, monitor, getStored } = bootWithConfig(null);
    getElement('monitor-display-mode-ascii').checked = true;
    getElement('monitor-display-mode-ascii').listeners.change();
    assert.equal(monitor.mode, 'ascii');
    assert.equal(getElement('monitor-display-mode').value, 'ascii');

    getElement('send-input').value = '41';
    getElement('send-mode-text').checked = true;
    getElement('send-mode-text').listeners.change();
    assert.equal(getElement('send-mode').value, 'text');
    assert.equal(getElement('send-input').value, 'A');

    getElement('send-interval-unit-hz').checked = true;
    getElement('send-interval-unit-hz').listeners.change();
    assert.equal(getElement('send-interval-unit').value, 'hz');
    assert.equal(JSON.parse(getStored()).sendIntervalUnit, 'hz');
});

test('legacy millisecond interval unit restores the second choice', () => {
    const { getElement } = bootWithConfig(JSON.stringify({ sendIntervalUnit: 'ms' }));
    assert.equal(getElement('send-interval-unit').value, 's');
    assert.equal(getElement('send-interval-unit-s').checked, true);
});

test('nested navigation panel reserves monitor height while preserving four log rows', () => {
    const { getElement, notifyResize } = bootWithConfig(null);
    const main = getElement('main-display');
    main.clientHeight = 800;
    getElement('v-resizer').offsetHeight = 20;
    getElement('monitor-header').offsetHeight = 40;
    getElement('monitor-stats').offsetHeight = 40;
    getElement('send-panel').offsetHeight = 100;
    const before = parseInt(getElement('canvas-wrapper').style.height, 10);
    getElement('navigation-panel').offsetHeight = 250;
    notifyResize('navigation-panel');
    assert.ok(parseInt(getElement('canvas-wrapper').style.height, 10) < before);
    assert.ok(parseInt(getElement('monitor-panel').style.height, 10) >= 530);
});

test('shared time and search controls remain visible with the minimum log space', () => {
    const { getElement } = bootWithConfig(null);
    getElement('main-display').clientHeight = 900;
    getElement('v-resizer').offsetHeight = 20;
    getElement('monitor-header').offsetHeight = 40;
    getElement('monitor-stats').offsetHeight = 40;
    getElement('send-panel').offsetHeight = 154;
    getElement('navigation-panel').offsetHeight = 209;
    getElement('plot-header').offsetHeight = 150;
    getElement('monitor-display-mode').listeners.change();
    assert.ok(parseInt(getElement('monitor-panel').style.height, 10) >= 543);
    assert.notEqual(getElement('navigation-panel').hidden, true);
    assert.notEqual(getElement('nav-time-tools').hidden, true);
    assert.notEqual(getElement('nav-search-tools').hidden, true);
});
