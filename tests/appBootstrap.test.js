const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function bootWithConfig(original, fixedDate) {
    const root = path.resolve(__dirname, '..');
    const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
    const scripts = [...html.matchAll(/<script src="([^"]+)"/g)].map(match => match[1]);
    const selects = new Map([...html.matchAll(/<select[^>]*id="([^"]+)"[^>]*>([\s\S]*?)<\/select>/g)]
        .map(([, id, markup]) => [id, [...markup.matchAll(/<option([^>]*)value="([^"]+)"([^>]*)>/g)]
            .map(([, before, value, after]) => ({ value, disabled: /disabled/.test(before + after),
                selected: /selected/.test(before + after) }))]));
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
        'capture-mode': 'number', 'text-encoding': 'utf-8', 'text-boundary': 'idle',
        'idle-gap-seconds': '0.001', 'monitor-search-origin': 'byte', 'nav-jump-mode': 'absolute',
        'send-mode': 'hex', 'send-interval-unit': 's'
    };
    const elements = new Map();
    const blobs = [], downloads = [];
    const documentListeners = {};
    const makeElement = () => ({
        listeners: {},
        style: {}, dataset: {}, classList: (() => {
            const values = new Set();
            return { add(...names) { names.forEach(name => values.add(name)); },
                remove(...names) { names.forEach(name => values.delete(name)); },
                replace(from, to) { if (values.delete(from)) values.add(to); },
                contains(name) { return values.has(name); } };
        })(),
        textContent: '', innerHTML: '', value: '', checked: false,
        children: [],
        clientWidth: 800, clientHeight: 600, offsetWidth: 200, offsetHeight: 20,
        scrollHeight: 0, scrollTop: 0,
        addEventListener(name, callback) {
            const previous = this.listeners[name];
            this.listeners[name] = previous ? event => { previous(event); callback(event); } : callback;
        },
        dispatchEvent(event) { this.listeners[event.type]?.(event); },
        click() { return this.listeners.click?.(); },
        append(...items) { this.children.push(...items); },
        appendChild(item) { this.children.push(item); },
        replaceChildren(...items) { this.children = items; },
        getBoundingClientRect() { return { width: 800, height: 600, left: 0 }; },
        getContext() { return new Proxy({}, { get: () => () => {} }); }
    });
    const getElement = id => {
        if (!elements.has(id)) {
            const element = makeElement();
            element.options = selects.get(id);
            element.tagName = element.options ? 'SELECT' : 'INPUT';
            element.value = defaults[id] ?? element.options?.find(option => option.selected)?.value
                ?? element.options?.[0]?.value ?? '';
            Object.defineProperty(element, 'selectedIndex', {
                get() { return this.options?.findIndex(option => option.value === this.value) ?? -1; },
                set(index) { this.value = this.options[index]?.value ?? ''; }
            });
            if (id === 'chk-header' || id === 'rebuild-history') element.checked = true;
            element.parentElement = makeElement();
            elements.set(id, element);
        }
        return elements.get(id);
    };
    const tabButtons = new Map(), tabGroups = [];
    for (const sidebarId of ['sidebar-top', 'channel-sidebar']) {
        const start = html.indexOf(`id="${sidebarId}"`);
        const markup = html.slice(start, html.indexOf('</aside>', start));
        const buttons = [...markup.matchAll(/<button class="tab-btn([^"]*)"(?: id="([^"]+)")? data-tab="([^"]+)">([^<]+)<\/button>/g)]
            .map(([, classes, buttonId, panelId, title]) => {
                const button = makeElement(); button.dataset.tab = panelId; button.textContent = title;
                if (classes.includes('active')) button.classList.add('active');
                const panel = getElement(panelId);
                if (new RegExp(`<div class="tab-content active" id="${panelId}"`).test(markup)) panel.classList.add('active');
                if (buttonId) elements.set(buttonId, button);
                tabButtons.set(panelId, button); return button;
            });
        const group = makeElement();
        group.querySelectorAll = selector => selector === '.tab-btn' ? buttons
            : selector === '.tab-content' ? buttons.map(button => getElement(button.dataset.tab)) : [];
        tabGroups.push(group);
    }
    let ready;
    const document = {
        getElementById: getElement,
        createElement(tag) { const element = makeElement(); element.tagName = tag?.toUpperCase();
            if (tag === 'a') downloads.push(element); return element; },
        createDocumentFragment: makeElement,
        querySelector: () => makeElement(),
        querySelectorAll: selector => selector === 'select' ? [...selects.keys()].map(getElement)
            : selector === '.tab-group' ? tabGroups
                : selector === '.tab-btn' ? [...tabButtons.values()]
                    : selector === '.tab-content' ? [...tabButtons.keys()].map(getElement) : [],
        addEventListener(name, callback) {
            if (name === 'DOMContentLoaded') ready = callback;
            else (documentListeners[name] ??= []).push(callback);
        },
        body: { style: {} }
    };
    let stored = original;
    let writes = 0;
    let now = 0;
    const intervals = [];
    const timeouts = [];
    let timeoutId = 0;
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
        performance: { now: () => now }, TextEncoder, TextDecoder, Event, Date: DateForTest, Blob,
        URL: { createObjectURL(blob) { blobs.push(blob); return 'blob:test'; }, revokeObjectURL() {} },
        setInterval(callback) { intervals.push(callback); }, clearInterval() {},
        setTimeout(callback, delay = 0) {
            const id = ++timeoutId; timeouts.push({ id, callback, due: now + delay }); return id;
        },
        clearTimeout(id) { const index = timeouts.findIndex(timer => timer.id === id);
            if (index >= 0) timeouts.splice(index, 1); },
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
    let plotter, parser, monitor, rawParser, serial, sendController;
    let replayYieldHook = null;
    const replay = context.SerialPlotter.replayCaptureHistory;
    context.SerialPlotter.replayCaptureHistory = (history, format, capacity, options = {}) => replay(history,
        format, capacity, { ...options, yieldControl: async () => {
            await new Promise(resolve => context.setTimeout(resolve, 0));
            replayYieldHook?.();
        } });
    const OriginalSend = context.SerialPlotter.SendController;
    context.SerialPlotter.SendController = class extends OriginalSend {
        constructor(...args) { super(...args); sendController = this; }
    };
    const OriginalRawParser = context.SerialPlotter.RawFrameParser;
    context.SerialPlotter.RawFrameParser = class extends OriginalRawParser {
        constructor(...args) { super(...args); rawParser = this; }
    };
    const OriginalSerial = context.SerialPlotter.SerialEngine;
    context.SerialPlotter.SerialEngine = class extends OriginalSerial {
        constructor(...args) { super(...args); serial = this; }
    };
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
    return { getElement,
        setReplayYieldHook(hook) { replayYieldHook = hook; },
        async finishRebuild() {
            for (let i = 0; i < 1000; i++) {
                await Promise.resolve();
                if (getElement('history-rebuild-progress').hidden) return;
                this.flushTimeouts();
            }
            assert.fail('history rebuild did not finish');
        },
        clickTab(id) { assert.ok(tabButtons.has(id), `missing tab ${id}`); tabButtons.get(id).listeners.click(); },
        isTabActive(id) { return tabButtons.get(id)?.classList.contains('active') && getElement(id).classList.contains('active'); },
        getStored: () => stored, getWrites: () => writes,
        flushTimeouts() {
            for (let count = 0; timeouts.length && count < 1000; count++) {
                timeouts.sort((a, b) => a.due - b.due);
                const timer = timeouts.shift(); now = Math.max(now, timer.due); timer.callback();
            }
            assert.equal(timeouts.length, 0);
        },
        tick(ms = 1000) {
            now += ms;
            for (let count = 0; count < 1000; count++) {
                const index = timeouts.findIndex(timer => timer.due <= now);
                if (index < 0) break;
                timeouts.splice(index, 1)[0].callback();
            }
            intervals.forEach(callback => callback());
        },
        notifyResize(id) {
            const element = getElement(id);
            for (const observer of resizeObservers) {
                if (observer.elements.includes(element)) observer.callback();
            }
        },
        fireDocument(name, event) { for (const callback of documentListeners[name] ?? []) callback(event); },
        setSavePicker(picker) { context.window.showSaveFilePicker = picker; },
        fireCanvas, plotter, get parser() { return parser; }, monitor,
        get rawParser() { return rawParser; }, serial, sendController, alerts, blobs, downloads };
}

