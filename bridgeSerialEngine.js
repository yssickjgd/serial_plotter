const serialBridgeUrl = 'ws://127.0.0.1:8081/serial';
const serialBridgeProtocol = 'serial-plotter/1';

function askSerialBridge(url, command, expected) {
    return new Promise((resolve, reject) => {
        if (typeof WebSocket !== 'function') { reject(new Error('当前浏览器不支持 Bridge 连接')); return; }
        const socket = new WebSocket(url);
        const timer = setTimeout(() => finish(new Error('未收到本地 Bridge 响应')), command ? 4000 : 450);
        function finish(error, result) {
            clearTimeout(timer);
            socket.onclose = socket.onerror = socket.onmessage = null;
            socket.close();
            if (error) reject(error); else resolve(result);
        }
        socket.onerror = socket.onclose = () => finish(new Error('无法连接到本地 Bridge'));
        socket.onmessage = ({ data }) => {
            let message;
            try { message = JSON.parse(data); }
            catch { finish(new Error('Bridge 响应无效')); return; }
            if (message.event === 'error') finish(new Error(message.reason));
            else if (message.event === 'hello') {
                if (message.protocol !== serialBridgeProtocol) finish(new Error('Bridge 协议不兼容'));
                else if (!command) finish(null, { serial: message.serial === true, ...(message.exclusive && { exclusive: true }) });
                else if (message.serial) socket.send(JSON.stringify(command));
                else finish(new Error('Bridge 未提供串口能力'));
            } else if (message.event === expected) finish(null, message);
        };
    });
}

class BridgeSerialEngine {
    static url = serialBridgeUrl;

    constructor() {
        this.backend = 'bridge';
        this.onDataCallback = null;
        this.onConnectStatusChange = null;
        this.cursor = null;
        this.sendId = 0;
        this.captureVisible = true;
        this.captureRevision = 0;
        this.liveStart = false;
        this.captureGraceDeadline = null;
    }

    static probe() {
        return askSerialBridge(this.url).catch(() => null);
    }

    static async ports(token) {
        const response = await askSerialBridge(this.url, { cmd: 'list', token }, 'ports');
        if (!Array.isArray(response.ports)) throw new Error('Bridge 串口列表无效');
        return response.ports;
    }

    onData(listener) { this.onDataCallback = listener; }
    onStatusChange(listener) { this.onConnectStatusChange = listener; }

    setCaptureVisible(visible) {
        if (this.captureVisible === visible) return;
        this.captureVisible = visible;
        this.captureRevision++;
        this.liveStart = true;
        this.captureGraceDeadline = null;
        this.updateCaptureSubscription?.();
    }

    setCaptureGrace(milliseconds) {
        const arming = milliseconds !== null;
        if (arming === (this.captureGraceDeadline !== null)) return;
        const now = Date.now();
        this.resumeGraceHistory = !arming && now < this.captureGraceDeadline;
        this.captureGraceDeadline = arming ? now + milliseconds : null;
        this.updateCaptureGrace?.();
    }

    remainingGrace() {
        return this.captureGraceDeadline === null ? null : Math.max(0, this.captureGraceDeadline - Date.now());
    }

