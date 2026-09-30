const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

function makeEngine(timers = { setTimeout, clearTimeout }) {
    class FakeSocket {
        static OPEN = 1;
        constructor() { this.readyState = 1; this.sent = []; FakeSocket.latest = this; }
        send(data) { this.sent.push(data); }
        close() { this.readyState = 3; if (this.onclose) this.onclose(); }
    }
    const source = fs.readFileSync(require.resolve('../netEngine.js'), 'utf8');
    const NetEngine = vm.runInNewContext(`${source}\nNetEngine`, {
        WebSocket: FakeSocket, console: { error() {} }, ...timers, Uint8Array, ArrayBuffer
    });
    return { engine: new NetEngine(), FakeSocket };
}

test('sends raw binary frames after bridge confirms connection', async () => {
    const { engine, FakeSocket } = makeEngine();
    const pending = engine.connect({ mode: 'tcp-client', host: '127.0.0.1', port: 9000 });
    const ws = FakeSocket.latest;
    ws.onopen();
    ws.onmessage({ data: JSON.stringify({ event: 'connected' }) });
    await pending;
    await engine.send(Uint8Array.of(0, 128, 255));
    assert.deepEqual([...ws.sent.at(-1)], [0, 128, 255]);
});

test('connection timeout settles the pending request and closes the socket', async () => {
    let timeout;
    const { engine } = makeEngine({ setTimeout: callback => { timeout = callback; return 1; }, clearTimeout() {} });
    const pending = engine.connect({ mode: 'tcp-client', host: '127.0.0.1', port: 9000 });
    timeout();
    await assert.rejects(pending, /超时/);
    assert.equal(engine.ws, null);
});

test('rejects a bridge error before connection and permits a later retry', async () => {
    const { engine, FakeSocket } = makeEngine();
    const pending = engine.connect({ mode: 'tcp-client', host: 'bad', port: 9000 });
    FakeSocket.latest.onmessage({ data: JSON.stringify({ event: 'error', msg: 'refused' }) });
    await assert.rejects(pending, /refused/);
    assert.equal(engine.ws, null);
    const retry = engine.connect({ mode: 'udp', host: '127.0.0.1', port: 9001 });
    FakeSocket.latest.onmessage({ data: JSON.stringify({ event: 'listening' }) });
    await retry;
});

test('reports a bridge failure after connection to the UI status callback', async () => {
    const { engine, FakeSocket } = makeEngine();
    const reasons = [];
    engine.onStatusChange((connected, error) => {
        if (!connected && error) reasons.push(error.message);
    });
    const pending = engine.connect({ mode: 'tcp-client', host: '127.0.0.1', port: 9000 });
    FakeSocket.latest.onmessage({ data: JSON.stringify({ event: 'connected' }) });
    await pending;
    FakeSocket.latest.onmessage({ data: JSON.stringify({ event: 'error', msg: 'device reset' }) });
    assert.deepEqual(reasons, ['device reset']);
});
