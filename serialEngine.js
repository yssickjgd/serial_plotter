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

class SerialEngine {
    /** 初始化端口/读取器状态、回调指针，注册浏览器串口断开事件 */
    constructor() {
        this.port = null;
        this.reader = null;
        this.keepReading = false;
        this.readTask = null;
        this._closing = null;
        this._connected = false;
        this._generation = 0;
        this._disposed = false;
        this.onDataCallback = null;
        this.onConnectStatusChange = null;
        this._onSerialDisconnect = (event) => {
            if (!this.port) return;
            if (this.port && event && event.port && event.port !== this.port) return;
            void this._handlePortDisconnect();
        };
        if (typeof navigator !== 'undefined' && navigator.serial && navigator.serial.addEventListener) {
            navigator.serial.addEventListener('disconnect', this._onSerialDisconnect);
        }
    }

    /* ── 回调注册 ── */

    /** 注册数据到达回调 callback(Uint8Array) */
    onData(callback) { this.onDataCallback = callback; }

    /** 注册连接状态变化回调 callback(connected: boolean, error?: Error) */
    onStatusChange(callback) { this.onConnectStatusChange = callback; }

    /* ── 连接管理 ── */

    /** 请求用户选择串口并打开，成功后启动 readLoop 持续读取 */
    async connect(config) {
        if (this._disposed) throw new Error('串口适配器已销毁');
        if (!('serial' in navigator)) {
            throw new Error('当前浏览器不支持 Web Serial API');
        }
        const generation = ++this._generation;
        const cancelled = () => {
            const error = new Error('串口连接已取消'); error.name = 'AbortError'; return error;
        };
        try {
            const port = await navigator.serial.requestPort();
            if (generation !== this._generation || this._disposed) throw cancelled();
            await port.open({
                baudRate: config.baudRate || 115200,
                dataBits: config.dataBits || 8,
                stopBits: config.stopBits || 1,
                parity:   config.parity   || 'none'
            });
            if (generation !== this._generation || this._disposed) {
                try { await port.close(); } catch { /* The cancelled port must never become active. */ }
                throw cancelled();
            }
            this.port = port;
            this.keepReading = true;
            this.readTask = this.readLoop();
            this._connected = true;
            if (this.onConnectStatusChange) this.onConnectStatusChange(true);
            return true;
        } catch (error) {
            if (generation === this._generation) this.port = null;
            throw error;
        }
    }

    /** 安全断开串口：取消读取 → 释放读取器 → 关闭端口 → 通知状态 */
    async disconnect() {
        this._generation++;
        if (this._closing) return this._closing;
        const closing = (async () => {
            this.keepReading = false;
            try { if (this.reader) await this.reader.cancel(); } catch (_) {}
            try { if (this.readTask) await this.readTask; } catch (_) {}
            try { if (this.port) await this.port.close(); } catch (_) {}
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
        navigator.serial?.removeEventListener?.('disconnect', this._onSerialDisconnect);
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
                    if (value && this.onDataCallback) this.onDataCallback(value);
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
            try { if (this.port) await this.port.close(); } catch (_) {}
            this.port = null;
            if (this._connected) {
                this._connected = false;
                if (this.onConnectStatusChange) this.onConnectStatusChange(false, failure);
            }
        }
    }
}

globalThis.SerialPlotter ??= {};
globalThis.SerialPlotter.SerialEngine = SerialEngine;
