const test = require('node:test');
const assert = require('node:assert/strict');
const { EngineChannelView } = require('../engineChannelView');
const { ChannelConfigView } = require('../channelConfigView');
const { ChannelRegistry } = require('../channelRegistry');
const { ChannelOperations } = require('../channelOperations');

class ChannelViewElement extends EventTarget {
    constructor(document, tag) {
        super(); this.ownerDocument = document; this.tagName = tag.toUpperCase(); this.attributes = new Map();
        this.children = []; this.style = {}; this.dataset = {}; this.className = ''; this.value = ''; this.scrollTop = 0;
        this.classList = { add: name => { this.className += ` ${name}`; },
            remove: name => { this.className = this.className.split(' ').filter(value => value !== name).join(' '); } };
    }
    setAttribute(key, value) { this.attributes.set(key, String(value)); }
    getAttribute(key) { return this.attributes.get(key) ?? null; }
    removeAttribute(key) { this.attributes.delete(key); }
    appendChild(child) { child.remove(); child.parentNode = this; this.children.push(child); return child; }
    append(...children) { children.forEach(child => this.appendChild(child)); }
    replaceChildren(...children) { this.children.forEach(child => { child.parentNode = null; }); this.children = []; this.append(...children); }
    remove() { if (this.parentNode) this.parentNode.children = this.parentNode.children.filter(child => child !== this); this.parentNode = null; }
    click() { this.dispatchEvent(new Event('click')); }
    setSelectionRange(start) { this.selectionStart = start; }
}
function all(root, predicate) { return root.children.flatMap(child => [...(predicate(child) ? [child] : []), ...all(child, predicate)]); }
const role = (root, name) => all(root, node => node.getAttribute('data-role') === name)[0];
function fixture(rawCount = 2, definitions = [{ number: 3, type: 'formula', expression: 'CH1+CH2' }]) {
    const document = { defaultView: { Event }, getElementById() { return null; },
        createElement(tag) { return new ChannelViewElement(document, tag); } };
    document.body = document.createElement('body');
    const root = document.createElement('section'); document.body.append(root);
    const calls = [], visible = new Set([0]);
    const controller = {
        globals: { channelsCount: rawCount, channelDefinitions: definitions, channelNames: ['温度', '压力'] },
        channelMeta() {
            const definitions = new Map(this.globals.channelDefinitions.map(value => [value.number, value]));
            let count = rawCount; for (const number of definitions.keys()) count = Math.max(count, number);
            return Array.from({ length: count }, (_, index) => ({ index, number: index + 1, definition: definitions.get(index + 1),
                name: this.globals.channelNames[index] ?? `信号${index + 1}`, color: '#ff0000', signal: index < rawCount || definitions.get(index + 1)?.type === 'formula' }));
        },
        channelVisible(widget, index) { return visible.has(index); },
        setChannelVisible(index, value) { calls.push(['visible', index, value]); },
        setChannelName(index, name) { calls.push(['name', index, name]); this.globals.channelNames[index] = name; },
        setChannelColor(index, color) { calls.push(['color', index, color]); },
        validateChannelDefinition(definition) {
            return new ChannelOperations(rawCount, this.globals.channelDefinitions.filter(value => value.number !== definition.number).concat(definition));
        },
        updateChannelDefinition(definition, options) {
            calls.push(['update', definition, options]); this.validateChannelDefinition(definition);
            this.globals.channelDefinitions = this.globals.channelDefinitions.filter(value => value.number !== definition.number).concat(definition);
            return Promise.resolve();
        },
        addChannel(type) {
            const number = rawCount + this.globals.channelDefinitions.length + 1;
            calls.push(['add', type]); this.globals.channelDefinitions.push({ number, type, expression: type === 'constant' ? '[0]=1' : 'CH1' }); return number;
        },
        moveChannel(from, to) { calls.push(['move', from, to]); return Promise.resolve(); },
        removeChannel(number) { calls.push(['remove', number]); this.globals.channelDefinitions = this.globals.channelDefinitions.filter(value => value.number !== number); }
    };
    const getRegistry = () => new ChannelRegistry({ rawCount, definitions: controller.globals.channelDefinitions, names: controller.globals.channelNames });
    return { document, root, controller, calls, getRegistry };
}

