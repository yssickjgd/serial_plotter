class NetEngine {
    constructor() {
        this.ws = null;
        this.onDataCallback = null;
        this.onConnectStatusChange = null;
        this.keepReading = false;
    }

    onData(callback) { this.onDataCallback = callback; }
    onStatusChange(callback) { this.onConnectStatusChange = callback; }

    async connect(config) {
        return new Promise((resolve, reject) => {
            try {
                this.ws = new WebSocket('ws://127.0.0.1:8081');
                this.ws.binaryType = 'arraybuffer';
            } catch (e) {
                reject(new Error('无法连接到本地 Bridge，请确认已运行 node bridge.js'));
                return;
            }
            this.ws.onopen = () => {
                const cmd = Object.assign({ cmd: 'connect' }, config);
                this.ws.send(JSON.stringify(cmd));
            };
            this.ws.onmessage = (event) => {
                if (typeof event.data === 'string') {
                    const res = JSON.parse(event.data);
                    if (res.event === 'error') {
                        console.error('网络引擎错误:', res.msg);
                        this.disconnect();
                    } else if (res.event === 'connected' || res.event === 'listening') {
                        this.keepReading = true;
                        if (this.onConnectStatusChange) this.onConnectStatusChange(true);
                        resolve(true);
                    } else if (res.event === 'disconnected') {
                        this.disconnect();
                    }
                } else {
                    if (this.onDataCallback && this.keepReading)
                        this.onDataCallback(new Uint8Array(event.data));
                }
            };
            this.ws.onerror = () => reject(new Error('Bridge WebSocket 连接意外丢失'));
            this.ws.onclose = () => { this.disconnect(); };
        });
    }

    async disconnect() {
        this.keepReading = false;
        try {
            if (this.ws && this.ws.readyState === WebSocket.OPEN) {
                try { this.ws.send(JSON.stringify({ cmd: 'disconnect' })); } catch (_) {}
                try { this.ws.close(); } catch (_) {}
            }
        } finally {
            this.ws = null;
            if (this.onConnectStatusChange) this.onConnectStatusChange(false);
        }
    }

    async forceDisconnect() {
        return this.disconnect();
    }

    async send(data) {
        if (!this.ws || this.ws.readyState !== WebSocket.OPEN) throw new Error('网络未连接，无法发送');
        // Wrap as binary command for bridge
        this.ws.send(JSON.stringify({ cmd: 'send', data: Array.from(data) }));
    }
}
