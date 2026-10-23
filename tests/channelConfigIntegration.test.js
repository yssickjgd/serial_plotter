const test = require('node:test');
const assert = require('node:assert/strict');
const { bootApplication } = require('./helpers/widgetAppHarness');
async function applyEngine(f) { const ready = f.app.engineView.apply(); await f.settle(); await ready; }

function editorList(f, number) {
    const view = f.app.engineView.channels; view.refresh();
    if (number !== undefined) view.expanded.add(view.keyFor(number));
    else for (const entry of view.registry.getChannels()) if (entry.definition) view.expanded.add(entry.id);
    view.refresh(); return view.list;
}
function editorRow(f, number) { return editorList(f, number).children.find(row => row.dataset.channelNumber === String(number)); }

test('right channel search locates shorthand IDs and names while preserving per-widget visibility', async t => {
    const f = bootApplication(); t.after(() => f.app.dispose());
    f.change('channels-count', '60'); await applyEngine(f);
    const wave = f.app.widgets.create({ type: 'wave' }); f.app.widgets.setChannelVisible(0, true);
    const byte = f.app.widgets.create({ type: 'byte', settings: { captureMode: 'engine' } });
    f.app.widgets.setChannelVisible(0, false);
    f.app.widgets.setChannelName(0, '温度'); f.app.widgets.setChannelName(1, '温度二');
    f.app.widgets.activate(wave.id);
    const search = f.get('channel-search-wave'); assert.ok(search, 'right channel lists expose a search input');
    const list = f.get('channel-config-list');
    const numbers = () => list.children.filter(row => row.dataset.channelNumber).map(row => Number(row.dataset.channelNumber));
    for (const query of ['CH1', 'CH01', 'CH00001']) {
        search.value = query; search.dispatchEvent({ type: 'input' });
        assert.deepEqual(numbers(), [1]);
    }
    search.value = 'CH60'; search.dispatchEvent({ type: 'input' });
    assert.deepEqual(numbers(), [60]);
    let located = false; list.children[0].scrollIntoView = () => { located = true; };
    search.dispatchEvent({ type: 'keydown', key: 'Enter' }); assert.equal(located, true);
    search.value = '温度'; search.dispatchEvent({ type: 'input' });
    assert.deepEqual(numbers(), [1, 2]);
    f.app.widgets.activate(byte.id);
    assert.equal(f.get('channel-search-byte').value, '温度');
    assert.equal(f.get('monitor-channel-list').children.filter(row => row.dataset.channelNumber).length, 2);
    assert.equal(f.app.widgets.channelVisible(byte, 0), false);
    assert.equal(f.app.widgets.channelVisible(wave, 0), true);
    f.change('channel-search-byte', '不存在的通道');
    assert.match(f.get('monitor-channel-list').textContent, /没有匹配/);
    assert.match(f.get('channel-search-status-byte').textContent, /0/);
    f.change('channel-search-byte', '');
    assert.ok(f.get('monitor-channel-list').children.filter(row => row.dataset.channelNumber).length <= 50);
});

test('right channel name and color edits share metadata with the engine and all views without interrupting color previews', async t => {
    const f = bootApplication(); t.after(() => f.app.dispose());
    f.change('channels-count', '2'); await applyEngine(f);
    const wave = f.app.widgets.create({ type: 'wave' });
    const byte = f.app.widgets.create({ type: 'byte', settings: { captureMode: 'engine' } });
    const row = f.get('monitor-channel-list').children.find(row => row.dataset.channelNumber === '1');
    const name = row.querySelector('[data-role="channel-name"]'), color = row.querySelector('[data-role="channel-color"]');
    assert.ok(name && color, 'right rows provide shared name and color editors');
    const engineRow = () => f.app.engineView.channels.list.children.find(row => row.dataset.channelNumber === '1');
    name.value = '速度'; name.dispatchEvent({ type: 'change' });
    assert.equal(f.app.getConfig().global.channelNames[0], '速度');
    assert.equal(engineRow().querySelector('[data-role="channel-name"]').value, '速度');
    assert.equal(wave.view.getChannelMeta()[0].name, '速度');
    for (const value of ['#123456', '#456789', '#abcdef']) {
        color.value = value; color.dispatchEvent({ type: 'input' });
        assert.ok(row.querySelector('[data-role="channel-color"]') === color);
        assert.ok(f.get('monitor-channel-list').contains(color));
        assert.equal(f.app.getConfig().global.channelColors[0], value);
        assert.equal(engineRow().querySelector('[data-role="channel-color"]').value, value);
        assert.equal(wave.view.getChannelMeta()[0].color, value);
        assert.equal(byte.view.channelColors[0], value);
    }
    name.value = 'CH1'; name.dispatchEvent({ type: 'change' });
    assert.equal(f.app.getConfig().global.channelNames[0], '速度');
    assert.equal(name.getAttribute('aria-invalid'), 'true');
    assert.match(f.get('channel-edit-status-byte').textContent, /CH|保留/);
    name.value = '加速度'; name.dispatchEvent({ type: 'change' });
    assert.equal(name.getAttribute('aria-invalid'), null);
    assert.equal(f.get('channel-edit-status-byte').hidden, true);
    const engineName = engineRow().querySelector('[data-role="channel-name"]');
    engineName.value = '新的速度'; engineName.dispatchEvent({ type: 'change' });
    assert.equal(name.value, '新的速度');
    const engineColor = engineRow().querySelector('[data-role="channel-color"]');
    engineColor.value = '#112233'; engineColor.dispatchEvent({ type: 'input' });
    assert.equal(color.value, '#112233');
    f.app.widgets.activate(wave.id);
    const otherRow = f.get('channel-config-list').children.find(row => row.dataset.channelNumber === '1');
    assert.equal(otherRow.querySelector('[data-role="channel-name"]').value, '新的速度');
    assert.equal(otherRow.querySelector('[data-role="channel-color"]').value, '#112233');
    const restored = bootApplication(f.app.getConfig()); t.after(() => restored.app.dispose());
    assert.equal(restored.app.getConfig().global.channelNames[0], '新的速度');
    assert.equal(restored.app.getConfig().global.channelColors[0], '#112233');
});