test('engine channel editing works without an active widget and validates names and formulas inline', async () => {
    const f = fixture(), view = new EngineChannelView(f);
    const rows = () => all(view.list, node => node.dataset.channelNumber);
    assert.equal(rows().length, 3);
    const name = role(rows()[0], 'channel-name'); name.value = '压力'; name.dispatchEvent(new Event('change'));
    assert.match(role(rows()[0], 'channel-error').textContent, /重复/); assert.equal(f.calls.length, 0);
    name.value = '气温'; name.dispatchEvent(new Event('change')); assert.deepEqual(f.calls[0], ['name', 0, '气温']);
    rows()[2].children[0].click();
    const expression = role(rows()[2], 'channel-expression'); expression.value = '气温+CH2'; expression.dispatchEvent(new Event('input'));
    assert.equal(f.calls.filter(call => call[0] === 'update').length, 0);
    const actions = role(rows()[2], 'channel-apply').parentNode;
    assert.equal(actions.children[0].getAttribute('data-role'), 'channel-apply');
    assert.equal(actions.children[1].getAttribute('data-role'), 'channel-delete');
    role(rows()[2], 'channel-apply').click(); await Promise.resolve();
    assert.equal(f.calls.find(call => call[0] === 'update')[1].expression, 'CH00001+CH00002');
    const invalid = role(rows()[2], 'channel-expression'); invalid.value = 'CH999'; invalid.dispatchEvent(new Event('input'));
    assert.match(role(rows()[2], 'channel-error').textContent, /不存在/);
    assert.equal(role(rows()[2], 'channel-error').hidden, false);
    view.dispose(); assert.equal(f.root.children.length, 0);
});

test('live channel colors stay current when virtual rows are rendered again', () => {
    const f = fixture(), view = new EngineChannelView(f);
    const picker = role(view.list, 'channel-color');
    picker.value = '#123456'; picker.dispatchEvent(new Event('input'));
    assert.deepEqual(f.calls.at(-1), ['color', 0, '#123456']);
    assert.equal(role(view.list, 'channel-color'), picker);
    view.renderWindow(true);
    assert.equal(role(view.list, 'channel-color').value, '#123456');
    view.dispose();
});

test('expanded formula constant and system rows fit their contents instead of reserving fixed blank space', () => {
    const f = fixture(2, [
        { number: 3, type: 'formula', expression: 'CH1' },
        { number: 4, type: 'constant', expression: '[0]=1' },
        { number: 5, type: 'system', expression: 'y[n]=x[n]', initial: '' }
    ]), view = new EngineChannelView(f);
    for (const number of [3, 4, 5]) view.expanded.add(view.keyFor(number));
    view.refresh();
    for (const row of all(view.list, node => node.dataset.channelNumber)) {
        assert.equal(row.style.minHeight, `${view.rowHeight}px`);
        if (Number(row.dataset.channelNumber) > 2) assert.ok(role(row, 'channel-apply'));
    }
    view.dispose();
});

test('measured channel heights update virtual spacers and preserve the visible row without rebuilding editors', () => {
    const f = fixture(200, [
        { number: 201, type: 'formula', expression: 'CH1' },
        { number: 202, type: 'system', expression: 'y[n]=x[n]', initial: '' }
    ]);
    let notifyResize, disconnected = 0;
    f.document.defaultView.ResizeObserver = class {
        constructor(callback) { notifyResize = callback; }
        observe() {}
        disconnect() { disconnected++; }
    };
    const view = new EngineChannelView(f);
    view.expanded.add(view.keyFor(201)); view.expanded.add(view.keyFor(202)); view.refresh();
    view.scrollToNumber(201);
    const row = number => view.list.children.find(child => child.dataset.channelNumber === String(number));
    const formula = row(201), system = row(202), errorRow = row(199), editor = role(formula, 'channel-expression');
    const resize = (target, height) => ({ target, borderBoxSize: [{ blockSize: height }] });
    notifyResize?.([resize(formula, 130), resize(system, 210), resize(errorRow, 60)]);
    assert.equal(view.offsets[201] - view.offsets[200], 130);
    assert.equal(view.offsets[202] - view.offsets[201], 210);
    assert.equal(view.list.scrollTop, 200 * view.rowHeight + 24);
    assert.ok(role(row(201), 'channel-expression') === editor);
    const spacer = view.list.children[0];
    assert.equal(spacer.style.height, `${view.offsets[152]}px`);
    notifyResize?.([resize(formula, 260)]);
    assert.equal(view.offsets[201] - view.offsets[200], 260);
    assert.ok(role(row(201), 'channel-expression') === editor);
    view.list.scrollTop = 0; view.list.dispatchEvent(new Event('scroll'));
    const before = view.offsets[201];
    notifyResize?.([resize(formula, 999)]);
    assert.equal(view.offsets[201], before, 'stale observers cannot change the current virtual window');
    view.expanded.delete(view.keyFor(201)); view.refresh();
    assert.equal(view.offsets[201] - view.offsets[200], view.rowHeight);
    view.dispose(); assert.ok(disconnected > 0);
    notifyResize?.([resize(system, 999)]);
    assert.equal(view.list.children.length, 0);
});

