const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

test('unsupported Web Serial is reported to the caller without showing UI in the transport', async () => {
    const source = fs.readFileSync(require.resolve('../serialEngine.js'), 'utf8');
    const SerialEngine = vm.runInNewContext(`${source}\nSerialEngine`, {
        navigator: {}, alert() { throw new Error('transport showed an alert'); }
    });
    await assert.rejects(new SerialEngine().connect({}), /不支持 Web Serial/);
});

test('disconnect cancels and releases the reader before closing the port', async () => {
    const calls = [];
    let finishRead;
    const reader = {
        read: () => new Promise(resolve => { finishRead = resolve; }),
        cancel: async () => { calls.push('cancel'); finishRead({ done: true }); },
        releaseLock: () => calls.push('release')
    };
    const port = {
        readable: { getReader: () => reader },
        writable: { getWriter: () => ({ write: async () => {}, releaseLock() {} }) },
        open: async () => calls.push('open'),
        close: async () => calls.push('close')
    };
    const navigator = { serial: { requestPort: async () => port, addEventListener() {} } };
    const source = fs.readFileSync(require.resolve('../serialEngine.js'), 'utf8');
    const SerialEngine = vm.runInNewContext(`${source}\nSerialEngine`, { navigator, console: { error() {} }, alert() {} });
    const engine = new SerialEngine();
    await engine.connect({ baudRate: 115200 });
    await engine.disconnect();
    await new Promise(resolve => setImmediate(resolve));
    assert.ok(calls.indexOf('cancel') < calls.indexOf('release'));
    assert.ok(calls.indexOf('release') < calls.indexOf('close'));
    assert.equal(calls.filter(call => call === 'release').length, 1);
    assert.equal(engine.port, null);
});

test('unrecoverable read error reports disconnection and closes the port', async () => {
    const status = [];
    const reasons = [];
    let closed = 0;
    const reader = { read: async () => { throw new Error('device lost'); },
        releaseLock() {}, cancel: async () => {} };
    const port = { readable: { getReader: () => reader }, open: async () => {},
        close: async () => { closed++; } };
    const navigator = { serial: { requestPort: async () => port, addEventListener() {} } };
    const source = fs.readFileSync(require.resolve('../serialEngine.js'), 'utf8');
    const SerialEngine = vm.runInNewContext(`${source}\nSerialEngine`, { navigator, console: { error() {} }, alert() {} });
    const engine = new SerialEngine();
    engine.onStatusChange((value, error) => { status.push(value); if (error) reasons.push(error.message); });
    await engine.connect({});
    await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(status, [true, false]);
    assert.deepEqual(reasons, ['device lost']);
    assert.equal(closed, 1);
});

test('end of readable stream stops the loop instead of reopening readers', async () => {
    let readers = 0;
    const port = { readable: { getReader: () => {
        readers++;
        if (readers > 3) throw new Error('reader reopened');
        return { read: async () => ({ done: true }), releaseLock() {}, cancel: async () => {} };
    } }, open: async () => {}, close: async () => {} };
    const navigator = { serial: { requestPort: async () => port, addEventListener() {} } };
    const source = fs.readFileSync(require.resolve('../serialEngine.js'), 'utf8');
    const SerialEngine = vm.runInNewContext(`${source}\nSerialEngine`, { navigator, console: { error() {} }, alert() {} });
    const engine = new SerialEngine();
    await engine.connect({});
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(readers, 1);
    assert.equal(engine.port, null);
});
