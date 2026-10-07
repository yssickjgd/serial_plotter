const test = require('node:test');
const assert = require('node:assert/strict');
const { bindSelectWheel, bindAllSelectWheels } = require('../selectWheel');

function createSelect(options = [{}, {}, {}], selectedIndex = 0) {
    const listeners = [];
    const changes = [];
    return {
        options, selectedIndex, disabled: false, listeners, changes,
        addEventListener(type, listener, settings) { listeners.push({ type, listener, settings }); },
        dispatchEvent(event) { changes.push(event); },
        wheel(deltaY, extra = {}) {
            const event = { deltaY, ctrlKey: false, prevented: false, preventDefault() { this.prevented = true; }, ...extra };
            listeners.forEach(({ listener }) => listener(event));
            return event;
        }
    };
}

test('select wheel moves one option per event, emits change and clamps at boundaries', () => {
    const select = createSelect();
    bindSelectWheel(select);
    assert.deepEqual(select.listeners[0].settings, { passive: false });
    assert.equal(select.wheel(120).prevented, true);
    assert.equal(select.selectedIndex, 1);
    assert.equal(select.changes.length, 1);
    assert.equal(select.changes[0].type, 'change');
    assert.equal(select.changes[0].bubbles, true);
    select.wheel(1000);
    select.wheel(1);
    assert.equal(select.selectedIndex, 2);
    assert.equal(select.changes.length, 2);
    select.wheel(-1);
    select.wheel(-1);
    select.wheel(-1);
    assert.equal(select.selectedIndex, 0);
    assert.equal(select.changes.length, 4);
});

test('select wheel skips disabled options and disabled option groups', () => {
    const group = { tagName: 'OPTGROUP', disabled: true };
    const select = createSelect([{}, { disabled: true }, { parentElement: group }, {}]);
    bindSelectWheel(select);
    select.wheel(1);
    assert.equal(select.selectedIndex, 3);
    select.wheel(-1);
    assert.equal(select.selectedIndex, 0);
});

test('select wheel preserves browser zoom, horizontal scrolling and disabled controls', () => {
    const select = createSelect();
    bindSelectWheel(select);
    assert.equal(select.wheel(1, { ctrlKey: true }).prevented, false);
    assert.equal(select.wheel(0).prevented, false);
    select.disabled = true;
    assert.equal(select.wheel(1).prevented, false);
    assert.equal(select.selectedIndex, 0);
    assert.equal(select.changes.length, 0);
});

test('binding all selects repeatedly attaches only one wheel handler', () => {
    const selects = [createSelect(), createSelect()];
    const root = { querySelectorAll(selector) { assert.equal(selector, 'select'); return selects; } };
    bindAllSelectWheels(root);
    bindAllSelectWheels(root);
    bindSelectWheel(selects[0]);
    assert.equal(selects[0].listeners.length, 1);
    assert.equal(selects[1].listeners.length, 1);
});
