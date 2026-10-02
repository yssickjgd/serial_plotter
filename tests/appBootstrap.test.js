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
        'monitor-display-mode': 'hex', 'monitor-search-mode': 'hex',
        'send-mode': 'hex', 'send-interval-unit': 'ms'
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
        setTimeout() {}, clearTimeout() {},
        requestAnimationFrame() {}, console: { ...console, warn() {} }
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
        tick(ms = 1000) { now += ms; intervals.forEach(callback => callback()); },
        fireCanvas, plotter, parser, monitor };
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
    const titleRow = html.match(/<div class="plot-title-row">([\s\S]*?)<\/div>/)?.[1];
    const statsRow = html.match(/<div class="plot-info-row"[^>]*>([\s\S]*?)<\/div>/)?.[1];
    assert.match(titleRow, /id="stat-plot-fps"/);
    assert.doesNotMatch(titleRow, /右键绘图区重置缩放/);
    assert.doesNotMatch(statsRow, /id="stat-plot-fps"/);
    assert.match(statsRow, /id="plot-channel-stats"/);
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
    getElement('wave-jump-mode').value = 'relative';
    getElement('wave-jump-mode').listeners.change();
    getElement('wave-jump-relative').value = '2';
    getElement('wave-jump-button').listeners.click();
    assert.equal(plotter._timeCenterOrder, 3);
    getElement('byte-jump-mode').value = 'relative';
    getElement('byte-jump-relative').value = '1';
    getElement('byte-jump-button').listeners.click();
    assert.equal(monitor.anchor.order, 2);

    getElement('show-waveform').checked = false;
    getElement('show-waveform').listeners.change();
    assert.equal(plotter.isVisible, false);
    assert.equal(getElement('canvas-wrapper').hidden, true);
    getElement('show-waveform').checked = true;
    getElement('show-waveform').listeners.change();
    assert.equal(plotter.isVisible, true);

    getElement('monitor-search-mode').value = 'number';
    getElement('monitor-search-mode').listeners.change();
    getElement('monitor-search-query').value = '2';
    getElement('monitor-search-tolerance').value = '0';
    getElement('monitor-search-button').listeners.click();
    assert.equal(monitor.matches.length, 1);
    assert.equal(monitor.mode, 'number');
    getElement('monitor-search-next').listeners.click();
    assert.equal(monitor.currentMatch, 0);
    assert.equal(monitor.anchor.order, 3);
});

test('absolute system-time jump selects the nearest retained frame', () => {
    const { getElement, parser, monitor } = bootWithConfig(null);
    const entered = '2026-10-02T10:30:00.500';
    const start = new Date(entered).getTime();
    for (let i = 0; i < 3; i++)
        parser.onFrameParsed([i], `t${i}`, Uint8Array.of(i), start + i * 1000);
    getElement('btn-pause').listeners.click();
    getElement('byte-jump-mode').value = 'absolute';
    getElement('byte-jump-absolute').value = '2026-10-02T10:30:01.400';
    getElement('byte-jump-button').listeners.click();
    assert.equal(monitor.anchor.order, 2);
});

test('time tools default to local milliseconds and are available only while paused', () => {
    const { getElement, parser, plotter } = bootWithConfig(null);
    parser.onFrameParsed([1], 't', Uint8Array.of(1), Date.now());
    assert.equal(getElement('wave-jump-button').disabled, true);
    assert.equal(getElement('byte-jump-button').disabled, true);
    assert.equal(getElement('monitor-search-button').disabled, true);
    getElement('wave-jump-relative').value = '0';
    getElement('wave-jump-mode').value = 'relative';
    getElement('wave-jump-button').listeners.click();
    assert.equal(plotter._timeCenterOrder, null);

    getElement('btn-pause').listeners.click();
    for (const prefix of ['wave', 'byte']) {
        const before = Date.now();
        assert.equal(getElement(`${prefix}-jump-button`).disabled, false);
        const value = getElement(`${prefix}-jump-absolute`).value;
        assert.match(value, /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}$/);
        assert.ok(Math.abs(new Date(value).getTime() - before) < 1000);
        assert.equal(new Date(value).getMilliseconds() % 10, 0);
    }
    assert.equal(getElement('monitor-search-button').disabled, false);
    getElement('btn-pause').listeners.click();
    assert.equal(getElement('wave-jump-button').disabled, true);
    assert.equal(getElement('byte-jump-button').disabled, true);
    assert.equal(getElement('monitor-search-button').disabled, true);
});

test('pausing defaults both time locators to the latest retained frame timestamp', () => {
    const { getElement, parser } = bootWithConfig(null, '2026-10-02T11:00:00.000');
    for (const time of ['2026-10-02T10:29:59.120', '2026-10-02T10:30:01.340'])
        parser.onFrameParsed([1], 't', Uint8Array.of(1), new Date(time).getTime());
    getElement('btn-pause').listeners.click();
    for (const prefix of ['wave', 'byte']) {
        assert.equal(getElement(`${prefix}-jump-absolute`).value, '2026-10-02T10:30:01.340');
    }
});

