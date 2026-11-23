const assert = require('node:assert/strict');
const test = require('node:test');
const { bootApplication } = require('./helpers/widgetAppHarness');

function communications(t, { wide = false } = {}) {
    const viewport = new EventTarget();
    viewport.matches = wide;
    const f = bootApplication(null, { matchMedia: query => query.includes('min-width') ? viewport : { matches: false } });
    t.after(() => f.app.dispose());
    f.click('serial-manager-open');
    return { ...f, viewport };
}

test('the desktop overview applies changes to the selected source and restores the focused panel as a tab', async t => {
    const f = communications(t, { wide: true });
    const panels = ['engine-communication', 'engine-parsing', 'engine-raw-records', 'engine-channels'];
    assert.deepEqual(panels.map(id => f.get(id).hidden), [false, false, false, false]);
    assert.equal(f.get('engine-edit-actions').hidden, false);

    f.click('serial-source-add');
    const secondary = f.app.serialSources.get('serial-2');
    f.change('engine-raw-idle-timeout', '75');
    await f.app.engineView.apply();
    assert.equal(Number(secondary.capture.dataEngine.config.rawIdleTimeouts.Raw_Data), 75);
    assert.equal(Number(f.app.dataEngine.config.rawIdleTimeouts.Raw_Data), 50);

    f.get('engine-raw-idle-timeout').focus();
    f.viewport.matches = false;
    f.viewport.dispatchEvent(new Event('change'));
    assert.deepEqual(panels.map(id => f.get(id).hidden), [true, true, false, true]);
    assert.equal(f.document.activeElement.id, 'engine-raw-idle-timeout');
    assert.equal(f.app.engineView.engine, secondary.capture.dataEngine);
});

test('deleting another source from the source list preserves the selected source', t => {
    const f = communications(t);
    f.click('serial-source-add');
    f.selectConnection('primary', 'engine-parsing');
    const primaryName = f.get('serial-config-name').value;
    const scope = f.get('engine-parsing').querySelector('.scope-badge');
    assert.equal(f.get('serial-2-remove').closest('#serial-source-nav'), f.get('serial-source-nav'));
    assert.equal(f.get('serial-primary-remove'), null);
    assert.equal(scope.textContent, '来源共用');
    f.click('serial-2-remove');
    assert.equal(f.app.serialSources.has('serial-2'), false);
    assert.equal(f.get('serial-config-name').value, primaryName);
    assert.equal(scope.textContent, '全局共用');
});

test('deleting the selected source confirms retained records before rebinding the overview', t => {
    const f = communications(t, { wide: true });
    f.click('serial-source-add');
    const secondary = f.app.serialSources.get('serial-2');
    secondary.capture.receive(Uint8Array.of(7));
    let confirmationCount = 0;
    f.window.confirm = () => ++confirmationCount === 2;

    f.click('serial-2-remove');
    assert.equal(f.app.serialSources.get('serial-2'), secondary);
    assert.equal(f.app.engineView.engine, secondary.capture.dataEngine);
    f.get('serial-2-remove').focus();
    f.click('serial-2-remove');
    assert.equal(confirmationCount, 2);
    assert.equal(f.app.serialSources.has('serial-2'), false);
    assert.equal(f.app.engineView.engine, f.app.dataEngine);
    assert.equal(f.document.activeElement.getAttribute('aria-controls'), 'serial-primary-details');
});

test('synchronized grid settings belong to the main channel tab and plot help follows the active source', t => {
    const f = communications(t, { wide: true });
    assert.ok(f.get('workspace-grid-settings').closest('#tab-channel-configuration'));
    assert.equal(f.get('workspace-grid-settings').closest('#engine-communication'), null);
    f.click('serial-manager-close');
    f.click('workspace-channel-auto-map');
    const single = f.app.widgets.create({ type: 'wave' });
    const multi = f.app.widgets.create({ type: 'wave', settings: { connectionSource: 'workspace' } });
    f.app.widgets.activate(multi.id);
    assert.equal(f.get('plot-workspace-sampling-hint').hidden, false);
    assert.equal(f.get('plot-sample-axis-hint').hidden, true);
    f.app.widgets.activate(single.id);
    assert.equal(f.get('plot-workspace-sampling-hint').hidden, true);
});

