const test = require('node:test');
const assert = require('node:assert/strict');
const { bootApplication } = require('./helpers/widgetAppHarness');
async function applyEngine(f) { const ready = f.app.engineView.apply(); await f.settle(); await ready; }

test('panel dimensions and explicit collapse preferences survive save reload and JSON import', async t => {
    const f = boot(t);
    f.get('main-display').clientHeight = 1000;
    f.get('navigation-panel').clientHeight = 70;
    for (const [handleId, panelId, width, dx] of [
        ['h-resizer', 'sidebar', 268, 87], ['right-resizer', 'channel-sidebar', 320, -90]
    ]) {
        f.get(panelId).clientWidth = width;
        f.get(handleId).dispatchEvent({ type: 'pointerdown', button: 0, pointerId: 7, clientX: 500 });
        f.document.dispatchEvent({ type: 'pointermove', pointerId: 7, clientX: 500 + dx });
        f.document.dispatchEvent({ type: 'pointerup', pointerId: 7 });
    }
    f.click('workspace-toggle-left');
    f.get('global-send').clientHeight = 200;
    f.get('send-resizer').dispatchEvent({ type: 'keydown', key: 'ArrowUp' });
    const expected = { leftWidth: 355, rightWidth: 410, leftOpen: false, rightOpen: true, sendHeight: 220, leftSplitRatio: .5 };
    assert.deepEqual(JSON.parse(JSON.stringify(f.app.getConfig().uiLayout)), expected);
    await f.tick(200);
    assert.deepEqual(JSON.parse(f.storage.get('serialplot_v3_config')).uiLayout, expected);
    const restored = boot(t, JSON.parse(f.storage.get('serialplot_v3_config')));
    assert.equal(restored.get('sidebar').style['--sidebar-w'], '355px');
    assert.equal(restored.get('channel-sidebar').style['--channel-sidebar-w'], '410px');
    assert.equal(restored.get('app-container').classList.contains('left-collapsed'), true);
    assert.equal(restored.get('workspace-toggle-right').getAttribute('aria-expanded'), 'true');
    restored.get('main-display').clientHeight = 1000;
    restored.get('navigation-panel').clientHeight = 70;
    restored.window.dispatchEvent({ type: 'resize' });
    assert.equal(restored.get('global-send').style.height, '220px');
    f.app.applyConfig({ ...f.app.getConfig(), uiLayout: { ...expected, leftOpen: true, rightOpen: false, sendHeight: 310 } });
    assert.equal(f.get('global-send').style.height, '310px');
    assert.equal(f.get('app-container').classList.contains('left-collapsed'), false);
    assert.equal(f.get('app-container').classList.contains('right-collapsed'), true);
    const before = JSON.stringify(f.app.getConfig());
    assert.throws(() => f.app.applyConfig({ ...f.app.getConfig(), uiLayout: { leftWidth: -1 } }), /界面布局/);
    assert.equal(JSON.stringify(f.app.getConfig()), before);
});

test('sender pointer resize saves only the completed drag and cancellation preserves the saved height', async t => {
    const f = boot(t), sender = f.get('global-send'), handle = f.get('send-resizer');
    f.get('main-display').clientHeight = 1000;
    f.get('navigation-panel').clientHeight = 70;
    sender.clientHeight = 200;
    const dragTo = end => {
        handle.dispatchEvent({ type: 'pointerdown', button: 0, pointerId: 9, clientY: 500 });
        f.document.dispatchEvent({ type: 'pointermove', pointerId: 9, clientY: 400 });
        f.document.dispatchEvent({ type: end, pointerId: 9 });
    };
    dragTo('pointercancel');
    assert.equal(f.app.getConfig().uiLayout.sendHeight, 200);
    dragTo('pointerup');
    assert.equal(f.app.getConfig().uiLayout.sendHeight, 300);
    await f.tick(200);
    assert.equal(JSON.parse(f.storage.get('serialplot_v3_config')).uiLayout.sendHeight, 300);
});

test('temporary compact layout and sender clamping preserve imported layout preferences', t => {
    const f = boot(t);
    const preferred = { leftWidth: 350, rightWidth: 400, leftOpen: true, rightOpen: false, sendHeight: 350, leftSplitRatio: .5 };
    f.window.innerWidth = 900;
    f.get('main-display').clientHeight = 380;
    f.get('navigation-panel').clientHeight = 70;
    f.app.applyConfig({ ...f.app.getConfig(), uiLayout: preferred });
    assert.equal(f.get('app-container').classList.contains('left-collapsed'), true);
    assert.equal(f.get('global-send').style.height, '160px');
    assert.deepEqual(JSON.parse(JSON.stringify(f.app.getConfig().uiLayout)), preferred);
    f.window.innerWidth = 1800;
    f.get('main-display').clientHeight = 1000;
    f.window.dispatchEvent({ type: 'resize' });
    assert.equal(f.get('global-send').style.height, '350px');
    assert.equal(f.get('app-container').classList.contains('left-collapsed'), false);
    assert.equal(f.get('app-container').classList.contains('right-collapsed'), true);
});

test('buffer memory budget defaults to 4096 MiB validates input and survives config import', async t => {
    const f = bootApplication(); t.after(() => f.app.dispose());
    assert.equal(f.get('capture-memory-mib').value, '4096');
    assert.equal(f.app.service.memoryUsage().limitBytes, 4096 * 1048576);
    f.get('capture-memory-mib').value = '64';
    f.get('capture-memory-mib').dispatchEvent({ type: 'change' });
    assert.equal(f.app.service.memoryUsage().limitBytes, 64 * 1048576);
    assert.equal(f.app.getConfig().global.captureMemoryMiB, 64);
    f.get('capture-memory-mib').value = '-1';
    f.get('capture-memory-mib').dispatchEvent({ type: 'change' });
    assert.equal(f.app.service.memoryUsage().limitBytes, 64 * 1048576);
    const next = f.app.getConfig(); next.global.captureMemoryMiB = 128;
    f.app.applyConfig(next);
    assert.equal(f.app.service.memoryUsage().limitBytes, 128 * 1048576);
    await f.tick(1000);
    assert.match(f.get('capture-memory-status').textContent, /128 MiB/);
});

test('P toggles global capture once per press and follows the same pause state as the button', t => {
    const f = bootApplication(); t.after(() => f.app.dispose());
    const widget = f.app.widgets.create({ type: 'wave' });
    const press = (key, extra = {}) => f.document.dispatchEvent({ type: 'keydown', key, target: widget.element, ...extra });
    press('p');
    assert.equal(f.app.service.paused, true);
    assert.equal(widget.view.isPaused, true);
    assert.equal(f.get('btn-pause').textContent, '恢复捕获');
    press('p', { repeat: true });
    assert.equal(f.app.service.paused, true, 'holding P must not toggle repeatedly');
    press('P');
    assert.equal(f.app.service.paused, false);
    assert.equal(widget.view.isPaused, false);
    f.click('btn-pause');
    press('p');
    assert.equal(f.app.service.paused, false);
});

test('capture shortcut ignores editing composition browser shortcuts and detaches on disposal', () => {
    const f = bootApplication();
    for (const target of [f.get('send-input'), f.get('widget-title'), f.get('plot-window-points'), f.get('plot-view-mode')]) {
        f.document.dispatchEvent({ type: 'keydown', key: 'p', target });
        assert.equal(f.app.service.paused, false);
    }
    const editable = f.document.createElement('div'); editable.isContentEditable = true;
    f.document.dispatchEvent({ type: 'keydown', key: 'p', target: editable });
    assert.equal(f.app.service.paused, false);
    for (const extra of [{ ctrlKey: true }, { altKey: true }, { metaKey: true }, { isComposing: true }, { defaultPrevented: true }]) {
        f.document.dispatchEvent({ type: 'keydown', key: 'p', target: f.document.body, ...extra });
        assert.equal(f.app.service.paused, false);
    }
    f.app.dispose();
    f.document.dispatchEvent({ type: 'keydown', key: 'p', target: f.document.body });
    assert.equal(f.app.service.paused, false);
});
const { GLOBAL_DEFAULTS } = require('../widgetConfig');
const config = widgets => ({ version: 2, global: { ...GLOBAL_DEFAULTS, dataType: 'uint8', enableHeader: false },
    widgets, workspace: { step: 10, rects: {} }, nextNumber: 10 });
