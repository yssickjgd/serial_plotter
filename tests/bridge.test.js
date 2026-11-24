const test = require('node:test');
const assert = require('node:assert/strict');
const { once } = require('node:events');
const net = require('node:net');
const dgram = require('node:dgram');
const WebSocket = require('ws');
const { createBridge } = require('../bridge');

function message(ws) { return once(ws, 'message').then(([data, binary]) => ({ data, binary })); }

test('bridge forwards binary bytes to and from a TCP server', async () => {
    const tcp = net.createServer(socket => socket.on('data', data => socket.write(data)));
    tcp.listen(0, '127.0.0.1');
    await once(tcp, 'listening');
    const bridge = createBridge({ port: 0 });
    await once(bridge, 'listening');
    const ws = new WebSocket(`ws://127.0.0.1:${bridge.address().port}`);
    try {
        await once(ws, 'open');
        ws.send(JSON.stringify({ cmd: 'connect', mode: 'tcp-client', host: '127.0.0.1', port: tcp.address().port }));
        assert.equal(JSON.parse((await message(ws)).data).event, 'connected');
        ws.send(Buffer.from([0, 128, 255]));
        const reply = await message(ws);
        assert.equal(reply.binary, true);
        assert.deepEqual([...reply.data], [0, 128, 255]);
    } finally {
        ws.close();
        bridge.close();
        tcp.close();
    }
});

test('bridge forwards binary UDP datagrams', async () => {
    const udp = dgram.createSocket('udp4');
    udp.on('message', (data, remote) => udp.send(data, remote.port, remote.address));
    udp.bind(0, '127.0.0.1');
    await once(udp, 'listening');
    const bridge = createBridge({ port: 0 });
    await once(bridge, 'listening');
    const ws = new WebSocket(`ws://127.0.0.1:${bridge.address().port}`);
    try {
        await once(ws, 'open');
        ws.send(JSON.stringify({ cmd: 'connect', mode: 'udp', host: '127.0.0.1', port: udp.address().port, localPort: 0 }));
        assert.equal(JSON.parse((await message(ws)).data).event, 'listening');
        ws.send(Buffer.from([1, 2, 255]));
        assert.deepEqual([...(await message(ws)).data], [1, 2, 255]);
    } finally {
        ws.close();
        bridge.close();
        udp.close();
    }
});

test('TCP server mode accepts a device and forwards bytes in both directions', async () => {
    const reservation = net.createServer();
    reservation.listen(0, '127.0.0.1');
    await once(reservation, 'listening');
    const localPort = reservation.address().port;
    await new Promise(resolve => reservation.close(resolve));
    const bridge = createBridge({ port: 0 });
    await once(bridge, 'listening');
    const ws = new WebSocket(`ws://127.0.0.1:${bridge.address().port}`);
    let device;
    try {
        await once(ws, 'open');
        ws.send(JSON.stringify({ cmd: 'connect', mode: 'tcp-server', port: localPort, localPort }));
        assert.equal(JSON.parse((await message(ws)).data).event, 'listening');
        device = net.createConnection({ host: '127.0.0.1', port: localPort });
        await once(device, 'connect');
        assert.equal(JSON.parse((await message(ws)).data).event, 'connected');
        device.write(Buffer.from([7, 8]));
        assert.deepEqual([...(await message(ws)).data], [7, 8]);
        ws.send(Buffer.from([9, 10]));
        assert.deepEqual([...(await once(device, 'data'))[0]], [9, 10]);
    } finally {
        if (device) device.destroy();
        ws.close();
        bridge.close();
    }
});