test('alignment and sampling are separate groups with matching resync help and mode-specific controls', t => {
    const f = communications(t);
    const summaries = ['sidebar', 'channel'].map(prefix => {
        const alignment = f.get(prefix + '-time-alignment-group');
        const sampling = f.get(prefix + '-sampling-group');
        assert.ok(alignment && sampling);
        assert.equal(alignment.parentElement, sampling.parentElement);
        assert.ok(alignment.contains(f.get(prefix + '-timebase-rate')));
        assert.ok(sampling.contains(f.get(prefix + '-resync-enabled')));
        assert.ok(sampling.contains(f.get(prefix + '-grid-method')));
        assert.equal(f.get(prefix + '-resync-fixed').hidden, true);
        assert.equal(f.get(prefix + '-grid-method').disabled, false);
        const summary = f.get(prefix + '-resync-summary');
        assert.equal(f.get(prefix + '-resync-settings').firstElementChild, summary);
        return summary.textContent;
    });
    assert.equal(summaries[0], summaries[1]);
    assert.match(summaries[0], /同时/);
    f.change('sidebar-timebase-mode', 'fixed');
    assert.equal(f.get('sidebar-timebase-fixed').hidden, false);
    assert.equal(f.get('sidebar-resync-fixed').hidden, true);
    f.get('sidebar-time-alignment-group').dispatchEvent({ type: 'pointerleave' });
    assert.equal(f.get('sidebar-resync-fixed').hidden, false);
    assert.equal(f.get('channel-resync-fixed').hidden, false);
    f.change('channel-timebase-mode', 'receive');
    assert.equal(f.get('channel-resync-fixed').hidden, true);
    for (const field of ['delay', 'batches', 'confirmation']) {
        const hints = ['sidebar', 'channel'].map(prefix => {
            const input = f.get(prefix + '-resync-' + field);
            const hint = f.get(input.getAttribute('aria-describedby'));
            assert.ok(hint);
            assert.equal(hint.parentElement, input.parentElement);
            return hint.textContent;
        });
        assert.equal(hints[0], hints[1]);
    }
});

test('sidebar selections keep independent drafts and survive changes to the source list', t => {
    const f = communications(t);
    f.click('serial-source-add');
    f.change('sidebar-alignment-source', 'serial-2');
    f.change('sidebar-sampling-source', 'serial-2');
    for (const id of ['sidebar-alignment-source', 'sidebar-sampling-source']) {
        const enter = { type: 'keydown', key: 'Enter', bubbles: true,
            stopPropagation() { this.bubbles = false; },
            preventDefault() { this.defaultPrevented = true; } };
        f.get(id).dispatchEvent(enter);
        assert.equal(enter.defaultPrevented, undefined, 'Enter remains available to the source picker');
    }
    f.change('sidebar-config-offset', '-12');
    f.change('sidebar-grid-method', 'linear');
    f.get('sidebar-sampling-group').dispatchEvent({ type: 'pointerleave' });
    assert.equal(f.app.getConfig().workspaceChannels.methods['serial-2'], 'linear');
    assert.equal(f.get('sidebar-config-offset').value, '-12');
    assert.equal(f.app.serialSources.get('serial-2').settings.timeOffsetMs, 0);

    f.change('sidebar-grid-method', 'spline');
    f.change('sidebar-alignment-source', 'primary');
    assert.equal(f.app.serialSources.get('serial-2').settings.timeOffsetMs, -12);
    assert.equal(f.get('sidebar-sampling-source').value, 'serial-2');
    assert.equal(f.get('sidebar-grid-method').value, 'spline');
    f.change('sidebar-sampling-source', 'primary');
    assert.equal(f.app.getConfig().workspaceChannels.methods['serial-2'], 'spline');
    assert.equal(f.get('sidebar-grid-method').value, 'hold');

    f.change('sidebar-sampling-source', 'serial-2');
    f.click('serial-source-add');
    assert.equal(f.get('sidebar-sampling-source').value, 'serial-2');
    assert.equal(f.get('sidebar-alignment-source').value, 'primary');
    f.click('serial-2-remove');
    assert.equal(f.get('sidebar-sampling-source').value, 'primary');
    assert.equal(f.get('sidebar-alignment-source').value, 'primary');
    assert.deepEqual(f.get('sidebar-sampling-source').options.map(option => option.value), ['primary', 'serial-3']);
});

