const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function bootWithConfig(original) {
    const root = path.resolve(__dirname, '..');
    const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
    const scripts = [...html.matchAll(/<script src="([^"]+)"/g)].map(match => match[1]);
    const groups = [...html.matchAll(/<div class="choice-group" data-plot-choice="([^"]+)"[^>]*>([\s\S]*?)<\/div>/g)]
        .map(([, id, markup]) => ({ id, values: [...markup.matchAll(/<input type="radio"[^>]*value="([^"]+)"/g)]
            .map(match => match[1]) }));
    const defaults = {
        'conn-type': 'serial', 'channels-count': '1', 'max-points': '1000',
        'data-type': 'float32', endianness: 'little',
        'plot-view-mode': 'time', 'plot-y-scale-mode': 'auto',
        'plot-time-x-unit': 'samples', 'plot-freq-x-unit': 'hz',
        'plot-freq-x-scale': 'linear', 'plot-freq-y-scale': 'linear',
        'plot-fft-window': 'hann',
        'plot-y-min': '-1', 'plot-y-max': '1',
        'serial-baud': '115200', 'serial-data': '8', 'serial-stop': '1',
        'serial-parity': 'none', 'net-port': '9000', 'net-local': '9000',
        'frame-header': 'AB', 'frame-footer': '0D 0A'
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
    const context = vm.createContext({
        document, window: { addEventListener() {} }, localStorage, navigator: {},
        performance: { now: () => now }, TextEncoder, TextDecoder, Event,
        setInterval(callback) { intervals.push(callback); }, clearInterval() {},
        setTimeout() {}, clearTimeout() {},
        requestAnimationFrame() {}, console: { ...console, warn() {} }
    });
    for (const file of scripts) {
        vm.runInContext(fs.readFileSync(path.join(root, file), 'utf8'), context, { filename: file });
    }
    let plotter;
    const OriginalPlotter = context.SerialPlotter.Plotter;
    context.SerialPlotter.Plotter = class extends OriginalPlotter {
        constructor(...args) { super(...args); plotter = this; }
    };
    ready();
    const fireCanvas = (name, x, y) => getElement('waveform-canvas').listeners[name]({
        button: 0, pointerId: 1, clientX: x, clientY: y,
        preventDefault() {}
    });
    return { getElement, getStored: () => stored, getWrites: () => writes,
        getChoiceGroup: id => choiceGroups.get(id),
        tick(ms = 1000) { now += ms; intervals.forEach(callback => callback()); },
        fireCanvas, plotter };
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
