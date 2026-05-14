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
        this.onDataCallback = null;
        this.onConnectStatusChange = null;
        this._onSerialDisconnect = (event) => {
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

    /** 注册连接状态变化回调 callback(connected: boolean) */
    onStatusChange(callback) { this.onConnectStatusChange = callback; }

    /* ── 连接管理 ── */

    /** 请求用户选择串口并打开，成功后启动 readLoop 持续读取 */
    async connect(config) {
        if (!('serial' in navigator)) {
            alert('当前浏览器暂不支持 Web Serial API');
            throw new Error('API Not Supported');
        }
        try {
            this.port = await navigator.serial.requestPort();
            await this.port.open({
                baudRate: config.baudRate || 115200,
                dataBits: config.dataBits || 8,
                stopBits: config.stopBits || 1,
                parity:   config.parity   || 'none'
            });
            this.keepReading = true;
            this.readLoop();
            if (this.onConnectStatusChange) this.onConnectStatusChange(true);
            return true;
        } catch (error) {
            console.error('串口异常:', error);
            if (this.onConnectStatusChange) this.onConnectStatusChange(false);
            throw error;
        }
    }

    /** 安全断开串口：取消读取 → 释放读取器 → 关闭端口 → 通知状态 */
    async disconnect() {
        this.keepReading = false;
        try {
            if (this.reader) {
                try { await this.reader.cancel(); } catch (_) {}
                try { this.reader.releaseLock(); } catch (_) {}
            }
            if (this.port) {
                try { await this.port.close(); } catch (_) {}
            }
        } finally {
            this.reader = null;
            this.port = null;
            if (this.onConnectStatusChange) this.onConnectStatusChange(false);
        }
    }

    /** 强制断开（接口与 NetEngine 保持一致，内部委托给 disconnect） */
    async forceDisconnect() {
        return this.disconnect();
    }

    /** 浏览器串口断开事件处理（用户拔出设备时触发） */
    async _handlePortDisconnect() {
        this.keepReading = false;
        try {
            if (this.reader) await this.reader.cancel();
        } catch (_) {}
        try {
            if (this.reader) this.reader.releaseLock();
        } catch (_) {}
        this.reader = null;
        this.port = null;
        if (this.onConnectStatusChange) this.onConnectStatusChange(false);
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
        while (this.port && this.port.readable && this.keepReading) {
            this.reader = this.port.readable.getReader();
            try {
                while (true) {
                    const { value, done } = await this.reader.read();
                    if (done) break;
                    if (value && this.onDataCallback) this.onDataCallback(value);
                }
            } catch (error) {
                if (this.keepReading) console.error('读取数据流时出错:', error);
            } finally {
                if (this.reader) this.reader.releaseLock();
            }
        }
    }
}
