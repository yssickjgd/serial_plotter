class SerialEngine {
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

    onData(callback) { this.onDataCallback = callback; }
    onStatusChange(callback) { this.onConnectStatusChange = callback; }

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

    async forceDisconnect() {
        return this.disconnect();
    }

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

    async send(data) {
        if (!this.port || !this.port.writable) throw new Error('串口未连接，无法发送');
        const writer = this.port.writable.getWriter();
        try {
            await writer.write(data instanceof Uint8Array ? data : new Uint8Array(data));
        } finally {
            writer.releaseLock();
        }
    }

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