const wave = id => ({ id, type: 'wave', title: id, settings: {} });
const bytes = (id, settings = {}) => ({ id, type: 'byte', title: id, settings: { captureMode: 'hex', ...settings } });
function boot(t, state) { const f = bootApplication(state); t.after(() => f.app?.dispose()); return f; }

test('one-click commands persist nested editing and tab state while ordinary sending remains independent', async t => {
    const f = boot(t), view = f.app.commandView;
    assert.ok(view, 'global command view is installed');
    f.click('send-tab-commands');
    assert.equal(f.get('send-panel').hidden, true);
    assert.equal(f.get('command-panel').hidden, false);
    f.click('command-add-group');
    const groupId = view.selectedId;
    view.add('command', groupId);
    const commandId = view.selectedId;
    const content = f.get('command-tree').querySelector('[data-field="content"]');
    content.value = '00 FF'; content.dispatchEvent({ type: 'input' });
    const saved = f.app.getConfig();
    assert.equal(saved.send.tab, 'commands');
    assert.equal(saved.send.commands[0].children[0].content, '00 FF');
    const transport = [];
    const adapter = f.app.serialAdapter;
    adapter.send = async bytes => transport.push([...bytes]);
    adapter.onConnectStatusChange(true);
    assert.equal(await f.app.commandRunner.start(groupId), true);
    assert.deepEqual(transport, [[0, 255]]);
    assert.equal(f.app.service.stats.txBytes, 2);
    f.click('send-tab-regular');
    f.get('send-input').value = 'CC'; await f.app.sendController.handleClick();
    assert.deepEqual(transport, [[0, 255], [204]]);
    assert.equal(f.app.commandLibrary.find(commandId).content, '00 FF');
    f.app.applyConfig(saved);
    assert.equal(f.get('command-panel').hidden, false);
    assert.equal(f.app.commandLibrary.find(commandId).content, '00 FF');
});

test('one-click send stops on disconnect and import rejection preserves the active command tree', async t => {
    const f = boot(t), adapter = f.app.serialAdapter;
    const id = f.app.commandLibrary.add('command');
    f.app.commandLibrary.update(id, { content: 'AA', repeat: 3, interval: 1 });
    const sent = [];
    adapter.send = async bytes => sent.push([...bytes]); adapter.onConnectStatusChange(true);
    const run = f.app.commandRunner.start(id);
    for (let i = 0; i < 20; i++) await Promise.resolve();
    adapter.onConnectStatusChange(false);
    assert.equal(await run, false);
    await f.tick(2000); assert.equal(sent.length, 1);
    const saved = f.app.getConfig(), invalid = JSON.parse(JSON.stringify(saved));
    invalid.send.commands.push(invalid.send.commands[0]);
    assert.throws(() => f.app.applyConfig(invalid), /指令/);
    assert.equal(f.app.commandLibrary.find(id).content, 'AA');
});

test('one-click editor renders names and text safely and regular send cancels a waiting sequence', async t => {
    const f = boot(t), adapter = f.app.serialAdapter, view = f.app.commandView;
    const id = view.add('command');
    f.app.commandLibrary.update(id, { name: '<script>test</script>', content: 'AA', repeat: 3, interval: 1 });
    view.render();
    assert.equal(f.get('command-tree').querySelector('script'), null);
    assert.equal(f.get('command-tree').querySelector('.command-name').value, '<script>test</script>');
    const sent = [];
    adapter.send = async bytes => sent.push([...bytes]); adapter.onConnectStatusChange(true);
    const run = f.app.commandRunner.start(id);
    for (let i = 0; i < 20; i++) await Promise.resolve();
    f.get('send-input').value = 'CC';
    await f.app.sendController.handleClick();
    assert.equal(await run, false);
    assert.deepEqual(sent, [[170], [204]]);
    const listeners = f.get('command-add').listeners.get('click').size;
    assert.ok(listeners > 0); f.app.dispose();
    assert.equal(f.get('command-add').listeners.get('click').size, 0);
});

test('command tree editor supports regrouping sorting folding inline errors and busy state', async t => {
    const f = boot(t), view = f.app.commandView, library = f.app.commandLibrary;
    const groupId = view.add('group'), a = view.add('command', groupId), b = view.add('command', groupId);
    library.update(a, { content: 'AA' }); library.update(b, { content: 'BB' }); view.render();
    const tree = f.get('command-tree');
    const row = () => tree.querySelector(`[data-command-id="${b}"]`).querySelector('.command-row');
    const field = name => name === 'parent' || name === 'name' ? row().querySelector(`[data-field="${name}"]`)
        : tree.querySelector('.command-editor').querySelector(`[data-field="${name}"]`);
    field('repeat').value = '0'; field('repeat').dispatchEvent({ type: 'change' });
    assert.equal(f.get('command-error').hidden, false);
    assert.equal(library.find(b).repeat, 1);
    field('repeat').value = '2'; field('repeat').dispatchEvent({ type: 'change' });
    assert.equal(library.find(b).repeat, 2);
    const action = text => row().querySelector('.command-row-actions').querySelectorAll('button').find(button => (button.getAttribute('aria-label') ?? button.textContent) === text);
    action('上移').click();
    assert.equal(library.find(groupId).children[0].id, b);
    field('parent').value = ''; field('parent').dispatchEvent({ type: 'change' });
    assert.equal(library.location(b).parent, null);
    assert.equal(library.find(groupId).children.length, 1);
    view.selectedId = groupId; view.render();
    const fold = tree.querySelector(`[data-command-id="${groupId}"]`).querySelector('.command-disclosure');
    fold.click(); assert.equal(library.find(groupId).collapsed, true);
    assert.equal(tree.querySelector(`[data-command-id="${a}"]`), null);
    view.setState({ running: true, currentId: b, message: '发送中' });
    assert.equal(f.get('command-add').disabled, true);
    assert.equal(field('name').disabled, true);
    assert.equal(f.get('command-stop').disabled, false);
    view.setState({ running: false, message: '完成' });
    assert.equal(f.get('command-add').disabled, false);
});

