const test = require('node:test');
const assert = require('node:assert/strict');
const { bootApplication } = require('./helpers/widgetAppHarness');

const schema = () => ({ id: 'library', name: '示例协议', framing: { header: [170], fixedLength: 3 },
    payloadOffset: 1, messages: [{ id: 'sample', command: 1, fields: [{ id: 'sample.value', name: 'value', type: 'uint16' }] }] });
function fixture(t) { const f = bootApplication(); t.after(() => f.app.dispose()); return f; }

test('empty protocol libraries remain empty after configuration restore; presets are explicit', t => {
    const f = fixture(t);
    assert.equal(f.app.engineView.draft.protocols.length, 0);
    assert.equal(f.get('engine-protocol-edit').disabled, false);
    assert.equal(f.document.getElementById('engine-protocol-new'), null);
    assert.equal(f.document.getElementById('engine-protocol-preset'), null);
    const entry = f.get('engine-protocol-settings');
    assert.equal(entry.querySelectorAll('button').length, 1);
    assert.equal(entry.querySelectorAll('select').length, 1);
    assert.equal(entry.contains(f.get('engine-mappings')), false);
    f.get('engine-protocol-edit').click();
    const editor = f.app.engineView.editor;
    assert.equal(editor.emptyLibrary, true);
    editor.libraryFooter.querySelector('[data-action="add-robomaster-template"]').click();
    assert.equal(f.app.engineView.draft.protocols.length, 1);
    assert.equal(editor.emptyLibrary, false);
    f.app.engineView.updateProtocolLibrary([], null);
    assert.equal(f.app.getConfig().dataEngine.draft.protocols.length, 0);
    const config = f.app.getConfig(), restored = bootApplication(config);
    try { assert.equal(restored.app.engineView.draft.protocols.length, 0); }
    finally { restored.app.dispose(); }
});

test('protocol entry opens an existing library when no protocol is selected without adding a default', t => {
    const f = fixture(t), view = f.app.engineView;
    view.updateProtocolLibrary([schema()], null);
    f.get('engine-protocol-edit').click();
    assert.equal(view.editor.draft.id, 'library');
    assert.equal(view.draft.protocols.length, 1);
});

test('library deletion keeps applied revisions and refuses stale editor callbacks', async t => {
    const f = fixture(t), view = f.app.engineView, protocol = schema();
    view.updateProtocolLibrary([protocol], protocol.id);
    await view.apply();
    assert.equal(f.app.dataEngine.config.protocols[0].id, protocol.id);
    view.updateProtocolLibrary([], null);
    view.editor.onDraft({ ...protocol, name: '迟到的草稿' });
    assert.equal(view.draft.protocols.length, 0);
    assert.equal(f.app.dataEngine.config.protocols.length, 1);
    await assert.rejects(view.editor.onApply(protocol), /删除|不存在/);
    await view.apply();
    assert.equal(f.app.dataEngine.config.protocols.length, 0);
});

test('protocol deletion reference reports include mappings and nested structured sends', t => {
    const f = fixture(t), view = f.app.engineView;
    view.updateProtocolLibrary([schema()], 'library');
    view.draft.mappings.push({ protocolId: 'library', messageId: 'sample', path: 'value', channel: 0 });
    const group = f.app.commandLibrary.add('group'), id = f.app.commandLibrary.add('command', group);
    f.app.commandLibrary.update(id, { mode: 'protocol', protocol: { protocolId: 'library', messageId: 'sample', fields: { value: 1 } } });
    f.app.regularProtocolView.setValue({ protocolId: 'library', messageId: 'sample', fields: { value: 2 } });
    f.change('send-mode', 'protocol');
    const report = view.protocolReferences('library');
    assert.ok(report.some(item => item.kind === 'mapping'));
    assert.ok(report.some(item => item.kind === 'command' && item.id === id));
    assert.ok(report.some(item => item.kind === 'regular-send'));
});

test('inactive send drafts do not prevent deleting the only applied protocol', async t => {
    const f = fixture(t), view = f.app.engineView;
    view.updateProtocolLibrary([schema()], 'library'); await view.apply();
    assert.equal(f.get('send-mode').value, 'hex');
    assert.equal(f.app.regularProtocolView.getDraft().protocolId, 'library');
    assert.deepEqual(Array.from(view.protocolReferences('library')), []);
    view.editor.open(view.currentProtocol());
    view.editor.dialog.querySelector('[data-action="delete-protocol"]').click();
    view.editor.dialog.querySelector('[data-action="confirm-delete"]').click();
    assert.equal(view.draft.protocols.length, 0);
    await view.apply(); assert.equal(f.app.dataEngine.config.protocols.length, 0);
});

test('sample and editor layout state survive configuration save without changing wire protocols', async t => {
    const f = fixture(t), view = f.app.engineView;
    view.updateProtocolLibrary([schema()], 'library'); await view.apply();
    const wire = JSON.stringify(f.app.dataEngine.config.protocols);
    view.editor.onEditorState({ leftWidth: 240, samples: { library: [{ id: 'one', name: '样例 1', hex: 'AA 01 00' }] } });
    const saved = f.app.getConfig();
    assert.equal(JSON.stringify(saved.dataEngine.protocols), wire);
    assert.equal(saved.dataEngine.editorState.leftWidth, 240);
    assert.equal(saved.dataEngine.editorState.samples.library[0].name, '样例 1');
    assert.equal(saved.dataEngine.draft, null);
    const restored = bootApplication(saved);
    try { assert.equal(restored.app.engineView.editor.getEditorState().leftWidth, 240); }
    finally { restored.app.dispose(); }
});
