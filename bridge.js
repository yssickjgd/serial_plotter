const WebSocket = require('ws');
const net = require('net');
const dgram = require('dgram');
const { randomBytes } = require('node:crypto');
const { SerialBridge, serialDriver: loadSerialDriver } = require('./serialBridge');

function createBridge({ host = '127.0.0.1', port = 8081, serialDriver = loadSerialDriver(), serialToken,
    serialHistoryBytes, authorizeReplacement, exclusiveWorkspace = false } = {}) {
    const serial = new SerialBridge(serialDriver, serialToken, { historyBytes: serialHistoryBytes });
    const server = new WebSocket.Server({ host, port });
    let shutdown, serialShutdown, workspace;
    function attachWorkspaceConnection(ws, key) {
        if (!exclusiveWorkspace) return true;
        if (!workspace || workspace.key !== key || workspace.control.readyState !== WebSocket.OPEN) return false;
        const { connections } = workspace;
        connections.add(ws);
        ws.once('close', () => connections.delete(ws));
        return true;
    }
    function claimWorkspace(ws) {
        ws.on('error', () => ws.terminate());
        ws.on('message', (data, binary) => {
            if (shutdown || binary || ws.readyState !== WebSocket.OPEN || workspace?.control === ws) return;
            let token;
            try { token = JSON.parse(data)?.token; } catch { /* Treated as an invalid access code. */ }
            if (!serial.authorized(token)) {
                ws.send(JSON.stringify({ event: 'error', code: 'invalid-access-code', reason: 'Bridge 访问码无效' }));
                return;
            }
            const previous = workspace;
            const owner = { key: randomBytes(24).toString('hex'), control: ws, connections: new Set() };
            workspace = owner;
            ws.once('close', () => {
                if (workspace !== owner) return;
                workspace = null;
                for (const connection of owner.connections) connection.terminate();
            });
            if (previous) {
                if (previous.control.readyState === WebSocket.OPEN) {
                    previous.control.send(JSON.stringify({ event: 'superseded' }));
                    previous.control.close(4001, 'Workspace superseded');
                }
                for (const connection of previous.connections) connection.terminate();
            }
            ws.send(JSON.stringify({ event: 'claimed', key: owner.key }));
        });
    }
    const stopSerial = () => serialShutdown ??= serial.dispose();
    server.on('close', () => { void stopSerial(); });
    server.stop = () => shutdown ??= (async () => {
        for (const client of server.clients) client.terminate();
        await stopSerial();
        await new Promise(resolve => server.close(resolve));
    })();
    server.on('connection', (ws, request) => {
        if (shutdown) { ws.terminate(); return; }
        if (request.url === '/_bridge/replace') {
            const key = request.headers['x-bridge-replacement-key'];
            if (request.headers.origin !== undefined || !authorizeReplacement?.(key)) {
                ws.close(1008, 'Unauthorized');
                return;
            }
            ws.send(JSON.stringify({ event: 'replacing' }), error => {
                if (!error) void server.stop();
            });
            return;
        }
        const [path, query] = request.url.split('?', 2);
        if (path === '/_bridge/workspace' && exclusiveWorkspace) { claimWorkspace(ws); return; }
        if (path === '/serial') {
            serial.attach(ws, { exclusive: exclusiveWorkspace, authorizeConnection: key => attachWorkspaceConnection(ws, key) });
            return;
        }
        if (!attachWorkspaceConnection(ws, new URLSearchParams(query).get('workspace'))) {
            ws.send(JSON.stringify({ event: 'error', msg: '请先获得当前页面的 Bridge 使用权' }));
            ws.close(1008, 'Workspace required');
            return;
        }
        let mode = null;
        let socket = null;
        let tcpServer = null;
        let generation = 0;
        let remoteHost = null;
        let remotePort = null;
        let captureVisible = true;
        let graceTimer = null, graceExpired = false;
        const validGrace = ms => ms === null || Number.isSafeInteger(ms) && ms >= 0 && ms <= 2147483647;
        const setCaptureGrace = ms => {
            clearTimeout(graceTimer);
            graceTimer = null;
            graceExpired = ms === 0;
            if (ms > 0) {
                graceTimer = setTimeout(() => { graceExpired = true; graceTimer = null; }, ms);
                graceTimer.unref();
            }
        };
        const sendStatus = (event, msg) => {
            if (ws.readyState !== WebSocket.OPEN) return;
            const status = { event, msg };
            if (event === 'listening' || event === 'connected') {
                status.captureVisibility = true;
                status.captureGrace = true;
            }
            ws.send(JSON.stringify(status));
        };
        const sendBytes = data => {
            if (captureVisible && !graceExpired && ws.readyState === WebSocket.OPEN) ws.send(data, { binary: true });
        };
        const cleanup = () => {
            setCaptureGrace(null);
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
            if (ws.readyState !== WebSocket.OPEN) return;
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
            if (command.cmd === 'capture-grace' && validGrace(command.graceMs)) {
                setCaptureGrace(command.graceMs);
                return;
            }
            if (command.cmd === 'capture-visibility' && typeof command.visible === 'boolean' &&
                Number.isSafeInteger(command.revision)) {
                captureVisible = command.visible;
                setCaptureGrace(null);
                // WebSocket message order puts this boundary after all previously forwarded RX.
                ws.send(JSON.stringify({ event: 'capture-visibility', revision: command.revision }));
                return;
            }
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
            captureVisible = command.captureVisible !== false;
            if (validGrace(command.captureGraceMs)) setCaptureGrace(command.captureGraceMs);
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
    require('./bridgeProcess').startBridge(createBridge, {
        replace: process.argv.includes('--replace'), openPage: process.argv.includes('--open')
    }).catch(error => {
        console.error('[Bridge] ' + error.message);
        process.exitCode = 1;
    });
}

module.exports = { createBridge };