test('capture formats apply automatically and raw formats control display and waveform', async () => {
    const fixture = bootWithConfig(null);
    const { getElement, plotter, monitor, rawParser } = fixture;
    const mode = getElement('capture-mode');
    assert.equal(mode.value, 'number');
    assert.equal(monitor.mode, 'number');
    mode.value = 'hex';
    mode.listeners.change();
    assert.equal(getElement('format-apply-status').textContent, '');
    assert.equal(getElement('format-apply-status').hidden, true);
    assert.equal(monitor.mode, 'hex');
    assert.equal(plotter.isVisible, false);
    assert.equal(getElement('canvas-wrapper').hidden, true);
    assert.equal(getElement('btn-export').disabled, false);
    rawParser.appendData(Uint8Array.of(65));
    getElement('btn-pause').listeners.click();
    assert.equal(plotter.frames.length, 1);
    assert.deepEqual(Array.from(plotter.frames.rawBytesAt(0)), [65]);
    mode.value = 'text'; mode.listeners.change();
    await fixture.finishRebuild();
    assert.equal(monitor.mode, 'text');
    assert.equal(plotter.frames.length, 1, 'identical raw idle format preserves history');
    getElement('text-boundary').value = 'crlf';
    getElement('text-boundary').listeners.change();
    await fixture.finishRebuild();
    assert.equal(plotter.frames.length, 1);
    assert.equal(getElement('frame-idle-settings').hidden, true);
    mode.value = 'number'; mode.listeners.change();
    await fixture.finishRebuild();
    assert.equal(monitor.mode, 'number');
    assert.equal(plotter.isVisible, true);
    assert.equal(getElement('btn-export').disabled, false);
});

test('raw text configuration restores charset and framing and hidden numeric values', () => {
    const { getElement, monitor, plotter, rawParser } = bootWithConfig(JSON.stringify({
        captureMode: 'text', textEncoding: 'utf-16le', textBoundary: 'lf', idleGapSeconds: '0.01',
        channelsCount: '3', dataType: 'int16', enableHeader: true, headerHex: 'AB'
    }));
    assert.equal(monitor.mode, 'text');
    assert.equal(getElement('channels-count').value, '3');
    assert.equal(getElement('frame-numeric-settings').hidden, true);
    assert.equal(getElement('frame-header-settings').hidden, true);
    rawParser.appendData(Uint8Array.of(65, 0, 10, 0));
    assert.equal(plotter.frames.length, 1);
    assert.equal(plotter.frames.frameAt(0).incomplete, false);
    getElement('btn-pause').listeners.click();
    getElement('monitor-search-query').value = 'A';
    getElement('monitor-search-nearest').listeners.click();
    assert.equal(monitor.matches.length, 1);
    assert.equal(getElement('monitor-search-channel').hidden, true);
    assert.equal(getElement('monitor-search-origin').disabled, true);
    getElement('nav-jump-relative').value = '0';
    getElement('nav-jump-mode').value = 'relative';
    getElement('nav-jump-mode').listeners.change();
    getElement('nav-jump-button').listeners.click();
    assert.equal(monitor.cursorOrder, plotter.frames.orderAt(0));
    assert.equal(getElement('plot-view-mode').value, 'time');
    assert.equal(plotter.isVisible, false, 'time navigation cannot reopen the waveform');
});

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

