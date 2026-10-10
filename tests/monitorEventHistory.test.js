const test = require('node:test');
const assert = require('node:assert/strict');
const { bootApplication } = require('./helpers/widgetAppHarness');

function setup(t, capacity = 25000) {
    const f = bootApplication(); t.after(() => f.app.dispose());
    f.change('max-points', String(capacity));
    return f;
}
function scroll(view, fraction) {
    view.container.scrollTop = Math.max(0, view.container.scrollHeight - view.container.clientHeight) * fraction;
    view.container.dispatchEvent({ type: 'scroll' });
}

test('new byte views browse all 20000 retained TX records while materializing only nearby rows', async t => {
    const f = setup(t);
    for (let i = 0; i < 20000; i++) f.app.service.appendTx(Uint8Array.of(i & 255), i);
    const tx = f.app.service.txFrames, frameAt = tx.frameAt.bind(tx);
    let reads = 0; tx.frameAt = index => { reads++; return frameAt(index); };
    const widget = f.app.widgets.create({ type: 'byte' }); await f.settle();
    const view = widget.view;
    assert.equal(view.lastRows.at(-1)?.order, 20000);
    assert.equal(view.extras.length, 0, 'shared TX history must not be copied into per-view extras');
    scroll(view, 0);
    assert.equal(view.lastRows[0]?.order, 1);
    scroll(view, 0.5);
    assert.ok(view.lastRows.some(row => row.order >= 9990 && row.order <= 10010));
    view.followLatest();
    assert.equal(view.lastRows.at(-1).order, 20000);
    assert.ok(reads < 500, 'opening and scrolling a large history must read only local records, got ' + reads);
    assert.ok(view.spacer.children.length < 100);
    assert.equal(tx.length, 20000);
});

test('shared TX appends appear once in every byte view and capacity changes prune their histories', async t => {
    const f = setup(t, 1000), a = f.app.widgets.create({ type: 'byte' }), b = f.app.widgets.create({ type: 'byte' });
    for (let i = 0; i < 800; i++) f.app.sendController.onSent(Uint8Array.of(i & 255));
    await f.tick();
    for (const widget of [a, b]) {
        widget.view.render();
        assert.equal(widget.view.lastRows.length, 800);
        assert.equal(new Set(widget.view.lastRows.map(row => row.order)).size, 800);
        assert.equal(widget.view.extras.length, 0);
    }
    f.change('max-points', '50'); await f.tick();
    for (const widget of [a, b]) {
        widget.view.render();
        assert.equal(widget.view.lastRows.length, 50);
        assert.equal(widget.view.lastRows[0].order, 751);
    }
    f.app.widgets.remove(a.id);
    assert.equal(f.app.service.txFrames.length, 50);
});

test('all retained parser errors are virtualized and can be viewed before the latest 120 entries', async t => {
    const f = setup(t), errors = f.app.service.numericSource.errors;
    for (let i = 0; i < 20000; i++) errors.push({ kind: 'error', order: i + 1,
        bytes: Uint8Array.of(i & 255), time: 't', reason: 'checksum', timestamp: i });
    const widget = f.app.widgets.create({ type: 'byte', settings: { captureMode: 'number' } }); await f.settle();
    const view = widget.view;
    assert.equal(view.lastRows.at(-1)?.order, 20000);
    scroll(view, 0);
    assert.equal(view.lastRows[0]?.order, 1);
    assert.equal(view.lastRows[0]?.bytes, errors[0].bytes, 'records borrow their existing payload');
    assert.ok(view.lastRows.length < 100);
    view.setDisplayOptions({ showErrors: false });
    assert.equal(view.lastRows.length, 0);
});

test('a long TX row centered between RX samples chooses the nearest sample order', async t => {
    const f = setup(t), source = f.app.service.numericSource;
    source.frames.append([10], Uint8Array.of(10), 't', 10, 10);
    source.frames.append([30], Uint8Array.of(30), 't', 30, 30);
    for (let i = 0; i < 3000; i++) f.app.service.txFrames.appendRaw(
        i === 1500 ? new Uint8Array(5000).fill(65) : Uint8Array.of(65), 't', 11 + i / 200, i, { kind: 'tx' });
    const widget = f.app.widgets.create({ type: 'byte', settings: { captureMode: 'number' } }); await f.settle();
    const view = widget.view;
    view.followTail = false; view.anchor = { order: 18.5, center: true };
    view.render();
    assert.equal(view.currentFrameIndex(), 0);
    assert.equal(view.getReferenceByteOffset(), source.frames.rawByteOffsetAt(0));
    const center = view.container.scrollTop + view.container.clientHeight / 2;
    const row = view.rowPositions.find(row => row.order === 18.5);
    assert.ok(row && center >= row.top && center < row.top + row.height);
    view.followLatest(); assert.equal(view.currentFrameIndex(), 1);
});

test('TX text records decode separately and search continues to address only RX', async t => {
    const f = setup(t), widget = f.app.widgets.create({ type: 'byte', settings: { captureMode: 'text' } });
    f.app.sendController.onSent(Uint8Array.of(0xe4, 0xb8));
    f.app.sendController.onSent(Uint8Array.of(0xad));
    await f.tick(); widget.view.render();
    const rows = widget.view.lastRows;
    assert.equal(rows.length, 2);
    for (const row of rows) assert.equal(row.frameIndex, undefined);
    assert.ok(widget.view._textTokens(rows[0]).some(token => token.failed));
    assert.ok(widget.view._textTokens(rows[1]).some(token => token.failed));
    assert.equal(widget.source.frames.length, 0);
});

test('a search spanning RX records does not highlight intervening TX or parser errors', async t => {
    const f = setup(t), widget = f.app.widgets.create({ type: 'byte' });
    widget.view.matches = [{ startOrder: 1, endOrder: 3, startByte: 0, endByte: 1 }];
    assert.equal(widget.view._rangesForRow({ kind: 'tx', order: 2, bytes: Uint8Array.of(65) }).length, 0);
    assert.equal(widget.view._rangesForRow({ kind: 'error', order: 2, bytes: Uint8Array.of(65) }).length, 0);
});

test('copying a shared TX history freezes its rows until right-click while other views keep updating', async t => {
    const f = setup(t), a = f.app.widgets.create({ type: 'byte' }), b = f.app.widgets.create({ type: 'byte' });
    for (let i = 0; i < 2100; i++) f.app.sendController.onSent(Uint8Array.of(65));
    await f.tick();
    const last = a.view.spacer.children.at(-1);
    const selection = { isCollapsed: false, anchorNode: last, focusNode: last,
        removeAllRanges() { this.isCollapsed = true; } };
    f.document.getSelection = () => selection;
    f.document.dispatchEvent({ type: 'selectionchange' });
    f.app.sendController.onSent(Uint8Array.of(66)); await f.tick();
    assert.equal(a.view.spacer.children.at(-1), last);
    assert.equal(b.view.lastRows.at(-1).order, 2101);
    selection.isCollapsed = true; f.document.dispatchEvent({ type: 'selectionchange' });
    f.app.sendController.onSent(Uint8Array.of(67)); await f.tick();
    assert.equal(a.view.spacer.children.at(-1), last);
    a.view.container.dispatchEvent({ type: 'contextmenu' });
    assert.equal(a.view.lastRows.at(-1).order, 2102);
    assert.equal(a.view.followTail, true);
    assert.equal(f.app.service.txFrames.length, 2102);
});