    async connect(settings, binding, token, workspace) {
        if (this.socket) throw new Error('Bridge 串口连接正在使用');
        if (binding.identity !== this.identity) this.cursor = null;
        this.identity = binding.identity;
        const cursor = this.cursor;
        const socket = new WebSocket(this.constructor.url);
        socket.binaryType = 'arraybuffer';
        this.socket = socket;
        return new Promise((resolve, reject) => {
            let requestedRevision, acceptedRevision, requestedGrace, supportsVisibility, supportsGrace;
            const restartHint = '请重新启动新版 Bridge 以使用仅在页面可见时采集';
            const timer = setTimeout(() => finish(new Error('Bridge 打开串口超时')), 5000);
            const notifyClosed = (error, detached) => {
                if (this.socket !== socket) return;
                this.socket = null;
                this.updateCaptureSubscription = null;
                this.updateCaptureGrace = null;
                const connected = this.connected;
                this.connected = false;
                this.pendingSend?.reject(error ?? new Error('Bridge 串口已断开'));
                this.pendingSend = null;
                this.resolveDisconnect?.(error);
                this.resolveDisconnect = null;
                if (connected) this.onConnectStatusChange?.(false, error, { detached });
            };
            const finish = error => {
                clearTimeout(timer);
                if (error) {
                    notifyClosed(error, true);
                    socket.close();
                    reject(error);
                } else resolve(true);
            };
            socket.onerror = () => finish(new Error('Bridge 串口连接失败'));
            socket.onclose = () => {
                if (this.connected) notifyClosed(new Error('Bridge 数据连接中断，请重新连接'), true);
                else finish(new Error('Bridge 串口连接已关闭'));
            };
            socket.onmessage = ({ data }) => {
                if (this.socket !== socket) return;
                if (typeof data !== 'string') {
                    // Old binary messages can already be in the browser's queue. Only the
                    // ordered acknowledgement for the latest visibility change opens RX.
                    if (!this.connected || !this.captureVisible || acceptedRevision !== this.captureRevision || data.byteLength <= 16) return;
                    const header = new DataView(data, 0, 16), timestamp = header.getFloat64(0, true);
                    const offset = header.getFloat64(8, true);
                    if (!Number.isSafeInteger(offset) || !Number.isFinite(timestamp) || offset !== this.cursor.offset) {
                        finish(new Error('Bridge 串口数据序号不连续，请重新连接'));
                        return;
                    }
                    const bytes = new Uint8Array(data, 16);
                    this.onDataCallback?.(bytes, { timestamp, arrival: performance.now() + timestamp - Date.now() });
                    this.cursor.offset += bytes.length;
                    return;
                }
                let message;
                try { message = JSON.parse(data); }
                catch { finish(new Error('Bridge 串口响应无效')); return; }
                if (message.event === 'hello') {
                    supportsVisibility = message.captureVisibility === true;
                    supportsGrace = message.captureGrace === true;
                    requestedGrace = this.captureGraceDeadline;
                    requestedRevision = this.captureRevision;
                    if (message.protocol !== serialBridgeProtocol || !message.serial)
                        finish(new Error('Bridge 未提供串口能力'));
                    else if (this.liveStart && !supportsVisibility) finish(new Error(restartHint));
                    else socket.send(JSON.stringify({ cmd: 'connect', token, path: binding.path, identity: binding.identity,
                        settings, cursor, workspace, captureVisible: this.captureVisible, liveStart: this.liveStart,
                        captureGraceMs: this.remainingGrace() }));
                } else if (message.event === 'connected') {
                    if (typeof message.session !== 'string' || !Number.isSafeInteger(message.start) || message.start < 0) {
                        finish(new Error('Bridge 串口连接信息无效'));
                        return;
                    }
                    this.connected = true;
                    this.cursor = { session: message.session, offset: message.start };
                    this.updateCaptureSubscription = () => {
                        if (!supportsVisibility) { finish(new Error(restartHint)); return; }
                        if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify({
                            cmd: 'capture-visibility', visible: this.captureVisible, revision: this.captureRevision
                        }));
                    };
                    this.updateCaptureGrace = () => {
                        if (supportsGrace && socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify({
                            cmd: 'capture-grace', graceMs: this.remainingGrace(), revision: this.captureRevision,
                            resumeHistory: this.resumeGraceHistory === true
                        }));
                    };
                    acceptedRevision = requestedRevision;
                    if (requestedRevision !== this.captureRevision) {
                        this.updateCaptureSubscription();
                        if (!this.connected) return;
                    } else if (this.captureVisible) this.liveStart = false;
                    if (requestedGrace !== this.captureGraceDeadline) this.updateCaptureGrace();
                    this.onConnectStatusChange?.(true, null, { gap: message.gap });
                    finish();
                } else if (message.event === 'capture-visibility' && this.connected && message.revision === this.captureRevision) {
                    if (!Number.isSafeInteger(message.start) || message.start < 0) {
                        finish(new Error('Bridge 实时接收起点无效'));
                        return;
                    }
                    this.cursor.offset = message.start;
                    acceptedRevision = message.revision;
                    if (this.captureVisible) this.liveStart = false;
                    if (message.gap) this.onConnectStatusChange?.(true, null, { gap: true });
                } else if (message.event === 'disconnected') {
                    this.cursor = null;
                    notifyClosed(message.reason ? new Error(message.reason) : null, false);
                    socket.close();
                    finish();
                } else if (message.event === 'error') finish(new Error(message.reason));
                else if (this.pendingSend?.id === message.id && (message.event === 'sent' || message.event === 'send-error')) {
                    const { resolve: done, reject: failed } = this.pendingSend;
                    this.pendingSend = null;
                    if (message.event === 'sent') done(); else failed(new Error(message.reason));
                }
            };
        });
    }

    async disconnect() {
        const socket = this.socket;
        if (!socket) return;
        if (!this.connected) { socket.close(); return; }
        await new Promise((resolve, reject) => {
            const timer = setTimeout(() => { this.resolveDisconnect = null; reject(new Error('等待 Bridge 关闭串口超时')); }, 5000);
            this.resolveDisconnect = error => { clearTimeout(timer); if (error) reject(error); else resolve(); };
            socket.send(JSON.stringify({ cmd: 'disconnect' }));
        });
    }

    forceDisconnect() { return this.disconnect(); }
    dispose() { this.socket?.close(); }

    async send(bytes) {
        if (!this.socket || !this.connected) throw new Error('Bridge 串口未连接');
        if (this.pendingSend) throw new Error('上一条串口发送尚未结束');
        const payload = new Uint8Array(bytes.length + 4), id = ++this.sendId >>> 0;
        new DataView(payload.buffer).setUint32(0, id, true); payload.set(bytes, 4);
        await new Promise((resolve, reject) => {
            this.pendingSend = { id, resolve, reject };
            try { this.socket.send(payload); }
            catch (error) { this.pendingSend = null; reject(error); }
        });
    }
}