test('command rows expose identity and group run options inline while command payloads still expand', t => {
    const f = boot(t), view = f.app.commandView, tree = f.get('command-tree');
    const groupId = view.add('group'), id = view.add('command', groupId);
    const row = nodeId => tree.querySelector(`[data-command-id="${nodeId}"]`).querySelector('.command-row');
    const name = row(groupId).querySelector('.command-name');
    assert.equal(name.tagName, 'INPUT');
    name.value = '初始化'; name.dispatchEvent({ type: 'change' });
    assert.equal(f.app.commandLibrary.find(groupId).name, '初始化');
    assert.equal(row(id).querySelector('[data-field="parent"]').options.find(option => option.value === groupId).textContent, '初始化');
    assert.ok(row(groupId).querySelector('[data-field="parent"]'));
    assert.ok(row(groupId).querySelector('[data-field="repeat"]'));
    assert.ok(row(groupId).querySelector('[data-field="interval"]'));
    row(groupId).querySelector('.command-disclosure').click();
    assert.equal(f.app.commandLibrary.find(groupId).collapsed, true);
    assert.equal(tree.querySelector(`[data-command-id="${id}"]`), null);
    assert.equal(row(groupId).querySelector('.command-edit'), null);
    assert.equal(tree.querySelector('.command-editor'), null);
    row(groupId).querySelector('.command-disclosure').click();
    assert.equal(view.selectedId, id);
    const editor = tree.querySelector('.command-editor');
    assert.equal(editor.id, `command-editor-${id}`);
    assert.ok(row(id).querySelector('[data-field="name"]'));
    assert.ok(row(id).querySelector('[data-field="parent"]'));
    assert.equal(editor.querySelector('[data-field="name"]'), null);
    assert.equal(editor.querySelector('[data-field="parent"]'), null);
    assert.ok(editor.querySelector('.command-content-heading').querySelector('[data-field="mode"]'));
    assert.equal(editor.querySelector('[data-field="content"]').rows, 2);
    assert.ok(editor.querySelector('.command-send-options').querySelector('[data-field="repeat"]'));
    assert.ok(editor.querySelector('.command-send-options').querySelector('[data-field="interval"]'));
    row(id).querySelector('.command-disclosure').click();
    assert.equal(view.selectedId, null);
    assert.equal(row(id).querySelector('.command-disclosure').getAttribute('aria-expanded'), 'false');
});

test('command sorting keeps keyboard focus on the reordered item and uses its title at a list boundary', t => {
    const f = boot(t), tree = f.get('command-tree'), view = f.app.commandView;
    Object.getPrototypeOf(tree).focus = function () { if (!this.disabled) f.document.activeElement = this; };
    view.add('command'); view.add('command');
    const id = view.add('command');
    const up = tree.querySelector(`[data-command-id="${id}"]`).querySelector('[data-command-action="move-up"]');
    up.focus(); up.click();
    assert.ok(tree.contains(f.document.activeElement), 'rebuilding the editor must not leave focus on its detached old button');
    assert.equal(f.document.activeElement.dataset.commandAction, 'move-up');
    f.document.activeElement.click();
    assert.equal(f.app.commandLibrary.location(id).index, 0);
    assert.ok(tree.contains(f.document.activeElement));
    assert.equal(f.document.activeElement.dataset.commandAction, 'name');
});

test('native command dragging previews insertion and moves across groups or back to the root', t => {
    const f = boot(t), view = f.app.commandView, library = f.app.commandLibrary, tree = f.get('command-tree');
    const g = view.add('group'), a = view.add('command', g), b = view.add('command'), c = view.add('command');
    const row = id => tree.querySelector(`[data-command-id="${id}"]`).querySelector('.command-row');
    const transfer = { setData(type, id) { this.type = type; this.id = id; } };
    const drag = id => row(id).querySelector('.command-drag-handle').dispatchEvent({ type: 'dragstart', dataTransfer: transfer });
    drag(b);
    row(c).dispatchEvent({ type: 'dragover', clientY: 599, dataTransfer: transfer });
    assert.equal(row(c).classList.contains('command-drop-after'), true);
    row(c).dispatchEvent({ type: 'drop', dataTransfer: transfer });
    assert.deepEqual(Array.from(library.nodes, node => node.id), [g, c, b]);
    drag(b);
    row(g).dispatchEvent({ type: 'dragover', clientY: 300, dataTransfer: transfer });
    assert.equal(row(g).classList.contains('command-drop-inside'), true);
    row(g).dispatchEvent({ type: 'drop', dataTransfer: transfer });
    assert.equal(library.location(b).parent.id, g);
    assert.deepEqual(Array.from(library.find(g).children, node => node.id), [a, b]);
    drag(b);
    const root = tree.querySelector('.command-root-drop');
    assert.equal(root.hidden, false);
    root.dispatchEvent({ type: 'dragover', bubbles: true, dataTransfer: transfer });
    root.dispatchEvent({ type: 'drop', bubbles: true, dataTransfer: transfer });
    assert.equal(library.location(b).parent, null);
    assert.equal(tree.querySelector('.command-root-drop').hidden, true);
    drag(g);
    const saved = JSON.stringify(library.serialize());
    row(a).dispatchEvent({ type: 'dragover', clientY: 0, dataTransfer: transfer });
    assert.equal(transfer.dropEffect, 'none');
    row(a).dispatchEvent({ type: 'drop', dataTransfer: transfer });
    assert.equal(JSON.stringify(library.serialize()), saved);
    drag(c); f.document.dispatchEvent({ type: 'keydown', key: 'Escape' });
    assert.equal(view.dragId, null);
    assert.equal(tree.querySelector('.command-root-drop').hidden, true);
    assert.deepEqual(Array.from(f.app.getConfig().send.commands, node => node.id), [g, c, b]);
});

test('inline group settings and recursive copies persist independently and block dragging while sending', t => {
    const f = boot(t), view = f.app.commandView, library = f.app.commandLibrary, tree = f.get('command-tree');
    const g = view.add('group'), a = view.add('command', g);
    library.update(a, { content: 'AA' }); view.render();
    const row = id => tree.querySelector(`[data-command-id="${id}"]`).querySelector('.command-row');
    for (const [field, value] of [['repeat', '3'], ['interval', '.25']]) {
        const input = row(g).querySelector(`[data-field="${field}"]`); input.value = value; input.dispatchEvent({ type: 'change' });
    }
    row(g).querySelectorAll('button').find(button => button.textContent === '复制').click();
    const copyId = view.selectedId;
    assert.notEqual(copyId, g);
    assert.equal(library.find(copyId).repeat, 3); assert.equal(library.find(copyId).interval, .25);
    const copyName = row(copyId).querySelector('.command-name');
    copyName.value = '副本测试'; copyName.dispatchEvent({ type: 'change' });
    assert.notEqual(library.find(g).name, '副本测试');
    assert.equal(library.find(copyId).children[0].content, 'AA');
    const saved = f.app.getConfig(); f.app.applyConfig(saved);
    assert.equal(library.find(copyId).name, '副本测试'); assert.equal(library.find(copyId).repeat, 3);
    assert.equal(row(copyId).querySelector('.command-edit'), null);
    const parent = row(a).querySelector('[data-field="parent"]');
    parent.dispatchEvent({ type: 'focus' });
    assert.ok(parent.options.some(option => option.value === copyId));
    view.setState({ running: true, currentId: a, message: '发送中' });
    const handle = row(g).querySelector('.command-drag-handle');
    assert.equal(handle.draggable, false);
    handle.dispatchEvent({ type: 'dragstart', dataTransfer: { setData() {} } });
    assert.equal(view.dragId, null);
    assert.equal(row(g).querySelector('.command-name').disabled, true);
});

test('a send button rejects an invalid inline draft instead of sending with the last valid group count', async t => {
    const f = boot(t), view = f.app.commandView, library = f.app.commandLibrary, tree = f.get('command-tree');
    const g = view.add('group'), a = view.add('command', g);
    library.update(a, { content: 'AA' }); view.render();
    const writes = []; f.app.serialAdapter.send = async bytes => writes.push([...bytes]);
    f.app.serialAdapter.onConnectStatusChange(true);
    const item = tree.querySelector(`[data-command-id="${g}"]`), repeat = item.querySelector('[data-field="repeat"]');
    repeat.value = '0'; repeat.dispatchEvent({ type: 'change' });
    item.querySelector('.command-send').click();
    for (let i = 0; i < 20; i++) await Promise.resolve();
    assert.equal(writes.length, 0);
    assert.equal(f.get('command-error').hidden, false);
    repeat.value = '2'; repeat.dispatchEvent({ type: 'change' });
    item.querySelector('.command-send').click();
    for (let i = 0; i < 30; i++) await Promise.resolve();
    assert.deepEqual(writes, [[170], [170]]);
});