test('right channel editing and search leave Chinese input composition to the input method', t => {
    const f = bootApplication(); t.after(() => f.app.dispose());
    f.app.widgets.create({ type: 'wave' });
    const list = f.get('channel-config-list'), search = f.get('channel-search-wave');
    const name = list.children[0].querySelector('[data-role="channel-name"]');
    const previous = f.app.getConfig().global.channelNames[0];
    name.value = '航向';
    let prevented = false;
    for (const key of ['Enter', 'Escape']) name.dispatchEvent({ type: 'keydown', key, isComposing: true,
        preventDefault() { prevented = true; } });
    assert.equal(prevented, false);
    assert.equal(name.value, '航向');
    assert.equal(f.app.getConfig().global.channelNames[0], previous);
    name.dispatchEvent({ type: 'change' });
    assert.equal(f.app.getConfig().global.channelNames[0], '航向');
    search.value = '航'; search.dispatchEvent({ type: 'input', isComposing: true });
    assert.equal(f.app.widgets.channelSearchText, '');
    search.dispatchEvent({ type: 'compositionend' });
    assert.equal(f.app.widgets.channelSearchText, '航');
    let located = false; list.children[0].scrollIntoView = () => { located = true; };
    search.dispatchEvent({ type: 'keydown', key: 'Enter', keyCode: 229 });
    assert.equal(located, false);
    search.dispatchEvent({ type: 'keydown', key: 'Enter' });
    assert.equal(located, true);
});

test('renamed Unicode channel names use the registry canonical value in every view', t => {
    const f = bootApplication(); t.after(() => f.app.dispose());
    const wave = f.app.widgets.create({ type: 'wave' });
    const input = f.get('channel-config-list').children[0].querySelector('[data-role="channel-name"]');
    input.value = 'Cafe\u0301'; input.dispatchEvent({ type: 'change' });
    assert.equal(f.app.getConfig().global.channelNames[0], 'Café');
    assert.equal(input.value, 'Café');
    assert.equal(wave.view.getChannelMeta()[0].name, 'Café');
    assert.equal(f.app.engineView.channels.list.children[0].querySelector('[data-role="channel-name"]').value, 'Café');
});

test('shared renames refresh channel search membership and counts', async t => {
    const f = bootApplication(); t.after(() => f.app.dispose());
    f.change('channels-count', '2'); await applyEngine(f);
    f.app.widgets.create({ type: 'wave' });
    f.app.widgets.setChannelName(0, '温度'); f.change('channel-search-wave', '温度');
    const list = f.get('channel-config-list');
    f.app.widgets.setChannelName(0, '压力');
    assert.equal(list.children.filter(row => row.dataset.channelNumber).length, 0);
    assert.equal(f.get('channel-search-status-wave').textContent, '0 / 2');
    f.app.widgets.setChannelName(1, '温度二');
    assert.equal(list.children.find(row => row.dataset.channelNumber)?.dataset.channelNumber, '2');
    assert.equal(f.get('channel-search-status-wave').textContent, '1 / 2');
    const name = list.children[0].querySelector('[data-role="channel-name"]');
    name.value = '湿度'; name.dispatchEvent({ type: 'change' });
    assert.equal(list.children.filter(row => row.dataset.channelNumber).length, 0);
    assert.equal(f.get('channel-search-status-wave').textContent, '0 / 2');
});

test('right renames also refresh the engine name search and registry validation', async t => {
    const f = bootApplication(); t.after(() => f.app.dispose());
    f.change('channels-count', '2'); await applyEngine(f);
    f.app.widgets.create({ type: 'wave' });
    const engine = f.app.engineView.channels;
    f.app.widgets.setChannelName(0, '温度');
    engine.search.value = '温度'; engine.search.dispatchEvent({ type: 'input' });
    f.app.widgets.setChannelName(0, '压力');
    assert.equal(engine.channels.length, 0);
    assert.equal(engine.status.textContent, '0 个通道');
    f.app.widgets.setChannelName(1, '温度二');
    assert.equal(engine.channels.length, 1);
    assert.equal(engine.channels[0].number, 2);
    assert.equal(engine.registry.get(1).name, '压力');
    assert.equal(engine.registry.get(2).name, '温度二');
});

