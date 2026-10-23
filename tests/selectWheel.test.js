const test = require('node:test');
const assert = require('node:assert/strict');
const { bootApplication } = require('./helpers/widgetAppHarness');
function boot(t) { const f = bootApplication(); t.after(() => f.app.dispose()); return f; }
function wheel(node, extra = {}) {
    const event = { type: 'wheel', deltaY: 100, bubbles: true, prevented: false,
        preventDefault() { this.prevented = true; }, ...extra };
    node.dispatchEvent(event); return event;
}
test('scrolling over a configuration select never changes its value or prevents page scrolling', t => {
    const f = boot(t), select = f.get('conn-type'), before = JSON.stringify(f.app.getConfig());
    const value = select.value;
    assert.equal(wheel(select).prevented, false);
    assert.equal(select.value, value);
    assert.equal(JSON.stringify(f.app.getConfig()), before);
    assert.equal(wheel(select, { deltaY: -100 }).prevented, false);
    assert.equal(select.value, value);
});
test('focused selects release focus on vertical scrolling including controls added after startup', t => {
    const f = boot(t), select = f.document.createElement('select');
    for (const value of ['a','b']) { const option = f.document.createElement('option'); option.value = value; select.append(option); }
    f.document.body.append(select); select.focus();
    const event = wheel(select);
    assert.equal(event.prevented, false);
    assert.equal(select.value, 'a');
    assert.ok(f.document.activeElement !== select, 'native focused-select wheel changes are prevented by releasing focus');
    select.focus(); assert.equal(f.document.activeElement, select, 'mouse and keyboard can focus it again');
    wheel(select, { ctrlKey: true }); assert.equal(f.document.activeElement, select);
    wheel(select, { deltaY: 0, deltaX: 10 }); assert.equal(f.document.activeElement, select);
});
test('dynamic command selectors retain their settings when scrolling', t => {
    const f = boot(t); f.app.commandView.add('group'); f.app.commandView.add('command');
    const select = f.get('command-tree').querySelector('select');
    const before = JSON.stringify(f.app.getConfig().send.commands), value = select.value;
    wheel(select); assert.equal(select.value, value);
    assert.equal(JSON.stringify(f.app.getConfig().send.commands), before);
});
