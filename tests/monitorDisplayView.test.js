const test = require('node:test');
const assert = require('node:assert/strict');
const { MonitorDisplayView } = require('../monitorDisplayView');

function displayFixture() {
    const elements = new Map();
    const document = { getElementById(id) {
        if (!elements.has(id)) elements.set(id, { value: '', checked: false, hidden: false,
            textContent: '', listeners: {}, addEventListener(type, callback) { this.listeners[type] = callback; } });
        return elements.get(id);
    } };
    const applied = [];
    const view = new MonitorDisplayView(document, { onChange: options => applied.push(options) });
    return { view, applied, getElement: id => document.getElementById(id) };
}

test('restoring display options changes controls and conditional panels without applying user edits', () => {
    const { view, applied, getElement } = displayFixture();
    view.apply({ hexBytesPerLine: 16, hexAscii: true, foldLong: true, foldLines: 3 });
    view.setMode('hex');
    assert.equal(getElement('monitor-display-panel').hidden, false);
    assert.equal(getElement('monitor-hex-options').hidden, false);
    assert.equal(getElement('monitor-text-options').hidden, true);
    assert.equal(getElement('monitor-number-options').hidden, true);
    assert.equal(getElement('monitor-fold-lines-wrap').hidden, false);
    assert.equal(getElement('monitor-hex-bytes-per-line').value, '16');
    assert.equal(view.read().hexAscii, true);
    assert.equal(view.read().foldLines, 3);
    assert.equal(applied.length, 0);
    view.setMode('text');
    assert.equal(getElement('monitor-hex-options').hidden, true);
    assert.equal(getElement('monitor-text-options').hidden, false);
    assert.equal(getElement('monitor-fold-lines-wrap').hidden, false);
    view.setMode('number');
    assert.equal(getElement('monitor-display-panel').hidden, false);
    assert.equal(getElement('monitor-config-panel').hidden, false);
    assert.equal(getElement('monitor-hex-options').hidden, true);
    assert.equal(getElement('monitor-text-options').hidden, true);
    assert.equal(getElement('monitor-number-options').hidden, false);
    view.apply();
    assert.equal(view.read().hexBytesPerLine, 'auto');
    assert.equal(getElement('monitor-fold-lines-wrap').hidden, true);
});

test('numeric significant digits restore and apply without accepting invalid drafts', () => {
    const { view, applied, getElement } = displayFixture();
    const input = getElement('monitor-numeric-significant-digits');
    assert.equal(input.value, '6');
    view.apply({ numericSignificantDigits: 12 });
    assert.equal(input.value, '12');
    input.value = '3'; input.listeners.input();
    assert.equal(applied.at(-1).numericSignificantDigits, 3);
    input.value = '18'; input.listeners.input();
    assert.equal(applied.length, 1);
    assert.equal(getElement('monitor-display-status').hidden, false);
    view.setMode('text');
    assert.equal(getElement('monitor-number-options').hidden, true);
    input.value = '17'; input.listeners.change();
    assert.equal(applied.at(-1).numericSignificantDigits, 17);
    view.setMode('number');
    assert.equal(getElement('monitor-number-options').hidden, false);
    view.apply();
    assert.equal(input.value, '6');
});

test('keyword format controls drafts and case-sensitive visibility before validation', () => {
    const { view, applied, getElement } = displayFixture();
    const format = getElement('monitor-keyword-format');
    const keyword = getElement('monitor-keyword');
    assert.equal(format.value, 'text');
    assert.equal(getElement('monitor-keyword-case-wrap').hidden, false);
    keyword.value = 'alarm';
    format.value = 'hex'; format.listeners.change();
    assert.equal(getElement('monitor-keyword-case-wrap').hidden, true);
    assert.match(keyword.placeholder, /AB CD/);
    assert.equal(applied.length, 0);
    assert.equal(getElement('monitor-display-status').hidden, false);
    keyword.value = 'AB CD'; keyword.listeners.input();
    assert.equal(applied.length, 1);
    assert.equal(applied[0].keywordFormat, 'hex');
    view.apply({ keywordFormat: 'text', keywordCaseSensitive: true });
    assert.equal(getElement('monitor-keyword-case-wrap').hidden, false);
    assert.match(keyword.placeholder, /alarm/);
    assert.equal(getElement('monitor-keyword-case-sensitive').checked, true);
});

test('display color controls restore and apply all record and search colors', () => {
    const { view, applied, getElement } = displayFixture();
    const ids = { rxColor: 'monitor-rx-color', txColor: 'monitor-tx-color',
        rxErrorColor: 'monitor-rx-error-color', txErrorColor: 'monitor-tx-error-color',
        searchCurrentColor: 'monitor-search-current-color', searchMatchColor: 'monitor-search-match-color' };
    const defaults = ['#50b4ff', '#63ff9a', '#ffcc02', '#ff5a5a', '#ff8c00', '#745a00'];
    Object.values(ids).forEach((id, i) => assert.equal(getElement(id).value, defaults[i]));
    view.apply({ rxColor: '#123456', txColor: '#654321', searchMatchColor: '#222222' });
    assert.equal(getElement(ids.rxColor).value, '#123456');
    assert.equal(getElement(ids.txColor).value, '#654321');
    const input = getElement(ids.searchCurrentColor);
    input.value = '#abcdef'; input.listeners.input();
    assert.equal(applied.length, 1);
    assert.equal(applied[0].searchCurrentColor, '#abcdef');
    assert.equal(applied[0].searchMatchColor, '#222222');
});

test('literal keyword edits apply full options and invalid drafts display an error until corrected', () => {
    const { view, applied, getElement } = displayFixture();
    const keyword = getElement('monitor-keyword');
    keyword.value = '[alarm]\nerror.*'; keyword.listeners.input();
    assert.equal(applied.length, 1);
    assert.equal(applied[0].keyword, '[alarm]\nerror.*');
    assert.equal(applied[0].showDirection, true);
    assert.equal(applied[0].refreshRate, 10);
    keyword.value = 'x'.repeat(257); keyword.listeners.input();
    assert.equal(applied.length, 1);
    assert.equal(getElement('monitor-display-status').hidden, false);
    keyword.value = 'alarm'; keyword.listeners.change();
    assert.equal(applied.length, 2);
    assert.equal(view.read().keyword, 'alarm');
    assert.equal(applied[0].keyword, '[alarm]\nerror.*');
    assert.equal(getElement('monitor-display-status').hidden, true);
});