test('one authenticated Bridge serves two serial ports and resumes a detached subscriber', { timeout: 5000 }, async t => {
    const { EventEmitter } = require('node:events');
    const ports = new Map();
    class MockSerial extends EventEmitter {
        static async list() { return [{ path: 'COM3', serialNumber: 'a' }, { path: 'COM518', serialNumber: 'b' }]; }
        constructor(options) { super(); this.options = options; this.writes = []; ports.set(options.path, this); }
        open(done) { this.isOpen = true; done(); }
        close(done) { this.isOpen = false; this.emit('close'); done(); }
        write(data, done) { this.writes.push(Buffer.from(data)); done(); }
        drain(done) { done(); }
    }
    const bridge = createBridge({ port: 0, serialDriver: MockSerial, serialToken: 'test-token' });
    await once(bridge, 'listening');
    const clients = new Set();
    t.after(() => { for (const ws of clients) ws.terminate(); bridge.close(); });
    async function subscribe() {
        const ws = new WebSocket('ws://127.0.0.1:' + bridge.address().port + '/serial');
        clients.add(ws);
        let hello;
        try { hello = JSON.parse((await message(ws)).data); }
        catch (error) { throw new Error('serial Bridge did not announce capability', { cause: error }); }
        assert.equal(hello.serial, true);
        return ws;
    }
    function command(ws, data) {
        const waiting = message(ws).then(result => JSON.parse(result.data));
        ws.send(JSON.stringify(data));
        return waiting;
    }
    const first = await subscribe(), second = await subscribe();
    assert.equal((await command(first, { cmd: 'list', token: 'bad' })).event, 'error');
    const token = 'test-token';
    const catalog = await command(first, { cmd: 'list', token });
    assert.deepEqual(catalog.ports.map(port => port.path), ['COM3', 'COM518']);
    const open = (ws, port, cursor = undefined) => command(ws, { cmd: 'connect', token, ...port, cursor,
        settings: { baudRate: 1250000, dataBits: 8, stopBits: 1, parity: 'none' } });
    const [one, two] = await Promise.all([open(first, catalog.ports[0]), open(second, catalog.ports[1])]);
    assert.equal(one.event, 'connected'); assert.equal(two.event, 'connected');
    const waiting = [message(first), message(second)];
    ports.get('COM3').emit('data', Buffer.from([3]));
    ports.get('COM518').emit('data', Buffer.from([5, 18]));
    const frames = await Promise.all(waiting);
    assert.deepEqual(frames.map(value => [...value.data.subarray(16)]), [[3], [5, 18]]);
    const tx = Buffer.alloc(5); tx.writeUInt32LE(7); tx[4] = 42;
    const sent = message(second); second.send(tx);
    assert.equal(JSON.parse((await sent).data).id, 7);
    assert.deepEqual([...ports.get('COM518').writes[0]], [42]);
    assert.equal(ports.get('COM3').writes.length, 0);

    const closed = once(first, 'close'); first.close(); await closed;
    assert.equal(ports.get('COM3').isOpen, true);
    ports.get('COM3').emit('data', Buffer.from([99]));
    const resumed = await subscribe();
    const framesAfterAttach = [];
    resumed.on('message', (data, binary) => { if (binary) framesAfterAttach.push([...data.subarray(16)]); });
    const result = await open(resumed, catalog.ports[0], { session: one.session, offset: 1 });
    assert.equal(result.start, 1);
    if (!framesAfterAttach.length) await message(resumed);
    assert.deepEqual(framesAfterAttach, [[99]]);
    assert.equal((await command(resumed, { cmd: 'disconnect' })).event, 'disconnected');
    assert.equal(ports.get('COM3').isOpen, false);
    assert.equal(ports.get('COM518').isOpen, true);

    const { BridgeSerialEngine } = require('../bridgeSerialEngine');
    class BrowserClient extends BridgeSerialEngine {
        static url = 'ws://127.0.0.1:' + bridge.address().port + '/serial';
    }
    assert.deepEqual(await BrowserClient.probe(), { serial: true });
    assert.deepEqual(await BrowserClient.ports(token), catalog.ports);
    const client = new BrowserClient();
    t.after(() => client.dispose());
    await client.connect({ baudRate: 1250000, dataBits: 8, stopBits: 1, parity: 'none' }, catalog.ports[0], token);
    const rx = new Promise(resolve => client.onData((bytes, stamp) => resolve({ bytes: [...bytes], stamp })));
    ports.get('COM3').emit('data', Buffer.from([41, 42]));
    const delivered = await rx;
    assert.deepEqual(delivered.bytes, [41, 42]);
    assert.ok(Math.abs(Date.now() - delivered.stamp.timestamp) < 2000);
    await client.send(Uint8Array.of(43));
    assert.deepEqual([...ports.get('COM3').writes[0]], [43]);
    await client.disconnect();
    assert.equal(ports.get('COM3').isOpen, false);
    assert.equal(ports.get('COM518').isOpen, true);
});