test('continuous channel color previews keep the native picker mounted and save the final color', async t => {
    const f = bootApplication(); t.after(() => f.app.dispose());
    const wave = f.app.widgets.create({ type: 'wave' });
    const byte = f.app.widgets.create({ type: 'byte', settings: { captureMode: 'number' } });
    const row = editorRow(f, 1), list = f.app.engineView.channels.list;
    const picker = row.querySelector('[data-role="channel-color"]'); picker.focus();
    for (const color of ['#123456', '#456789', '#abcdef']) {
        picker.value = color; picker.dispatchEvent({ type: 'input', bubbles: true });
        assert.ok(list.querySelector('[data-role="channel-color"]') === picker,
            'live input must not replace the element that owns the browser color popup');
        assert.ok(list.contains(picker));
        assert.ok(f.document.activeElement === picker);
        assert.equal(f.app.getConfig().global.channelColors[0], color);
        assert.equal(wave.view.getChannelMeta()[0].color, color);
        assert.equal(byte.view.channelColors[0], color);
    }
    picker.dispatchEvent({ type: 'change', bubbles: true });
    await f.tick(200); await f.app.flushConfig();
    assert.ok(list.querySelector('[data-role="channel-color"]') === picker);
    const restored = bootApplication(f.app.getConfig()); t.after(() => restored.app.dispose());
    assert.equal(restored.app.engineView.channels.list.querySelector('[data-role="channel-color"]').value, '#abcdef');
});

test('engine renames update open widget channel rows without replacing selections or resetting the inspector', async t => {
    for (const type of ['wave', 'byte']) await t.test(type, async t => {
        const f = bootApplication(); t.after(() => f.app.dispose());
        const widget = f.app.widgets.create({ type, settings: type === 'byte' ? { captureMode: 'number' } : {} });
        const tabId = type === 'wave' ? 'tab-waveform-channels' : 'tab-monitor-channels';
        f.app.widgets.selectTab(tabId);
        f.change(`channel-category-${type}`, 'raw');
        const list = f.get(type === 'wave' ? 'channel-config-list' : 'monitor-channel-list');
        const row = list.children.find(child => child.dataset.channelNumber === '1');
        const checkbox = row.querySelector('[data-role="channel-visible"]'), checked = checkbox.checked;
        const host = f.get(tabId); host.scrollTop = 96;
        const editor = editorRow(f, 1).querySelector('[data-role="channel-name"]');
        editor.value = '新温度'; editor.dispatchEvent({ type: 'change', bubbles: true });
        const updated = list.children.find(child => child.dataset.channelNumber === '1');
        assert.equal(updated.querySelector('.channel-name-editor').value, '新温度');
        assert.ok(updated === row, 'a metadata edit keeps the current row mounted');
        assert.equal(row.querySelector('.channel-readonly-name').title, '新温度');
        assert.match(checkbox.getAttribute('aria-label'), /新温度/);
        assert.equal(checkbox.checked, checked);
        assert.equal(host.scrollTop, 96);
        assert.equal(widget.channelCategory, 'raw');
        assert.equal(widget.lastTab, tabId);
        assert.equal(f.app.service.channelNames[0], '新温度');
        if (type === 'wave') assert.equal(widget.view.getChannelMeta()[0].name, '新温度');
    });
});

test('renamed off-screen channels retain their new names when virtual inspector rows enter view', async t => {
    const f = bootApplication(); t.after(() => f.app.dispose());
    const widget = f.app.widgets.create({ type: 'wave' });
    f.change('channels-count', '60'); await applyEngine(f);
    f.app.widgets.selectTab('tab-waveform-channels');
    const list = f.get('channel-config-list'), host = f.get('tab-waveform-channels');
    host.clientHeight = 200;
    host.getBoundingClientRect = () => ({ top: 0 });
    list.getBoundingClientRect = () => ({ top: 100 - host.scrollTop });
    assert.equal(list.children.find(child => child.dataset.channelNumber === '60'), undefined);
    const view = f.app.engineView.channels; view.scrollToNumber(60);
    const editor = view.list.children.find(child => child.dataset.channelNumber === '60').querySelector('[data-role="channel-name"]');
    editor.value = '末端信号'; editor.dispatchEvent({ type: 'change', bubbles: true });
    host.scrollTop = 59 * 32 + 100; host.dispatchEvent({ type: 'scroll' });
    assert.equal(list.children.find(child => child.dataset.channelNumber === '60').querySelector('.channel-name-editor').value, '末端信号');
    assert.equal(f.app.widgets.activeId, widget.id);
});

test('engine renames refresh the current pose binding labels while preserving channel bindings', t => {
    const f = bootApplication(); t.after(() => f.app.dispose());
    const widget = f.app.widgets.create({ type: 'pose', settings: { bindings: { euler: [0, 0, 0] } } });
    f.app.widgets.selectTab('tab-pose-channels');
    const binding = f.get('pose-bindings-euler-0');
    const editor = editorRow(f, 1).querySelector('[data-role="channel-name"]');
    editor.value = '航向'; editor.dispatchEvent({ type: 'change', bubbles: true });
    assert.ok(f.get('pose-bindings-euler-0') === binding);
    assert.match(binding.options.find(option => option.value === '0').textContent, /CH00001.*航向/);
    assert.equal(binding.value, '0');
    assert.equal(widget.settings.bindings.euler[0], 0);
    assert.equal(widget.lastTab, 'tab-pose-channels');
});