test('command tabs share one sender height and keep the separator fixed after a resize and mode switch', t => {
    const f = boot(t), handle = f.get('send-resizer'), input = f.get('send-input'), tree = f.get('command-tree'), sender = f.get('global-send');
    f.get('send-tab-regular').dispatchEvent({ type: 'keydown', key: 'ArrowRight' });
    assert.equal(f.get('send-panel').hidden, true);
    assert.equal(f.get('send-tab-commands').getAttribute('aria-selected'), 'true');
    f.get('main-display').clientHeight = 700;
    f.get('navigation-panel').clientHeight = 70;
    sender.clientHeight = 200;
    handle.dispatchEvent({ type: 'pointerdown', button: 0, pointerId: 9, clientY: 600 });
    f.document.dispatchEvent({ type: 'pointermove', pointerId: 9, clientY: 550 });
    assert.equal(sender.style.height, '250px');
    assert.equal(input.style.height, undefined);
    assert.equal(tree.style.height, undefined);
    f.document.dispatchEvent({ type: 'pointerup', pointerId: 9 });
    f.get('send-tab-commands').dispatchEvent({ type: 'keydown', key: 'Home' });
    assert.equal(f.get('send-panel').hidden, false);
    assert.equal(f.get('command-panel').hidden, true);
    assert.equal(sender.style.height, '250px');
    f.click('send-tab-commands');
    assert.equal(sender.style.height, '250px');
});

test('parent selections expose their complete path on hover and refresh after a group rename', t => {
    const f = boot(t), view = f.app.commandView, tree = f.get('command-tree');
    const g = view.add('group'), nested = view.add('group', g), id = view.add('command', nested);
    f.app.commandLibrary.update(g, { name: '完整的上级指令组名称' });
    f.app.commandLibrary.update(nested, { name: '完整的下级指令组名称' }); view.render();
    const row = nodeId => tree.querySelector(`[data-command-id="${nodeId}"]`).querySelector('.command-row');
    const select = row(id).querySelector('[data-field="parent"]');
    assert.equal(select.title, '完整的上级指令组名称 / 完整的下级指令组名称');
    select.dispatchEvent({ type: 'focus' });
    const option = select.options.find(item => item.value === nested);
    assert.equal(option.title, select.title);
    const name = row(g).querySelector('.command-name'); name.value = '新组名'; name.dispatchEvent({ type: 'change' });
    assert.equal(select.title, '新组名 / 完整的下级指令组名称');
    assert.equal(option.title, select.title);
});

test('deleting a nonempty command requires a second click while an empty command can be removed directly', t => {
    const f = boot(t), view = f.app.commandView, library = f.app.commandLibrary, tree = f.get('command-tree');
    const id = view.add('command'); library.update(id, { content: 'AA' }); view.render();
    const remove = nodeId => tree.querySelector(`[data-command-id="${nodeId}"]`).querySelector('.command-delete');
    remove(id).click();
    assert.ok(library.find(id)); assert.match(remove(id).textContent, /确认删除/);
    remove(id).click(); assert.equal(library.find(id), null);
    const empty = view.add('command'); remove(empty).click(); assert.equal(library.find(empty), null);
    const whitespace = view.add('command'); library.update(whitespace, { content: ' ' }); view.render();
    remove(whitespace).click(); assert.ok(library.find(whitespace));
    remove(whitespace).click(); assert.equal(library.find(whitespace), null);
});

test('starting a group cancels ordinary repeats while serializing behind an already submitted write', async t => {
    const f = boot(t), adapter = f.app.serialAdapter;
    let finish;
    const sent = [];
    adapter.send = bytes => { sent.push([...bytes]); return sent.length === 1
        ? new Promise(resolve => { finish = resolve; }) : Promise.resolve(); };
    adapter.onConnectStatusChange(true);
    f.get('send-input').value = 'AA'; f.change('send-interval', '1');
    const ordinary = f.app.sendController.handleClick();
    const id = f.app.commandLibrary.add('command');
    f.app.commandLibrary.update(id, { content: 'BB' });
    const groupRun = f.app.commandRunner.start(id);
    assert.equal(sent.length, 1);
    finish(); await Promise.all([ordinary, groupRun]);
    assert.equal(f.app.sendController.timer, null);
    assert.deepEqual(sent, [[170], [187]]);
    assert.equal(f.app.service.stats.txBytes, 2);
});

test('wave axes use shared arrival-based sampling rate instead of a jittering statistics timer', async t => {
    const f = boot(t, config([wave('w1'), wave('w2'), bytes('b1', { captureMode: 'number' })]));
    const s = f.app.service, first = f.app.widgets.widgets.get('w1').view;
    for (let i = 0; i <= 200; i++) s.receive(new Uint8Array(10), { arrival: i * 10 });
    await f.tick(2100);
    assert.equal(first.sampleRateHz, 1000);
    for (let i = 201; i <= 300; i++) s.receive(new Uint8Array(10), { arrival: i * 10 });
    await f.tick(980);
    assert.equal(first.sampleRateHz, 1000);
    assert.equal(f.app.widgets.widgets.get('w2').view.sampleRateHz, 1000);
    assert.equal(f.app.widgets.widgets.get('b1').refs['stat-fps-value'].textContent, '1020 f/s',
        'the receive-rate statistic retains its live one-second meaning');
    f.click('btn-pause'); await f.tick(10000);
    assert.equal(first.sampleRateHz, 1000);
});

test('a fresh page has no widgets while persistent acquisition continues', async t => {
    const f = boot(t);
    assert.equal(f.app.widgets.widgets.size, 0);
    assert.equal(f.get('workspace-empty').hidden, false);
    f.app.serialAdapter.onDataCallback(Uint8Array.of(0xab, 0, 0, 128, 63));
    await f.tick();
    assert.equal(f.app.service.numericSource.frames.length, 1);
    assert.equal(f.app.service.baseSource.frames.length, 1);
    assert.equal(f.app.service.stats.rxBytes, 5);
    assert.equal(f.writes, 0, 'bootstrap must not overwrite missing or existing stored settings');
});

test('disposing during serial selection prevents a late connection and retains detached callbacks', async t => {
    const f = boot(t);
    let release, opened = 0;
    f.context.navigator.serial = { requestPort: () => new Promise(resolve => { release = resolve; }) };
    f.click('btn-connect');
    f.app.dispose();
    release({ open: async () => { opened++; }, close: async () => {} });
    for (let i = 0; i < 30; i++) await Promise.resolve();
    assert.equal(opened, 0);
    assert.equal(f.app.serialAdapter.port, null);
    assert.equal(f.app.serialAdapter.onConnectStatusChange, null);
    assert.equal(f.app.serialAdapter._connected, false);
});

test('legacy settings migrate to two independent views without losing channel transforms', t => {
    const f = boot(t, { dataType: 'uint8', enableHeader: false, channelsCount: '1',
        captureMode: 'hex', channels: [{ name: 'Voltage', visible: true, gainEnabled: true, gain: 2 }] });
    assert.equal(f.app.widgets.widgets.size, 2);
    assert.equal(f.app.getConfig().version, 3);
    assert.equal(f.app.widgets.widgets.get('wave-1').view.getChannelMeta()[0].gain, 2);
    assert.equal(f.app.getConfig().global.channelNames[0], 'Voltage');
    assert.equal(f.writes, 0);
});

