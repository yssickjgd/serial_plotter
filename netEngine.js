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
        this._rejectPending = null;
        this._connected = false;
    }

    /* ── 回调注册 ── */

    /** 注册数据到达回调 callback(Uint8Array) */
    onData(callback) { this.onDataCallback = callback; }

    /** 注册连接状态变化回调 callback(connected: boolean, error?: Error) */
    onStatusChange(callback) { this.onConnectStatusChange = callback; }

    /* ── 连接管理 ── */

    /** 通过 WebSocket 连接到本地 bridge（ws://127.0.0.1:8081），发送 connect 指令 */
    async connect(config) {
        if (this.ws) await this.disconnect();
        return new Promise((resolve, reject) => {
            let settled = false;
            const finish = (error) => {
                if (settled) return;
                settled = true;
                clearTimeout(timer);
                this._rejectPending = null;
                if (error) reject(error); else resolve(true);
            };
            const timer = setTimeout(() => {
                finish(new Error('Bridge 连接超时'));
                void this.disconnect();
            }, 10000);
            this._rejectPending = (error) => finish(error);
            try {
                this.ws = new WebSocket('ws://127.0.0.1:8081');
                this.ws.binaryType = 'arraybuffer';
            } catch (e) {
                finish(new Error('无法连接到本地 Bridge，请确认已运行 node bridge.js'));
                return;
            }
            const ws = this.ws;
            ws.onopen = () => {
                if (this.ws !== ws) return;
                const cmd = Object.assign({ cmd: 'connect' }, config);
                ws.send(JSON.stringify(cmd));
            };
            ws.onmessage = (event) => {
                if (this.ws !== ws) return;
                if (typeof event.data === 'string') {
                    let res;
                    try { res = JSON.parse(event.data); }
                    catch (_) {
                        const error = new Error('Bridge 返回了无效状态消息');
                        finish(error);
                        void this.disconnect(error);
                        return;
                    }
                    if (res.event === 'error') {
                        const error = new Error(res.msg || '网络连接失败');
                        finish(error);
                        void this.disconnect(error);
                    } else if (res.event === 'connected' || res.event === 'listening') {
                        this.keepReading = true;
                        if (!this._connected) {
                            this._connected = true;
                            if (this.onConnectStatusChange) this.onConnectStatusChange(true);
                        }
                        finish();
                    } else if (res.event === 'disconnected') {
                        const error = new Error('Bridge 已断开');
                        finish(error);
                        void this.disconnect(error);
                    }
                } else {
                    if (this.onDataCallback && this.keepReading)
                        this.onDataCallback(new Uint8Array(event.data));
                }
            };
            ws.onerror = () => {
                const error = new Error('Bridge WebSocket 连接意外丢失');
                finish(error);
                void this.disconnect(error);
            };
            ws.onclose = () => {
                const error = new Error('Bridge WebSocket 已关闭');
                finish(error);
                if (this.ws === ws) void this.disconnect(error);
            };
        });
    }

    /** 断开 WebSocket：发送 disconnect 指令 → 关闭连接 → 通知状态 */
    async disconnect(reason = null) {
        if (this._rejectPending) this._rejectPending(new Error('连接已取消'));
        this.keepReading = false;
        const ws = this.ws;
        this.ws = null;
        try {
            if (ws && ws.readyState === WebSocket.OPEN) {
                try { ws.send(JSON.stringify({ cmd: 'disconnect' })); } catch (_) {}
            }
            if (ws && ws.readyState < WebSocket.CLOSING) ws.close();
        } finally {
            if (this._connected) {
                this._connected = false;
                if (this.onConnectStatusChange) this.onConnectStatusChange(false, reason);
            }
        }
    }

    /** 强制断开（接口与 SerialEngine 保持一致，内部委托给 disconnect） */
    async forceDisconnect() {
        return this.disconnect();
    }

    /* ── 数据传输 ── */

    /** 通过 bridge 发送二进制数据 */
    async send(data) {
        if (!this.ws || this.ws.readyState !== WebSocket.OPEN || !this.keepReading) throw new Error('网络未连接，无法发送');
        this.ws.send(data instanceof Uint8Array ? data : new Uint8Array(data));
    }
}

globalThis.SerialPlotter ??= {};
globalThis.SerialPlotter.NetEngine = NetEngine;
