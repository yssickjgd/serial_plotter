const test = require('node:test');
const assert = require('node:assert/strict');
const { bootArrayApplication: bootApplication } = require('./helpers/widgetAppHarness');

test('disposing shared computation cancels its scheduled yield and does not retain a pending task', async t => {
    const f = bootApplication();
    t.after(() => f.app.dispose());
    const controller = f.app.widgets;
    controller.create({ type: 'wave' });
    f.selectConnection();
    f.change('rebuild-history', false); f.click('engine-apply');
    const number = controller.addChannel('formula');
    f.app.service.receive(Uint8Array.of(0, 0, 128, 63, 0, 0, 128, 127));
    f.change('rebuild-history', true); f.click('engine-apply');
    const pending = controller.updateChannelDefinition({ number, type: 'formula', expression: 'CH01*2' });
    assert.equal(f.app.service.numericSource.frames.rebuilding, true);
    f.app.dispose();
    assert.equal(f.timers.size, 0);
    await pending;
    assert.equal(f.app.service.numericSource.frames.rebuilding, false);
});

test('destroying the global engine editor detaches formula and autocomplete callbacks without a selected widget', () => {
    const f = bootApplication(), controller = f.app.widgets;
    const number = controller.addChannel('formula');
    f.app.engineView.channels.expanded.add(number); f.app.engineView.channels.refresh();
    const expression = f.get('engine-channel-panel').querySelector('[data-role="channel-expression"]');
    const editor = expression.closest('.channel-definition');
    assert.ok(expression); assert.ok(editor);
    assert.equal(f.document.querySelectorAll('.channel-autocomplete').length, 1);
    f.app.dispose(); expression.value = 'CH01*3'; expression.dispatchEvent({ type: 'change' });
    expression.dispatchEvent({ type: 'input' });
    editor.dispatchEvent({ type: 'pointerleave' });
    assert.equal(controller.globals.channelDefinitions[0].expression, 'CH00001');
    assert.equal(f.document.querySelectorAll('.channel-autocomplete').length, 0);
});

test('interactive channel validation rejects legacy lowercase syntax and new systems start with uppercase input', async t => {
    const f = bootApplication(); t.after(() => f.app.dispose());
    const controller = f.app.widgets, number = controller.addChannel('formula');
    for (const expression of ['diff(CH01)', 'int(CH01)', 'CH01[n]'])
        assert.throws(() => controller.validateChannelDefinition({ number, type: 'formula', expression }), undefined, expression);
    await controller.updateChannelDefinition({ number, type: 'formula', expression: 'INT(CH01)' });
    const system = controller.addChannel('system');
    assert.equal(controller.globals.channelDefinitions.find(definition => definition.number === system).expression, 'X[0]');
});
