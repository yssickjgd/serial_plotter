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
        f.change(prefix + '-timebase-mode', 'fixed');
        assert.equal(f.get(prefix + '-timebase-fixed').hidden, false);
        assert.equal(f.get(prefix + '-resync-fixed').hidden, false);
        const summary = f.get(prefix + '-resync-summary');
        assert.equal(f.get(prefix + '-resync-settings').firstElementChild, summary);
        return summary.textContent;
    });
    assert.equal(summaries[0], summaries[1]);
    assert.match(summaries[0], /同时/);
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

test('the sidebar and communication dialog edit one persistent resync policy per source', t => {
    const f = communications(t);
    f.click('serial-source-add');
    const sidebar = f.get('sidebar-source-alignment'), mainSource = f.get('sidebar-alignment-source');
    assert.ok(sidebar.closest('#tab-connection'));
    f.change('sidebar-alignment-source', 'serial-2');
    f.change('sidebar-timebase-mode', 'fixed');
    f.change('sidebar-resync-delay', '7.5');
    f.change('sidebar-resync-batches', '4');
    assert.equal(f.get('sidebar-resync-confirmation').value, '100');
    f.change('sidebar-resync-confirmation', '0');
    sidebar.dispatchEvent({ type: 'pointerleave' });
    assert.equal(f.get('channel-resync-confirmation').value, '0');
    assert.equal(f.get('channel-timebase-mode').value, 'fixed');
    assert.equal(f.get('channel-resync-delay').value, '7.5');
    assert.equal(f.get('channel-resync-batches').value, '4');
    f.change('channel-resync-enabled', false);
    f.get('serial-config-alignment').dispatchEvent({ type: 'pointerleave' });
    assert.equal(f.get('sidebar-resync-enabled').checked, false);
    assert.equal(f.get('sidebar-resync-delay').disabled, true);
    assert.equal(f.get('sidebar-resync-confirmation').disabled, true);
    f.change('sidebar-resync-enabled', true);
    f.change('sidebar-resync-batches', '0');
    f.change('sidebar-alignment-source', 'primary');
    assert.equal(mainSource.value, 'serial-2');
    assert.match(f.get('sidebar-alignment-status').textContent, /连续批次数/);
    f.change('sidebar-resync-batches', '4');
    f.change('sidebar-resync-enabled', false);
    f.change('sidebar-alignment-source', 'primary');
    assert.equal(mainSource.value, 'primary');
    assert.equal(f.get('sidebar-resync-enabled').checked, true);
    assert.equal(f.get('sidebar-resync-confirmation').value, '100');
    f.selectConnection('primary', 'engine-communication');
    f.change('channel-timebase-mode', 'fixed');
    f.change('channel-resync-confirmation', '36.5');
    const dialog = f.get('serial-config-alignment');
    dialog.dispatchEvent({ type: 'keydown', key: 'Enter', target: f.get('channel-resync-confirmation') });
    assert.equal(f.get('sidebar-resync-confirmation').value, '36.5');
    f.change('channel-resync-confirmation', '');
    dialog.dispatchEvent({ type: 'pointerleave' });
    assert.match(f.get('channel-alignment-status').textContent, /确认时间/);
    assert.equal(f.get('sidebar-resync-confirmation').value, '36.5');
    f.change('channel-resync-confirmation', '36.5');
    f.change('sidebar-alignment-source', 'serial-2');
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