test('moving derived channels preserves dependencies, history and widget selections', async t => {
    const f = bootApplication(); t.after(() => f.app.dispose());
    const wave = f.app.widgets.create({ type: 'wave' });
    f.change('channels-count', '12'); f.change('chk-header', false); f.change('data-type', 'uint8'); await applyEngine(f);
    const first = f.app.widgets.addChannel('formula'), second = f.app.widgets.addChannel('formula');
    await f.app.widgets.updateChannelDefinition({ number: first, type: 'formula', expression: 'CH00001+CH00002' });
    await f.app.widgets.updateChannelDefinition({ number: second, type: 'formula', expression: 'CH00013+CH00002' });
    f.app.widgets.setChannelName(first - 1, '求和'); f.app.widgets.setChannelColor(first - 1, '#112233');
    f.app.widgets.setChannelVisible(first - 1, true);
    const byte = f.app.widgets.create({ type: 'byte', settings: { captureMode: 'number' } });
    f.app.widgets.setChannelVisible(first - 1, false); f.app.widgets.activate(wave.id);
    f.click('btn-export-channels-all-off');
    const checkbox = f.get('export-channel-list').children[first - 1].children[0];
    checkbox.checked = true; checkbox.dispatchEvent({ type: 'change' });
    f.app.tools.selectedChannels = new Set([first - 1]);
    f.app.service.receive(Uint8Array.from({ length: 12 }, (_, i) => i < 2 ? i + 1 : 0));
    const frames = wave.source.frames, bytes = Array.from(frames.frameAt(0).bytes);
    await f.app.widgets.moveChannel(first, second);
    const definitions = f.app.getConfig().global.channelDefinitions;
    assert.deepEqual(Array.from(definitions, d => [d.number, d.expression]), [[13, 'CH00014+CH00002'], [14, 'CH00001+CH00002']]);
    assert.equal(frames.getValue(12, 0), 5); assert.equal(frames.getValue(13, 0), 3);
    assert.deepEqual(Array.from(frames.frameAt(0).bytes), bytes);
    assert.equal(wave.view.getChannelMeta()[13].name, '求和');
    assert.equal(wave.view.getChannelMeta()[13].color, '#112233');
    assert.equal(wave.view.getChannelMeta()[13].visible, true);
    assert.ok(byte.settings.monitorDisplay.numericHiddenChannels.includes(13));
    assert.deepEqual(Array.from(f.app.getConfig().tools.exportProfiles.numeric.formats.csv.channelIndices), [13]);
    assert.deepEqual([...f.app.tools.selectedChannels], [13]);
    f.app.service.receive(Uint8Array.from({ length: 12 }, (_, i) => i === 0 ? 1 : i === 1 ? 3 : 0));
    assert.equal(frames.getValue(12, 1), 7); assert.equal(frames.getValue(13, 1), 4);
    const restored = bootApplication(f.app.getConfig()); t.after(() => restored.app.dispose());
    assert.deepEqual(Array.from(restored.app.widgets.globals.channelDefinitions, d => d.expression), ['CH00014+CH00002', 'CH00001+CH00002']);
});

test('moving a channel preserves integral, difference, filter state and unapplied drafts', async t => {
    const f = bootApplication(); t.after(() => f.app.dispose()); f.app.widgets.create({ type: 'wave' });
    f.change('channels-count', '2'); await applyEngine(f);
    const definitions = [
        { number: 3, type: 'formula', expression: 'INT(CH00001)' },
        { number: 4, type: 'formula', expression: 'DIFF(CH00003)+CH00003[-1]' },
        { number: 5, type: 'constant', expression: '[0]=1,[1]=2' },
        { number: 6, type: 'formula', expression: 'FILTER(CH00003,CH00005)' }
    ];
    for (const definition of definitions) await f.app.widgets.updateChannelDefinition(definition);
    f.app.widgets.channelView.drafts.set(4, { ...definitions[1], expression: 'CH00003[-1]+CH00004' });
    const frames = f.app.service.numericSource.frames;
    frames.append([1, 0]); frames.append([2, 0]);
    await f.app.widgets.moveChannel(3, 6);
    assert.deepEqual(Array.from(f.app.widgets.globals.channelDefinitions, d => [d.number, d.expression]), [
        [3, 'DIFF(CH00006)+CH00006[-1]'], [4, '[0]=1,[1]=2'], [5, 'FILTER(CH00006,CH00004)'], [6, 'INT(CH00001)']
    ]);
    assert.equal(f.app.widgets.channelView.drafts.get(3).expression, 'CH00006[-1]+CH00003');
    frames.append([3, 0]);
    assert.deepEqual(Array.from(frames.channelSlice(5)), [1, 3, 6]);
    assert.equal(frames.getValue(2, 2), 6); assert.equal(frames.getValue(4, 2), 12);
    const before = JSON.stringify(f.app.getConfig());
    assert.throws(() => f.app.widgets.moveChannel(1, 3), /原始|新增/);
    assert.throws(() => f.app.widgets.moveChannel(3, 1), /原始|新增/);
    await f.app.widgets.moveChannel(3, 3);
    assert.equal(JSON.stringify(f.app.getConfig()), before);
});

test('dragging channel labels reorders added channels in both inspectors and leaves raw rows fixed', async t => {
    for (const type of ['wave', 'byte']) {
        const f = bootApplication(); t.after(() => f.app.dispose());
        f.app.widgets.create({ type, settings: type === 'byte' ? { captureMode: 'number' } : {} });
        f.change('channels-count', '2'); await applyEngine(f);
        f.app.widgets.addChannel('formula'); f.app.widgets.addChannel('constant');
        const list = editorList(f);
        const raw = list.children[0], first = list.children[2], second = list.children[3];
        const handle = first.querySelector('.channel-toggle');
        assert.equal(handle.draggable, true);
        assert.notEqual(raw.querySelector('.channel-label').draggable, true);
        const transfer = { setData() {}, effectAllowed: '', dropEffect: '' };
        handle.dispatchEvent({ type: 'dragstart', dataTransfer: transfer });
        second.dispatchEvent({ type: 'dragover', dataTransfer: transfer });
        assert.ok(second.classList.contains('channel-drop-target'));
        second.dispatchEvent({ type: 'drop', dataTransfer: transfer });
        await f.settle();
        assert.deepEqual(Array.from(f.app.widgets.globals.channelDefinitions, d => d.type), ['constant', 'formula']);
        const current = list.children[2].querySelector('.channel-toggle');
        current.dispatchEvent({ type: 'dragstart', dataTransfer: transfer });
        current.dispatchEvent({ type: 'dragend' });
        list.children[3].dispatchEvent({ type: 'drop', dataTransfer: transfer });
        assert.deepEqual(Array.from(f.app.widgets.globals.channelDefinitions, d => d.type), ['constant', 'formula']);
    }
});

