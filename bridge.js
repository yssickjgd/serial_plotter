const WebSocket = require('ws');
const net = require('net');
const dgram = require('dgram');

function createBridge({ host = '127.0.0.1', port = 8081 } = {}) {
    const server = new WebSocket.Server({ host, port });
    server.on('connection', ws => {
        let mode = null;
        let socket = null;
        let tcpServer = null;
        let generation = 0;
        let remoteHost = null;
        let remotePort = null;
        const sendStatus = (event, msg) => {
            if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ event, msg }));
        };
        const sendBytes = data => {
            if (ws.readyState === WebSocket.OPEN) ws.send(data, { binary: true });
        };
        const cleanup = () => {
            generation++;
            const oldSocket = socket;
            socket = null;
            mode = null;
            if (oldSocket) {
                if (typeof oldSocket.destroy === 'function') oldSocket.destroy();
                else oldSocket.close();
            }
            if (tcpServer) { tcpServer.close(); tcpServer = null; }
        };
        const validPort = value => Number.isInteger(value) && value >= 1 && value <= 65535;
        ws.on('message', (message, isBinary) => {
            if (isBinary) {
                if (mode === 'tcp-client' || mode === 'tcp-server') {
                    if (socket && !socket.destroyed) socket.write(message);
                } else if (mode === 'udp' && socket && remoteHost && validPort(remotePort)) {
                    socket.send(message, remotePort, remoteHost);
                }
                return;
            }
            let command;
            try { command = JSON.parse(message.toString()); }
            catch (_) { sendStatus('error', '无效的控制消息'); return; }
            if (command.cmd === 'disconnect') { cleanup(); sendStatus('disconnected'); return; }
            if (command.cmd !== 'connect') { sendStatus('error', '未知控制命令'); return; }
            cleanup();
            const localPort = command.localPort == null ? command.port : command.localPort;
            if (!['tcp-client', 'tcp-server', 'udp'].includes(command.mode)
                || !validPort(command.port)
                || ((command.mode === 'udp' || command.mode === 'tcp-server')
                    && (!Number.isInteger(localPort) || localPort < 0 || localPort > 65535))
                || (command.mode !== 'tcp-server' && (typeof command.host !== 'string' || !command.host.trim()))) {
                sendStatus('error', '网络参数无效');
                return;
            }
            mode = command.mode;
            const current = generation;
            if (mode === 'tcp-client') {
                const tcp = net.createConnection({ host: command.host, port: command.port });
                socket = tcp;
                tcp.on('connect', () => { if (current === generation) sendStatus('connected'); });
                tcp.on('data', data => { if (current === generation) sendBytes(data); });
                tcp.on('error', error => { if (current === generation) sendStatus('error', error.message); });
                tcp.on('close', () => { if (current === generation) sendStatus('disconnected'); });
            } else if (mode === 'tcp-server') {
                tcpServer = net.createServer(client => {
                    if (current !== generation) { client.destroy(); return; }
                    if (socket) socket.destroy();
                    socket = client;
                    client.on('data', data => { if (current === generation) sendBytes(data); });
                    client.on('error', error => { if (current === generation) sendStatus('error', error.message); });
                    sendStatus('connected');
                });
                tcpServer.on('error', error => { if (current === generation) sendStatus('error', error.message); });
                tcpServer.listen(localPort, '0.0.0.0', () => {
                    if (current === generation) sendStatus('listening');
                });
            } else {
                const udp = dgram.createSocket('udp4');
                socket = udp;
                remoteHost = command.host;
                remotePort = command.port;
                udp.on('message', data => { if (current === generation) sendBytes(data); });
                udp.on('error', error => { if (current === generation) sendStatus('error', error.message); });
                udp.bind(localPort, () => { if (current === generation) sendStatus('listening'); });
            }
        });
        ws.on('close', cleanup);
    });
    return server;
}

if (require.main === module) {
    const server = createBridge();
    server.on('listening', () => console.log('Bridge 已启动: ws://127.0.0.1:8081'));
}

module.exports = { createBridge };