test('foreground-only Bridge serial resumes at the live offset while other subscribers and TX continue', { timeout: 5000 }, async t => {
    const { EventEmitter } = require('node:events');
    const { BridgeSerialEngine } = require('../bridgeSerialEngine');
    let device;
    class MockSerial extends EventEmitter {
        static async list() { return [{ path: 'COM3' }]; }
        constructor() { super(); device = this; }
        open(done) { this.isOpen = true; done(); }
        close(done) { this.isOpen = false; this.emit('close'); done(); }
        write(_bytes, done) { done(); }
        drain(done) { done(); }
    }
    const token = 'visibility-test';
    const bridge = createBridge({ port: 0, serialDriver: MockSerial, serialToken: token });
    await once(bridge, 'listening');
    class Client extends BridgeSerialEngine {
        static url = 'ws://127.0.0.1:' + bridge.address().port + '/serial';
    }
    const client = new Client(), observer = new Client();
    t.after(async () => { client.dispose(); observer.dispose(); await bridge.stop(); });
    const settings = { baudRate: 1250000, dataBits: 8, stopBits: 1, parity: 'none' };
    const [port] = await Client.ports(token);
    const received = [], observed = [];
    client.onData(bytes => received.push(...bytes));
    observer.onData(bytes => observed.push(...bytes));
    await client.connect(settings, port, token);
    await observer.connect(settings, port, token);
    const fence = engine => engine.send(Uint8Array.of(42));
    device.emit('data', Buffer.from([1]));
    await fence(client);
    device.emit('data', Buffer.from([2])); // Already en route when the tab hides.
    client.setCaptureVisible(false);
    await fence(client);
    let hiddenPackets = 0;
    client.socket.addEventListener('message', ({ data }) => { if (typeof data !== 'string') hiddenPackets++; });
    device.emit('data', Buffer.from([3]));
    await fence(client);
    assert.equal(hiddenPackets, 0);
    client.setCaptureVisible(true);
    client.setCaptureVisible(false);
    client.setCaptureVisible(true);
    await fence(client);
    device.emit('data', Buffer.from([4]));
    await fence(client);
    assert.deepEqual(received, [1, 4]);

    client.setCaptureVisible(false);
    await fence(client);
    const detached = once(client.socket, 'close');
    client.dispose();
    await detached;
    device.emit('data', Buffer.from([5]));
    client.setCaptureVisible(true);
    await client.connect(settings, port, token);
    device.emit('data', Buffer.from([6]));
    await Promise.all([fence(client), fence(observer)]);
    assert.deepEqual(received, [1, 4, 6]);
    assert.deepEqual(observed, [1, 2, 3, 4, 5, 6]);

    // Simulate a short return whose cancellation is delayed in transport.
    let delayedCancel;
    const send = client.socket.send.bind(client.socket);
    client.socket.send = data => {
        if (typeof data === 'string' && JSON.parse(data).cmd === 'capture-grace' && JSON.parse(data).graceMs === null)
            delayedCancel = data;
        else send(data);
    };
    let packets = 0;
    client.socket.addEventListener('message', ({ data }) => { if (typeof data !== 'string') packets++; });
    client.setCaptureGrace(100);
    client.setCaptureGrace(null);
    await fence(client);
    await new Promise(resolve => setTimeout(resolve, 120));
    device.emit('data', Buffer.from([7]));
    await fence(client);
    assert.equal(packets, 0, 'Bridge must stop forwarding even while the page does no visibility work');
    send(delayedCancel);
    await fence(client);
    assert.deepEqual(received, [1, 4, 6, 7], 'late cancellation replays only the missed suffix');
    client.socket.send = send;

    client.setCaptureGrace(0);
    await fence(client);
    device.emit('data', Buffer.from([8]));
    await fence(client);
    client.setCaptureVisible(false);
    client.setCaptureVisible(true);
    client.setCaptureGrace(null);
    await fence(client);
    device.emit('data', Buffer.from([9]));
    await fence(client);
    assert.deepEqual(received, [1, 4, 6, 7, 9], 'a long return skips all hidden data');

    const detachedAgain = once(client.socket, 'close');
    client.dispose();
    await detachedAgain;
    client.setCaptureGrace(0);
    await client.connect(settings, port, token);
    device.emit('data', Buffer.from([10]));
    await fence(client);
    assert.deepEqual(received, [1, 4, 6, 7, 9], 'opening during an expired grace also suppresses live packets');
});


