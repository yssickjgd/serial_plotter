/* ═══════════════════════════════════════════════════════════════
 *  netEngine.js — WebSocket 网络通信适配器（通过 bridge.js 中转）
 *
 *  职责：通过本地 WebSocket 连接到 Node.js bridge 代理，
 *        由 bridge 完成实际的 TCP/UDP 收发，本模块仅负责
 *        指令下发（connect/disconnect/send）与数据上报。
 *
 *  代码结构：
 *    1. 构造函数（WebSocket 实例、回调、状态）
 *    2. 回调注册（onData、onStatusChange）
 *    3. 连接管理（connect、disconnect、forceDisconnect）
 *    4. 数据传输（send）
 * ═══════════════════════════════════════════════════════════════ */

class NetEngine {
    /** 初始化 WebSocket 实例指针、回调和读取状态 */
    constructor() {
        this.ws = null;
        this.onDataCallback = null;
        this.onConnectStatusChange = null;
        this.keepReading = false;
    }

    /* ── 回调注册 ── */

    /** 注册数据到达回调 callback(Uint8Array) */
    onData(callback) { this.onDataCallback = callback; }

    /** 注册连接状态变化回调 callback(connected: boolean) */
    onStatusChange(callback) { this.onConnectStatusChange = callback; }

    /* ── 连接管理 ── */

    /** 通过 WebSocket 连接到本地 bridge（ws://127.0.0.1:8081），发送 connect 指令 */
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

    /** 断开 WebSocket：发送 disconnect 指令 → 关闭连接 → 通知状态 */
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

    /** 强制断开（接口与 SerialEngine 保持一致，内部委托给 disconnect） */
    async forceDisconnect() {
        return this.disconnect();
    }

    /* ── 数据传输 ── */

    /** 通过 bridge 发送二进制数据（序列化为 JSON 数组经 WebSocket 传输） */
    async send(data) {
        if (!this.ws || this.ws.readyState !== WebSocket.OPEN) throw new Error('网络未连接，无法发送');
        this.ws.send(JSON.stringify({ cmd: 'send', data: Array.from(data) }));
    }
}