test('sidebar timing settings apply from the main view and confirm the saved values', async t => {
    const f = communications(t);
    f.click('serial-source-add');
    f.click('serial-manager-close');
    assert.equal(f.get('serial-config-dialog').open, false);
    f.change('sidebar-alignment-source', 'serial-2');
    f.change('sidebar-sampling-source', 'serial-2');
    f.change('sidebar-timebase-mode', 'fixed');
    f.change('sidebar-timebase-rate', '1250');
    f.change('sidebar-config-offset', '-8');
    f.get('sidebar-config-offset').dispatchEvent({ type: 'keydown', key: 'Enter', bubbles: true });
    assert.equal(f.app.getConfig().workspaceChannels.timebases['serial-2'].sampleRate, 1250);
    assert.equal(f.app.serialSources.get('serial-2').settings.timeOffsetMs, -8);
    assert.equal(f.get('sidebar-alignment-status').textContent, '设置已应用');
    assert.equal(f.get('sidebar-alignment-status').classList.contains('is-error'), false);

    f.change('sidebar-grid-method', 'quadratic');
    f.change('sidebar-resync-batches', '0');
    f.get('sidebar-sampling-group').dispatchEvent({ type: 'pointerleave' });
    assert.match(f.get('sidebar-sampling-status').textContent, /连续批次数/);
    assert.equal(f.get('sidebar-sampling-status').classList.contains('is-error'), true);
    assert.equal(f.app.getConfig().workspaceChannels.methods['serial-2'], 'hold');
    f.change('sidebar-resync-batches', '5');
    f.get('sidebar-sampling-group').dispatchEvent({ type: 'pointerleave' });
    assert.equal(f.app.getConfig().workspaceChannels.timebases['serial-2'].resyncBatches, 5);
    assert.equal(f.app.getConfig().workspaceChannels.methods['serial-2'], 'quadratic');
    assert.equal(f.get('sidebar-sampling-status').textContent, '设置已应用');
    assert.equal(f.get('sidebar-sampling-status').classList.contains('is-error'), false);

    await f.tick();
    const saved = JSON.parse(f.storage.get('serialplot_v3_config'));
    assert.equal(saved.serialSources.entries[0].timeOffsetMs, -8);
    assert.equal(saved.workspaceChannels.timebases['serial-2'].sampleRate, 1250);
    assert.equal(saved.workspaceChannels.methods['serial-2'], 'quadratic');
    assert.equal(f.get('serial-config-dialog').open, false);
});

