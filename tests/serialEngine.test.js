const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

test('foreground serial resumes on a flushed reader, ignores queued bytes, and keeps the port writable', async () => {
    const turns = () => new Promise(resolve => setImmediate(resolve));
    let read, finishFlush, flushCount = 0, closes = 0;
    const output = [], writes = [], states = [];
    const port = {
        open: async () => {}, close: async () => { closes++; },
        readable: { getReader() {
            return {
                read: () => new Promise(resolve => { read = resolve; }),
                cancel() {
                    flushCount++;
                    read?.({ done: true });
                    if (flushCount === 1) return new Promise(resolve => { finishFlush = resolve; });
                    return Promise.resolve();
                },
                releaseLock() {}
            };
        } },
        writable: { getWriter: () => ({ write: async data => writes.push(...data), releaseLock() {} }) }
    };
    const source = fs.readFileSync(require.resolve('../serialEngine.js'), 'utf8');
    const Engine = vm.runInNewContext(`${source}\nSerialEngine`, { navigator: { serial: {} } });
    const engine = new Engine();
    engine.onData(data => output.push(...data));
    engine.onStatusChange(connected => states.push(connected));
    await engine.connect({}, port);
    read({ value: [1] });
    await turns();
    engine.setCaptureVisible(false);
    read({ value: [2] });
    await turns();
    await engine.send([6]);
    read({ value: [3] }); // already fulfilled, but not yet delivered to the JS read loop
    engine.setCaptureVisible(true);
    engine.setCaptureVisible(false);
    engine.setCaptureVisible(true);
    finishFlush();
    await turns();
    assert.equal(flushCount, 2, 'a new foreground interval during an active flush gets a fresh boundary');
    read({ value: [4] });
    await turns();
    assert.deepEqual(output, [1, 4]);
    assert.deepEqual(writes, [6]);
    assert.deepEqual(states, [true]);
    await engine.disconnect();
    assert.equal(closes, 1);
});

test('unsupported Web Serial is reported to the caller without showing UI in the transport', async () => {
    const source = fs.readFileSync(require.resolve('../serialEngine.js'), 'utf8');
    const SerialEngine = vm.runInNewContext(`${source}\nSerialEngine`, {
        navigator: {}, alert() { throw new Error('transport showed an alert'); }
    });
    await assert.rejects(new SerialEngine().connect({}), /不支持 Web Serial/);
});

test('a recoverable overrun while discarding hidden RX keeps the serial connection alive', async () => {
    const turn = () => new Promise(resolve => setImmediate(resolve)), received = [];
    let next, failRead, closes = 0;
    const port = {
        open: async () => {}, close: async () => { closes++; },
        readable: { getReader: () => ({
            read: () => new Promise((resolve, reject) => { next = resolve; failRead = reject; }),
            cancel: async () => next({ done: true }), releaseLock() {}
        }) }
    };
    const source = fs.readFileSync(require.resolve('../serialEngine.js'), 'utf8');
    const Engine = vm.runInNewContext(`${source}\nSerialEngine`, { navigator: { serial: {} } });
    const engine = new Engine();
    engine.onData(data => received.push(...data));
    await engine.connect({}, port);
    engine.setCaptureVisible(false);
    failRead(Object.assign(new Error('overrun'), { name: 'BufferOverrunError' }));
    await turn();
    assert.equal(closes, 0);
    engine.setCaptureVisible(true);
    await turn();
    next({ value: [9] });
    await turn();
    assert.deepEqual(received, [9]);
    await engine.disconnect();
});

