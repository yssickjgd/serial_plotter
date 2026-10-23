const test = require('node:test');
const assert = require('node:assert/strict');
const { bootApplication } = require('./helpers/widgetAppHarness');

test('65535 pose binding choices use searchable pages and retain an off-page current channel', t => {
    const f = bootApplication(); t.after(() => f.app.dispose());
    const widget = f.app.widgets.create({ type: 'pose' }), view = f.app.widgets.poseConfigView;
    const channels = Array.from({ length: 65535 }, (_, index) => ({ index, name: index === 65534 ? '末端姿态' : 'CH' + (index + 1), signal: true }));
    f.app.widgets.channelMeta = () => channels;
    widget.settings.bindings.euler[0] = 65534;
    view.render(widget);
    const input = view.fields.get('bindings.euler.0').input;
    assert.ok(input.options.length <= 42);
    assert.equal(input.value, '65534');
    assert.ok(input.options.some(option => option.value === '65534' && option.textContent.includes('CH65535')));
    const picker = view.channelPickers.get('bindings.euler.0');
    picker.filter.value = '末端姿态'; picker.filter.dispatchEvent({ type: 'input' });
    assert.equal(input.value, '65534');
    assert.ok(input.options.some(option => option.textContent.includes('末端姿态')));
    picker.filter.value = 'CH1'; picker.filter.dispatchEvent({ type: 'input' });
    assert.ok(input.options.some(option => option.value === '0' && option.textContent.includes('CH00001')));
    assert.equal(input.value, '65534');
    assert.equal(widget.settings.bindings.euler[0], 65534);
});

test('pose binding pagination exposes later channels while keeping filtering separate from binding changes', t => {
    const f = bootApplication(); t.after(() => f.app.dispose());
    const widget = f.app.widgets.create({ type: 'pose' }), view = f.app.widgets.poseConfigView;
    f.app.widgets.channelMeta = () => Array.from({ length: 101 }, (_, index) => ({ index, name: '通道' + (index + 1), signal: true }));
    widget.settings.bindings.euler[0] = 99; view.render(widget);
    const picker = view.channelPickers.get('bindings.euler.0'), input = view.fields.get('bindings.euler.0').input;
    picker.next.click();
    assert.ok(input.options.some(option => option.value === '40'));
    assert.equal(input.value, '99'); assert.equal(widget.settings.bindings.euler[0], 99);
    picker.filter.value = '不存在'; picker.filter.dispatchEvent({ type: 'input' });
    assert.equal(input.options.length, 2, 'placeholder and current binding survive an empty filter result');
    assert.equal(input.value, '99');
});