test('time and search labels share their permanently visible control rows', () => {
    const html = fs.readFileSync(path.resolve(__dirname, '..', 'index.html'), 'utf8');
    assert.match(html, /<div class="monitor-tool-row" id="wave-tools">\s*<span class="tool-label">时间定位<\/span>\s*<div class="jump-toolbar"/);
    assert.match(html, /<div class="monitor-tool-row" id="byte-tools">\s*<span class="tool-label">时间定位<\/span>\s*<div class="jump-toolbar"/);
    assert.match(html, /<div class="monitor-tool-row" id="byte-search-tools">\s*<span class="tool-label">搜索<\/span>\s*<div class="monitor-search-toolbar"/);
    assert.doesNotMatch(html, /<details class="monitor-tools"|<summary id="(?:wave|byte)-tools-summary"/);
});

test('search format radio choices update the search mode and numeric fields', () => {
    const { getElement } = bootWithConfig(null);
    assert.equal(getElement('monitor-search-mode-hex').checked, true);
    getElement('btn-pause').listeners.click();
    const number = getElement('monitor-search-mode-number');
    number.checked = true;
    number.listeners.change();
    assert.equal(getElement('monitor-search-mode').value, 'number');
    assert.equal(getElement('monitor-search-tolerance').hidden, false);
    assert.equal(getElement('monitor-search-channel').hidden, false);
    const ascii = getElement('monitor-search-mode-ascii');
    ascii.checked = true;
    ascii.listeners.change();
    assert.equal(getElement('monitor-search-mode').value, 'ascii');
    assert.equal(getElement('monitor-search-tolerance').hidden, true);
    assert.equal(getElement('monitor-search-channel').hidden, true);
});

test('numeric tolerance shows a hint while its default remains empty', () => {
    const html = fs.readFileSync(path.resolve(__dirname, '..', 'index.html'), 'utf8');
    const input = html.match(/<input id="monitor-search-tolerance"[^>]*>/)?.[0];
    assert.ok(input);
    assert.match(input, /placeholder="±误差"/);
    assert.doesNotMatch(input, /\bvalue=/);
});

test('visible time-mode choices switch the paired time input in both monitors', () => {
    const { getElement } = bootWithConfig(null);
    for (const prefix of ['wave', 'byte']) {
        const relativeChoice = getElement(`${prefix}-jump-mode-relative`);
        relativeChoice.checked = true;
        relativeChoice.listeners.change();
        assert.equal(getElement(`${prefix}-jump-mode`).value, 'relative');
        assert.equal(getElement(`${prefix}-jump-relative`).hidden, false);
        assert.equal(getElement(`${prefix}-jump-absolute`).hidden, true);
        const absoluteChoice = getElement(`${prefix}-jump-mode-absolute`);
        absoluteChoice.checked = true;
        absoluteChoice.listeners.change();
        assert.equal(getElement(`${prefix}-jump-mode`).value, 'absolute');
        assert.equal(getElement(`${prefix}-jump-relative`).hidden, true);
        assert.equal(getElement(`${prefix}-jump-absolute`).hidden, false);
    }
});

test('pausing at the start of a second still displays a 10 ms fraction', () => {
    const { getElement } = bootWithConfig(null, '2026-10-02T10:30:00.005');
    getElement('btn-pause').listeners.click();
    assert.equal(getElement('byte-jump-absolute').value, '2026-10-02T10:30:00.010');
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

test('restored interval unit selects its visible radio choice', () => {
    const { getElement } = bootWithConfig(JSON.stringify({ sendIntervalUnit: 's' }));
    assert.equal(getElement('send-interval-unit').value, 's');
    assert.equal(getElement('send-interval-unit-s').checked, true);
});

test('permanent time controls take space from the log down to four rows, then the waveform', () => {
    const { getElement } = bootWithConfig(null);
    const main = getElement('main-display');
    main.clientHeight = 800;
    getElement('v-resizer').offsetHeight = 20;
    getElement('monitor-header').offsetHeight = 40;
    getElement('monitor-stats').offsetHeight = 40;
    getElement('send-panel').offsetHeight = 100;
    const tools = getElement('byte-tools');
    tools.offsetHeight = 250;
    getElement('monitor-search-mode').listeners.change();
    assert.ok(parseInt(getElement('monitor-panel').style.height, 10) >= 550);
    assert.ok(parseInt(getElement('canvas-wrapper').style.height, 10) <= 250);
});

test('permanent search controls are included in the minimum monitor height', () => {
    const { getElement } = bootWithConfig(null);
    getElement('main-display').clientHeight = 800;
    getElement('v-resizer').offsetHeight = 20;
    getElement('monitor-header').offsetHeight = 40;
    getElement('monitor-stats').offsetHeight = 40;
    getElement('send-panel').offsetHeight = 100;
    getElement('byte-search-tools').offsetHeight = 250;
    getElement('monitor-search-mode').listeners.change();
    assert.ok(parseInt(getElement('monitor-panel').style.height, 10) >= 550);
});

test('always visible time and search controls preserve a four-row log', () => {
    const { getElement } = bootWithConfig(null);
    getElement('main-display').clientHeight = 900;
    getElement('v-resizer').offsetHeight = 20;
    getElement('monitor-header').offsetHeight = 40;
    getElement('monitor-stats').offsetHeight = 40;
    getElement('send-panel').offsetHeight = 154;
    getElement('byte-tools').offsetHeight = 209;
    getElement('plot-header').offsetHeight = 150;
    getElement('monitor-search-mode').listeners.change();
    assert.ok(parseInt(getElement('monitor-panel').style.height, 10) >= 563);
    assert.notEqual(getElement('wave-tools').hidden, true);
    assert.notEqual(getElement('byte-tools').hidden, true);
    assert.notEqual(getElement('byte-search-tools').hidden, true);
});