test('a new launcher replaces the matching Bridge and lets the old process exit normally', { timeout: 12000 }, async t => {
    const { spawn } = require('node:child_process');
    const { mkdtemp, unlink, rmdir } = require('node:fs/promises');
    const { join, resolve } = require('node:path');
    const { tmpdir } = require('node:os');
    const directory = await mkdtemp(join(tmpdir(), 'serial-bridge-test-'));
    const replacementPath = join(directory, 'replace.key');
    t.after(async () => { await unlink(replacementPath).catch(() => {}); await rmdir(directory); });

    const reservation = net.createServer();
    reservation.listen(0, '127.0.0.1');
    await once(reservation, 'listening');
    const port = reservation.address().port;
    await new Promise(resolve => reservation.close(resolve));

    function launch(replace) {
        const options = JSON.stringify({ port, replacementPath, replace });
        const script = 'const { startBridge } = require("./bridgeProcess");' +
            'const { createBridge } = require("./bridge");' +
            'startBridge(createBridge, ' + options + ').catch(error => { console.error(error.message); process.exitCode = 1; });';
        const child = spawn(process.execPath, ['-e', script], { cwd: resolve(__dirname, '..'),
            windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
        const done = once(child, 'exit');
        t.after(async () => { if (child.exitCode === null && child.signalCode === null) child.kill(); await done; });
        const ready = new Promise((resolve, reject) => {
            let output = '', stderr = '';
            child.stderr.on('data', data => { stderr += data; });
            child.stdout.on('data', data => {
                output += data;
                if (output.includes('Bridge 已启动')) resolve(output);
            });
            child.once('error', reject);
            child.once('exit', code => reject(new Error('Bridge exited before startup (' + code + '): ' + stderr)));
        });
        return { done, ready };
    }

    const old = launch(false);
    await old.ready;
    const unauthorized = new WebSocket('ws://127.0.0.1:' + port + '/_bridge/replace', {
        headers: { 'x-bridge-replacement-key': 'unrelated' }, origin: 'https://example.test'
    });
    assert.equal((await once(unauthorized, 'close'))[0], 1008);
    const connectedClient = new WebSocket('ws://127.0.0.1:' + port + '/serial');
    await once(connectedClient, 'open');
    const detached = once(connectedClient, 'close');
    const replacement = launch(true);
    await replacement.ready;
    await detached;
    assert.deepEqual(await old.done, [0, null]);
});


test('the latest correctly authorized page alone owns Bridge serial and network connections', { timeout: 5000 }, async t => {
    const { EventEmitter } = require('node:events');
    let device;
    class MockSerial extends EventEmitter {
        static async list() { return [{ path: 'COM3' }]; }
        constructor() { super(); device = this; }
        open(done) { this.isOpen = true; done(); }
        close(done) { this.isOpen = false; this.emit('close'); done(); }
    }
    const token = 'test-workspace-code';
    const bridge = createBridge({ port: 0, serialDriver: MockSerial, serialToken: token, exclusiveWorkspace: true });
    await once(bridge, 'listening');
    const url = 'ws://127.0.0.1:' + bridge.address().port;
    const sockets = [];
    t.after(async () => { for (const socket of sockets) socket.terminate(); await bridge.stop(); });
    function client(path) {
        const ws = new WebSocket(url + path); sockets.push(ws); return ws;
    }
    function command(socket, request) {
        const response = message(socket).then(data => JSON.parse(data.data));
        socket.send(JSON.stringify(request));
        return response;
    }
    async function startControl() {
        const socket = client('/_bridge/workspace');
        await once(socket, 'open'); return socket;
    }
    const old = await startControl();
    const first = await command(old, { token });
    assert.equal(first.event, 'claimed');
    const serial = client('/serial');
    const hello = JSON.parse((await message(serial)).data);
    assert.equal(hello.exclusive, true);
    const port = (await command(serial, { cmd: 'list', token })).ports[0];
    const settings = { baudRate: 115200, dataBits: 8, stopBits: 1, parity: 'none' };
    const opened = await command(serial, { cmd: 'connect', token, ...port, settings, workspace: first.key });
    assert.equal(opened.event, 'connected');
    const network = client('/?workspace=' + first.key);
    await once(network, 'open');
    assert.equal((await command(network, { cmd: 'connect', mode: 'udp', host: '127.0.0.1', port: 1234, localPort: 0 })).event, 'listening');

    const newer = await startControl();
    assert.equal((await command(newer, { token: 'wrong' })).code, 'invalid-access-code');
    assert.equal(device.isOpen, true);
    assert.equal(serial.readyState, WebSocket.OPEN);
    const lost = message(old).then(data => JSON.parse(data.data));
    const detached = Promise.all([once(serial, 'close'), once(network, 'close')]);
    const second = await command(newer, { token });
    assert.equal(second.event, 'claimed');
    assert.equal((await lost).event, 'superseded');
    await detached;
    assert.equal(device.isOpen, true);
    device.emit('data', Buffer.from([42]));

    const rejected = client('/serial');
    await message(rejected);
    assert.equal((await command(rejected, { cmd: 'connect', token, ...port, settings, workspace: first.key })).event, 'error');
    const resumed = client('/serial');
    await message(resumed);
    const data = [];
    resumed.on('message', (bytes, binary) => { if (binary) data.push(bytes[16]); });
    assert.equal((await command(resumed, { cmd: 'connect', token, ...port, settings, workspace: second.key })).session, opened.session);
    if (!data.length) await message(resumed);
    assert.deepEqual(data, [42]);
});
