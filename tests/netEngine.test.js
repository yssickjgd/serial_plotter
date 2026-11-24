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

test('background network RX resumes after its latest ordered Bridge acknowledgement', async () => {
    const { engine, FakeSocket } = makeEngine(), received = [];
    const connect = () => engine.connect({ mode: 'udp', host: '127.0.0.1', port: 9000 });
    const status = (ws, data) => ws.onmessage({ data: JSON.stringify(data) });
    const rx = (ws, n) => ws.onmessage({ data: Uint8Array.of(n).buffer });
    engine.onData(bytes => received.push(...bytes));
    engine.setCaptureVisible(false);
    const pending = connect(), ws = FakeSocket.latest;
    ws.onopen();
    assert.equal(JSON.parse(ws.sent[0]).captureVisible, false);
    status(ws, { event: 'listening', captureVisibility: true });
    await pending;
    rx(ws, 1);
    await engine.send(Uint8Array.of(10));
    assert.deepEqual([...ws.sent.at(-1)], [10]);
    engine.setCaptureVisible(true);
    const first = JSON.parse(ws.sent.at(-1));
    engine.setCaptureVisible(false);
    engine.setCaptureVisible(true);
    const latest = JSON.parse(ws.sent.at(-1));
    assert.ok(first.revision < latest.revision);
    status(ws, { event: 'capture-visibility', revision: first.revision });
    rx(ws, 2);
    status(ws, { event: 'capture-visibility', revision: latest.revision });
    rx(ws, 3);
    assert.deepEqual(received, [3]);
    await engine.disconnect();
});

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

test('the network Bridge receives only the remaining grace when opened during the hidden interval', async () => {
    let now = 2000;
    const { engine, FakeSocket } = makeEngine({ setTimeout, clearTimeout, performance: { now: () => now } });
    engine.setCaptureGrace(5000);
    const pending = engine.connect({ mode: 'udp', host: '127.0.0.1', port: 9000 });
    const ws = FakeSocket.latest;
    now += 1500;
    ws.onopen();
    assert.equal(JSON.parse(ws.sent[0]).captureGraceMs, 3500);
    engine.setCaptureGrace(null); // became visible before network listening confirmation
    ws.onmessage({ data: JSON.stringify({ event: 'listening', captureVisibility: true, captureGrace: true }) });
    await pending;
    assert.deepEqual(JSON.parse(ws.sent.at(-1)), { cmd: 'capture-grace', graceMs: null });
    engine.setCaptureGrace(5000);
    assert.deepEqual(JSON.parse(ws.sent.at(-1)), { cmd: 'capture-grace', graceMs: 5000 });
    await engine.disconnect();
});

test('an older network Bridge can still connect but foreground-only RX fails with an actionable message', async () => {
    const { engine, FakeSocket } = makeEngine(), states = [];
    engine.onStatusChange((connected, error) => states.push([connected, error?.message]));
    const pending = engine.connect({ mode: 'tcp-client', host: '127.0.0.1', port: 9000 });
    const ws = FakeSocket.latest;
    ws.onopen();
    ws.onmessage({ data: JSON.stringify({ event: 'connected' }) }); // no feature advertised
    await pending;
    await engine.send(Uint8Array.of(1));
    engine.setCaptureVisible(false);
    assert.equal(engine.ws, null);
    assert.equal(states.at(-1)[0], false);
    assert.match(states.at(-1)[1], /启动.*新版 Bridge/);
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

test('network Bridge pauses forwarding through the foreground boundary while preserving TCP TX', { timeout: 5000 }, async t => {
    const { once } = require('node:events');
    const tcp = require('node:net').createServer();
    const WebSocket = require('ws');
    const bridge = require('../bridge').createBridge({ port: 0, serialDriver: null });
    tcp.listen(0, '127.0.0.1');
    const peer = once(tcp, 'connection');
    t.after(async () => { tcp.close(); await bridge.stop(); });
    await Promise.all([once(tcp, 'listening'), once(bridge, 'listening')]);
    const ws = new WebSocket('ws://127.0.0.1:' + bridge.address().port);
    await once(ws, 'open');
    function command(request) {
        const response = once(ws, 'message').then(([data]) => JSON.parse(data));
        ws.send(JSON.stringify(request));
        return response;
    }
    const connected = await command({ cmd: 'connect', mode: 'tcp-client', host: '127.0.0.1', port: tcp.address().port });
    assert.equal(connected.captureVisibility, true);
    assert.equal(connected.captureGrace, true);
    const [socket] = await peer;
    t.after(() => socket.destroy());
    const rx = [];
    ws.on('message', (data, binary) => { if (binary) rx.push(...data); });
    assert.equal((await command({ cmd: 'capture-visibility', visible: false, revision: 1 })).revision, 1);
    const written = once(socket, 'data');
    ws.send(Buffer.from([3]));
    assert.deepEqual([...(await written)[0]], [3]);
    socket.write(Buffer.from([7]));
    // The peer's FIN is observed after its data event; use it to test this interval without a timing delay.
    const closed = once(ws, 'message');
    socket.end();
    assert.equal(JSON.parse((await closed)[0]).event, 'disconnected');
    assert.deepEqual(rx, []);
});

test('network Bridge stops forwarding on its own deadline and a late short-return cancellation resumes RX', { timeout: 5000 }, async t => {
    const { once } = require('node:events');
    const tcp = require('node:net').createServer();
    const WebSocket = require('ws');
    const bridge = require('../bridge').createBridge({ port: 0, serialDriver: null });
    tcp.listen(0, '127.0.0.1');
    const peer = once(tcp, 'connection');
    t.after(async () => { tcp.close(); await bridge.stop(); });
    await Promise.all([once(tcp, 'listening'), once(bridge, 'listening')]);
    const ws = new WebSocket('ws://127.0.0.1:' + bridge.address().port);
    await once(ws, 'open');
    const message = () => once(ws, 'message').then(([bytes, binary]) => binary ? [...bytes] : JSON.parse(bytes));
    const connected = message();
    ws.send(JSON.stringify({ cmd: 'connect', mode: 'tcp-client', host: '127.0.0.1', port: tcp.address().port, captureGraceMs: 10 }));
    await connected;
    const [socket] = await peer;
    t.after(() => socket.destroy());
    // No visibility command from the page during the entire interval.
    await new Promise(resolve => setTimeout(resolve, 30));
    const afterGrace = message();
    socket.write(Buffer.from([1]));
    await new Promise(resolve => setTimeout(resolve, 25));
    ws.send(JSON.stringify({ cmd: 'capture-grace', graceMs: null }));
    ws.send(Buffer.from([3]));
    assert.deepEqual([...(await once(socket, 'data'))[0]], [3]);
    socket.write(Buffer.from([2]));
    assert.deepEqual(await afterGrace, [2]);
});