test('multiple waves and byte monitors share parsers without multiplying physical RX', async t => {
    const f = boot(t, config([wave('w1'), wave('w2'), bytes('b1'), bytes('b2')]));
    f.app.serialAdapter.onDataCallback(Uint8Array.of(10, 20, 30));
    await f.tick();
    const widgets = f.app.widgets.widgets;
    assert.equal(widgets.get('w1').view.frames, widgets.get('w2').view.frames);
    assert.equal(widgets.get('b1').source, widgets.get('b2').source);
    assert.equal(widgets.get('w1').view.frames.length, 3);
    assert.equal(widgets.get('b1').view.frames.length, 1);
    assert.equal(f.app.service.stats.rxBytes, 3);
    f.app.widgets.remove('w1'); f.app.widgets.remove('w2');
    f.app.serialAdapter.onDataCallback(Uint8Array.of(40));
    assert.equal(f.app.service.numericSource.frames.length, 4);
});

test('global pause and clear update every view and preserve pause state', async t => {
    const f = boot(t, config([wave('w1'), bytes('b1')]));
    f.app.serialAdapter.onDataCallback(Uint8Array.of(1, 2));
    f.click('btn-pause');
    assert.equal(f.app.service.paused, true);
    assert.equal(f.app.widgets.widgets.get('w1').view.isPaused, true);
    f.app.serialAdapter.onDataCallback(Uint8Array.of(3));
    assert.equal(f.app.service.numericSource.frames.length, 2);
    assert.equal(f.app.service.stats.rxBytes, 3);
    f.click('btn-clear');
    assert.equal(f.app.service.paused, true);
    assert.equal(f.app.service.numericSource.frames.length, 0);
    assert.equal(f.app.service.baseSource.frames.length, 0);
    assert.equal(f.app.service.stats.rxBytes, 0);
    f.click('btn-pause');
    f.app.serialAdapter.onDataCallback(Uint8Array.of(4));
    assert.equal(f.app.service.numericSource.frames.length, 1);
});

test('configuration import validates atomically and saves a complete versioned workspace', async t => {
    const f = boot(t, config([wave('w1')]));
    const before = JSON.stringify(f.app.getConfig());
    const bad = f.app.getConfig(); bad.global.maxPoints = '-1';
    assert.throws(() => f.app.applyConfig(bad));
    assert.equal(JSON.stringify(f.app.getConfig()), before);
    f.app.widgets.create({ type: 'byte', title: 'extra' });
    await f.tick(200);
    const stored = JSON.parse(f.storage.get('serialplot_v3_config'));
    assert.equal(stored.version, 3);
    assert.equal(stored.widgets.length, 2);
    assert.equal(Object.keys(stored.workspace.rects).length, 2);
});

test('export source is independent from activation and missing byte sources require reselection', async t => {
    const f = boot(t, config([wave('w1'), wave('w2'), bytes('b1', { captureMode: 'text', textBoundary: 'lf' })]));
    f.app.serialAdapter.onDataCallback(Uint8Array.of(4)); f.app.service.pause(true); await f.tick();
    f.change('export-format', 'csv');
    assert.equal(f.get('btn-export').disabled, false);
    f.app.widgets.activate('w1');
    f.app.widgets.activate('w2');
    assert.equal(f.get('export-source').value, 'numeric');
    f.change('export-format', 'binary'); f.change('export-source', 'b1'); f.app.widgets.remove('b1');
    assert.equal(f.get('export-source').value, '');
    assert.equal(f.get('btn-export').disabled, true);
    f.app.widgets.activate('w1');
    assert.equal(f.get('btn-export').disabled, true);
    f.change('export-source', 'numeric');
    f.change('export-format', 'hex-text');
    assert.equal(f.get('export-source').value, 'numeric');
    assert.equal(f.get('export-format').options.find(option => option.value === 'csv').disabled, false);
});

test('CSV exports use shared values regardless of active wave calibration and include UTF8 BOM', async t => {
    const f = boot(t, config([wave('w1'), wave('w2')]));
    const widget = f.app.widgets.widgets.get('w1');
    Object.assign(widget.settings.channels[0], { gainEnabled: true, gain: 2, offsetEnabled: true, offset: 3 });
    f.app.widgets.applySettings(widget);
    f.app.serialAdapter.onDataCallback(Uint8Array.of(4));
    f.app.widgets.activate('w2');
    assert.equal(await f.app.exportData(), true);
    f.app.widgets.activate('w1');
    assert.equal(await f.app.exportData(), true);
    assert.match(await f.blobs[0].text(), /0,4/);
    assert.match(await f.blobs[1].text(), /0,4/);
    assert.deepEqual([...new Uint8Array(await f.blobs[0].arrayBuffer()).subarray(0, 3)], [239, 187, 191]);
});

test('source and per-view draw rate statistics return to zero when idle', async t => {
    const f = boot(t, config([wave('w1'), bytes('b1')]));
    await f.tick();
    f.app.serialAdapter.onDataCallback(Uint8Array.of(1, 2)); await f.tick();
    const widget = f.app.widgets.widgets.get('w1');
    assert.match(widget.refs['stat-plot-fps'].textContent, /[1-9].*FPS/);
    assert.equal(widget.view.sampleRateHz, 0, 'a single received packet cannot establish the sample clock');
    await f.tick(); await f.tick();
    assert.match(widget.refs['stat-plot-fps'].textContent, /0 FPS/);
    assert.equal(f.app.widgets.widgets.get('b1').refs['stat-fps-value'].textContent, '0 f/s');
});

test('wave FPS tooltip distinguishes the actual GPU from the requested performance preference', async t => {
    const f = boot(t, config([wave('w1')]));
    const widget = f.app.widgets.widgets.get('w1');
    const renderer = { available: true, rendererName: 'ANGLE (Intel, Intel(R) UHD Graphics, D3D11)',
        render: () => true, resize() {}, dispose() {} };
    widget.view.gpuRenderer = renderer;
    await f.tick();
    assert.match(widget.refs['stat-plot-fps'].title, /Intel\(R\) UHD Graphics/);
    renderer.rendererName = 'ANGLE (NVIDIA, NVIDIA GeForce RTX 4060 Laptop GPU, D3D11)';
    await f.tick();
    assert.match(widget.refs['stat-plot-fps'].title, /NVIDIA GeForce RTX 4060/);
    assert.doesNotMatch(widget.refs['stat-plot-fps'].title, /Intel/);
    renderer.rendererName = '';
    await f.tick();
    assert.match(widget.refs['stat-plot-fps'].title, /未提供/);
    renderer.available = false;
    await f.tick();
    assert.match(widget.refs['stat-plot-fps'].title, /Canvas 2D/);
});

test('application disposal stops timers and removes views without saving an empty layout', async t => {
    const f = boot(t, config([wave('w1'), bytes('b1')]));
    await f.tick();
    const before = f.storage.get('serialplot_v3_config');
    f.app.dispose(); f.app.dispose();
    assert.equal(f.app.service.disposed, true);
    assert.equal(f.app.widgets.widgets.size, 0);
    assert.equal(f.intervals.size, 0);
    assert.equal(f.rafs.size, 0);
    assert.equal(f.storage.get('serialplot_v3_config'), before);
});

test('the global sender writes once and shares successful and failed TX records across byte widgets', async t => {
    const f = boot(t, config([bytes('b1'), bytes('b2')]));
    const sent = [];
    f.app.serialAdapter.send = async value => { sent.push([...value]); };
    f.app.serialAdapter.onConnectStatusChange(true);
    f.get('send-input').value = '41 42';
    assert.equal(await f.app.sendController.sendOnce(), true);
    assert.deepEqual(sent, [[65, 66]]);
    assert.equal(f.app.service.stats.txBytes, 2);
    assert.equal(f.app.service.txFrames.length, 1);
    for (const widget of f.app.widgets.widgets.values()) {
        widget.view.render();
        assert.equal(widget.view.lastRows.filter(row => row.kind === 'tx').length, 1);
        assert.equal(widget.view.extras.length, 0);
    }
    f.app.serialAdapter.send = async () => { throw new Error('device unavailable'); };
    assert.equal(await f.app.sendController.sendOnce(), false);
    for (const widget of f.app.widgets.widgets.values()) assert.equal(widget.view.extras.at(-1).kind, 'tx-error');
    assert.equal(f.app.service.stats.txBytes, 2);
    assert.equal(f.app.service.txFrames.length, 1);
});