class BridgeWorkspace {
    constructor(onRevoked) {
        this.onRevoked = onRevoked;
        this.key = null;
        this.socket = null;
        this.revoked = false;
    }

    claim(bridgeUrl, token) {
        if (this.key) return Promise.resolve(this.key);
        const url = new URL('/_bridge/workspace', bridgeUrl);
        const socket = new WebSocket(url);
        this.socket = socket;
        return new Promise((resolve, reject) => {
            const timer = setTimeout(() => fail(new Error('等待 Bridge 授权超时')), 4000);
            const current = () => socket === this.socket;
            const fail = error => {
                clearTimeout(timer);
                if (current()) { this.socket = null; this.key = null; }
                socket.close();
                reject(error);
            };
            const revoke = () => {
                if (!current()) return;
                this.revoked = true;
                fail(new Error('Bridge 已由另一个页面接管'));
                this.onRevoked?.();
            };
            socket.onopen = () => socket.send(JSON.stringify({ token }));
            socket.onerror = () => fail(new Error('无法连接到本地 Bridge'));
            socket.onclose = event => {
                if (event.code === 4001) revoke();
                else fail(new Error('Bridge 授权连接已关闭'));
            };
            socket.onmessage = ({ data }) => {
                if (!current()) return;
                let message;
                try { message = JSON.parse(data); }
                catch { fail(new Error('Bridge 授权响应无效')); return; }
                if (message.event === 'superseded') revoke();
                else if (message.event === 'error') fail(Object.assign(new Error(message.reason), { code: message.code }));
                else if (message.event === 'claimed' && /^[a-f0-9]{48}$/.test(message.key)) {
                    clearTimeout(timer);
                    this.key = message.key;
                    this.revoked = false;
                    resolve(this.key);
                }
            };
        });
    }

    dispose() {
        this.socket?.close();
        this.socket = null;
        this.key = null;
    }
}

globalThis.SerialPlotter ??= {};
Object.assign(globalThis.SerialPlotter, { BridgeSerialEngine, BridgeWorkspace });
if (typeof module !== 'undefined') module.exports = { BridgeSerialEngine, BridgeWorkspace };
