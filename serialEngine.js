/* ═══════════════════════════════════════════════════════════════
 *  serialEngine.js — Web Serial API 通信适配器
 *
 *  职责：封装 Web Serial API 的串口连接、数据读取与断开逻辑，
 *        通过回调向 app.js 上报数据和连接状态变化。
 *
 *  代码结构：
 *    1. 构造函数（端口、读取器、回调、断开事件监听）
 *    2. 回调注册（onData、onStatusChange）
 *    3. 连接管理（connect、disconnect、forceDisconnect）
 *    4. 数据传输（send、readLoop）
 * ═══════════════════════════════════════════════════════════════ */

const serialPortOwners = new WeakMap();

class SerialEngine {
    /** 初始化端口/读取器状态、回调指针，注册浏览器串口断开事件 */
    constructor() {
        this.port = null;
        this.reader = null;
        this.keepReading = false;
        this.readTask = null;
        this._closing = null;
        this._connected = false;
        this._opening = false;
        this._serial = null;
        this._generation = 0;
        this._disposed = false;
        this.onDataCallback = null;
        this.onConnectStatusChange = null;
        this._onSerialDisconnect = (event) => {
            if (this.port && (event?.port ?? event?.target) === this.port) void this._handlePortDisconnect();
        };
        this._listenToSerial(globalThis.navigator?.serial);
    }

    _listenToSerial(serial) {
        if (serial === this._serial) return;
        this._serial?.removeEventListener?.('disconnect', this._onSerialDisconnect);
        this._serial = serial;
        serial?.addEventListener?.('disconnect', this._onSerialDisconnect);
    }

    /* ── 回调注册 ── */

    /** 注册数据到达回调 callback(Uint8Array, { arrival, timestamp }) */
    onData(callback) { this.onDataCallback = callback; }

    /** 注册连接状态变化回调 callback(connected: boolean, error?: Error) */
    onStatusChange(callback) { this.onConnectStatusChange = callback; }

    /* ── 连接管理 ── */

    /** 请求用户选择串口并打开，成功后启动 readLoop 持续读取 */
    async connect(config, boundPort = null) {
        if (this._disposed) throw new Error('串口适配器已销毁');
        const serial = globalThis.navigator?.serial;
        if (!serial) throw new Error('当前浏览器不支持 Web Serial API');
        if (this._opening || this._closing || this.port) throw new Error('此数据来源已有串口正在连接或已连接');
        this._listenToSerial(serial);
        this._opening = true;
        const generation = ++this._generation;
        const cancelled = () => {
            const error = new Error('串口连接已取消'); error.name = 'AbortError'; return error;
        };
        let reservedPort;
        try {
            const port = boundPort ?? await serial.requestPort();
            if (generation !== this._generation || this._disposed) throw cancelled();
            if (serialPortOwners.has(port)) throw new Error('该串口已被另一数据来源打开或正在连接');
            serialPortOwners.set(port, this);
            reservedPort = port;
            await port.open({
                baudRate: config.baudRate || 115200,
                dataBits: config.dataBits || 8,
                stopBits: config.stopBits || 1,
                parity:   config.parity   || 'none',
                // At 2 Mbaud (8N1), the default 255 bytes cover only 1.3 ms.
                // Leave room for reads delayed by rendering and page scheduling.
                bufferSize: 64 * 1024
            });
            if (generation !== this._generation || this._disposed) {
                await this._closePort(port);
                throw cancelled();
            }
            this.port = port;
            this.keepReading = true;
            this.readTask = this.readLoop();
            this._connected = true;
            if (this.onConnectStatusChange) this.onConnectStatusChange(true);
            return true;
        } finally {
            if (reservedPort && this.port !== reservedPort && serialPortOwners.get(reservedPort) === this)
                serialPortOwners.delete(reservedPort);
            this._opening = false;
        }
    }

    async _closePort(port) {
        if (!port) return;
        try { await port.close(); } catch { /* A disconnected physical port can already be closed. */ }
        finally { if (serialPortOwners.get(port) === this) serialPortOwners.delete(port); }
    }

    /** 安全断开串口：取消读取 → 释放读取器 → 关闭端口 → 通知状态 */
    async disconnect() {
        this._generation++;
        if (this._closing) return this._closing;
        const closing = (async () => {
            this.keepReading = false;
            try { if (this.reader) await this.reader.cancel(); } catch (_) {}
            try { if (this.readTask) await this.readTask; } catch (_) {}
            await this._closePort(this.port);
            this.port = null;
            this.readTask = null;
            if (this._connected) {
                this._connected = false;
                if (this.onConnectStatusChange) this.onConnectStatusChange(false);
            }
        })();
        this._closing = closing;
        try { await closing; }
        finally { if (this._closing === closing) this._closing = null; }
    }

    async dispose() {
        this._disposed = true;
        this._listenToSerial(null);
        this.onDataCallback = null;
        this.onConnectStatusChange = null;
        await this.disconnect();
    }

    /** 强制断开（接口与 NetEngine 保持一致，内部委托给 disconnect） */
    async forceDisconnect() {
        return this.disconnect();
    }

