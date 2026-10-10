const test = require('node:test');
const assert = require('node:assert/strict');
const { bootApplication } = require('./helpers/widgetAppHarness');

test('moving derived channels preserves dependencies, history and widget selections', async t => {
    const f = bootApplication(); t.after(() => f.app.dispose());
    const wave = f.app.widgets.create({ type: 'wave' });
    f.change('channels-count', '12'); f.change('chk-header', false); f.change('data-type', 'uint8'); await f.settle();
    const first = f.app.widgets.addChannel('formula'), second = f.app.widgets.addChannel('formula');
    await f.app.widgets.updateChannelDefinition({ number: first, type: 'formula', expression: 'CH01+CH02' });
    await f.app.widgets.updateChannelDefinition({ number: second, type: 'formula', expression: 'CH13+CH02' });
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
    assert.deepEqual(Array.from(definitions, d => [d.number, d.expression]), [[13, 'CH14+CH02'], [14, 'CH01+CH02']]);
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
    assert.deepEqual(Array.from(restored.app.widgets.globals.channelDefinitions, d => d.expression), ['CH14+CH02', 'CH01+CH02']);
});

test('moving a channel preserves integral, difference, filter state and unapplied drafts', async t => {
    const f = bootApplication(); t.after(() => f.app.dispose()); f.app.widgets.create({ type: 'wave' });
    f.change('channels-count', '2'); await f.settle();
    const definitions = [
        { number: 3, type: 'formula', expression: 'int(CH01)' },
        { number: 4, type: 'formula', expression: 'diff(CH03)+CH03[-1]' },
        { number: 5, type: 'constant', expression: '[0]=1,[1]=2' },
        { number: 6, type: 'formula', expression: 'filter(CH03,CH05)' }
    ];
    for (const definition of definitions) await f.app.widgets.updateChannelDefinition(definition);
    f.app.widgets.channelView.drafts.set(4, { ...definitions[1], expression: 'CH03[-1]+CH04' });
    const frames = f.app.service.numericSource.frames;
    frames.append([1, 0]); frames.append([2, 0]);
    await f.app.widgets.moveChannel(3, 6);
    assert.deepEqual(Array.from(f.app.widgets.globals.channelDefinitions, d => [d.number, d.expression]), [
        [3, 'diff(CH06)+CH06[-1]'], [4, '[0]=1,[1]=2'], [5, 'filter(CH06,CH04)'], [6, 'int(CH01)']
    ]);
    assert.equal(f.app.widgets.channelView.drafts.get(3).expression, 'CH06[-1]+CH03');
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
        f.change('channels-count', '2'); await f.settle();
        f.app.widgets.addChannel('formula'); f.app.widgets.addChannel('constant');
        const list = f.get(type === 'wave' ? 'channel-config-list' : 'monitor-channel-list');
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

test('new channel type follows category for both inspectors and all categories restores manual selection', t => {
    const f = bootApplication(); t.after(() => f.app.dispose());
    for (const type of ['wave', 'byte']) {
        const widget = f.app.widgets.create({ type, settings: type === 'byte' ? { captureMode: 'number' } : {} });
        f.change(`channel-add-type-${type}`, 'system');
        for (const category of ['formula', 'constant', 'system']) {
            f.change(`channel-category-${type}`, category);
            const select = f.get(`channel-add-type-${type}`);
            assert.equal(select.value, category);
            assert.equal(select.disabled, true);
            assert.equal(select.hidden, false);
            f.click(`channel-add-${type}`);
            assert.equal(f.app.getConfig().global.channelDefinitions.at(-1).type, category);
            assert.equal(select.value, category, 'adding must not reset the current category');
        }
        f.change(`channel-category-${type}`, 'raw');
        assert.equal(f.get(`channel-add-type-${type}`).value, 'raw');
        assert.equal(f.get(`channel-add-type-${type}`).disabled, true);
        assert.equal(f.get(`channel-add-${type}`).disabled, true);
        const count = f.app.getConfig().global.channelDefinitions.length;
        f.click(`channel-add-${type}`);
        assert.equal(f.app.getConfig().global.channelDefinitions.length, count);
        f.change(`channel-category-${type}`, 'all');
        assert.equal(f.get(`channel-add-type-${type}`).disabled, false);
        assert.equal(f.get(`channel-add-type-${type}`).value, 'system');
        assert.equal(f.get(`channel-add-${type}`).disabled, false);
        f.app.widgets.activate(null);
        f.app.widgets.activate(widget.id);
        assert.equal(f.get(`channel-add-type-${type}`).value, 'system');
    }
});

test('deleting CH24 shifts later definitions references metadata and retained samples without resetting state', async t => {
    const f = bootApplication(); t.after(() => f.app.dispose());
    const wave = f.app.widgets.create({ type: 'wave' });
    f.change('channels-count', '23'); f.change('chk-header', false); f.change('data-type', 'uint8'); await f.settle();
    const removed = f.app.widgets.addChannel('formula'), kept = f.app.widgets.addChannel('formula');
    const dependent = f.app.widgets.addChannel('formula');
    await f.app.widgets.updateChannelDefinition({ number: kept, type: 'formula', expression: 'int(CH01)' });
    await f.app.widgets.updateChannelDefinition({ number: dependent, type: 'formula', expression: 'diff(CH25)+CH25[-1]' });
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
    assert.equal(f.app.widgets.globals.channelDefinitions[1].expression, 'diff(CH24)+CH24[-1]');
    assert.equal(wave.settings.responseChannels[24]?.name ?? f.app.widgets.globals.channelNames[24], 'CH25');
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
    f.app.widgets.updateChannelDefinition({ number: second, type: 'formula', expression: 'CH02+1' });
    const before = JSON.stringify(f.app.getConfig());
    assert.throws(() => f.app.widgets.removeChannel(first), /不存在/);
    assert.equal(JSON.stringify(f.app.getConfig()), before);
});

test('original channels have no expansion and all type explanations sit below channel creation', t => {
    const f = bootApplication(); t.after(() => f.app.dispose());
    for (const type of ['wave', 'byte']) {
        const widget = f.app.widgets.create({ type, settings: type === 'byte' ? { captureMode: 'number' } : {} });
        for (const kind of ['formula', 'constant', 'system']) f.app.widgets.addChannel(kind);
        const list = f.get(type === 'wave' ? 'channel-config-list' : 'monitor-channel-list');
        const raw = list.children[0];
        assert.ok(!raw.querySelector('.channel-toggle'));
        assert.ok(!raw.querySelector('.channel-definition'));
        assert.equal(raw.querySelector('.channel-label').textContent, 'CH01');
        const help = f.get(`channel-help-${type}`), parent = help.parentNode;
        assert.equal(parent.children[parent.children.indexOf(help) - 1].className, 'channel-create');
        for (const label of ['原始数据', '运算通道', '常量数组', '差分方程系统']) assert.ok(help.textContent.includes(label));
        for (const row of list.children.slice(1)) {
            assert.ok(row.querySelector('.channel-toggle'));
            assert.ok(row.querySelector('[data-role="channel-expression"]'));
            assert.ok(!row.querySelector('.channel-definition').querySelector('.hint-text'));
        }
        const visible = raw.children.find(node => node.type === 'checkbox');
        visible.checked = true; visible.dispatchEvent({ type: 'change' });
        assert.equal(f.app.widgets.channelVisible(widget, 0), true);
        assert.equal(f.app.widgets.active, widget);
    }
});

test('computed definitions and colors are global while numeric visibility belongs to each widget', async t => {
    const f = bootApplication(); t.after(() => f.app.dispose());
    const a = f.app.widgets.create({ type: 'wave' }), b = f.app.widgets.create({ type: 'wave' });
    const byte = f.app.widgets.create({ type: 'byte', settings: { captureMode: 'number' } });
    assert.equal(typeof f.app.widgets.addChannel, 'function', 'the inspector supports derived channels');
    const number = f.app.widgets.addChannel('formula');
    await f.app.widgets.updateChannelDefinition({ number, type: 'formula', expression: 'CH01*2' });
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
    assert.equal(f.app.getConfig().global.channelDefinitions[0].expression, 'CH01*2');
});

test('uniform editor reports invalid formulas below channel without replacing valid samples', async t => {
    const f = bootApplication(); t.after(() => f.app.dispose());
    const wave = f.app.widgets.create({ type: 'wave' });
    assert.equal(typeof f.app.widgets.addChannel, 'function');
    const number = f.app.widgets.addChannel('formula');
    const row = f.get('channel-config-list').children.find(child => child.dataset.channelNumber === String(number));
    const formula = row.querySelector('[data-role="channel-expression"]');
    formula.value = 'diffCH01'; formula.dispatchEvent({ type: 'change' });
    row.querySelector('[data-role="channel-apply"]').click();
    assert.equal(row.querySelector('[data-role="channel-error"]').hidden, false);
    assert.equal(wave.source.frames.definitions[0].expression, 'CH01');
    formula.value = 'diff(CH01)'; formula.dispatchEvent({ type: 'change' });
    row.querySelector('[data-role="channel-apply"]').click(); await f.settle();
    assert.equal(f.app.getConfig().global.channelDefinitions[0].expression, 'diff(CH01)');
});

test('formula drafts apply explicitly and update plotted historical values only with rebuild enabled', async t => {
    const f = bootApplication(); t.after(() => f.app.dispose());
    const wave = f.app.widgets.create({ type: 'wave' });
    f.change('chk-header', false); f.change('data-type', 'uint8'); await f.settle();
    const number = f.app.widgets.addChannel('formula'); await f.settle();
    f.app.widgets.setChannelVisible(number - 1, true);
    f.app.service.receive(Uint8Array.of(2, 3)); await f.settle();
    f.app.service.pause(true);
    const findRow = () => f.get('channel-config-list').children.find(child => child.dataset.channelNumber === String(number));
    let row = findRow(), expression = row.querySelector('[data-role="channel-expression"]');
    const apply = row.querySelector('[data-role="channel-apply"]');
    assert.ok(apply, 'the editor provides an explicit apply button');
    assert.equal(apply.textContent, '应用公式');
    assert.equal(apply.parentElement.children[1].textContent, '删除通道');
    expression.value = 'CH01*2'; expression.dispatchEvent({ type: 'input' }); expression.dispatchEvent({ type: 'change' });
    assert.equal(f.app.getConfig().global.channelDefinitions[0].expression, 'CH01');
    assert.deepEqual(Array.from(wave.view.frames.channelSlice(number - 1)), [2, 3]);
    f.change('channel-rebuild-wave', false); apply.click(); await f.settle();
    assert.equal(f.app.getConfig().global.channelDefinitions[0].expression, 'CH01*2');
    assert.deepEqual(Array.from(wave.view.frames.channelSlice(number - 1)), [2, 3]);
    f.app.service.pause(false); f.app.service.receive(Uint8Array.of(4)); await f.settle(); f.app.service.pause(true);
    assert.deepEqual(Array.from(wave.view.frames.channelSlice(number - 1)), [2, 3, 8]);
    // Reapplying the same expression with rebuild enabled must also refresh older samples.
    f.change('channel-rebuild-wave', true); row = findRow();
    row.querySelector('[data-role="channel-apply"]').click(); await f.settle();
    assert.deepEqual(Array.from(wave.view.frames.channelSlice(number - 1)), [4, 6, 8]);
    assert.equal(wave.view.getChannelMeta()[number - 1].visible, true);
});

test('numeric byte editor applies shared constants and system initial state in one action', async t => {
    const f = bootApplication(); t.after(() => f.app.dispose());
    const byte = f.app.widgets.create({ type: 'byte', settings: { captureMode: 'number' } });
    const kernel = f.app.widgets.addChannel('constant');
    let row = f.get('monitor-channel-list').children.find(child => child.dataset.channelNumber === String(kernel));
    const constant = row.querySelector('[data-role="channel-expression"]');
    constant.value = '[0]=2,[1]=-1'; constant.dispatchEvent({ type: 'input' });
    row.querySelector('[data-role="channel-apply"]').click();
    const system = f.app.widgets.addChannel('system');
    row = f.get('monitor-channel-list').children.find(child => child.dataset.channelNumber === String(system));
    const expression = row.querySelector('[data-role="channel-expression"]'), initial = row.querySelector('[data-role="channel-initial"]');
    expression.value = 'x[0]+y[-1]'; expression.dispatchEvent({ type: 'input' });
    initial.value = 'y[-1]=5'; initial.dispatchEvent({ type: 'change' });
    row.querySelector('[data-role="channel-apply"]').click(); await f.settle();
    assert.equal(byte.source.frames.definitions.find(value => value.number === kernel).expression, '[0]=2,[1]=-1');
    assert.equal(byte.source.frames.definitions.find(value => value.number === system).initial, 'y[-1]=5');
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
    f.change('chk-header', false); f.change('data-type', 'uint8'); await f.settle();
    f.change('channel-rebuild-wave', false);
    const number = f.app.widgets.addChannel('formula');
    await f.app.widgets.updateChannelDefinition({ number, type: 'formula', expression: 'CH01/2' });
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
    config.global.channelDefinitions = [{ number: 3, type: 'formula', expression: 'CH01+CH02' }];
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