test('the sidebar and communication dialog edit one persistent resync policy per source', t => {
    const f = communications(t);
    f.click('serial-source-add');
    const alignment = f.get('sidebar-time-alignment-group'), sampling = f.get('sidebar-sampling-group');
    const alignmentSource = f.get('sidebar-alignment-source'), samplingSource = f.get('sidebar-sampling-source');
    assert.ok(alignment.closest('#tab-connection'));
    assert.ok(sampling.contains(samplingSource));
    assert.deepEqual(samplingSource.options.map(option => option.value), ['primary', 'serial-2']);
    f.change('sidebar-alignment-source', 'serial-2');
    f.change('sidebar-timebase-mode', 'fixed');
    alignment.dispatchEvent({ type: 'pointerleave' });
    assert.equal(samplingSource.value, 'primary');
    assert.equal(f.get('sidebar-resync-fixed').hidden, true);
    f.change('sidebar-sampling-source', 'serial-2');
    assert.equal(f.get('sidebar-resync-fixed').hidden, false);
    f.change('sidebar-resync-delay', '7.5');
    f.change('sidebar-resync-batches', '4');
    assert.equal(f.get('sidebar-resync-confirmation').value, '100');
    f.change('sidebar-resync-confirmation', '0');
    sampling.dispatchEvent({ type: 'pointerleave' });
    assert.equal(f.get('channel-resync-confirmation').value, '0');
    assert.equal(f.get('channel-timebase-mode').value, 'fixed');
    assert.equal(f.get('channel-resync-delay').value, '7.5');
    assert.equal(f.get('channel-resync-batches').value, '4');
    f.change('channel-resync-enabled', false);
    f.click('engine-apply');
    assert.equal(f.get('sidebar-resync-enabled').checked, false);
    assert.equal(f.get('sidebar-resync-delay').disabled, true);
    assert.equal(f.get('sidebar-resync-confirmation').disabled, true);
    f.change('sidebar-resync-enabled', true);
    f.change('sidebar-resync-batches', '0');
    f.change('sidebar-sampling-source', 'primary');
    assert.equal(samplingSource.value, 'serial-2');
    assert.match(f.get('sidebar-sampling-status').textContent, /连续批次数/);
    f.change('sidebar-resync-batches', '4');
    f.change('sidebar-resync-enabled', false);
    f.change('sidebar-sampling-source', 'primary');
    assert.equal(samplingSource.value, 'primary');
    assert.equal(alignmentSource.value, 'serial-2');
    assert.equal(f.get('sidebar-resync-enabled').checked, true);
    assert.equal(f.get('sidebar-resync-confirmation').value, '100');
    f.selectConnection('primary', 'engine-communication');
    f.change('channel-timebase-mode', 'fixed');
    f.change('channel-resync-confirmation', '36.5');
    f.click('engine-apply');
    assert.equal(f.get('sidebar-resync-confirmation').value, '36.5');
    f.change('channel-resync-confirmation', '');
    f.click('engine-apply');
    assert.match(f.get('engine-status').textContent, /确认时间/);
    assert.equal(f.get('sidebar-resync-confirmation').value, '36.5');
    f.change('channel-resync-confirmation', '36.5');
    f.change('sidebar-sampling-source', 'serial-2');
    assert.equal(f.get('sidebar-resync-enabled').checked, false);
    assert.equal(f.get('sidebar-resync-confirmation').value, '0');
    const config = f.app.getConfig();
    assert.equal(config.workspaceChannels.timebases['serial-2'].resyncDelayMs, 7.5);
    assert.equal(config.workspaceChannels.timebases['serial-2'].resyncBatches, 4);
    assert.equal(config.workspaceChannels.timebases['serial-2'].resyncEnabled, false);
    assert.equal(config.workspaceChannels.timebases['serial-2'].resyncConfirmationMs, 0);
    assert.equal(config.workspaceChannels.timebases.primary.resyncConfirmationMs, 36.5);
    const restored = bootApplication(config);
    t.after(() => restored.app.dispose());
    restored.selectConnection('serial-2');
    assert.equal(restored.get('channel-resync-enabled').checked, false);
    assert.equal(restored.get('channel-resync-delay').value, '7.5');
    assert.equal(restored.get('channel-resync-confirmation').value, '0');
    restored.selectConnection('primary');
    assert.equal(restored.get('channel-resync-confirmation').value, '36.5');
});