test('byte buffer export combines chronological RX and shared TX without changing bytes', async t => {
    const f = boot(t, config([bytes('b1')]));
    f.app.serialAdapter.onDataCallback(Uint8Array.of(65, 66)); await f.tick();
    f.app.sendController.onSent(Uint8Array.of(67));
    f.change('export-format', 'binary'); f.change('export-source', 'base'); f.change('export-direction', 'both');
    assert.equal(await f.app.exportData(), true);
    assert.deepEqual([...new Uint8Array(await f.blobs[0].arrayBuffer())], [65, 66, 67]);
    f.change('export-format', 'text'); f.change('export-encoding', 'ascii');
    f.change('export-direction', 'both');
    f.change('export-timestamps', false); f.change('export-markers', false);
    assert.equal(await f.app.exportData(), true);
    assert.equal(await f.blobs[1].text(), 'ABC');
});

test('changing one byte parser rebuilds that source while other views continue receiving', async t => {
    const f = boot(t, config([wave('w1'), bytes('b1'), bytes('b2')]));
    f.app.serialAdapter.onDataCallback(Uint8Array.of(65, 10, 66, 10)); await f.tick();
    const before = f.app.widgets.widgets.get('b2').source;
    f.app.widgets.activate('b1'); f.change('capture-mode', 'text'); f.change('text-boundary', 'lf');
    await f.settle();
    const changed = f.app.widgets.widgets.get('b1').source;
    assert.notEqual(changed, before);
    assert.equal(f.app.widgets.widgets.get('b2').source, before);
    assert.equal(changed.frames.length, 2);
    f.app.serialAdapter.onDataCallback(Uint8Array.of(67, 10)); await f.tick();
    assert.equal(changed.frames.length, 3);
    assert.equal(f.app.service.numericSource.frames.length, 6);
    assert.equal(f.app.service.stats.rxBytes, 6);
});

test('shared numeric rule changes preserve raw bytes and do not report replay as a new sample rate', async t => {
    const f = boot(t, config([wave('w1'), bytes('b1')]));
    f.app.serialAdapter.onDataCallback(Uint8Array.of(1, 2, 3, 4)); await f.tick();
    f.app.widgets.activate('w1'); f.change('data-type', 'uint16'); await applyEngine(f);
    assert.deepEqual(Array.from(f.app.service.numericSource.frames.channelSlice(0)), [513, 1027]);
    assert.deepEqual(Array.from(f.app.service.baseSource.frames.rawBytesAt(0)), [1, 2, 3, 4]);
    assert.equal(f.app.service.stats.rxBytes, 4);
    assert.equal(f.get('history-rebuild-progress').hidden, true);
});

test('search and default nearest reference follow the active widget without a placeholder option', async t => {
    const initial = config([wave('w1'), bytes('b1')]); initial.tools = { sourceId: 'b1', referenceId: 'w1' };
    const f = boot(t, initial);
    f.app.widgets.activate('b1');
    assert.equal(f.get('monitor-search-origin').value, 'b1');
    assert.ok(f.get('monitor-search-origin').options.every(option => option.value));
    f.app.serialAdapter.onDataCallback(Uint8Array.of(65, 66, 65)); await f.tick();
    assert.equal(f.get('monitor-search-nearest').disabled, true);
    f.click('btn-pause');
    f.get('monitor-search-query').value = '41';
    const pending = f.app.tools.requestSearch('nearest');
    await f.tick(); assert.equal(await pending, true);
    assert.equal(f.app.tools.matches.length, 2);
    assert.equal(f.app.widgets.widgets.get('b1').view.followTail, false);
    assert.equal(f.app.tools.sourceId, 'b1');
    f.app.widgets.activate('w1');
    assert.equal(f.app.tools.sourceId, 'w1');
    assert.equal(f.app.tools.matches.length, 0);
    assert.equal(f.app.tools.referenceId, 'w1');
    assert.equal(f.get('monitor-search-tolerance').hidden, false);
    f.app.widgets.remove('b1');
    assert.equal(f.app.tools.sourceId, 'w1');
    f.app.widgets.activate(null);
    assert.equal(f.app.tools.sourceId, null);
    assert.equal(f.get('monitor-search-nearest').disabled, true);
});

test('large streaming export aborts when the selected source changes while writing', async t => {
    const initial = config([wave('w1')]); initial.global.maxPoints = '60000';
    const f = boot(t, initial);
    f.app.serialAdapter.onDataCallback(new Uint8Array(50001).fill(7));
    f.app.widgets.activate('w1');
    let writes = 0, aborts = 0, closes = 0;
    f.window.showSaveFilePicker = async () => ({ async createWritable() { return {
        async write() { writes++; f.app.service.clear(); }, async abort() { aborts++; }, async close() { closes++; }
    }; } });
    assert.equal(await f.app.exportData(), false);
    assert.equal(writes, 1); assert.equal(aborts, 1); assert.equal(closes, 0);
    assert.match(f.get('export-source-status').textContent, /导出失败/);
});

test('invalid saved settings show an error without overwriting storage or creating partial widgets', async t => {
    const invalid = { ...config([wave('w1')]), widgets: [{ id: 'bad', type: 'unknown', title: 'bad' }] };
    const f = boot(t, invalid);
    assert.equal(f.app.widgets.widgets.size, 0);
    assert.equal(f.get('cfg-save-status').hidden, false);
    await f.tick(); assert.equal(f.writes, 0);
    assert.equal(f.storage.get('serialplot_v3_config'), JSON.stringify(invalid));
});

test('capacity changes clamp every wave window and text widgets show decoding failures', async t => {
    const f = boot(t, config([wave('w1'), wave('w2'), bytes('b1', { captureMode: 'text', textEncoding: 'ascii' })]));
    f.change('max-points', '50');
    for (const widget of f.app.widgets.widgets.values()) if (widget.type === 'wave') {
        assert.equal(widget.view.plotWindowPoints, 50); assert.equal(f.app.getConfig().global.plotWindowPoints, '50');
    }
    f.app.serialAdapter.onDataCallback(Uint8Array.of(65, 255)); f.app.service.endStream();
    await f.tick(); await f.tick();
    const widget = f.app.widgets.widgets.get('b1');
    assert.match(widget.refs['stat-fps-value'].textContent, /^\d+ f\/s$/);
    assert.equal(widget.refs['stat-fail-label'].textContent, '失败字符 / 总字符:');
    assert.equal(widget.refs['stat-fail-value'].textContent, '1 / 2 (50.0%)');
    assert.match(widget.refs['stat-rx-value'].textContent, /\(2 B\)/);
});

test('wave sampling frequency survives idle periods, pause, and rebuilding baselines', async t => {
    const f = boot(t, config([wave('w1')])), widget = f.app.widgets.widgets.get('w1');
    for (let i = 0; i <= 2; i++) f.app.service.receive(Uint8Array.of(1, 2, 3), { arrival: i * 1000 });
    await f.tick(2100);
    const rate = widget.view.sampleRateHz;
    assert.ok(rate > 0);
    await f.tick(); assert.equal(widget.view.sampleRateHz, rate);
    f.click('btn-pause'); await f.tick(); assert.equal(widget.view.sampleRateHz, rate);
    widget.source.generation++; await f.tick(); assert.equal(widget.view.sampleRateHz, rate);
    f.click('btn-clear'); assert.equal(widget.view.sampleRateHz, 0);
});

