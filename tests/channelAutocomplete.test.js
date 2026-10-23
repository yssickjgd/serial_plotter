const test = require('node:test');
const assert = require('node:assert/strict');
const { ChannelAutocomplete, channelCompletionRange } = require('../channelAutocomplete');
const { ChannelRegistry } = require('../channelRegistry');

class CompletionElement extends EventTarget {
    constructor(document) {
        super(); this.ownerDocument = document; this.attributes = new Map(); this.children = []; this.style = {};
        this.value = ''; this.selectionStart = 0; this.scrollTop = 0;
    }
    setAttribute(key, value) { this.attributes.set(key, value); }
    getAttribute(key) { return this.attributes.get(key) ?? null; }
    removeAttribute(key) { this.attributes.delete(key); }
    appendChild(child) { child.parentNode = this; this.children.push(child); return child; }
    replaceChildren() { this.children = []; }
    setSelectionRange(start) { this.selectionStart = start; }
    remove() { this.parentNode.children = this.parentNode.children.filter(child => child !== this); }
}
function setup(names = ['温度', '压力']) {
    const document = { defaultView: { Event }, createElement() { return new CompletionElement(document); } };
    document.body = document.createElement('body');
    const input = document.createElement('textarea'), registry = new ChannelRegistry({ rawCount: names.length, names });
    const completion = new ChannelAutocomplete(input, { registry });
    const type = value => { input.value = value; input.selectionStart = value.length; input.dispatchEvent(new Event('input')); };
    const key = (key, extra = {}) => {
        const event = Object.assign(new Event('keydown', { cancelable: true }), { key, ...extra });
        input.dispatchEvent(event); return event;
    };
    return { input, registry, completion, type, key, document };
}

test('completion replaces the current Unicode token and supports keyboard acceptance and dismissal', () => {
    const f = setup();
    f.type('diff(温'); assert.equal(f.completion.items[0].name, '温度');
    assert.deepEqual(channelCompletionRange(f.input), { start: 5, end: 6, query: '温' });
    assert.equal(f.key('Enter').defaultPrevented, true); assert.equal(f.input.value, 'diff(温度');
    assert.equal(f.completion.open, false);
    f.type('CH2'); f.key('Tab'); assert.equal(f.input.value, 'CH00002');
    f.type('CH'); f.key('ArrowDown'); f.key('Enter'); assert.equal(f.input.value, 'CH00002');
    f.type('温'); assert.equal(f.key('Escape').defaultPrevented, true); assert.equal(f.completion.open, false);
    f.type('温度+1'); f.input.selectionStart = 1; f.completion.refresh();
    f.key('Tab'); assert.equal(f.input.value, '温度+1');
    f.type('123'); assert.equal(f.completion.open, false);
    f.completion.destroy(); assert.equal(f.document.body.children.length, 0);
    assert.equal(f.input.getAttribute('aria-autocomplete'), null);
});

test('composition events and composing keyboard keys never select a channel', () => {
    const f = setup();
    f.type('温'); f.input.dispatchEvent(new Event('compositionstart'));
    assert.equal(f.completion.open, false);
    f.type('温度'); assert.equal(f.completion.open, false);
    assert.equal(f.key('Enter', { isComposing: true }).defaultPrevented, false);
    f.input.dispatchEvent(new Event('compositionend'));
    assert.equal(f.completion.open, true);
    assert.equal(f.key('Enter', { keyCode: 229 }).defaultPrevented, false);
    f.key('Tab'); assert.equal(f.input.value, '温度'); assert.equal(f.completion.open, false);
    f.completion.destroy();
});

test('the popup virtualizes large registries to at most thirty choices while scrolling and arrowing', () => {
    const f = setup(Array.from({ length: 1000 }, (_, index) => `信号${index + 1}`));
    const choices = () => f.completion.popup.children.filter(child => child.getAttribute('role') === 'option');
    f.type(''); assert.equal(f.completion.total, 1000); assert.equal(choices().length, 30);
    f.key('ArrowUp'); assert.equal(f.completion.activeIndex, 999); assert.ok(choices().length <= 30);
    f.key('Enter'); assert.equal(f.input.value, '信号1000');
    f.type('CH'); f.completion.popup.scrollTop = 6000; f.completion.popup.dispatchEvent(new Event('scroll'));
    assert.equal(f.completion.offset, 200); assert.equal(choices().length, 30);
    choices()[0].dispatchEvent(new Event('click')); assert.equal(f.input.value, 'CH00201');
    f.completion.destroy();
});
