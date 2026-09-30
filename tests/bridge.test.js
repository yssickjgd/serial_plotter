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