test('main-view waveform and buffer fields apply on Enter or pointerleave without opening the dialog', t => {
    const f = bootApplication();
    t.after(() => f.app.dispose());
    f.app.widgets.create({ type: 'wave' });
    const points = f.get('plot-window-points');
    points.value = '2000';
    points.dispatchEvent({ type: 'input' });
    points.dispatchEvent({ type: 'keydown', key: 'Enter' });
    assert.equal(f.app.getConfig().global.plotWindowPoints, '2000');
    const memory = f.get('capture-memory-mib');
    memory.value = '2048';
    f.get('board-toolbar').dispatchEvent({ type: 'pointerleave' });
    assert.equal(f.app.getConfig().global.captureMemoryMiB, 2048);
    assert.equal(f.get('serial-config-dialog').open, undefined);
});

test('the communication footer applies all source drafts while Enter and pointerleave leave them pending', async t => {
    const f = communications(t);
    f.click('serial-source-add');
    const source = f.app.serialSources.get('serial-2');
    assert.equal(f.get('engine-edit-actions').hidden, false);
    assert.equal(f.get('serial-config-reset'), null);
    f.change('serial-baud', '1250000');
    f.change('channel-timebase-mode', 'fixed');
    f.change('channel-timebase-rate', '500');
    f.change('serial-config-offset', '-4');
    f.change('rebuild-history', false);
    f.change('max-raw-frame-bytes', '2048');
    f.change('engine-raw-idle-timeout', '65');
    const channel = f.app.engineView.channels.list.querySelector('.channel-name');
    channel.value = '传感器';
    channel.dispatchEvent({ type: 'change', bubbles: true });
    f.get('serial-baud').dispatchEvent({ type: 'keydown', key: 'Enter', bubbles: true });
    f.get('serial-config-form').dispatchEvent({ type: 'pointerleave' });
    f.get('serial-config-form').dispatchEvent({ type: 'submit' });
    f.get('serial-config-alignment').dispatchEvent({ type: 'pointerleave' });
    assert.equal(source.settings.baudRate, 115200);
    assert.equal(source.settings.timeOffsetMs, 0);
    assert.equal(source.capture.rebuildHistory, true);
    assert.equal(f.app.service.maxRawFrameBytes, 1024);
    assert.equal(source.capture.dataEngine.config.rawIdleTimeouts.Raw_Data, 50);
    assert.notEqual(source.capture.dataEngine.globals.channelNames[0], '传感器');

    f.change('channel-resync-batches', '0');
    f.click('engine-apply'); await f.tick();
    assert.match(f.get('engine-status').textContent, /连续批次数/);
    assert.equal(source.settings.baudRate, 115200);
    f.change('channel-resync-batches', '5');
    f.click('engine-apply'); await f.tick();
    assert.equal(source.settings.baudRate, 1250000);
    assert.equal(source.settings.timeOffsetMs, -4);
    assert.equal(source.capture.rebuildHistory, false);
    assert.equal(f.app.service.maxRawFrameBytes, 2048);
    assert.equal(source.capture.maxRawFrameBytes, 2048);
    assert.equal(source.capture.dataEngine.config.rawIdleTimeouts.Raw_Data, 65);
    assert.equal(source.capture.dataEngine.globals.channelNames[0], '传感器');
    assert.equal(f.app.getConfig().workspaceChannels.timebases['serial-2'].resyncBatches, 5);
    f.click('serial-manager-close');
    f.change('sidebar-alignment-source', 'serial-2');
    assert.equal(f.get('sidebar-config-offset').value, '-4');
    f.change('sidebar-config-offset', '-12');
    f.get('sidebar-config-offset').dispatchEvent({ type: 'keydown', key: 'Enter', bubbles: true });
    f.selectConnection('serial-2');
    assert.equal(f.get('serial-config-offset').value, '-12');

    f.change('serial-config-offset', '-30');
    f.click('serial-manager-close');
    f.change('sidebar-config-offset', '-14');
    f.get('sidebar-time-alignment-group').dispatchEvent({ type: 'pointerleave' });
    f.selectConnection('serial-2');
    assert.equal(f.get('serial-config-offset').value, '-14');
    f.click('engine-apply');
    assert.equal(source.settings.timeOffsetMs, -14);
});
