const test = require('node:test');
const assert = require('node:assert/strict');
const { bootApplication } = require('./helpers/widgetAppHarness');

test('disposing shared computation cancels its scheduled yield and does not retain a pending task', async t => {
    const f = bootApplication();
    t.after(() => f.app.dispose());
    const controller = f.app.widgets;
    controller.create({ type: 'wave' }); f.change('channel-rebuild-wave', false);
    const number = controller.addChannel('formula');
    f.app.service.receive(Uint8Array.of(0xab, 0, 0, 128, 63));
    f.change('channel-rebuild-wave', true);
    const pending = controller.updateChannelDefinition({ number, type: 'formula', expression: 'CH01*2' });
    assert.equal(f.app.service.numericSource.frames.rebuilding, true);
    f.app.dispose();
    assert.equal(f.timers.size, 0);
    await pending;
    assert.equal(f.app.service.numericSource.frames.rebuilding, false);
});

test('destroying the inspector detaches formula editor callbacks', () => {
    const f = bootApplication(), controller = f.app.widgets;
    controller.create({ type: 'wave' }); controller.addChannel('formula');
    const expression = f.get('channel-config-list').querySelector('[data-role="channel-expression"]');
    const apply = f.get('channel-config-list').querySelector('[data-role="channel-apply"]');
    f.app.dispose(); expression.value = 'CH01*3'; expression.dispatchEvent({ type: 'change' });
    apply.click();
    assert.equal(controller.globals.channelDefinitions[0].expression, 'CH01');
});