test('high-speed serial opens with enough receive space for a delayed browser read', async () => {
    let options;
    const port = {
        open: async config => { options = config; },
        close: async () => {},
        readable: { getReader: () => ({
            read: async () => ({ done: true }), releaseLock() {}, cancel: async () => {}
        }) }
    };
    const source = fs.readFileSync(require.resolve('../serialEngine.js'), 'utf8');
    const SerialEngine = vm.runInNewContext(`${source}\nSerialEngine`, {
        navigator: { serial: { requestPort: async () => port } }
    });
    const engine = new SerialEngine();
    await engine.connect({ baudRate: 2_000_000, dataBits: 8, stopBits: 1, parity: 'none' });
    assert.equal(options.baudRate, 2_000_000);
    assert.ok(options.bufferSize >= 2_000_000 / 10 * 0.25,
        'the browser buffer can hold at least 250 ms of 8N1 traffic at 2 Mbaud');
    await engine.disconnect();
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

test('disconnect cancels pending port selection without opening the selected port', async () => {
    let selected, opened = 0;
    const source = fs.readFileSync(require.resolve('../serialEngine.js'), 'utf8');
    const SerialEngine = vm.runInNewContext(`${source}\nSerialEngine`, { navigator: { serial: {
        requestPort: () => new Promise(resolve => { selected = resolve; }), addEventListener() {}
    } } });
    const engine = new SerialEngine(), connection = engine.connect({});
    await engine.disconnect();
    selected({ open: async () => { opened++; }, close: async () => {} });
    await assert.rejects(connection, { name: 'AbortError' });
    assert.equal(opened, 0);
    assert.equal(engine.port, null);
});

test('a foreground boundary during port.open discards queued bytes before the first read', async () => {
    const calls = [];
    let finishOpen, finishRead;
    const port = { open: () => new Promise(resolve => { finishOpen = resolve; }), close: async () => {},
        readable: { getReader: () => ({
            read: () => { calls.push('read'); return new Promise(resolve => { finishRead = resolve; }); },
            cancel: async () => { calls.push('flush'); finishRead?.({ done: true }); }, releaseLock() {}
        }) } };
    const source = fs.readFileSync(require.resolve('../serialEngine.js'), 'utf8');
    const Engine = vm.runInNewContext(`${source}\nSerialEngine`, { navigator: { serial: {} } });
    const engine = new Engine(), opened = engine.connect({}, port);
    engine.setCaptureVisible(false);
    engine.setCaptureVisible(true);
    finishOpen();
    await opened;
    await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(calls, ['flush', 'read']);
    await engine.disconnect();
});

test('dispose closes a port opened after cancellation and removes the serial listener', async () => {
    let opened, closed = 0, removed;
    const serial = { requestPort: async () => ({
        open: () => new Promise(resolve => { opened = resolve; }), close: async () => { closed++; }
    }), addEventListener() {}, removeEventListener(name, handler) { removed = { name, handler }; } };
    const source = fs.readFileSync(require.resolve('../serialEngine.js'), 'utf8');
    const SerialEngine = vm.runInNewContext(`${source}\nSerialEngine`, { navigator: { serial } });
    const engine = new SerialEngine(), connection = engine.connect({});
    for (let i = 0; i < 10 && !opened; i++) await Promise.resolve();
    assert.equal(typeof opened, 'function');
    await engine.dispose();
    opened();
    await assert.rejects(connection, { name: 'AbortError' });
    assert.equal(closed, 1);
    assert.equal(engine.port, null);
    assert.equal(engine._connected, false);
    assert.equal(removed.name, 'disconnect');
    assert.equal(removed.handler, engine._onSerialDisconnect);
});

test('disconnect before any connection does not prevent a later connection from closing', async () => {
    let closed = 0;
    const source = fs.readFileSync(require.resolve('../serialEngine.js'), 'utf8');
    const SerialEngine = vm.runInNewContext(`${source}\nSerialEngine`, { navigator: { serial: {
        requestPort: async () => ({ open: async () => {}, close: async () => { closed++; } }), addEventListener() {}
    } } });
    const engine = new SerialEngine();
    await engine.disconnect();
    await engine.connect({});
    await engine.disconnect();
    assert.equal(closed, 1);
    assert.equal(engine.port, null);
});

test('independent connections isolate bytes and disconnect events and reject a duplicate physical port', async () => {
    const source = fs.readFileSync(require.resolve('../serialEngine.js'), 'utf8');
    function createPort() {
        let finishRead;
        const port = {
            options: null, closed: 0,
            open: async options => { port.options = options; },
            close: async () => { port.closed++; },
            readable: { getReader() {
                let currentRead;
                return {
                    read: () => new Promise(resolve => { finishRead = currentRead = resolve; }),
                    releaseLock() {}, cancel: async () => { currentRead?.({ done: true }); }
                };
            } },
            receive: byte => finishRead({ value: Uint8Array.of(byte), done: false })
        };
        return port;
    }
    const a = createPort(), b = createPort(), requests = [a, a, b];
    const handlers = new Set();
    const serial = { requestPort: async () => requests.shift(),
        addEventListener: (_type, callback) => handlers.add(callback),
        removeEventListener: (_type, callback) => handlers.delete(callback) };
    const Engine = vm.runInNewContext(`${source}\nSerialEngine`, {
        navigator: { serial }, performance: { now: () => 10.25 }
    });
    const first = new Engine(), second = new Engine(), received = [[], []];
    try {
        first.onData((bytes, stamp) => received[0].push([bytes[0], stamp?.arrival]));
        second.onData((bytes, stamp) => received[1].push([bytes[0], stamp?.arrival]));
        await first.connect({ baudRate: 2_000_000 });
        await assert.rejects(second.connect({}), /串口已被另一数据来源打开/);
        await second.connect({ baudRate: 115200 });
        a.receive(11); b.receive(22);
        await new Promise(resolve => setImmediate(resolve));
        for (const callback of handlers) callback({ target: a });
        await new Promise(resolve => setImmediate(resolve));
        assert.equal(first.port, null);
        assert.equal(second.port, b);
        b.receive(33);
        await new Promise(resolve => setImmediate(resolve));
        assert.deepEqual(received, [[[11, 10.25]], [[22, 10.25], [33, 10.25]]]);
        assert.equal(a.options.baudRate, 2_000_000);
        assert.equal(b.options.baudRate, 115200);
        assert.equal(a.closed, 1);
        assert.equal(b.closed, 0);
    } finally { await Promise.all([first.dispose(), second.dispose()]); }
    assert.equal(handlers.size, 0);
});