test('global channel creation follows its category regardless of the selected widget', async t => {
    const f = bootApplication(); t.after(() => f.app.dispose());
    const view = f.app.engineView.channels;
    for (const type of ['wave', 'byte']) {
        f.app.widgets.create({ type });
        for (const category of ['formula', 'constant', 'system']) {
            view.categoryInput.value = category; view.categoryInput.dispatchEvent({ type: 'change' });
            assert.equal(view.addType.value, category); assert.equal(view.addType.disabled, true);
            view.add.click(); await f.settle();
            assert.equal(f.app.getConfig().global.channelDefinitions.at(-1).type, category);
        }
        view.categoryInput.value = 'raw'; view.categoryInput.dispatchEvent({ type: 'change' });
        assert.equal(view.add.disabled, true);
        view.categoryInput.value = 'all'; view.categoryInput.dispatchEvent({ type: 'change' });
        assert.equal(view.addType.disabled, false);
    }
});

test('deleting CH00024 shifts later definitions references metadata and retained samples without resetting state', async t => {
    const f = bootApplication(); t.after(() => f.app.dispose());
    const wave = f.app.widgets.create({ type: 'wave' });
    f.change('channels-count', '23'); f.change('chk-header', false); f.change('data-type', 'uint8'); await applyEngine(f);
    const removed = f.app.widgets.addChannel('formula'), kept = f.app.widgets.addChannel('formula');
    const dependent = f.app.widgets.addChannel('formula');
    await f.app.widgets.updateChannelDefinition({ number: kept, type: 'formula', expression: 'INT(CH00001)' });
    await f.app.widgets.updateChannelDefinition({ number: dependent, type: 'formula', expression: 'DIFF(CH00025)+CH00025[-1]' });
    f.app.widgets.setChannelName(kept - 1, '保留信号'); f.app.widgets.setChannelColor(kept - 1, '#112233');
    f.app.widgets.setChannelVisible(kept - 1, true);
    f.change('plot-content', 'response'); f.change('plot-content', 'samples');
    const byte = f.app.widgets.create({ type: 'byte', settings: { captureMode: 'number' } });
    f.app.widgets.setChannelVisible(kept - 1, false); f.app.widgets.activate(wave.id);
    f.click('btn-export-channels-all-off');
    const choice = f.get('export-channel-list').children[kept - 1].children[0];
    choice.checked = true; choice.dispatchEvent({ type: 'change' });
    f.app.tools.selectedChannels = new Set([kept - 1]);
    for (const value of [1, 2]) f.app.service.receive(Uint8Array.from({ length: 23 }, (_, i) => i ? 0 : value));
    const frames = wave.source.frames;
    assert.deepEqual(Array.from(frames.channelSlice(kept - 1)), [1, 3]);
    f.app.widgets.removeChannel(removed);
    assert.deepEqual(Array.from(f.app.widgets.globals.channelDefinitions, d => d.number), [24, 25]);
    assert.equal(f.app.widgets.globals.channelDefinitions[1].expression, 'DIFF(CH00024)+CH00024[-1]');
    assert.equal(wave.settings.responseChannels[24]?.name ?? f.app.widgets.globals.channelNames[24], 'CH00025');
    assert.deepEqual(Array.from(frames.channelSlice(23)), [1, 3]);
    assert.equal(wave.view.getChannelMeta()[23].name, '保留信号');
    assert.equal(wave.view.getChannelMeta()[23].color, '#112233');
    assert.equal(wave.view.getChannelMeta()[23].visible, true);
    assert.ok(byte.settings.monitorDisplay.numericHiddenChannels.includes(23));
    assert.deepEqual(Array.from(f.app.getConfig().tools.exportProfiles.numeric.formats.csv.channelIndices), [23]);
    assert.deepEqual([...f.app.tools.selectedChannels], [23]);
    f.app.service.receive(Uint8Array.from({ length: 23 }, (_, i) => i ? 0 : 3));
    assert.deepEqual(Array.from(frames.channelSlice(23)), [1, 3, 6]);
    assert.equal(frames.getValue(24, 2), 6);
    assert.equal(f.app.widgets.addChannel('formula'), 26);
});

test('deleting a referenced channel reports an error before renumbering any channel', t => {
    const f = bootApplication(); t.after(() => f.app.dispose());
    f.app.widgets.create({ type: 'wave' });
    const first = f.app.widgets.addChannel('formula'), second = f.app.widgets.addChannel('formula');
    f.app.widgets.updateChannelDefinition({ number: second, type: 'formula', expression: 'CH00002+1' });
    const before = JSON.stringify(f.app.getConfig());
    assert.throws(() => f.app.widgets.removeChannel(first), /不存在/);
    assert.equal(JSON.stringify(f.app.getConfig()), before);
});