test('per-buffer text options and CSV channel selection survive a configuration reload', t => {
    const initial = config([bytes('b1'), wave('w1')]); initial.global.channelsCount = '2';
    const f = boot(t, initial);
    f.change('export-format', 'text'); f.change('export-source', 'base');
    f.change('export-direction', 'both'); f.change('export-encoding', 'gb18030');
    f.get('export-timestamps').checked = false; f.get('export-markers').checked = true;
    const restored = boot(t, f.app.getConfig());
    assert.equal(restored.get('export-source').value, 'base');
    assert.equal(restored.get('export-format').value, 'text');
    assert.equal(restored.get('export-direction').value, 'both');
    assert.equal(restored.get('export-encoding').value, 'gb18030');
    assert.equal(restored.get('export-timestamps').checked, false);
    assert.equal(restored.get('export-markers').checked, true);
    f.change('export-source', 'numeric'); f.change('export-format', 'csv');
    const checkbox = f.get('export-channel-list').children[0].children[0];
    checkbox.checked = false; checkbox.dispatchEvent({ type: 'change' });
    const csv = boot(t, f.app.getConfig());
    assert.equal(csv.get('export-source').value, 'numeric');
    assert.deepEqual(Array.from(csv.app.getConfig().tools.exportProfiles.numeric.formats.csv.channelIndices), [1]);
});

test('network mode reveals its controls and connects with the requested remote and local ports', async t => {
    const f = boot(t, config([]));
    f.change('conn-type', 'udp');
    assert.equal(f.get('config-net').hidden, false);
    assert.notEqual(f.get('config-net').style.display, 'none');
    assert.notEqual(f.get('wrap-local-port').style.display, 'none');
    f.change('net-port', '9001'); f.change('net-local', '9002');
    let received;
    f.app.netAdapter.connect = async value => { received = value; f.app.netAdapter.onConnectStatusChange(true); };
    f.click('btn-connect'); await f.tick();
    assert.equal(received.mode, 'udp'); assert.equal(received.port, 9001); assert.equal(received.localPort, 9002);
    assert.equal(f.get('conn-type').disabled, true);
    f.click('btn-connect'); await f.tick();
    assert.equal(f.get('conn-type').disabled, false);
});

test('connection failures reenable controls and send repetition stops after disconnection', async t => {
    const f = boot(t, config([]));
    f.app.serialAdapter.connect = async () => { throw new Error('permission denied'); };
    f.click('btn-connect'); await f.tick();
    assert.match(f.get('connection-status').textContent, /permission denied/);
    assert.equal(f.get('btn-connect').disabled, false);
    f.app.serialAdapter.send = async () => {};
    f.app.serialAdapter.onConnectStatusChange(true);
    f.get('send-input').value = '41'; f.change('send-interval', '1');
    await f.app.sendController.handleClick();
    assert.notEqual(f.app.sendController.timer, null);
    f.app.serialAdapter.onConnectStatusChange(false);
    assert.equal(f.app.sendController.timer, null);
});

test('library add and drop create real views and saved grid steps apply on import', async t => {
    const f = boot(t, config([]));
    f.document.querySelector('[data-add-widget="wave"]').click();
    f.app.workspace.onDrop({ type: 'byte', rect: { x: 0, y: 320, width: 640, height: 300 } });
    assert.equal(f.app.widgets.widgets.size, 2);
    assert.equal(f.get('workspace-empty').hidden, true);
    const next = config([wave('restored')]); next.workspace.step = 40;
    f.app.applyConfig(next); await f.settle();
    assert.equal(f.app.workspace.step, 40);
    assert.equal(f.get('workspace-step').value, '40');
});

test('workspace zoom saves and imports before placing widgets without explicit rectangles', async t => {
    const f = boot(t, config([wave('w1')]));
    f.app.workspace.setZoom(2);
    await f.tick(200);
    assert.equal(JSON.parse(f.storage.get('serialplot_v3_config')).workspace.zoom, 2);
    const next = config([wave('w2')]); next.workspace.zoom = 0.5;
    f.app.applyConfig(next); await f.settle();
    assert.equal(f.app.workspace.zoom, 0.5);
    assert.equal(f.get('workspace-zoom-percent').value, '50');
    f.change('workspace-zoom-percent', '155');
    assert.equal(f.app.workspace.zoom, 1.55);
    f.change('workspace-zoom-percent', '501');
    assert.equal(f.app.workspace.zoom, 1.55);
    assert.equal(f.get('workspace-zoom-percent').value, '155');
    const before = JSON.stringify(f.app.getConfig());
    const bad = f.app.getConfig(); bad.workspace.zoom = 0;
    assert.throws(() => f.app.applyConfig(bad));
    assert.equal(JSON.stringify(f.app.getConfig()), before);
    f.click('workspace-zoom-reset');
    assert.equal(f.app.workspace.zoom, 1);
});

test('zooming a paused workspace redraws its waveform at the new pixel density', t => {
    const f = boot(t, config([wave('w1')])), plotter = f.app.widgets.widgets.get('w1').view;
    plotter.canvas.parentElement.getBoundingClientRect = () => ({ width: 800 * f.app.workspace.zoom,
        height: 400 * f.app.workspace.zoom, left: 0, top: 0 });
    plotter.resize(); f.click('btn-pause');
    const width = plotter.canvas.width, draws = plotter.completedDraws;
    f.app.workspace.setZoom(2);
    assert.equal(plotter.canvas.width, width * 2);
    assert.ok(plotter.completedDraws > draws);
    assert.equal(plotter.width, width);
});

test('both sidebar resizers update their CSS width constraint and stop on pointer release', t => {
    const f = boot(t);
    for (const [handleId, panelId, variable, width, dx, expected] of [
        ['h-resizer', 'sidebar', '--sidebar-w', 268, 100, '368px'],
        ['right-resizer', 'channel-sidebar', '--channel-sidebar-w', 320, -100, '420px']
    ]) {
        f.get(panelId).clientWidth = width;
        f.get(handleId).dispatchEvent({ type: 'pointerdown', button: 0, pointerId: 7, clientX: 500 });
        f.document.dispatchEvent({ type: 'pointermove', pointerId: 8, clientX: 0 });
        assert.equal(f.get(panelId).style[variable], width + 'px');
        f.document.dispatchEvent({ type: 'pointermove', pointerId: 7, clientX: 500 + dx });
        assert.equal(f.get(panelId).style[variable], expected);
        f.document.dispatchEvent({ type: 'pointerup', pointerId: 7 });
        f.document.dispatchEvent({ type: 'pointermove', pointerId: 7, clientX: 900 });
        assert.equal(f.get(panelId).style[variable], expected);
    }
});

test('sidebar controls preserve panel width and scroll position while giving the workspace room', t => {
    const f = boot(t);
    const left = f.get('sidebar'), right = f.get('channel-sidebar');
    left.scrollTop = 42; right.scrollTop = 27;
    left.style.setProperty('--sidebar-w', '355px');
    f.click('workspace-toggle-left');
    assert.equal(f.get('workspace-toggle-left').getAttribute('aria-expanded'), 'false');
    assert.equal(f.get('app-container').classList.contains('left-collapsed'), true);
    f.click('workspace-toggle-right');
    assert.equal(f.get('app-container').classList.contains('right-collapsed'), true);
    f.click('workspace-toggle-left'); f.click('workspace-toggle-right');
    assert.equal(f.get('workspace-toggle-left').getAttribute('aria-expanded'), 'true');
    assert.equal(f.get('workspace-toggle-right').getAttribute('aria-expanded'), 'true');
    assert.equal(left.style['--sidebar-w'], '355px');
    assert.equal(left.scrollTop, 42);
    assert.equal(right.scrollTop, 27);
});

