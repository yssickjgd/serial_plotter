const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

test('export count excludes non-sampling parameters and keeps original channel indices', () => {
    const { view, getElement } = exportFixture();
    getElement('export-format').value = 'csv';
    view.setChannels([{ name: 'raw', signal: true }, { name: 'kernel', signal: false },
        { name: 'formula', signal: true }, { name: 'system', signal: false }]);
    assert.equal(getElement('export-channel-summary').textContent, '导出通道（2 / 2）');
    assert.deepEqual(view.selectedChannels(), [0, 2]);
    const first = getElement('export-channel-list').children[0].children[0];
    first.checked = false; first.listeners.change();
    assert.equal(getElement('export-channel-summary').textContent, '导出通道（1 / 2）');
    assert.deepEqual(view.selectedChannels(), [2]);
});

function exportFixture() {
    const { ExportSettingsView } = require('../exportSettingsView');
    const elements = new Map();
    const makeElement = () => ({ value: '', checked: false, hidden: false, disabled: false,
        children: [], style: {}, textContent: '', listeners: {},
        addEventListener(type, callback) { this.listeners[type] = callback; },
        append(...children) { this.children.push(...children); },
        replaceChildren(...children) { this.children = children; } });
    const document = { createElement: makeElement, getElementById(id) {
        if (!elements.has(id)) elements.set(id, makeElement());
        return elements.get(id);
    } };
    const getElement = id => document.getElementById(id);
    getElement('export-format').value = 'csv';
    getElement('export-format').options = ['binary', 'hex-text', 'text', 'csv'].map(value => ({ value }));
    getElement('export-direction').value = 'rx';
    getElement('export-encoding').value = 'utf-8';
    getElement('export-output-encoding').value = 'utf-8';
    getElement('export-text-boundary').value = 'records';
    return { view: new ExportSettingsView(document), getElement };
}

test('unified export keeps all formats visible and shows only their applicable settings', () => {
    const { view, getElement } = exportFixture();
    view.setChannels([{ name: 'A' }]);
    getElement('export-timestamps').checked = true;
    getElement('export-markers').checked = true;
    for (const format of ['binary', 'hex-text', 'text', 'csv']) {
        getElement('export-format').value = format;
        view.sync({ numericAvailable: true });
        assert.ok(getElement('export-format').options.every(option => !option.hidden && !option.disabled));
        assert.equal(getElement('wrap-export-direction').hidden, format === 'csv');
        assert.equal(getElement('wrap-export-encoding').hidden, format !== 'text');
        assert.equal(getElement('export-text-metadata').hidden, format === 'binary');
        assert.equal(getElement('wrap-export-markers').hidden, format === 'csv');
        assert.equal(getElement('export-channels-wrap').hidden, format !== 'csv');
        assert.equal(getElement('export-binary-hint').hidden, format !== 'binary');
        assert.equal(getElement('btn-export').disabled, false);
        assert.equal(view.read().timestamps, true, 'hidden settings retain their values');
    }
    getElement('export-format').value = 'csv';
    view.sync({ numericAvailable: false });
    assert.equal(getElement('btn-export').disabled, true);
    assert.equal(getElement('export-format').options[3].hidden, false);
    assert.equal(getElement('export-format').options[3].disabled, true);
    assert.match(getElement('export-availability').textContent, /数值/);
    getElement('export-format').value = 'binary'; view.sync({ busy: true });
    assert.equal(getElement('btn-export').disabled, true);
    assert.equal(getElement('export-format').disabled, true);
});

test('export channel choices are independent, preserve physical indices and render names as text', () => {
    const { view, getElement } = exportFixture();
    view.setChannels([{ index: 0, name: '温度' }, { index: 1, name: '<img src=x>' }, { index: 2, name: 'CH03' }]);
    const list = getElement('export-channel-list');
    assert.equal(list.children[1].children[1].textContent, 'CH02 · <img src=x>');
    assert.equal(list.children[2].children[1].textContent, 'CH03');
    assert.deepEqual(view.read().channelIndices, [0, 1, 2]);
    const second = list.children[1].children[0]; second.checked = false; second.listeners.change();
    assert.deepEqual(view.read().channelIndices, [0, 2]);
    view.setChannels([{ name: 'A' }, { name: 'B' }, { name: 'C' }, { name: 'D' }]);
    assert.deepEqual(view.read().channelIndices, [0, 2, 3]);
    assert.match(getElement('export-channel-summary').textContent, /3.*4/);
    getElement('btn-export-channels-all-off').listeners.click();
    assert.deepEqual(view.read().channelIndices, []);
    assert.equal(getElement('btn-export').disabled, true);
    getElement('btn-export-channels-all-on').listeners.click();
    assert.equal(getElement('btn-export').disabled, false);
    const snapshot = view.read(); snapshot.channelIndices.pop();
    assert.deepEqual(view.read().channelIndices, [0, 1, 2, 3]);
});

test('text export source charset is validated independently of the capture decoder', () => {
    const { view, getElement } = exportFixture();
    getElement('export-format').value = 'text';
    getElement('export-direction').value = 'both';
    getElement('export-encoding').value = 'gbk';
    assert.equal(view.read().encoding, 'gbk');
    assert.equal(view.read().direction, 'both');
    getElement('export-encoding').value = 'unsupported';
    assert.throws(() => view.read(), /字符集/);
    getElement('export-format').value = 'binary';
    assert.doesNotThrow(() => view.read(), 'an irrelevant hidden charset cannot block byte export');
});

test('text export initially follows capture charset and preserves a manual choice during source changes', () => {
    const { view, getElement } = exportFixture();
    view.setDefaultEncoding('gbk');
    assert.equal(getElement('export-encoding').value, 'gbk');
    getElement('export-encoding').value = 'ascii'; getElement('export-encoding').listeners.change();
    view.setDefaultEncoding('utf-8');
    assert.equal(getElement('export-encoding').value, 'ascii');
});

test('unified export markup includes all four formats and an explicit text source encoding', () => {
    const html = fs.readFileSync(path.join(__dirname, '../index.html'), 'utf8');
    const start = html.indexOf('id="tab-export"'), end = html.indexOf('</aside>', start);
    const panel = html.slice(start, end);
    for (const value of ['binary', 'hex-text', 'text', 'csv']) assert.ok(panel.includes(`value="${value}"`));
    assert.match(panel, /id="export-encoding"/);
    assert.match(panel, /id="export-channels-wrap"/);
    assert.match(panel, /<div id="export-channels-wrap"/);
    assert.doesNotMatch(panel, /<details|<summary/);
    assert.match(panel, /id="export-channel-list"/);
    assert.match(html, /src="exportSettingsView.js"/);
});
