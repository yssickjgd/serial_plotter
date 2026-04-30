const WebSocket = require('ws');
const net = require('net');
const dgram = require('dgram');

const PORT = 8080;
const wss = new WebSocket.Server({ port: PORT }, () => {
    console.log(`===============================================`);
    console.log(`[Bridge 服务已启动]`);
    console.log(`请确保本页面正在运行，Web前端现可通过 ws://localhost:${PORT} 访问本地 TCP/UDP`);
    console.log(`===============================================`);
});

wss.on('connection', (ws) => {
    let mode = null; // 'tcp-client', 'tcp-server', 'udp'
    let socket = null;
    let tcpServer = null;
    let udpRemoteHost = null;
    let udpRemotePort = null;

    console.log("[WS] 网页端已连接至 Bridge");

    const cleanup = () => {
        if (socket && !socket.destroyed) socket.destroy && socket.destroy();
        if (socket && socket.close) socket.close();
        if (tcpServer) tcpServer.close();
        socket = null;
        tcpServer = null;
    };

    ws.on('message', (message, isBinary) => {
        if (!isBinary) {
            try {
                const config = JSON.parse(message.toString());
                if (config.cmd === 'connect') {
                    cleanup();
                    mode = config.mode;
                    console.log(`[WS] 收到建立 ${mode} 请求`, config);

                    if (mode === 'tcp-client') {
                        socket = new net.Socket();
                        socket.connect(config.port, config.host, () => {
                            ws.send(JSON.stringify({ event: 'connected', msg: `连接至 TCP Server ${config.host}:${config.port} 成功` }));
                        });
                        socket.on('data', (data) => ws.send(data));
                        socket.on('error', (err) => ws.send(JSON.stringify({ event: 'error', msg: err.message })));
                        socket.on('close', () => ws.send(JSON.stringify({ event: 'disconnected' })));
                        
                    } else if (mode === 'tcp-server') {
                        tcpServer = net.createServer((sock) => {
                            console.log(`[TCP Server] 新客户端接入: ${sock.remoteAddress}:${sock.remotePort}`);
                            if (socket) socket.destroy(); // 极简实现：挤掉老连接，只保持一个最新连接收发
                            socket = sock;
                            socket.on('data', (data) => ws.send(data));
                            socket.on('error', (err) => console.log('TCP 客户端异常', err.message));
                            ws.send(JSON.stringify({ event: 'connected', msg: `客户端 ${sock.remoteAddress} 已连接` }));
                        });
                        tcpServer.listen(config.port, config.host || '0.0.0.0', () => {
                            ws.send(JSON.stringify({ event: 'listening', msg: `正在监听 TCP 端口 ${config.port}` }));
                        });
                        tcpServer.on('error', (err) => ws.send(JSON.stringify({ event: 'error', msg: err.message })));
                        
                    } else if (mode === 'udp') {
                        socket = dgram.createSocket('udp4');
                        socket.on('message', (msg, rinfo) => {
                            ws.send(msg); // 转发二进制给网页
                        });
                        socket.on('error', (err) => ws.send(JSON.stringify({ event: 'error', msg: err.message })));
                        
                        // 绑定本地监听端口
                        socket.bind(config.localPort || 0, () => {
                            const address = socket.address();
                            ws.send(JSON.stringify({ event: 'listening', msg: `UDP 绑定监听于端口 ${address.port}` }));
                        });
                        // 保存目标地址供发送使用
                        udpRemoteHost = config.host;
                        udpRemotePort = config.port;
                    }

                } else if (config.cmd === 'disconnect') {
                    console.log("[WS] 收到主动断开请求");
                    cleanup();
                    ws.send(JSON.stringify({ event: 'disconnected' }));
                }
            } catch (e) {
                console.error("解析控制指令失败", e.message);
            }
        } else {
            // 是二进制数组，直接经由下层协议发出
            if ((mode === 'tcp-client' || mode === 'tcp-server') && socket) {
                socket.write(message);
            } else if (mode === 'udp' && socket && udpRemoteHost && udpRemotePort) {
                socket.send(message, 0, message.length, udpRemotePort, udpRemoteHost);
            }
        }
    });

    ws.on('close', () => {
        console.log("[WS] 网页端断开，开始清理资源...");
        cleanup();
    });
});
