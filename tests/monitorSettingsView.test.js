const test = require('node:test');
const assert = require('node:assert/strict');

function fixture() {
    const { MonitorSettingsView } = require('../monitorSettingsView');
    const ids = ['tab-waveform-frame', 'tab-waveform-config',
        'tab-waveform-channels', 'tab-byte-frame', 'tab-monitor-config', 'tab-monitor-channels'];
    const elements = new Map();
    const makeElement = () => {
        const classes = new Set();
        return { hidden: false, dataset: {}, textContent: '', listeners: {},
            classList: { add: value => classes.add(value), remove: value => classes.delete(value),
                contains: value => classes.has(value) },
            addEventListener(name, callback) { this.listeners[name] = callback; },
            setAttribute() {}, click() { this.listeners.click?.(); } };
    };
    const buttons = ids.map(id => {
        elements.set(id, makeElement());
        const button = makeElement(); button.dataset.tab = id; return button;
    });
    const root = { querySelectorAll: () => buttons };
    const document = { getElementById(id) {
        if (!elements.has(id)) elements.set(id, makeElement());
        return elements.get(id);
    } };
    const view = new MonitorSettingsView(root, document);
    return { view, buttons, get: id => elements.get(id),
        click: id => buttons.find(button => button.dataset.tab === id).click() };
}

test('activating each monitor shows only its peer configuration categories', () => {
    const f = fixture();
    assert.equal(f.view.activeTab, 'tab-monitor-config');
    f.view.activate('wave');
    assert.equal(f.view.activeTab, 'tab-waveform-config');
    for (const button of f.buttons) assert.equal(button.hidden, button.dataset.tab.startsWith('tab-byte-') ||
        ['tab-monitor-config', 'tab-monitor-channels'].includes(button.dataset.tab));
    assert.equal(f.get('active-monitor-caption').textContent, '波形监视台');
    f.view.activate('byte');
    assert.equal(f.view.activeTab, 'tab-monitor-config');
    assert.equal(f.get('tab-waveform-config').hidden, true);
});

test('monitor contexts remember their local categories without changing selection on repeated activation', () => {
    const f = fixture();
    f.click('tab-monitor-channels');
    f.view.activate('wave'); f.click('tab-waveform-frame');
    f.view.activate('byte');
    assert.equal(f.view.activeTab, 'tab-monitor-channels');
    f.view.activate('wave');
    assert.equal(f.view.activeTab, 'tab-waveform-frame');
    f.view.select('tab-export'); f.view.activate('wave');
    assert.equal(f.view.activeTab, 'tab-waveform-frame', 'left-side export is outside monitor categories');
    f.click('tab-monitor-config');
    assert.equal(f.view.activeTab, 'tab-waveform-frame', 'hidden categories do not change selection');
});