test('global editors expose definitions while widget channel lists only select visibility', t => {
    const f = bootApplication(); t.after(() => f.app.dispose());
    for (const kind of ['formula', 'constant', 'system']) f.app.widgets.addChannel(kind);
    const global = editorList(f);
    assert.equal(global.children[0].querySelector('.channel-toggle'), null);
    assert.match(f.get('engine-channel-panel').textContent, /常量数组/);
    for (const row of global.children.slice(1)) assert.ok(row.querySelector('[data-role="channel-expression"]'));
    for (const type of ['wave', 'byte']) {
        const widget = f.app.widgets.create({ type, settings: type === 'byte' ? { captureMode: 'engine' } : {} });
        const list = f.get(type === 'wave' ? 'channel-config-list' : 'monitor-channel-list');
        assert.equal(list.querySelector('[data-role="channel-expression"]'), null);
        const raw = list.children[0], visible = raw.children.find(node => node.type === 'checkbox');
        visible.checked = true; visible.dispatchEvent({ type: 'change' });
        assert.equal(f.app.widgets.channelVisible(widget, 0), true);
    }
});

test('computed definitions and colors are global while numeric visibility belongs to each widget', async t => {
    const f = bootApplication(); t.after(() => f.app.dispose());
    const a = f.app.widgets.create({ type: 'wave' }), b = f.app.widgets.create({ type: 'wave' });
    const byte = f.app.widgets.create({ type: 'byte', settings: { captureMode: 'number' } });
    assert.equal(typeof f.app.widgets.addChannel, 'function', 'the inspector supports derived channels');
    const number = f.app.widgets.addChannel('formula');
    await f.app.widgets.updateChannelDefinition({ number, type: 'formula', expression: 'CH00001*2' });
    f.app.service.receive(Uint8Array.of(0xab, 0, 0, 128, 63));
    await f.settle();
    assert.equal(a.source.frames.getValue(number - 1, 0), 2);
    assert.equal(a.view.frames, byte.view.frames);
    f.app.widgets.setChannelColor(number - 1, '#123456');
    assert.equal(a.view.getChannelMeta()[number - 1].color, '#123456');
    assert.equal(b.view.getChannelMeta()[number - 1].color, '#123456');
    f.app.widgets.activate(a.id); f.app.widgets.setChannelVisible(number - 1, true);
    assert.equal(a.view.getChannelMeta()[number - 1].visible, true);
    assert.equal(b.view.getChannelMeta()[number - 1].visible, false);
    f.app.widgets.activate(byte.id); f.app.widgets.setChannelVisible(number - 1, false);
    assert.ok(byte.settings.monitorDisplay.numericHiddenChannels.includes(number - 1));
    assert.equal(a.view.getChannelMeta()[number - 1].visible, true);
    assert.equal(f.app.getConfig().global.channelDefinitions[0].expression, 'CH00001*2');
});

test('uniform editor reports invalid formulas below channel without replacing valid samples', async t => {
    const f = bootApplication(); t.after(() => f.app.dispose());
    const wave = f.app.widgets.create({ type: 'wave' });
    assert.equal(typeof f.app.widgets.addChannel, 'function');
    const number = f.app.widgets.addChannel('formula');
    const row = editorRow(f, number);
    const formula = row.querySelector('[data-role="channel-expression"]');
    formula.value = 'diffCH01'; formula.dispatchEvent({ type: 'change' });
    row.querySelector('[data-role="channel-apply"]').click();
    assert.equal(row.querySelector('[data-role="channel-error"]').hidden, false);
    assert.equal(wave.source.frames.definitions[0].expression, 'CH00001');
    formula.value = 'DIFF(CH00001)'; formula.dispatchEvent({ type: 'change' });
    row.querySelector('[data-role="channel-apply"]').click(); await f.settle();
    assert.equal(f.app.getConfig().global.channelDefinitions[0].expression, 'DIFF(CH00001)');
});

test('formula drafts apply explicitly and update plotted historical values only with rebuild enabled', async t => {
    const f = bootApplication(); t.after(() => f.app.dispose());
    const wave = f.app.widgets.create({ type: 'wave' });
    f.change('chk-header', false); f.change('data-type', 'uint8'); await applyEngine(f);
    const number = f.app.widgets.addChannel('formula'); await f.settle();
    f.app.widgets.setChannelVisible(number - 1, true);
    f.app.service.receive(Uint8Array.of(2, 3)); await f.settle();
    f.app.service.pause(true);
    const findRow = () => editorRow(f, number);
    let row = findRow(), expression = row.querySelector('[data-role="channel-expression"]');
    const apply = row.querySelector('[data-role="channel-apply"]');
    assert.ok(apply, 'the editor provides an explicit apply button');
    assert.equal(apply.textContent, '应用公式');
    assert.equal(apply.parentElement.children[1].textContent, '删除通道');
    expression.value = 'CH00001*2'; expression.dispatchEvent({ type: 'input' }); expression.dispatchEvent({ type: 'change' });
    assert.equal(f.app.getConfig().global.channelDefinitions[0].expression, 'CH00001');
    assert.deepEqual(Array.from(wave.view.frames.channelSlice(number - 1)), [2, 3]);
    f.change('rebuild-history', false); apply.click(); await f.settle();
    assert.equal(f.app.getConfig().global.channelDefinitions[0].expression, 'CH00001*2');
    assert.deepEqual(Array.from(wave.view.frames.channelSlice(number - 1)), [2, 3]);
    f.app.service.pause(false); f.app.service.receive(Uint8Array.of(4)); await f.settle(); f.app.service.pause(true);
    assert.deepEqual(Array.from(wave.view.frames.channelSlice(number - 1)), [2, 3, 8]);
    // Reapplying the same expression with rebuild enabled must also refresh older samples.
    f.change('rebuild-history', true); row = findRow();
    row.querySelector('[data-role="channel-apply"]').click(); await f.settle();
    assert.deepEqual(Array.from(wave.view.frames.channelSlice(number - 1)), [4, 6, 8]);
    assert.equal(wave.view.getChannelMeta()[number - 1].visible, true);
});