    /** 浏览器串口断开事件处理（用户拔出设备时触发） */
    async _handlePortDisconnect() {
        await this.disconnect();
    }

    /* ── 数据传输 ── */

    /** 向串口写入 Uint8Array 数据 */
    async send(data) {
        if (!this.port || !this.port.writable) throw new Error('串口未连接，无法发送');
        const writer = this.port.writable.getWriter();
        try {
            await writer.write(data instanceof Uint8Array ? data : new Uint8Array(data));
        } finally {
            writer.releaseLock();
        }
    }

    /** 持续读取串口数据流，通过 onDataCallback 上报，直到 keepReading 为 false */
    async readLoop() {
        let failed = false;
        let failure = null;
        while (this.port && this.port.readable && this.keepReading) {
            let reader;
            try { reader = this.port.readable.getReader(); }
            catch (error) { failure = error; failed = true; this.keepReading = false; break; }
            this.reader = reader;
            try {
                while (this.keepReading) {
                    const { value, done } = await reader.read();
                    if (done) {
                        if (this.keepReading) {
                            failure = new Error('串口读取已结束');
                            failed = true;
                            this.keepReading = false;
                        }
                        break;
                    }
                    if (value && this.onDataCallback) {
                        const timestamp = Date.now(), arrival = globalThis.performance?.now() ?? timestamp;
                        this.onDataCallback(value, { timestamp, arrival });
                    }
                }
            } catch (error) {
                if (this.keepReading) {
                    failure = error;
                    failed = true;
                    this.keepReading = false;
                }
            } finally {
                reader.releaseLock();
                if (this.reader === reader) this.reader = null;
            }
        }
        if (failed) {
            await this._closePort(this.port);
            this.port = null;
            if (this._connected) {
                this._connected = false;
                if (this.onConnectStatusChange) this.onConnectStatusChange(false, failure);
            }
        }
    }
}

/** Exact port handles stay in memory. USB identifiers restore only unambiguous grants. */
class SerialPortBindings {
    constructor(hints) { this.ports = new Map(); this.load(hints); }

    load(hints = []) {
        const next = new Map(hints.map(({ id, ...hint }) => [id, hint]));
        for (const id of this.ports.keys()) {
            if (!next.has(id) || JSON.stringify(next.get(id)) !== JSON.stringify(this.hints?.get(id))) this.ports.delete(id);
        }
        this.hints = next;
    }

    snapshot() { return [...this.hints].map(([id, hint]) => ({ id, ...hint })); }
    remove(id) { this.hints.delete(id); this.ports.delete(id); }

    static identity(port) {
        try {
            const { usbVendorId, usbProductId } = port.getInfo?.() ?? {};
            if (Number.isInteger(usbVendorId) && Number.isInteger(usbProductId)) return { usbVendorId, usbProductId };
        } catch { /* A removed device may no longer provide information. */ }
        return null;
    }

    static same(a, b) {
        return a && b && a.usbVendorId === b.usbVendorId && a.usbProductId === b.usbProductId;
    }

    available(port, id) { return ![...this.ports].some(([owner, item]) => owner !== id && item === port); }

    bind(id, port, grants) {
        if (!this.available(port, id)) throw new Error('该物理端口已绑定到其他串口来源');
        const identity = SerialPortBindings.identity(port);
        if (identity) {
            const sameModel = hint => SerialPortBindings.same(hint, identity);
            const ambiguous = this.hints.get(id)?.ambiguous && sameModel(this.hints.get(id)) ||
                [...this.hints].some(([owner, hint]) => owner !== id && sameModel(hint)) ||
                (grants ?? []).filter(item => sameModel(SerialPortBindings.identity(item))).length > 1;
            this.hints.set(id, { ...identity, ambiguous: Boolean(ambiguous) });
            if (ambiguous) for (const hint of this.hints.values()) if (sameModel(hint)) hint.ambiguous = true;
        } else this.hints.delete(id);
        this.ports.set(id, port);
    }

    resolve(id, grants) {
        const exact = this.ports.get(id), hint = this.hints.get(id);
        if (exact) {
            if (grants === null || grants.includes(exact)) return { port: exact };
            return { issue: '已绑定的端口不在线或授权已取消' };
        }
        if (!hint) return { issue: '待绑定端口' };
        const sameModel = other => SerialPortBindings.same(other, hint);
        const matches = (grants ?? []).filter(port => sameModel(SerialPortBindings.identity(port)));
        const sharedHint = [...this.hints].some(([owner, other]) => owner !== id && sameModel(other));
        if (sharedHint || matches.length > 1) hint.ambiguous = true;
        if (hint.ambiguous) return { issue: '同型号端口需要重新确认绑定' };
        if (!matches.length || !this.available(matches[0], id)) return { issue: '已绑定的端口不在线或授权已取消' };
        return { port: matches[0] };
    }
}

globalThis.SerialPlotter ??= {};
globalThis.SerialPlotter.SerialEngine = SerialEngine;
globalThis.SerialPlotter.SerialPortBindings = SerialPortBindings;
