const test = require('node:test');
const assert = require('node:assert/strict');
const { bootApplication } = require('./helpers/widgetAppHarness');
async function fixture(t) {
    const f = bootApplication(); t.after(() => f.app.dispose());
    f.change('channels-count', '3'); await f.settle();
    const pose = f.app.widgets.create({ type: 'pose', settings: { bindings: { euler: [0, 2, 2] } } });
    const wave = f.app.widgets.create({ type: 'wave' });
    const byte = f.app.widgets.create({ type: 'byte', settings: { captureMode: 'number' } });
    for (const value of [1, 2, 3]) {
        const bytes = new Uint8Array(13); bytes[0] = 0xAB; const view = new DataView(bytes.buffer);
        [value, 42, 0].forEach((v, i) => view.setFloat32(1 + i * 4, v, true));
        f.app.serialAdapter.onDataCallback(bytes); await f.tick(10);
    }
    f.click('btn-pause'); f.app.workspace.activate(pose.id); f.change('monitor-search-origin', pose.id);
    async function search(query, action = 'nearest') {
        f.get('monitor-search-query').value = query; f.get('monitor-search-tolerance').value = '0';
        const promise = f.app.tools.requestSearch(action); for (let i = 0; i < 5; i++) await f.tick(10); return promise;
    }
    return { ...f, pose, wave, byte, search };
}
test('pose search uses only bound scalar channels and synchronizes exact retained positions', async t => {
    const f = await fixture(t);
    assert.equal(f.app.tools._kind(), 'number');
    assert.deepEqual(Array.from(f.app.tools.channelInputs, v => v.channel), [-1, 0, 2]);
    assert.equal(await f.search('42'), false, 'unbound channel must not be searched');
    assert.equal(await f.search('2'), true);
    const index = 1, frames = f.pose.source.frames;
    assert.equal(f.pose.view.target.order, frames.orderAt(index));
    assert.equal(f.pose.view.followTail, false); assert.equal(f.byte.view.cursorOrder, frames.orderAt(index));
    assert.equal(f.wave.view.navigationMarkers.matches.length, 1);
    assert.match(f.pose.refs['pose-status'].textContent, /当前搜索命中/);
    assert.equal(f.pose.view.getReferenceByteOffset(), frames.rawByteOffsetAt(index));
    f.click('btn-pause'); await f.tick();
    assert.equal(f.pose.view.followTail, true); assert.equal(f.pose.view.navigationMarkers.matches.length, 0);
    assert.equal(f.pose.view.getReferenceByteOffset(), frames.rawByteOffsetAt(2));
});
test('time navigation marks pose targets and retains invalid pose frames as exact targets', async t => {
    const f = await fixture(t), frames = f.pose.source.frames;
    f.app.tools._jumpAll(frames.rawByteOffsetAt(0), true); await f.tick();
    assert.equal(f.pose.view.navigationMarkers.timeOrder, frames.orderAt(0));
    assert.equal(f.pose.view.target.index, 0);
    assert.equal(f.pose.view.jumpToByteOffset(-1), false);
    assert.equal(f.pose.view.jumpToByteOffset(frames.rawByteOffsetAt(2) + 13), false);
    f.app.service.clear(); await f.tick();
    assert.equal(f.pose.view.lastValid, null); assert.equal(f.pose.view.getReferenceByteOffset(), null);
});