test('engine virtual rows fill a resized tall list and release removed channel measurements', () => {
    const f = fixture(200, [{ number: 201, type: 'formula', expression: 'CH1' }]);
    let notifyResize;
    f.document.defaultView.ResizeObserver = class {
        constructor(callback) { notifyResize = callback; }
        observe() {}
        disconnect() {}
    };
    const view = new EngineChannelView(f);
    view.list.clientHeight = 2100; notifyResize([{ target: view.list }]);
    const rows = all(view.list, node => node.dataset.channelNumber);
    assert.ok(rows.length >= Math.ceil(2100 / view.rowHeight));
    assert.ok(rows.length <= Math.ceil(2100 / view.rowHeight) + 8);
    view.scrollToNumber(201);
    const row = view.list.children.find(node => node.dataset.channelNumber === '201'), key = view.keyFor(201);
    notifyResize([{ target: row, borderBoxSize: [{ blockSize: 140 }] }]);
    assert.equal(view.measuredHeights.has(key), true);
    f.controller.globals.channelDefinitions = []; view.refresh();
    assert.equal(view.measuredHeights.has(key), false);
    view.dispose();
});

test('engine category fixes the add type, searching narrows names, and reorder uses controller operations', async () => {
    const f = fixture(2, [{ number: 3, type: 'formula', expression: 'CH1' }, { number: 4, type: 'constant', expression: '[0]=1' }]);
    const view = new EngineChannelView(f);
    const rows = () => all(view.list, node => node.dataset.channelNumber);
    role(rows()[2], 'channel-down').click(); await Promise.resolve(); assert.deepEqual(f.calls[0], ['move', 3, 4]);
    view.categoryInput.value = 'constant'; view.categoryInput.dispatchEvent(new Event('change'));
    assert.equal(view.addType.disabled, true); assert.equal(view.addType.value, 'constant');
    view.add.click(); assert.deepEqual(f.calls.find(call => call[0] === 'add'), ['add', 'constant']);
    view.categoryInput.value = 'raw'; view.categoryInput.dispatchEvent(new Event('change')); assert.equal(view.add.disabled, true);
    view.categoryInput.value = 'all'; view.categoryInput.dispatchEvent(new Event('change'));
    view.search.value = '温度'; view.search.dispatchEvent(new Event('input')); assert.equal(rows().length, 1);
    assert.equal(rows()[0].dataset.channelNumber, '1'); view.dispose();
});

test('global and widget channel lists render bounded windows for all 65535 channels', () => {
    const f = fixture(65535, []), engine = new EngineChannelView(f);
    const rows = list => all(list, node => node.dataset.channelNumber);
    assert.ok(rows(engine.list).length <= 60);
    engine.list.scrollTop = 65500 * 36; engine.list.dispatchEvent(new Event('scroll'));
    assert.ok(Number(rows(engine.list)[0].dataset.channelNumber) > 65000); assert.ok(rows(engine.list).length <= 60);
    const localRoot = f.document.createElement('div'), local = new ChannelConfigView(f.document, f.controller);
    local.render(localRoot, { type: 'wave', channelCategory: 'all' });
    assert.ok(rows(localRoot).length <= 60);
    assert.equal(all(localRoot, node => node.tagName === 'TEXTAREA' || node.tagName === 'BUTTON').length, 0);
    assert.ok(role(localRoot, 'channel-name')); assert.ok(role(localRoot, 'channel-color'));
    const checkbox = role(rows(localRoot)[0], 'channel-visible'); checkbox.checked = false; checkbox.dispatchEvent(new Event('change'));
    assert.deepEqual(f.calls[0], ['visible', 0, false]);
    localRoot.scrollTop = 65500 * 32; localRoot.dispatchEvent(new Event('scroll'));
    assert.ok(Number(rows(localRoot)[0].dataset.channelNumber) > 65000);
    local.dispose(); engine.dispose();
});