test('numeric byte editor applies shared constants and system initial state in one action', async t => {
    const f = bootApplication(); t.after(() => f.app.dispose());
    const byte = f.app.widgets.create({ type: 'byte', settings: { captureMode: 'number' } });
    const kernel = f.app.widgets.addChannel('constant');
    let row = editorRow(f, kernel);
    const constant = row.querySelector('[data-role="channel-expression"]');
    constant.value = '[0]=2,[1]=-1'; constant.dispatchEvent({ type: 'input' });
    row.querySelector('[data-role="channel-apply"]').click();
    const system = f.app.widgets.addChannel('system');
    row = editorRow(f, system);
    const expression = row.querySelector('[data-role="channel-expression"]'), initial = row.querySelector('[data-role="channel-initial"]');
    expression.value = 'X[0]+Y[-1]'; expression.dispatchEvent({ type: 'input' });
    initial.value = 'Y[-1]=5'; initial.dispatchEvent({ type: 'change' });
    row.querySelector('[data-role="channel-apply"]').click(); await f.settle();
    assert.equal(byte.source.frames.definitions.find(value => value.number === kernel).expression, '[0]=2,[1]=-1');
    assert.equal(byte.source.frames.definitions.find(value => value.number === system).initial, 'Y[-1]=5');
});

test('constant and system parameter channels cannot become visible wave series', t => {
    const f = bootApplication(); t.after(() => f.app.dispose());
    const wave = f.app.widgets.create({ type: 'wave' });
    assert.equal(typeof f.app.widgets.addChannel, 'function');
    const kernel = f.app.widgets.addChannel('constant'), system = f.app.widgets.addChannel('system');
    f.click('btn-channels-all-on');
    assert.equal(wave.view.getChannelMeta()[kernel - 1].visible, false);
    assert.equal(wave.view.getChannelMeta()[system - 1].visible, false);
});

test('computed numeric values flow into FFT search and CSV without synthetic raw bytes', async t => {
    const f = bootApplication(); t.after(() => f.app.dispose());
    const wave = f.app.widgets.create({ type: 'wave' });
    f.change('chk-header', false); f.change('data-type', 'uint8'); await applyEngine(f);
    f.change('rebuild-history', false);
    const number = f.app.widgets.addChannel('formula');
    await f.app.widgets.updateChannelDefinition({ number, type: 'formula', expression: 'CH00001/2' });
    f.app.widgets.setChannelName(number - 1, '半幅'); f.app.widgets.setChannelVisible(number - 1, true);
    f.app.service.receive(Uint8Array.of(2, 4, 6, 8)); await f.settle();
    f.app.service.pause(true); f.app.widgets.applySettings(wave); f.app.tools.syncPaused();
    f.app.tools.syncSources({ referenceId: wave.id });
    f.change('plot-view-mode', 'frequency');
    assert.equal(wave.view._frequencyForChannel(number - 1).fftSize, 4);
    f.change('monitor-search-query', '3'); f.change('monitor-search-tolerance', '0');
    await f.app.tools.requestSearch('nearest');
    assert.ok(f.app.tools.matches.some(match => match.channel === number - 1 && match.startFrame === 2));
    f.change('export-format', 'csv'); assert.equal(await f.app.exportData(), true);
    assert.match(await f.blobs.at(-1).text(), /半幅/);
    assert.match(await f.blobs.at(-1).text(), /2,6,3/);
    assert.deepEqual(Array.from(wave.source.frames.rawBytesAt(2)), [6]);
});

test('configuration replacement changes raw count and derived numbering without losing definitions', async t => {
    const f = bootApplication(); t.after(() => f.app.dispose());
    f.app.widgets.create({ type: 'wave' });
    const config = f.app.getConfig();
    config.global.channelsCount = '2'; config.global.dataType = 'uint8'; config.global.enableHeader = false;
    config.global.channelDefinitions = [{ number: 3, type: 'formula', expression: 'CH00001+CH00002' }];
    config.dataEngine.array = Object.fromEntries(f.S.ENGINE_ARRAY_FIELDS.map(key => [key, config.global[key]]));
    f.app.applyConfig(config); await f.settle();
    f.app.service.receive(Uint8Array.of(2, 3)); await f.settle();
    assert.equal(f.app.widgets.active, undefined);
    assert.equal(f.app.service.numericSource.frames.getValue(2, 0), 5);
    assert.equal(f.app.service.numericSource.frames.rawChannelCount, 2);
    const restored = bootApplication(f.app.getConfig()); t.after(() => restored.app.dispose());
    restored.app.service.receive(Uint8Array.of(4, 5)); await restored.settle();
    assert.equal(restored.app.service.numericSource.frames.getValue(2, 0), 9);
});