test('dropdown choices persist and dependent controls follow their parent selection', () => {
    const { getElement, getStored, plotter } = bootWithConfig(null);
    const choose = (id, value) => {
        const select = getElement(id);
        select.value = value;
        select.listeners.change();
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
    tick();
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
    const { getElement } = bootWithConfig(JSON.stringify({ channelsCount: '50' }));
    const row = getElement('channel-config-list').children[0];
    const toggle = row.children[0].children[0];
    const controls = row.children[1];
    assert.equal(toggle.textContent, 'CH01');
    for (const [index, label] of [[0, 'CH01'], [8, 'CH09'], [9, 'CH10'], [49, 'CH50']]) {
        const main = getElement('channel-config-list').children[index].children[0];
        assert.equal(main.children[0].textContent, label);
        assert.equal(main.children[2].placeholder, label);
        assert.equal(main.children[2].value, label);
    }
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
    assert.equal(getElement('monitor-search-origin').disabled, true);
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
    assert.equal(getElement('monitor-search-origin').disabled, false);
    assert.equal(getElement('monitor-search-nearest').disabled, false);
    getElement('btn-pause').listeners.click();
    assert.equal(getElement('nav-jump-button').disabled, true);
    assert.equal(getElement('monitor-search-prev').disabled, true);
    assert.equal(getElement('monitor-search-next').disabled, true);
    assert.equal(getElement('monitor-search-origin').disabled, true);
    assert.equal(getElement('monitor-search-nearest').disabled, true);
});

test('pausing defaults the shared time locator to the latest retained frame timestamp', () => {
    const { getElement, parser } = bootWithConfig(null, '2026-10-02T11:00:00.000');
    for (const time of ['2026-10-02T10:29:59.120', '2026-10-02T10:30:01.347'])
        parser.onFrameParsed([1], 't', Uint8Array.of(1), new Date(time).getTime());
    getElement('btn-pause').listeners.click();
    assert.equal(getElement('nav-jump-absolute').value, '2026-10-02T10:30:01.347');
});

test('buffer settings belong to the untitled shared navigation panel', () => {
    const html = fs.readFileSync(path.resolve(__dirname, '..', 'index.html'), 'utf8');
    assert.match(html, /<section class="navigation-panel box-border" id="navigation-panel"[^>]*>/);
    assert.match(html, /aria-label="缓冲区设置"/);
    assert.match(html, /class="tool-label">缓冲区设置<\/span>/);
    assert.doesNotMatch(html, /class="monitor-title">时间定位和搜索<\/span>/);
    assert.ok(html.indexOf('id="navigation-panel"') < html.indexOf('id="board-toolbar"'));
    assert.ok(html.indexOf('id="board-toolbar"') < html.indexOf('id="nav-time-tools"'));
    assert.doesNotMatch(html, /画板与缓存/);
    assert.doesNotMatch(html, /id="(?:nav-receive-tools|monitor-display-mode|show-waveform)"/);
    assert.match(html, /<div class="monitor-tool-row" id="nav-time-tools">\s*<span class="tool-label">时间定位<\/span>\s*<div class="jump-toolbar"/);
    assert.match(html, /<div class="monitor-tool-row" id="nav-search-tools">\s*<span class="tool-label">搜索<\/span>\s*<div class="monitor-search-toolbar"/);
    assert.ok(html.indexOf('id="v-resizer"') < html.indexOf('id="monitor-panel"'));
    assert.ok(html.indexOf('id="monitor-panel"') < html.indexOf('id="send-panel"'));
    assert.ok(html.indexOf('id="send-panel"') < html.indexOf('id="navigation-panel"'));
    assert.ok(html.indexOf('id="navigation-panel"') < html.indexOf('</main>'));
    assert.match(html, /<\/section>\s*<\/main>/);
    assert.match(html, /<\/div>\s*<!-- 独立[^>]*-->\s*<section class="navigation-panel box-border"/);
    assert.doesNotMatch(html, /id="monitor-search-button"/);
    assert.doesNotMatch(html, /id="(?:wave-tools|byte-tools|byte-search-tools)"/);
    assert.doesNotMatch(html, /<details class="monitor-tools"|<summary id="(?:wave|byte)-tools-summary"/);
});

test('applied capture format determines search type and numeric fields', () => {
    const { getElement, monitor } = bootWithConfig(null);
    getElement('btn-pause').listeners.click();
    assert.equal(getElement('monitor-search-tolerance').hidden, false);
    const mode = getElement('capture-mode');
    mode.value = 'text'; mode.listeners.change();
    assert.equal(monitor.mode, 'text');
    assert.equal(getElement('monitor-search-tolerance').hidden, true);
    assert.equal(getElement('monitor-search-channel').hidden, true);
    assert.equal(getElement('monitor-search-origin').disabled, true);
});

test('numeric search supports selecting multiple channels without searching the others', () => {
    const { getElement, parser, monitor } = bootWithConfig(JSON.stringify({ channelsCount: '3' }));
    parser.onFrameParsed([1, 1, 1], 't1', Uint8Array.of(1), 1000);
    parser.onFrameParsed([2, 1, 1], 't2', Uint8Array.of(2), 1001);
    getElement('btn-pause').listeners.click();

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
    assert.equal(getElement('monitor-search-channel-toggle').textContent, 'CH01、CH03');

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

test('numeric search channel choices show saved names and track renames without losing selection', () => {
    const { getElement, parser, monitor } = bootWithConfig(JSON.stringify({ channelsCount: '2',
        channels: [{ name: 'acc_x', visible: true }, { name: 'CH2', visible: false }] }));
    const picker = getElement('monitor-search-channel-options');
    assert.equal(picker.children[1].children[1].textContent, 'CH01 · acc_x',
        'saved names are reflected even before switching receive display');
    assert.equal(picker.children[2].children[1].textContent, 'CH02');
    parser.onFrameParsed([42, 42], 't', Uint8Array.of(1), 1000);
    getElement('btn-pause').listeners.click();
    const first = picker.children[1].children[0];
    first.checked = true;
    first.listeners.change();
    const toggle = getElement('monitor-search-channel-toggle');
    assert.equal(toggle.textContent, 'CH01 · acc_x');
    getElement('monitor-search-query').value = '42';
    getElement('monitor-search-nearest').listeners.click();
    const matches = monitor.matches;
    const nameInput = getElement('channel-config-list').children[0].children[0].children[2];
    nameInput.value = '<b>加速度</b>';
    nameInput.listeners.change();
    assert.equal(picker.children[1].children[1].textContent, 'CH01 · <b>加速度</b>');
    assert.equal(picker.children[1].title, 'CH01 · <b>加速度</b>');
    assert.equal(toggle.textContent, 'CH01 · <b>加速度</b>');
    assert.equal(toggle.title, 'CH01 · <b>加速度</b>');
    assert.equal(first.checked, true);
    assert.equal(monitor.matches, matches, 'renaming does not invalidate the numeric search results');
    nameInput.value = '';
    nameInput.listeners.change();
    assert.equal(picker.children[1].children[1].textContent, 'CH01');
    assert.equal(toggle.textContent, 'CH01');
});

test('automatically applying a new parser preserves original history and changes search', async () => {
    const fixture = bootWithConfig(null);
    const { getElement, parser, monitor } = fixture;
    parser.onFrameParsed([2], 't', Uint8Array.of(0x41), Date.now());
    getElement('btn-pause').listeners.click();
    getElement('monitor-search-query').value = '2';
    getElement('monitor-search-nearest').listeners.click();
    assert.equal(monitor.matches.length, 1);
    const mode = getElement('capture-mode');
    mode.value = 'text'; mode.listeners.change();
    await fixture.finishRebuild();
    assert.equal(monitor.matches.length, 0);
    assert.equal(getElement('monitor-search-status').textContent, '');
    getElement('btn-pause').listeners.click();
    fixture.serial.onDataCallback(Uint8Array.of(0x41));
    getElement('btn-pause').listeners.click();
    getElement('monitor-search-query').value = 'A';
    getElement('monitor-search-nearest').listeners.click();
    assert.equal(monitor.matches.length, 2);
    assert.equal(monitor.mode, 'text');
});

test('nearest origin selects the wave center or byte center and reuses the matches', () => {
    const { getElement, parser, plotter, monitor } = bootWithConfig(null);
    for (let index = 0; index < 10; index++)
        parser.onFrameParsed([index === 1 || index === 7 ? 42 : index], `t${index}`,
            Uint8Array.of(index), 1000 + index);
    getElement('btn-pause').listeners.click();
    getElement('monitor-search-query').value = '42';
    plotter.vp.time.displayCount = 4;
    plotter.vp.time.scrollOffset = 3; // visible frame indexes 3..6, centered near order 6
    plotter.vp.time.autoFollow = false;
    monitor.cursorOrder = 2;
    getElement('monitor-search-origin').value = 'wave';
    getElement('monitor-search-nearest').listeners.click();
    assert.equal(monitor.matches[monitor.currentMatch].startOrder, 8);
    assert.equal(plotter._timeCenterOrder, 8);
    const cachedMatches = monitor.matches;

    monitor.jumpToFrame(1);
    getElement('monitor-search-origin').value = 'byte';
    getElement('monitor-search-nearest').listeners.click();
    assert.equal(monitor.matches, cachedMatches);
    assert.equal(monitor.matches[monitor.currentMatch].startOrder, 2);
    assert.equal(plotter._timeCenterOrder, 2);
});

test('first previous skips the nearest result then uses the normal direction and cache', () => {
    const { getElement, parser, monitor, plotter } = bootWithConfig(null);
    for (const [index, byte] of [0x41, 0x42, 0x41, 0x42].entries())
        parser.onFrameParsed([byte === 0x41 ? 41 : 42], `t${index}`, Uint8Array.of(byte), 1000 + index);
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
        parser.onFrameParsed([byte === 0x41 ? 41 : 42], `t${index}`, Uint8Array.of(byte), 1000 + index);
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
        parser.onFrameParsed([byte === 0x41 ? 41 : 42], `t${index}`, Uint8Array.of(byte), 1000 + index);
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
    getElement('monitor-search-query').value = '42';
    return fixture;
}

test('first direction is reversed only before a result is selected', () => {
    for (const [action, firstFrame, secondFrame] of [['prev', 300, 200], ['next', 100, 200],
        ['nearest', 200, 200]]) {
        const { getElement, plotter, monitor } = numericSearchFixture([100, 200, 300]);
        plotter.jumpToFrame(209);
        getElement('monitor-search-origin').value = 'wave';
        getElement(`monitor-search-${action}`).listeners.click();
        assert.equal(monitor.matches[monitor.currentMatch].startFrame + 1, firstFrame);
        getElement(`monitor-search-${action}`).listeners.click();
        assert.equal(monitor.matches[monitor.currentMatch].startFrame + 1, secondFrame);
    }
});

test('nearest uses the latest frame by default and the time viewport in frequency mode', () => {
    const { getElement, plotter, monitor } = numericSearchFixture([100, 200, 300]);
    assert.equal(getElement('monitor-search-origin').value, 'byte');
    getElement('monitor-search-nearest').listeners.click();
    assert.equal(monitor.matches[monitor.currentMatch].startFrame, 299);
    plotter.jumpToFrame(109);
    plotter.setDisplayOptions({ displayMode: 'frequency' });
    getElement('monitor-search-origin').value = 'wave';
    getElement('monitor-search-nearest').listeners.click();
    assert.equal(monitor.matches[monitor.currentMatch].startFrame, 99);
});

test('nearest resolves an equal distance toward the earlier frame', () => {
    const { getElement, plotter, monitor } = numericSearchFixture([100, 200, 300]);
    plotter.jumpToFrame(249);
    getElement('monitor-search-origin').value = 'wave';
    getElement('monitor-search-nearest').listeners.click();
    assert.equal(monitor.matches[monitor.currentMatch].startFrame, 199);
});

test('an even-sized time window chooses the earlier result at its midpoint', () => {
    const { getElement, plotter, monitor } = numericSearchFixture([4, 7], 10);
    plotter.vp.time.displayCount = 4;
    plotter.vp.time.scrollOffset = 3;
    plotter.vp.time.autoFollow = false;
    getElement('monitor-search-origin').value = 'wave';
    getElement('monitor-search-nearest').listeners.click();
    assert.equal(monitor.matches[monitor.currentMatch].startFrame, 3);
});

test('selected results cycle normally across both ends and survive changing the origin', () => {
    const { getElement, plotter, monitor } = numericSearchFixture([100, 200, 300]);
    getElement('monitor-search-nearest').listeners.click();
    const matches = monitor.matches;
    plotter.jumpToFrame(99);
    getElement('monitor-search-origin').value = 'wave';
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
    getElement('monitor-search-origin').value = 'wave';
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
    const relativeChoice = getElement('nav-jump-mode');
    relativeChoice.value = 'relative';
    relativeChoice.listeners.change();
    assert.equal(getElement('nav-jump-mode').value, 'relative');
    assert.equal(getElement('nav-jump-relative').hidden, false);
    assert.equal(getElement('nav-jump-absolute').hidden, true);
    const absoluteChoice = getElement('nav-jump-mode');
    absoluteChoice.value = 'absolute';
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

test('send and interval dropdown choices update controls and preserve conversion', () => {
    const { getElement, getStored } = bootWithConfig(null);
    getElement('send-input').value = '41';
    getElement('send-mode').value = 'text';
    getElement('send-mode').listeners.change();
    assert.equal(getElement('send-input').value, 'A');
    getElement('send-interval-unit').value = 'hz';
    getElement('send-interval-unit').listeners.change();
    assert.equal(JSON.parse(getStored()).sendIntervalUnit, 'hz');
});

test('legacy millisecond interval unit restores the second choice', () => {
    const { getElement } = bootWithConfig(JSON.stringify({ sendIntervalUnit: 'ms' }));
    assert.equal(getElement('send-interval-unit').value, 's');
});

test('independent navigation panel reserves its own height while preserving four log rows', () => {
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
    assert.ok(parseInt(getElement('monitor-panel').style.height, 10) >= 280);
    const allocated = parseInt(getElement('canvas-wrapper').style.height) +
        parseInt(getElement('monitor-panel').style.height) + getElement('navigation-panel').offsetHeight;
    const fixed = 16 + 6 + getElement('v-resizer').offsetHeight;
    assert.ok(allocated + fixed <= main.clientHeight);
});

test('shared time and search controls remain visible with the minimum log space', () => {
    const { getElement, notifyResize } = bootWithConfig(null);
    getElement('main-display').clientHeight = 900;
    getElement('v-resizer').offsetHeight = 20;
    getElement('monitor-header').offsetHeight = 40;
    getElement('monitor-stats').offsetHeight = 40;
    getElement('send-panel').offsetHeight = 154;
    getElement('navigation-panel').offsetHeight = 209;
    getElement('plot-header').offsetHeight = 150;
    notifyResize('navigation-panel');
    assert.ok(parseInt(getElement('monitor-panel').style.height, 10) >= 334);
    assert.notEqual(getElement('navigation-panel').hidden, true);
    assert.notEqual(getElement('nav-time-tools').hidden, true);
    assert.notEqual(getElement('nav-search-tools').hidden, true);
});

test('presentation-only raw format switches keep bytes and clear incompatible search highlights', () => {
    const { getElement, rawParser, monitor, plotter } = bootWithConfig(JSON.stringify({ captureMode: 'hex' }));
    rawParser.appendData(Uint8Array.of(0x41));
    getElement('btn-pause').listeners.click();
    getElement('monitor-search-query').value = '41';
    getElement('monitor-search-nearest').listeners.click();
    assert.equal(monitor.matches.length, 1);
    getElement('capture-mode').value = 'text';
    getElement('capture-mode').listeners.change();
    assert.equal(plotter.frames.length, 1);
    assert.equal(monitor.matches.length, 0);
    assert.equal(getElement('monitor-search-status').textContent, '');
    getElement('monitor-search-nearest').listeners.click();
    assert.equal(monitor.matches.length, 0);
});

test('legacy imports validate numeric defaults before changing an active raw format', () => {
    const fixture = bootWithConfig(JSON.stringify({ captureMode: 'hex' }));
    const { getElement, rawParser, plotter, monitor, alerts } = fixture;
    rawParser.appendData(Uint8Array.of(65)); rawParser.flushPending();
    const target = { files: [{ text: JSON.stringify({ enableHeader: true, headerHex: 'GG' }) }], value: 'old.json' };
    getElement('cfg-file-input').listeners.change({ target });
    assert.equal(alerts.length, 1);
    assert.equal(getElement('capture-mode').value, 'hex');
    assert.equal(monitor.mode, 'hex');
    assert.equal(plotter.frames.length, 1);
});

test('transport entry, disconnect tail and pause share applied raw framing and statistics', () => {
    const { getElement, serial, plotter, tick, monitor } = bootWithConfig(JSON.stringify({
        captureMode: 'text', textBoundary: 'crlf' }));
    serial.onDataCallback(new TextEncoder().encode('中'));
    serial.onDataCallback(new TextEncoder().encode('文\r\n尾'));
    assert.equal(plotter.frames.length, 1);
    serial.onConnectStatusChange(false);
    assert.equal(plotter.frames.length, 2);
    assert.equal(plotter.frames.frameAt(1).incomplete, true);
    tick();
    assert.equal(getElement('stat-rx-value').textContent, '11 B/s');
    assert.equal(getElement('stat-fps-value').textContent, '2 f/s');
    getElement('btn-pause').listeners.click();
    serial.onDataCallback(new TextEncoder().encode('丢弃\r\n'));
    tick();
    assert.equal(plotter.frames.length, 2);
    assert.equal(getElement('stat-rx-value').textContent, '11 B/s');
    assert.equal(monitor.mode, 'text');
});

test('autosaving unrelated options persists applied format while a field is still being edited', () => {
    const { getElement, getStored } = bootWithConfig(null);
    getElement('channels-count').value = '2';
    getElement('channels-count').listeners.input();
    getElement('plot-view-mode').value = 'frequency';
    getElement('plot-view-mode').listeners.change();
    const saved = JSON.parse(getStored());
    assert.equal(saved.captureMode, 'number');
    assert.equal(saved.channelsCount, '1');
    assert.equal(getElement('format-apply-status').textContent, '');
    assert.equal(getElement('format-apply-status').hidden, true);
    getElement('channels-count').listeners.change();
    assert.equal(JSON.parse(getStored()).channelsCount, '2');
});

test('raw nearest origin displays byte position and restores the numeric session choice', () => {
    const { getElement } = bootWithConfig(null);
    const origin = getElement('monitor-search-origin');
    origin.value = 'wave';
    getElement('capture-mode').value = 'hex';
    getElement('capture-mode').listeners.change();
    assert.equal(origin.value, 'byte');
    assert.equal(origin.disabled, true);
    getElement('capture-mode').value = 'number';
    getElement('capture-mode').listeners.change();
    getElement('btn-pause').listeners.click();
    assert.equal(origin.value, 'wave');
    assert.equal(origin.disabled, false);
});

test('import uses resolved applied settings instead of unapplied numeric drafts', () => {
    const { getElement, plotter, monitor, alerts } = bootWithConfig(JSON.stringify({ captureMode: 'hex' }));
    getElement('capture-mode').value = 'number';
    getElement('frame-header').value = 'GG';
    const target = { files: [{ text: JSON.stringify({ maxPoints: '2000' }) }], value: 'old.json' };
    getElement('cfg-file-input').listeners.change({ target });
    assert.equal(alerts.length, 0);
    assert.equal(getElement('frame-header').value, 'AB');
    assert.equal(monitor.mode, 'number');
    assert.equal(plotter.maxPoints, 2000);
    assert.equal(getElement('max-points').value, '2000');
});

test('old configs with a smaller history restore a clamped default plot window', () => {
    const { getElement, plotter } = bootWithConfig(JSON.stringify({ maxPoints: '500' }));
    assert.equal(getElement('max-points').value, '500');
    assert.equal(plotter.maxPoints, 500);
    assert.equal(getElement('plot-window-points').value, '500');
});

test('frame format changes apply automatically, inactive fields hide, and invalid edits retain acquisition', async () => {
    const fixture = bootWithConfig(null);
    const { getElement, serial, parser, monitor, plotter, alerts } = fixture;
    const header = getElement('chk-header'); header.checked = false; header.listeners.change();
    assert.equal(getElement('header-config').hidden, true);
    const type = getElement('data-type'); type.value = 'float64'; type.listeners.change();
    assert.equal(parser.dataType, 'float64');
    serial.onDataCallback(Uint8Array.of(0,0,0,0,0,0,0xf0,0x3f));
    assert.equal(plotter.frames.getValue(0,0), 1);
    getElement('channels-count').value = '0'; getElement('channels-count').listeners.change();
    assert.equal(parser.channelsCount, 1);
    assert.equal(plotter.frames.length, 1);
    assert.match(getElement('format-apply-status').textContent, /通道数/);
    assert.equal(getElement('format-apply-status').hidden, false);
    assert.equal(alerts.length, 0);
    getElement('channels-count').value = '1'; getElement('channels-count').listeners.change();
    const mode = getElement('capture-mode'); mode.value = 'hex'; mode.listeners.change();
    await fixture.finishRebuild();
    assert.equal(monitor.mode, 'hex');
    assert.equal(getElement('channels-display-panel').hidden, true);
    assert.equal(getElement('plot-window-control').hidden, true);
    assert.equal(getElement('max-points-label').textContent, '最大帧数量');
    assert.equal(getElement('idle-gap-seconds').value, '0.001');
    assert.equal(getElement('btn-export').disabled, false);
});

test('frame and communications settings have peer left tabs and export has a right tab', () => {
    const html = fs.readFileSync(path.resolve(__dirname, '..', 'index.html'), 'utf8');
    assert.match(html, /data-tab="tab-export"/);
    const connectionPage = html.slice(html.indexOf('id="tab-connection"'), html.indexOf('id="tab-frame"'));
    assert.doesNotMatch(connectionPage, /id="export-panel"/);
    assert.doesNotMatch(connectionPage, /id="capture-mode"|id="rebuild-history"/);
    assert.match(connectionPage, /id="cfg-save-status"/);
    assert.doesNotMatch(connectionPage, /id="frame-raw-settings"/);
    const right = html.slice(html.indexOf('id="channel-sidebar"'));
    assert.match(right, /id="export-panel"/);
    assert.doesNotMatch(right, /sidebar-section-header/);
    assert.doesNotMatch(html, /id="sidebar-resizer"|id="sidebar-controls"/);
    assert.ok(html.indexOf('id="main-display"') < html.indexOf('id="board-toolbar"'));
    assert.ok(html.indexOf('id="canvas-wrapper"') < html.indexOf('id="board-toolbar"'));
    const options = html.match(/<select id="capture-mode">([\s\S]*?)<\/select>/)[1];
    assert.deepEqual([...options.matchAll(/value="([^"]+)"/g)].map(m => m[1]), ['hex','text','number','custom']);
});

test('merged buffer controls are counted only through the shared panel height', () => {
    const { getElement, notifyResize } = bootWithConfig(null);
    getElement('main-display').clientHeight = 1000;
    getElement('board-toolbar').offsetHeight = 80;
    getElement('navigation-panel').offsetHeight = 160;
    notifyResize('navigation-panel');
    const plot = getElement('canvas-wrapper'), monitor = getElement('monitor-panel');
    const reserved = 16 + 6 + getElement('v-resizer').offsetHeight +
        getElement('navigation-panel').offsetHeight;
    assert.ok(Math.abs(parseInt(plot.style.height) + parseInt(monitor.style.height) - (1000 - reserved)) <= 1);
    const before = parseInt(plot.style.height);
    getElement('board-toolbar').offsetHeight = 140;
    getElement('navigation-panel').offsetHeight = 220;
    notifyResize('navigation-panel');
    assert.ok(parseInt(plot.style.height) < before);
    assert.notEqual(getElement('board-toolbar').hidden, true);
    getElement('capture-mode').value = 'hex'; getElement('capture-mode').listeners.change();
    assert.equal(getElement('canvas-wrapper').hidden, true);
    assert.notEqual(getElement('board-toolbar').hidden, true);
    assert.equal(getElement('max-points-label').textContent, '最大帧数量');
});

test('raw exports include retained successful TX records beyond the visible extra log limit', async () => {
    const { getElement, rawParser, sendController, blobs, downloads } = bootWithConfig(JSON.stringify({captureMode:'hex'}));
    rawParser.appendData(Uint8Array.of(1,2)); rawParser.flushPending();
    for(let i=0;i<125;i++) sendController.onSent(Uint8Array.of(i));
    getElement('export-format').value = 'binary'; getElement('export-format').listeners.change();
    getElement('export-direction').value = 'both';
    await getElement('btn-export').listeners.click();
    assert.ok(downloads[0].download.endsWith('.bin'));
    assert.deepEqual(Array.from(new Uint8Array(await blobs[0].arrayBuffer())), [1,2,...Array.from({length:125},(_,i)=>i)]);
    getElement('max-points').value = '2'; getElement('max-points').listeners.change();
    getElement('export-direction').value = 'tx';
    await getElement('btn-export').listeners.click();
    assert.deepEqual(Array.from(new Uint8Array(await blobs[1].arrayBuffer())), [123,124]);
    getElement('btn-clear').listeners.click();
    await getElement('btn-export').listeners.click();
    assert.equal(blobs.length, 2);
});


test('large combined raw exports succeed when the TX buffer is empty', async () => {
    const { getElement, rawParser, setSavePicker, alerts } = bootWithConfig(JSON.stringify({ captureMode: 'hex' }));
    const size = 32 * 1024 * 1024 + 1;
    const bytes = new Uint8Array(size); bytes[0] = 0x41; bytes[size - 1] = 0xff;
    rawParser.appendData(bytes); rawParser.flushPending();
    let written = 0, closed = false;
    setSavePicker(async () => ({ createWritable: async () => ({
        async write(chunk) { written += chunk.length; assert.equal(chunk[0], 0x41); assert.equal(chunk[chunk.length - 1], 0xff); },
        async close() { closed = true; }, async abort() { assert.fail('unchanged export must not abort'); }
    }) }));
    getElement('export-format').value = 'binary'; getElement('export-format').listeners.change();
    getElement('export-direction').value = 'both';
    await getElement('btn-export').listeners.click();
    assert.deepEqual(alerts, []);
    assert.equal(written, size); assert.equal(closed, true);
});

test('text TX-only export works without RX and readable metadata follows the selected format', async () => {
    const { getElement, sendController, blobs, alerts } = bootWithConfig(JSON.stringify({ captureMode: 'text' }));
    sendController.onSent(new TextEncoder().encode('中文\n'));
    getElement('export-direction').value = 'tx';
    getElement('export-markers').checked = true;
    await getElement('btn-export').listeners.click();
    assert.equal(await blobs[0].text(), 'TX 中文\n');
    assert.deepEqual(alerts, []);
    assert.equal(getElement('export-text-metadata').hidden, false);
    getElement('capture-mode').value = 'number'; getElement('capture-mode').listeners.change();
    assert.equal(getElement('export-format').value, 'csv');
    assert.equal(getElement('wrap-export-direction').hidden, true);
    assert.equal(getElement('export-text-metadata').hidden, false);
});


test('CSV export exposes timestamps without raw markers and keeps the selection across formats', async () => {
    const { getElement, parser, blobs } = bootWithConfig(null);
    assert.equal(getElement('export-text-metadata').hidden, false);
    assert.equal(getElement('wrap-export-markers').hidden, true);
    parser.onFrameParsed([3], '22:13:20.123', Uint8Array.of(3), 1700000000123);
    getElement('export-timestamps').checked = true;
    await getElement('btn-export').listeners.click();
    assert.match(await blobs[0].text(), /Index,Timestamp,CH01\r\n0,2023-11-14T22:13:20.123Z,3/);
    const mode = getElement('capture-mode'); mode.value = 'hex'; mode.listeners.change();
    assert.equal(getElement('export-timestamps').checked, true);
    assert.equal(getElement('wrap-export-markers').hidden, false);
    getElement('export-format').value = 'binary'; getElement('export-format').listeners.change();
    assert.equal(getElement('export-text-metadata').hidden, true);
    assert.equal(getElement('export-binary-hint').hidden, false);
});


test('byte and waveform tabs preserve communications and hide only waveform controls in raw modes', () => {
    const { getElement, clickTab, isTabActive } = bootWithConfig(null);
    assert.equal(isTabActive('tab-connection'), true);
    assert.equal(isTabActive('tab-monitor-config'), true);
    clickTab('tab-waveform-config');
    assert.equal(isTabActive('tab-waveform-config'), true);
    assert.equal(isTabActive('tab-monitor-config'), false);
    assert.equal(isTabActive('tab-connection'), true);
    clickTab('tab-connection');
    assert.equal(isTabActive('tab-waveform-config'), true);
    assert.equal(isTabActive('tab-connection'), true);
    const mode = getElement('capture-mode'); mode.value = 'hex'; mode.listeners.change();
    assert.equal(getElement('channel-sidebar').hidden, false);
    assert.equal(isTabActive('tab-monitor-config'), true);
    assert.equal(getElement('tab-waveform-config-button').hidden, true);
    assert.equal(getElement('tab-monitor-config-button').hidden, false);
    assert.equal(getElement('monitor-display-panel').hidden, false);
    assert.equal(getElement('monitor-config-panel').hidden, false);
    assert.equal(getElement('monitor-hex-options').hidden, false);
    assert.equal(getElement('monitor-text-options').hidden, true);
    mode.value = 'number'; mode.listeners.change();
    assert.equal(getElement('channel-sidebar').hidden, false);
    assert.equal(isTabActive('tab-monitor-config'), true);
    assert.equal(getElement('tab-waveform-config-button').hidden, false);
    assert.equal(isTabActive('tab-connection'), true);
    assert.equal(getElement('monitor-display-panel').hidden, false);
    assert.equal(getElement('monitor-config-panel').hidden, false);
});

test('raw display settings update and persist without clearing RX TX search or changing framing', async () => {
    const fixture = bootWithConfig(JSON.stringify({ captureMode: 'hex', rebuildHistory: false }));
    const { getElement, serial, sendController, plotter, monitor, getStored } = fixture;
    serial.onDataCallback(Uint8Array.of(65, 66, 67));
    getElement('btn-pause').click();
    sendController.onSent(Uint8Array.of(90));
    getElement('monitor-search-query').value = '41';
    getElement('monitor-search-nearest').click();
    const matches = monitor.matches.length;
    const frames = plotter.frames;
    const progressHidden = getElement('history-rebuild-progress').hidden;
    const hexWidth = getElement('monitor-hex-bytes-per-line');
    assert.equal(typeof hexWidth.listeners.change, 'function');
    hexWidth.value = '8'; hexWidth.listeners.change();
    const showRx = getElement('monitor-show-rx');
    showRx.checked = false; showRx.listeners.change();
    const keyword = getElement('monitor-keyword');
    keyword.value = 'alarm\nERROR'; keyword.listeners.input();
    const fold = getElement('monitor-fold-long');
    fold.checked = true; fold.listeners.change();
    assert.equal(getElement('monitor-fold-lines-wrap').hidden, false);
    assert.equal(plotter.frames, frames);
    assert.deepEqual(Array.from(frames.rawBytesAt(0)), [65, 66, 67]);
    assert.equal(monitor.extras.length, 1);
    assert.equal(monitor.matches.length, matches);
    assert.equal(getElement('history-rebuild-progress').hidden, progressHidden);
    const saved = JSON.parse(getStored());
    assert.equal(saved.monitorDisplay.hexBytesPerLine, 8);
    assert.equal(saved.monitorDisplay.showRx, false);
    assert.equal(saved.monitorDisplay.keyword, 'alarm\nERROR');
    assert.equal(saved.monitorDisplay.foldLong, true);
    assert.equal(saved.captureMode, 'hex');
    assert.equal(saved.textBoundary, 'idle');
    getElement('export-format').value = 'binary'; getElement('export-format').listeners.change();
    await getElement('btn-export').click();
    assert.deepEqual(Array.from(new Uint8Array(await fixture.blobs.at(-1).arrayBuffer())), [65, 66, 67]);
});

test('text search case checkbox invalidates prior results without changing capture or other search modes', () => {
    const { getElement, serial, monitor, plotter } = bootWithConfig(JSON.stringify({ captureMode: 'text', rebuildHistory: false }));
    const caseOption = getElement('monitor-search-case-sensitive');
    assert.equal(caseOption.checked, true);
    assert.equal(caseOption.disabled, true);
    assert.equal(getElement('monitor-search-case-wrap').hidden, false);
    serial.onDataCallback(new TextEncoder().encode('Error error ERROR'));
    getElement('btn-pause').click();
    const bytes = Array.from(plotter.frames.rawBytesAt(0));
    assert.equal(caseOption.disabled, false);
    const query = getElement('monitor-search-query');
    query.value = 'error'; query.listeners.input();
    getElement('monitor-search-nearest').click();
    assert.equal(monitor.matches.length, 1);
    caseOption.checked = false; caseOption.listeners.change();
    assert.equal(monitor.matches.length, 0);
    getElement('monitor-search-nearest').click();
    assert.equal(monitor.matches.length, 3);
    assert.deepEqual(Array.from(plotter.frames.rawBytesAt(0)), bytes);
    getElement('capture-mode').value = 'hex'; getElement('capture-mode').listeners.change();
    assert.equal(getElement('monitor-search-case-wrap').hidden, true);
    assert.equal(caseOption.checked, false);
});

test('record and search colors persist and update waveform markers without clearing matches', () => {
    const { getElement, serial, monitor, plotter, getStored } = bootWithConfig(JSON.stringify({ captureMode: 'hex' }));
    serial.onDataCallback(Uint8Array.of(65, 66));
    getElement('btn-pause').click();
    getElement('monitor-search-query').value = '41';
    getElement('monitor-search-nearest').click();
    const matches = monitor.matches;
    const color = getElement('monitor-search-current-color');
    color.value = '#abcdef'; color.listeners.input();
    assert.equal(monitor.matches, matches);
    assert.equal(plotter.navigationColors.current, '#abcdef');
    assert.equal(JSON.parse(getStored()).monitorDisplay.searchCurrentColor, '#abcdef');
    assert.deepEqual(Array.from(plotter.frames.rawBytesAt(0)), [65, 66]);
});

test('monitor display restores settings and legacy imports reset defaults while numeric views retain them', () => {
    const { getElement, getStored } = bootWithConfig(JSON.stringify({ captureMode: 'text',
        monitorDisplay: { textInvalid: 'escape', textNewline: 'line-break', textTab: 'spaces-8',
            timestamp: 'none', showDirection: false, foldLong: true, foldLines: 3, numericSignificantDigits: 12 } }));
    assert.equal(getElement('monitor-text-invalid').value, 'escape');
    assert.equal(getElement('monitor-text-options').hidden, false);
    assert.equal(getElement('monitor-hex-options').hidden, true);
    assert.equal(getElement('monitor-fold-lines').value, '3');
    assert.equal(getElement('monitor-numeric-significant-digits').value, '12');
    assert.equal(getElement('monitor-number-options').hidden, true);
    getElement('capture-mode').value = 'number'; getElement('capture-mode').listeners.change();
    assert.equal(getElement('monitor-display-panel').hidden, false);
    assert.equal(getElement('monitor-number-options').hidden, false);
    const precision = getElement('monitor-numeric-significant-digits');
    precision.value = '7'; precision.listeners.input();
    assert.equal(JSON.parse(getStored()).monitorDisplay.numericSignificantDigits, 7);
    assert.equal(JSON.parse(getStored()).monitorDisplay.textTab, 'spaces-8');
    getElement('cfg-file-input').listeners.change({ target: { files: [{ text: JSON.stringify({ captureMode: 'hex' }) }] } });
    assert.equal(getElement('monitor-text-invalid').value, 'replacement');
    assert.equal(getElement('monitor-timestamp').value, 'clock');
    assert.equal(getElement('monitor-show-direction').checked, true);
    assert.equal(getElement('monitor-fold-lines-wrap').hidden, true);
    assert.equal(JSON.parse(getStored()).monitorDisplay.textTab, 'escape');
    assert.equal(getElement('monitor-numeric-significant-digits').value, '6');
    assert.equal(getElement('monitor-number-options').hidden, true);
});

test('invalid display edits keep the last applied settings and select wheels apply the next option', () => {
    const { getElement, monitor, getStored, getWrites } = bootWithConfig(JSON.stringify({ captureMode: 'hex' }));
    const fold = getElement('monitor-fold-lines');
    assert.equal(typeof fold.listeners.change, 'function');
    const writes = getWrites();
    fold.value = '0'; fold.listeners.change();
    assert.equal(monitor.displayOptions.foldLines, 8);
    assert.equal(getWrites(), writes);
    assert.equal(getElement('monitor-display-status').hidden, false);
    fold.value = '4'; fold.listeners.change();
    assert.equal(monitor.displayOptions.foldLines, 4);
    assert.equal(getElement('monitor-display-status').hidden, true);
    const width = getElement('monitor-hex-bytes-per-line');
    width.listeners.wheel({ deltaY: 100, preventDefault() {} });
    assert.equal(width.value, '8');
    assert.equal(monitor.displayOptions.hexBytesPerLine, 8);
    assert.equal(JSON.parse(getStored()).monitorDisplay.hexBytesPerLine, 8);
});

test('unapplied display drafts do not block unrelated saves or legacy imports', () => {
    const { getElement, getStored, monitor, alerts } = bootWithConfig(JSON.stringify({ captureMode: 'hex',
        monitorDisplay: { foldLines: 3 } }));
    const fold = getElement('monitor-fold-lines');
    fold.value = '0'; fold.listeners.input();
    const direction = getElement('monitor-show-direction');
    direction.checked = false; direction.listeners.change();
    assert.equal(monitor.displayOptions.showDirection, true);
    getElement('send-interval-unit').value = 's'; getElement('send-interval-unit').listeners.change();
    assert.equal(JSON.parse(getStored()).monitorDisplay.foldLines, 3);
    assert.equal(JSON.parse(getStored()).monitorDisplay.showDirection, true);
    getElement('cfg-file-input').listeners.change({ target: { files: [{ text: JSON.stringify({ captureMode: 'hex' }) }] } });
    assert.deepEqual(alerts, []);
    assert.equal(fold.value, '8');
    assert.equal(direction.checked, true);
    assert.equal(monitor.displayOptions.foldLines, 8);
});

test('history replays original bytes across text, Hex and numeric formats without losing TX', async () => {
    const fixture = bootWithConfig(JSON.stringify({ captureMode: 'hex', enableHeader: false, dataType: 'uint8' }));
    const { getElement, serial, plotter, sendController, blobs } = fixture;
    serial.onDataCallback(Uint8Array.of(65, 10, 66, 10));
    getElement('btn-pause').listeners.click();
    sendController.onSent(Uint8Array.of(90));
    const originalTime = plotter.frames.timestampAt(0);
    getElement('text-boundary').value = 'lf';
    getElement('capture-mode').value = 'text';
    getElement('capture-mode').listeners.change();
    assert.equal(getElement('history-rebuild-progress').hidden, false);
    assert.equal(getElement('btn-export').disabled, true);
    await fixture.finishRebuild();
    assert.equal(plotter.frames.length, 2);
    assert.deepEqual(Array.from(plotter.frames.rawBytesAt(0)), [65, 10]);
    assert.equal(plotter.frames.timestampAt(0), originalTime);
    assert.equal(getElement('stat-fail-value').textContent, '0 / 4 (0.0%)');
    getElement('export-direction').value = 'tx';
    await getElement('btn-export').listeners.click();
    assert.equal(await blobs.at(-1).text(), 'Z');
    getElement('capture-mode').value = 'number';
    getElement('capture-mode').listeners.change();
    await fixture.finishRebuild();
    assert.deepEqual(Array.from({ length: 4 }, (_, i) => plotter.frames.getValue(0, i)), [65, 10, 66, 10]);
    getElement('capture-mode').value = 'hex';
    getElement('capture-mode').listeners.change();
    await fixture.finishRebuild();
    assert.equal(plotter.frames.length, 1);
    assert.deepEqual(Array.from(plotter.frames.rawBytesAt(0)), [65, 10, 66, 10]);
});

test('text statistics count illegal characters, exempt CR LF TAB and update while paused', () => {
    const { getElement, serial, tick } = bootWithConfig(JSON.stringify({ captureMode: 'text', textBoundary: 'lf' }));
    serial.onDataCallback(Uint8Array.of(65, 0, 0xff, 13, 10, 9));
    tick();
    assert.equal(getElement('stat-fail-label').textContent, '失败字符 / 总字符:');
    assert.equal(getElement('stat-fail-value').textContent, '2 / 6 (33.3%)');
    getElement('btn-pause').listeners.click();
    assert.equal(getElement('stat-fail-value').textContent, '2 / 6 (33.3%)');
    getElement('btn-clear').listeners.click();
    assert.equal(getElement('stat-fail-value').textContent, '0 / 0 (0.0%)');
});

test('configuration changes cancel older replays and catch bytes received during rebuilding', async () => {
    const fixture = bootWithConfig(JSON.stringify({ captureMode: 'hex' }));
    const { getElement, serial, plotter } = fixture;
    serial.onDataCallback(Uint8Array.of(65, 10));
    getElement('text-boundary').value = 'lf';
    getElement('capture-mode').value = 'text';
    getElement('capture-mode').listeners.change();
    serial.onDataCallback(Uint8Array.of(66, 10));
    getElement('text-boundary').value = 'crlf';
    getElement('text-boundary').listeners.change();
    await fixture.finishRebuild();
    assert.equal(plotter.frames.length, 1);
    assert.deepEqual(Array.from(plotter.frames.rawBytesAt(0)), [65, 10, 66, 10]);
    assert.equal(fixture.monitor.mode, 'text');
    getElement('capture-mode').value = 'number';
    getElement('capture-mode').listeners.change();
    getElement('btn-clear').listeners.click();
    await fixture.finishRebuild();
    assert.equal(plotter.frames.length, 0);
    assert.equal(getElement('history-rebuild-progress').hidden, true);
    assert.equal(getElement('btn-export').disabled, false);
});

test('replaying after pause and resume preserves incomplete-tail stream boundaries', async () => {
    const fixture = bootWithConfig(JSON.stringify({ enableHeader: false, dataType: 'float32' }));
    const { getElement, serial, plotter } = fixture;
    serial.onDataCallback(Uint8Array.of(0, 0));
    getElement('btn-pause').click();
    getElement('btn-pause').click();
    serial.onDataCallback(Uint8Array.of(0, 0, 128, 63));
    getElement('btn-pause').click();
    assert.equal(plotter.frames.getValue(0, 0), 1);
    getElement('data-type').value = 'uint32';
    getElement('data-type').listeners.change();
    await fixture.finishRebuild();
    assert.equal(plotter.frames.getValue(0, 0), 1065353216);
    assert.deepEqual(Array.from(plotter.frames.rawBytesAt(0)), [0, 0, 128, 63]);
});

test('a presentation failure after replay keeps capture format consistent with installed frames', async () => {
    const fixture = bootWithConfig(JSON.stringify({ enableHeader: false, dataType: 'uint8' }));
    const { getElement, serial, plotter, monitor } = fixture;
    serial.onDataCallback(Uint8Array.of(65));
    getElement('btn-pause').click();
    const original = monitor.setEncoding.bind(monitor);
    let injected = false;
    monitor.setEncoding = (...args) => {
        if (!injected) { injected = true; throw new Error('presentation test failure'); }
        return original(...args);
    };
    getElement('capture-mode').value = 'text';
    getElement('capture-mode').listeners.change();
    await fixture.finishRebuild();
    assert.match(getElement('format-apply-status').textContent, /presentation test failure/);
    assert.equal(plotter.frames.rawMode, true);
    getElement('btn-pause').click();
    serial.onDataCallback(Uint8Array.of(66));
    getElement('btn-pause').click();
    assert.equal(plotter.frames.length, 2);
    assert.deepEqual(Array.from(plotter.frames.rawBytesAt(1)), [66]);
});

test('new receive bytes arriving during long-text preparation are replayed once before commit', async () => {
    const fixture = bootWithConfig(JSON.stringify({ captureMode: 'hex', idleGapSeconds: '0.001' }));
    const { getElement, serial, plotter } = fixture;
    serial.onDataCallback(new Uint8Array(70000).fill(65));
    fixture.flushTimeouts();
    getElement('capture-mode').value = 'text';
    getElement('capture-mode').listeners.change();
    for (let i = 0; i < 100; i++) {
        await Promise.resolve();
        if (getElement('history-rebuild-progress').textContent.startsWith('正在准备文本显示')) break;
        fixture.flushTimeouts();
    }
    assert.match(getElement('history-rebuild-progress').textContent, /^正在准备文本显示/);
    serial.onDataCallback(Uint8Array.of(66));
    await fixture.finishRebuild();
    assert.equal(plotter.frames.length, 2);
    assert.equal(plotter.frames.rawBytesAt(0).length, 70000);
    assert.deepEqual(Array.from(plotter.frames.rawBytesAt(1)), [66]);
    assert.equal(getElement('stat-fail-value').textContent, '0 / 70001 (0.0%)');
});

test('pause and resume during text preparation replay a boundary even without new bytes', async () => {
    const fixture = bootWithConfig(JSON.stringify({ captureMode: 'hex' }));
    const { getElement, serial, monitor } = fixture;
    serial.connect = async () => { serial.port = {}; serial.keepReading = true; };
    await getElement('btn-connect').listeners.click();
    serial.onDataCallback(new Uint8Array(70000).fill(65));
    fixture.tick(10);
    serial.onDataCallback(Uint8Array.of(0xe4, 0xb8));
    const prepare = monitor.prepareText.bind(monitor);
    let injected = false;
    monitor.prepareText = async (...args) => {
        const state = await prepare(...args);
        if (!injected) {
            injected = true;
            getElement('btn-pause').click();
            getElement('btn-pause').click();
        }
        return state;
    };
    getElement('capture-mode').value = 'text';
    getElement('capture-mode').listeners.change();
    await fixture.finishRebuild();
    serial.onDataCallback(Uint8Array.of(0xad));
    getElement('btn-pause').click();
    assert.equal(getElement('stat-fail-value').textContent, '3 / 70003 (0.0%)');
    getElement('monitor-search-query').value = '中';
    getElement('monitor-search-nearest').click();
    assert.equal(monitor.matches.length, 0);
});

test('continuous reception does not prevent committing Hex to text or numeric views', async () => {
    for (const mode of ['text', 'number']) {
        const fixture = bootWithConfig(JSON.stringify({ captureMode: 'hex', enableHeader: false,
            dataType: 'uint8', textBoundary: 'lf' }));
        const { getElement, serial, monitor, plotter } = fixture;
        serial.connect = async () => { serial.port = {}; serial.keepReading = true; };
        await getElement('btn-connect').click();
        serial.onDataCallback(Uint8Array.of(65, 10));
        fixture.tick(2);
        fixture.setReplayYieldHook(() => serial.onDataCallback(Uint8Array.of(66, 10)));
        getElement('capture-mode').value = mode;
        getElement('capture-mode').listeners.change();
        try {
            for (let i = 0; i < 20; i++) {
                fixture.flushTimeouts();
                await Promise.resolve();
            }
            assert.equal(monitor.mode, mode, 'a live stream must not starve format commit');
            assert.equal(plotter.isPaused, false);
            assert.equal(getElement('canvas-wrapper').hidden, mode !== 'number');
            assert.equal(getElement('channels-display-panel').hidden, mode !== 'number');
            assert.ok(plotter.frames.length > 1, 'new frames must continue reaching the installed buffer');
            assert.equal(getElement('history-rebuild-progress').hidden, true);
            assert.equal(getElement('btn-export').disabled, false);
            assert.equal(getElement('max-points').disabled, false);
        } finally {
            fixture.setReplayYieldHook(null);
            await fixture.finishRebuild();
        }
    }
});

test('all framing and decoding controls belong to the frame tab', () => {
    const html = fs.readFileSync(path.resolve(__dirname, '..', 'index.html'), 'utf8');
    assert.match(html, /data-tab="tab-frame">帧格式<\/button>/);
    const framePage = html.slice(html.indexOf('id="tab-frame"'), html.indexOf('</aside>'));
    for (const id of ['capture-mode', 'rebuild-history', 'frame-raw-settings', 'frame-header-settings', 'frame-footer-settings',
        'frame-checksum-settings', 'frame-numeric-settings']) {
        assert.match(framePage, new RegExp(`id="${id}"`));
    }
    const { clickTab, isTabActive, getElement } = bootWithConfig(null);
    clickTab('tab-frame');
    assert.equal(isTabActive('tab-frame'), true);
    assert.equal(isTabActive('tab-connection'), false);
    assert.equal(isTabActive('tab-monitor-config'), true);
    getElement('capture-mode').value = 'hex'; getElement('capture-mode').listeners.change();
    assert.equal(isTabActive('tab-frame'), true);
    assert.equal(getElement('frame-raw-settings').hidden, false);
    assert.equal(getElement('frame-numeric-settings').hidden, true);
    clickTab('tab-connection');
    assert.equal(isTabActive('tab-frame'), false);
    assert.equal(isTabActive('tab-connection'), true);
});

test('pausing during live catchup retains already received numeric frames and drops later input', async () => {
    const fixture = bootWithConfig(JSON.stringify({ captureMode: 'hex', enableHeader: false,
        dataType: 'uint8', maxPoints: '5000' }));
    const { getElement, serial, monitor, plotter } = fixture;
    serial.connect = async () => { serial.port = {}; serial.keepReading = true; };
    await getElement('btn-connect').listeners.click();
    serial.onDataCallback(Uint8Array.of(1)); fixture.tick(2);
    let queued = false, paused = false;
    fixture.setReplayYieldHook(() => {
        if (!queued) { queued = true; serial.onDataCallback(new Uint8Array(4097).fill(7)); }
        else if (!paused && monitor.mode === 'number') {
            paused = true;
            serial.onDataCallback(Uint8Array.of(9));
            getElement('btn-pause').click();
            serial.onDataCallback(Uint8Array.of(99));
        }
    });
    getElement('capture-mode').value = 'number'; getElement('capture-mode').listeners.change();
    await fixture.finishRebuild();
    assert.equal(paused, true);
    assert.equal(plotter.isPaused, true);
    assert.deepEqual(Array.from(plotter.frames.channelSlice(0)), [1, ...new Array(4097).fill(7), 9]);
    fixture.setReplayYieldHook(null);
    getElement('btn-pause').click(); serial.onDataCallback(Uint8Array.of(11));
    assert.deepEqual(Array.from(plotter.frames.channelSlice(0)), [1, ...new Array(4097).fill(7), 9, 11]);
});

test('clearing a committed raw view during catchup restores live idle timers', async () => {
    const fixture = bootWithConfig(JSON.stringify({ captureMode: 'hex', textBoundary: 'idle' }));
    const { getElement, serial, monitor, plotter } = fixture;
    serial.connect = async () => { serial.port = {}; serial.keepReading = true; };
    await getElement('btn-connect').listeners.click();
    serial.onDataCallback(Uint8Array.of(65)); fixture.tick(2);
    let queued = false, cleared = false;
    fixture.setReplayYieldHook(() => {
        if (!queued) { queued = true; serial.onDataCallback(new Uint8Array(4097).fill(66)); }
        else if (!cleared && monitor.mode === 'text') {
            cleared = true; getElement('btn-clear').click();
            serial.onDataCallback(Uint8Array.of(67));
        }
    });
    getElement('capture-mode').value = 'text'; getElement('capture-mode').listeners.change();
    await fixture.finishRebuild(); fixture.tick(10);
    assert.equal(cleared, true);
    assert.equal(monitor.mode, 'text');
    assert.equal(plotter.frames.length, 1);
    assert.deepEqual(Array.from(plotter.frames.rawBytesAt(0)), [67]);
    fixture.setReplayYieldHook(null);
});

test('another mode change during live catchup cancels the old parser and keeps the newest view live', async () => {
    const fixture = bootWithConfig(JSON.stringify({ captureMode: 'hex', textBoundary: 'lf',
        enableHeader: false, dataType: 'uint8', channelsCount: '2', maxPoints: '5000' }));
    const { getElement, serial, monitor, plotter } = fixture;
    serial.connect = async () => { serial.port = {}; serial.keepReading = true; };
    await getElement('btn-connect').listeners.click();
    serial.onDataCallback(Uint8Array.of(65, 10)); fixture.tick(2);
    let queued = false, switched = false;
    fixture.setReplayYieldHook(() => {
        if (!queued) { queued = true; serial.onDataCallback(Uint8Array.from({ length: 4098 }, (_, i) => i % 2 ? 10 : 66)); }
        else if (!switched && monitor.mode === 'text') {
            switched = true;
            getElement('capture-mode').value = 'number'; getElement('capture-mode').listeners.change();
            serial.onDataCallback(Uint8Array.of(67, 10));
        }
    });
    getElement('capture-mode').value = 'text'; getElement('capture-mode').listeners.change();
    await fixture.finishRebuild();
    fixture.setReplayYieldHook(null);
    assert.equal(switched, true);
    assert.equal(monitor.mode, 'number');
    assert.equal(getElement('canvas-wrapper').hidden, false);
    assert.deepEqual(Array.from(plotter.frames.channelSlice(0)), [65, ...new Array(2049).fill(66), 67]);
    serial.onDataCallback(Uint8Array.of(68, 10));
    assert.deepEqual(Array.from(plotter.frames.channelSlice(0)), [65, ...new Array(2049).fill(66), 67, 68]);
    assert.equal(plotter.isPaused, false);
});

test('the rebuild-history checkbox clears RX and TX on format changes without pausing capture', () => {
    const fixture = bootWithConfig(JSON.stringify({ enableHeader: false, dataType: 'uint8' }));
    const { getElement, serial, plotter, monitor, sendController, getStored } = fixture;
    serial.onDataCallback(Uint8Array.of(65)); sendController.onSent(Uint8Array.of(66));
    getElement('rebuild-history').checked = false; getElement('rebuild-history').dispatchEvent(new Event('change'));
    assert.equal(plotter.frames.length, 1, 'changing only the retention choice must not delete data');
    getElement('capture-mode').value = 'text'; getElement('capture-mode').listeners.change();
    assert.equal(monitor.mode, 'text');
    assert.equal(plotter.frames.length, 0);
    assert.equal(monitor.extras.length, 0);
    assert.equal(getElement('history-rebuild-progress').hidden, true);
    assert.equal(plotter.isPaused, false);
    assert.equal(JSON.parse(getStored()).rebuildHistory, false);
    serial.onDataCallback(Uint8Array.of(67)); fixture.tick(10);
    assert.equal(plotter.frames.length, 1);
    getElement('text-encoding').value = 'ascii'; getElement('text-encoding').listeners.change();
    assert.equal(plotter.frames.length, 0);
});

test('invalid format changes never clear existing data when history rebuilding is disabled', () => {
    const fixture = bootWithConfig(JSON.stringify({ enableHeader: false, dataType: 'uint8', rebuildHistory: false }));
    const { getElement, serial, plotter } = fixture;
    serial.onDataCallback(Uint8Array.of(7));
    getElement('channels-count').value = '99'; getElement('channels-count').listeners.change();
    assert.equal(plotter.frames.length, 1);
    assert.equal(plotter.frames.getValue(0, 0), 7);
    assert.equal(getElement('format-apply-status').hidden, false);
});

test('format changes with rebuilding disabled also clear a TX-only buffer', async () => {
    const fixture = bootWithConfig(JSON.stringify({ captureMode: 'hex', rebuildHistory: false }));
    const { getElement, sendController, blobs, monitor } = fixture;
    sendController.onSent(Uint8Array.of(65));
    getElement('capture-mode').value = 'text'; getElement('capture-mode').listeners.change();
    assert.equal(monitor.extras.length, 0);
    getElement('export-direction').value = 'tx';
    await getElement('btn-export').click();
    assert.equal(blobs.length, 0);
});