test('widget visibility uses the outer tab scroll with complete small lists and bounded large lists', () => {
    const f = fixture(23, []), localRoot = f.document.createElement('div');
    const host = f.document.createElement('section'); host.append(localRoot);
    localRoot.closest = selector => selector === '.tab-content' ? host : null;
    host.getBoundingClientRect = () => ({ top: 50 });
    localRoot.getBoundingClientRect = () => ({ top: 150 - host.scrollTop });
    const view = new ChannelConfigView(f.document, f.controller), rows = () => all(localRoot, node => node.dataset.channelNumber);
    view.render(localRoot, { type: 'wave', channelCategory: 'all' });
    assert.equal(rows().length, 23);
    assert.equal(rows().at(-1).dataset.channelNumber, '23');
    assert.equal(localRoot.style.overflowY, 'visible');
    assert.equal(localRoot.style.maxHeight, 'none');
    f.controller.channelMeta = () => Array.from({ length: 65535 }, (_, index) => ({ index, number: index + 1, signal: true }));
    view.render(localRoot, { type: 'byte', channelCategory: 'all' });
    host.scrollTop = 65500 * 32 + 100; host.dispatchEvent(new Event('scroll'));
    assert.ok(Number(rows()[0].dataset.channelNumber) > 65000);
    assert.equal(rows().at(-1).dataset.channelNumber, '65535');
    assert.ok(rows().length <= 50);
    view.dispose(); host.scrollTop = 0; host.dispatchEvent(new Event('scroll'));
    assert.equal(localRoot.children.length, 0, 'disposing unhooks the parent scroll listener');
});

test('widget visibility fills tall parent viewports and updates after resizing without scrolling', () => {
    const f = fixture(65535, []), list = f.document.createElement('div'), host = f.document.createElement('section');
    host.append(list); host.clientHeight = 2000;
    list.closest = () => host;
    host.getBoundingClientRect = () => ({ top: 0 });
    list.getBoundingClientRect = () => ({ top: 100 - host.scrollTop });
    let notifyResize, disconnected = false;
    f.document.defaultView.ResizeObserver = class {
        constructor(callback) { notifyResize = callback; }
        observe(target) { assert.equal(target, host); }
        disconnect() { disconnected = true; }
    };
    const view = new ChannelConfigView(f.document, f.controller);
    const rows = () => all(list, node => node.dataset.channelNumber);
    view.render(list, { type: 'wave' });
    assert.ok(rows().length >= Math.ceil((host.clientHeight - 100) / 32));
    host.clientHeight = 3000; notifyResize?.();
    assert.ok(rows().length >= Math.ceil((host.clientHeight - 100) / 32));
    assert.ok(rows().length <= Math.ceil(host.clientHeight / 32) + 10);
    view.dispose(); assert.equal(disconnected, true);
    notifyResize?.(); assert.equal(list.children.length, 0);
});

test('right channel editors locate CH65535 with bounded DOM and retain native pickers through unchanged windows', () => {
    const f = fixture(65535, []), list = f.document.createElement('div'), host = f.document.createElement('section');
    host.append(list); host.clientHeight = 600;
    list.closest = () => host;
    host.getBoundingClientRect = () => ({ top: 0 });
    list.getBoundingClientRect = () => ({ top: 100 - host.scrollTop });
    let resize;
    f.document.defaultView.ResizeObserver = class { constructor(callback) { resize = callback; } observe() {} disconnect() {} };
    const view = new ChannelConfigView(f.document, f.controller);
    f.controller.channelSearchText = 'CH65535'; view.render(list, { type: 'wave' });
    assert.equal(all(list, node => node.dataset.channelNumber).length, 1);
    assert.equal(list.children[0].dataset.channelNumber, '65535');
    f.controller.channelSearchText = ''; view.render(list, { type: 'wave' });
    assert.ok(all(list, node => node.dataset.channelNumber).length <= 50);
    const color = role(list, 'channel-color'); color.value = '#112233'; color.dispatchEvent(new Event('input'));
    host.scrollTop = 20; host.dispatchEvent(new Event('scroll')); resize();
    assert.ok(role(list, 'channel-color') === color);
    const before = f.calls.length; view.dispose(); color.dispatchEvent(new Event('input'));
    assert.equal(f.calls.length, before, 'destroying the editor detaches all row input handlers');
    assert.equal(view.metadata.size, 0);
});

test('Enter navigation returns to the first matching channel beyond a scrolled virtual window', () => {
    const f = fixture(150, []), list = f.document.createElement('div'), host = f.document.createElement('section');
    host.append(list); host.clientHeight = 600;
    list.closest = () => host;
    host.getBoundingClientRect = () => ({ top: 0 });
    list.getBoundingClientRect = () => ({ top: 100 - host.scrollTop });
    const view = new ChannelConfigView(f.document, f.controller);
    f.controller.channelSearchText = 'CH'; view.render(list, { type: 'wave' });
    host.scrollTop = 2100; host.dispatchEvent(new Event('scroll'));
    assert.ok(Number(all(list, node => node.dataset.channelNumber)[0].dataset.channelNumber) > 1);
    view.locateFirst(list);
    assert.equal(all(list, node => node.dataset.channelNumber)[0].dataset.channelNumber, '1');
    assert.equal(host.scrollTop, 100);
    view.dispose();
});