test('workspace help is initially visible and can be dismissed and reopened', t => {
    const f = boot(t);
    assert.equal(f.get('workspace-help').hidden, false);
    f.click('workspace-help-dismiss');
    assert.equal(f.get('workspace-help').hidden, true);
    assert.equal(f.get('workspace-help-toggle').getAttribute('aria-expanded'), 'false');
    f.click('workspace-help-toggle');
    assert.equal(f.get('workspace-help').hidden, false);
});

test('narrow layout collapses both panels and reopening one keeps the other closed', t => {
    const f = boot(t);
    f.window.innerWidth = 900;
    f.window.dispatchEvent({ type: 'resize' });
    const shell = f.get('app-container');
    assert.equal(shell.classList.contains('compact-layout'), true);
    assert.equal(shell.classList.contains('left-collapsed'), true);
    assert.equal(shell.classList.contains('right-collapsed'), true);
    f.click('workspace-toggle-left');
    assert.equal(shell.classList.contains('left-collapsed'), false);
    f.click('sidebar-close-left');
    assert.equal(shell.classList.contains('left-collapsed'), true);
    f.click('workspace-toggle-left');
    f.click('workspace-toggle-right');
    assert.equal(shell.classList.contains('left-collapsed'), true);
    assert.equal(shell.classList.contains('right-collapsed'), false);
    f.click('sidebar-close-right');
    assert.equal(shell.classList.contains('right-collapsed'), true);
    f.window.innerWidth = 1600;
    f.window.dispatchEvent({ type: 'resize' });
    assert.equal(shell.classList.contains('compact-layout'), false);
    assert.equal(shell.classList.contains('left-collapsed'), false);
    assert.equal(shell.classList.contains('right-collapsed'), true, 'an explicitly closed panel stays closed');
});

test('widened sidebars trigger compact layout before the workspace becomes unreadable', t => {
    const f = boot(t);
    f.window.innerWidth = 1360;
    f.get('sidebar').style.setProperty('--sidebar-w', '600px');
    f.get('channel-sidebar').style.setProperty('--channel-sidebar-w', '600px');
    f.window.dispatchEvent({ type: 'resize' });
    assert.equal(f.get('app-container').classList.contains('compact-layout'), true);
});

test('the shared global sender resizes upward while reserving workspace space and supports cancellation', t => {
    const f = boot(t), sender = f.get('global-send'), handle = f.get('send-resizer');
    assert.ok(handle, 'the global sender needs its own separator');
    f.get('main-display').clientHeight = 620;
    f.get('navigation-panel').clientHeight = 70;
    sender.clientHeight = 200;
    f.get('monitor-workspace').clientHeight = 400;
    f.get('workspace-toolbar').offsetHeight = 28;
    handle.dispatchEvent({ type: 'pointerdown', button: 0, pointerId: 9, clientY: 600 });
    f.document.dispatchEvent({ type: 'pointermove', pointerId: 9, clientY: 500 });
    assert.equal(sender.style.height, '300px');
    f.document.dispatchEvent({ type: 'pointermove', pointerId: 9, clientY: -1000 });
    assert.equal(sender.style.height, '380px', 'reserve space for the workspace toolbar and visible help');
    f.document.dispatchEvent({ type: 'pointermove', pointerId: 9, clientY: 1000 });
    assert.equal(sender.style.height, '160px', 'retain room for the four-line input and panel controls');
    f.document.dispatchEvent({ type: 'pointermove', pointerId: 9, clientY: 400 });
    f.document.dispatchEvent({ type: 'pointerup', pointerId: 8 });
    f.document.dispatchEvent({ type: 'pointercancel', pointerId: 9 });
    assert.equal(sender.style.height, '200px');
    assert.equal(f.document.body.style.userSelect, undefined);
    sender.clientHeight = 350; sender.style.height = '350px';
    f.get('main-display').clientHeight = 400;
    f.window.dispatchEvent({ type: 'resize' });
    assert.equal(sender.style.height, '160px', 'a smaller window must reserve the toolbar and visible help');
});

test('importing malformed JSON or overlapping rectangles never destroys the current view', async t => {
    const f = boot(t, config([wave('w1')]));
    const file = f.get('cfg-file-input');
    file.files = [{ text: async () => '{bad' }]; file.dispatchEvent({ type: 'change' }); await f.tick();
    assert.equal(f.app.widgets.widgets.size, 1);
    const bad = config([wave('x'), bytes('y')]);
    bad.workspace.rects = { x: { x: 0, y: 0, width: 300, height: 200 }, y: { x: 0, y: 0, width: 300, height: 200 } };
    file.files = [{ text: async () => JSON.stringify(bad) }]; file.dispatchEvent({ type: 'change' }); await f.tick();
    assert.equal(f.app.widgets.widgets.has('w1'), true);
    assert.equal(f.get('cfg-save-status').hidden, false);
});

test('time navigation uses selected source timestamps and rejects times outside its retained range', async t => {
    const initial = config([wave('w1'), bytes('b1')]); initial.tools = { sourceId: 'w1', referenceId: 'b1' };
    const f = boot(t, initial);
    f.app.widgets.activate('w1');
    f.app.service.receive(Uint8Array.of(1), { timestamp: 1000, arrival: 1 });
    f.app.service.receive(Uint8Array.of(2), { timestamp: 2000, arrival: 2 });
    f.click('btn-pause');
    f.change('nav-jump-mode', 'relative'); f.get('nav-jump-relative').value = '1';
    assert.equal(f.app.tools.jumpToTime(), true);
    assert.equal(f.app.widgets.widgets.get('w1').view.currentFrameIndex(), 1);
    f.get('nav-jump-relative').value = '20';
    assert.equal(f.app.tools.jumpToTime(), false);
    assert.equal(f.app.widgets.widgets.get('w1').view.currentFrameIndex(), 1);
});

test('a large export cancelled by source deletion at the file picker never opens a writable stream', async t => {
    const initial = config([bytes('b1', { captureMode: 'text', textBoundary: 'lf' })]); initial.global.maxPoints = '60000';
    const f = boot(t, initial);
    f.app.serialAdapter.onDataCallback(new Uint8Array(50001).fill(10));
    f.change('export-format', 'binary');
    f.change('export-source', 'b1');
    let opened = false;
    f.window.showSaveFilePicker = async () => {
        f.app.widgets.remove('b1');
        return { createWritable() { opened = true; } };
    };
    assert.equal(await f.app.exportData(), false);
    assert.equal(opened, false);
    assert.equal(f.get('export-source').value, '');
});

test('activating another wave does not cancel export of an independently selected buffer', async t => {
    const initial = config([wave('w1'), wave('w2')]); initial.global.maxPoints = '60000';
    const f = boot(t, initial);
    f.app.serialAdapter.onDataCallback(new Uint8Array(50001).fill(7));
    f.app.widgets.activate('w1');
    let writes = 0, aborts = 0, closes = 0;
    f.window.showSaveFilePicker = async () => ({ async createWritable() { return {
        async write() { writes++; f.app.widgets.activate('w2'); },
        async abort() { aborts++; }, async close() { closes++; }
    }; } });
    const pending = f.app.exportData();
    for (let i = 0; i < 100; i++) await f.tick(1);
    assert.equal(await pending, true);
    assert.ok(writes > 1); assert.equal(aborts, 0); assert.equal(closes, 1);
    assert.equal(f.get('export-source').value, 'numeric');
    assert.equal(f.get('btn-export').disabled, false);
    assert.equal(f.app.getConfig().tools.exportProfiles.numeric.format, 'csv');
});