test('wave object switches isolate static visibility and retain sampled data viewport', async t => {
    const f = bootApplication(); t.after(() => f.app.dispose());
    const wave = f.app.widgets.create({ type: 'wave' });
    const kernel = f.app.widgets.addChannel('constant');
    const system = f.app.widgets.addChannel('system');
    wave.view.vp.time.displayCount = 20;
    f.change('plot-content', 'response');
    assert.equal(wave.settings.plotContent, 'response');
    assert.equal(wave.view.frames.responseMode, true);
    f.app.widgets.setChannelVisible(kernel - 1, true);
    f.app.widgets.setChannelVisible(system - 1, true);
    assert.equal(wave.view.getChannelMeta()[kernel - 1].visible, true);
    f.change('plot-view-mode', 'frequency'); wave.view.draw();
    assert.equal(wave.view._frequencyForChannel(kernel - 1).mags[0], 1);
    assert.equal(wave.view.magnitudeUnit, 'db');
    f.change('plot-view-mode', 'phase'); f.change('plot-phase-unwrap', false); wave.view.draw();
    assert.equal(wave.view.displayMode, 'phase');
    assert.equal(wave.view._drawState.min, -Math.PI); assert.equal(wave.view._drawState.max, Math.PI);
    f.change('plot-content', 'samples');
    assert.equal(wave.view.frames, wave.source.frames);
    assert.equal(wave.view.getChannelMeta()[kernel - 1].visible, false);
    assert.equal(wave.view.vp.time.displayCount, 20);
    f.change('plot-content', 'response');
    assert.equal(wave.view.getChannelMeta()[kernel - 1].visible, true);
    f.app.widgets.setChannelColor(kernel - 1, '#112233');
    assert.equal(wave.settings.channels[0].visible, false);
    assert.equal(wave.settings.responseChannels[kernel - 1].color, '#112233');
});

test('channel classification filters every type without mutating checked visibility', t => {
    const f = bootApplication(); t.after(() => f.app.dispose());
    const wave = f.app.widgets.create({ type: 'wave' });
    const formula = f.app.widgets.addChannel('formula'), kernel = f.app.widgets.addChannel('constant');
    f.app.widgets.addChannel('system');
    f.app.widgets.setChannelVisible(formula - 1, true);
    for (const [category, expected] of [['raw', [1]], ['formula', [formula]], ['constant', [kernel]], ['system', [kernel + 1]]]) {
        f.change('channel-category-wave', category);
        assert.deepEqual(f.get('channel-config-list').children.map(row => Number(row.dataset.channelNumber)), expected);
        assert.equal(wave.settings.channels[formula - 1].visible, true);
    }
    f.change('channel-category-wave', 'all');
    assert.equal(f.get('channel-config-list').children.length, 4);
});

test('byte numeric categories preserve independent visibility and restore selection after activation', t => {
    const f = bootApplication(); t.after(() => f.app.dispose());
    const wave = f.app.widgets.create({ type: 'wave' });
    const formula = f.app.widgets.addChannel('formula');
    const byte = f.app.widgets.create({ type: 'byte', settings: { captureMode: 'number' } });
    f.app.widgets.setChannelVisible(formula - 1, true);
    f.change('channel-category-byte', 'formula');
    assert.deepEqual(f.get('monitor-channel-list').children.map(row => Number(row.dataset.channelNumber)), [formula]);
    f.change('channel-category-byte', 'raw');
    assert.equal(byte.settings.monitorDisplay.numericHiddenChannels.includes(formula - 1), false);
    assert.equal(wave.settings.channels[formula - 1]?.visible ?? false, false);
    f.app.widgets.activate(wave.id); f.app.widgets.activate(byte.id);
    assert.equal(f.get('channel-category-byte').value, 'raw');
});

test('response configuration reload preserves sampled and static visibility without creating received frames', async t => {
    const f = bootApplication(); t.after(() => f.app.dispose());
    const wave = f.app.widgets.create({ type: 'wave' });
    f.app.widgets.setChannelVisible(0, true);
    const kernel = f.app.widgets.addChannel('constant');
    f.change('plot-content', 'response'); f.app.widgets.setChannelVisible(kernel - 1, true);
    f.change('plot-view-mode', 'phase'); f.change('plot-response-sample-rate', '1000');
    wave.view.vp.phase.displayCount = 100; wave.view.draw();
    const config = f.app.getConfig(), restored = bootApplication(config); t.after(() => restored.app.dispose());
    await restored.settle();
    const w = restored.app.widgets.widgets.get(wave.id);
    assert.equal(w.view.frames.responseMode, true); assert.equal(w.view.vp.phase.displayCount, 100);
    assert.equal(w.settings.channels[0].visible, true);
    assert.equal(w.view.getChannelMeta()[kernel - 1].visible, true);
    assert.equal(w.view.responseSampleRate, 1000); assert.equal(w.source.frames.length, 0);
});

test('system plots do not redraw on receipt and cannot become byte navigation references', async t => {
    const f = bootApplication(); t.after(() => f.app.dispose());
    const wave = f.app.widgets.create({ type: 'wave' });
    const kernel = f.app.widgets.addChannel('constant');
    f.change('plot-content', 'response'); f.app.widgets.setChannelVisible(kernel - 1, true);
    await f.settle();
    wave.view.draw(); const draws = wave.view.completedDraws;
    f.app.service.receive(Uint8Array.of(0xab, 0, 0, 128, 63)); await f.tick();
    assert.equal(wave.view.completedDraws, draws);
    assert.equal(wave.source.frames.length, 1);
    f.app.service.pause(true); f.app.tools.syncPaused();
    assert.equal(wave.view.getReferenceByteOffset(), null); assert.equal(wave.view.jumpToByteOffset(0), false);
    assert.equal(await f.app.tools.requestSearch('nearest'), false);
});
