const test = require('node:test');
const assert = require('node:assert/strict');
const { ExportSettingsView } = require('../exportSettingsView');

function fixture(widget) {
    const elements = new Map();
    const document = { getElementById(id) {
        if (!elements.has(id)) elements.set(id, { value: '', checked: false, addEventListener() {} });
        return elements.get(id);
    } };
    const get = id => document.getElementById(id);
    return { get, view: new ExportSettingsView(document, { widget }) };
}

test('raw controls retain direction and metadata independently of widget export', () => {
    const { view, get } = fixture(false);
    view.applyProfile({ direction: 'both', markers: true, timestamps: true });
    get('export-format').value = 'hex-text';
    view.sync({ available: true });
    assert.deepEqual(view.read(), { format: 'hex-text', direction: 'both', markers: true, timestamps: true });
    assert.equal(get('export-text-metadata').hidden, false);
    assert.equal(get('btn-export').disabled, false);
    get('export-format').value = 'binary';
    view.sync({ busy: true, available: true });
    assert.equal(get('export-text-metadata').hidden, true);
    assert.equal(get('btn-export').disabled, true);
});

test('widget controls show output encoding only for text and optional provenance only for synchronized CSV', () => {
    const { view, get } = fixture(true);
    view.applyProfile({ outputEncoding: 'gbk', timestamps: true });
    for (const format of view.allowedFormats) {
        get('widget-export-format').value = format;
        view.sync({ available: true, syncAvailable: true });
        assert.equal(get('wrap-widget-export-output-encoding').hidden, !['text', 'engine-text'].includes(format));
        assert.equal(get('widget-export-sync-states-wrap').hidden, format !== 'csv');
        assert.equal(get('widget-export-text-metadata').hidden, format === 'binary');
        assert.equal(get('wrap-widget-export-markers').hidden, format === 'csv');
        assert.equal(view.read().direction, 'rx');
    }
    view.sync({ available: false });
    assert.equal(get('btn-widget-export').disabled, true);
    assert.equal(get('widget-export-format').disabled, false);
    get('widget-export-output-encoding').value = 'bad';
    get('widget-export-format').value = 'engine-text';
    assert.throws(() => view.read(), /字符集/);
});
