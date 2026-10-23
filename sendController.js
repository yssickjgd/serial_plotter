const sendByteUtils = typeof module !== 'undefined'
    ? require('./byteUtils').ByteUtils : globalThis.SerialPlotter.ByteUtils;

/** Owns send-panel state, file bytes, and repeated-send lifecycle. */
class SendController {
    constructor({ mode, input, fileInput, interval, intervalUnit, button, loadButton,
        getEngine, onSent, onInputError, onSendError, onStart = () => {},
        protocolSession = null, getProtocolCommand = () => null }) {
        this.mode = mode;
        this.input = input;
        this.fileInput = fileInput;
        this.interval = interval;
        this.intervalUnit = intervalUnit;
        this.button = button;
        this.loadButton = loadButton;
        this.getEngine = getEngine;
        this.onSent = onSent;
        this.onInputError = onInputError || (() => {});
        this.onSendError = onSendError || (() => {});
        this.onStart = onStart;
        this.loadedBytes = null;
        this.previewBytes = null;
        this.previousMode = mode.value;
        this.timer = null;
        this.inFlight = false;
        this.starting = false;
        this.disposed = false;
        this.listeners = [];
        this.fileGeneration = 0;
        this.sendGeneration = 0;
        this.pendingWrite = null;
        this.protocolSession = protocolSession;
        this.getProtocolCommand = getProtocolCommand;
        this.activeProtocol = null;
        this.protocolInFlight = false;

        this.listen(mode, 'change', () => this.changeMode());
        this.listen(input, 'input', () => {
            this.fileGeneration++;
            this.loadedBytes = null;
            this.previewBytes = null;
        });
        this.listen(button, 'click', () => { void this.handleClick(); });
        this.listen(loadButton, 'click', () => fileInput.click());
        this.listen(fileInput, 'change', event => this.loadFile(event));
    }

    listen(element, name, callback) {
        element.addEventListener(name, callback);
        this.listeners.push(() => element.removeEventListener?.(name, callback));
    }

    dispose() {
        if (this.disposed) return;
        this.disposed = true;
        this.fileGeneration++;
        this.stop();
        for (const remove of this.listeners.splice(0)) remove();
    }

    stop() {
        this.sendGeneration++;
        this.starting = false;
        this.activeProtocol = null;
        if (this.timer !== null) clearInterval(this.timer);
        this.timer = null;
        this.button.textContent = '发送';
        this.button.className = 'btn btn-primary';
    }

    periodMs() {
        const value = Number(this.interval.value);
        if (!Number.isFinite(value) || value <= 0) return 0;
        if (this.intervalUnit.value === 'hz') return 1000 / value;
        if (this.intervalUnit.value === 's') return value * 1000;
        return value;
    }

    async sendOnce({ queue = false } = {}) {
        if (this.disposed || (this.inFlight || this.protocolInFlight) && !queue) return false;
        if (!this.getEngine()) { this.stop(); return false; }
        if (this.mode.value === 'protocol') {
            const generation = this.sendGeneration;
            this.protocolInFlight = true;
            try {
                const prepared = this.activeProtocol || this.prepareProtocol();
                const sent = await this.sendProtocol(prepared, () => generation === this.sendGeneration);
                if (!sent && generation === this.sendGeneration) this.stop();
                return sent;
            } catch (error) {
                this.onInputError(error);
                if (generation === this.sendGeneration) this.stop();
                return false;
            } finally { this.protocolInFlight = false; }
        }
        let bytes;
        try {
            bytes = this.loadedBytes || this.previewBytes || (this.mode.value === 'hex'
                ? sendByteUtils.hexToBytes(this.input.value)
                : sendByteUtils.textToBytes(this.input.value));
            if (bytes.length === 0) return false;
        } catch (error) {
            this.onInputError(error);
            this.stop();
            return false;
        }
        const generation = this.sendGeneration;
        const sent = await this.sendBytes(bytes, () => generation === this.sendGeneration);
        if (!sent && generation === this.sendGeneration) this.stop();
        return sent;
    }

    /** Both sending modes share this serialized physical transport and TX accounting. */
    sendBytes(bytes, isCurrent = () => true) {
        const engine = this.getEngine();
        const queued = this.pendingWrite !== null;
        const write = async () => {
            const currentEngine = this.getEngine();
            if (this.disposed || !engine || !currentEngine || queued && currentEngine !== engine || !isCurrent()) return false;
            this.inFlight = true;
            try {
                await engine.send(bytes);
                if (!this.disposed) this.onSent(bytes);
                return true;
            } catch (error) {
                if (!this.disposed) this.onSendError(error, bytes);
                return false;
            } finally { this.inFlight = false; }
        };
        const result = this.pendingWrite ? this.pendingWrite.then(write) : write();
        const tail = result.catch(() => {}).then(() => { if (this.pendingWrite === tail) this.pendingWrite = null; });
        this.pendingWrite = tail;
        return result;
    }

    prepareProtocol(binding = this.getProtocolCommand()) {
        if (!this.protocolSession) throw new Error('协议发送尚未配置');
        if (!binding) throw new Error('请选择协议和消息');
        return this.protocolSession.prepare(binding);
    }

    sendProtocol(prepared, isCurrent = () => true) {
        if (!this.protocolSession) throw new Error('协议发送尚未配置');
        const engine = this.getEngine();
        return this.protocolSession.send(prepared, (bytes, current) => this.sendBytes(bytes, current),
            () => !this.disposed && this.getEngine() === engine && isCurrent());
    }

    async handleClick() {
        if (this.disposed) return;
        if (this.timer !== null || this.starting) { this.stop(); return; }
        this.onStart();
        if (this.mode.value === 'protocol') {
            try { this.activeProtocol = this.prepareProtocol(); }
            catch (error) { this.onInputError(error); this.stop(); return; }
        }
        const period = this.periodMs();
        const generation = this.sendGeneration;
        if (period > 0) {
            if (!this.getEngine()) return;
            this.starting = true;
            const sent = await this.sendOnce({ queue: true });
            if (generation !== this.sendGeneration) return;
            if (!sent || !this.starting || !this.getEngine()) {
                this.starting = false;
                return;
            }
            this.timer = setInterval(() => { void this.sendOnce(); }, period);
            this.starting = false;
            this.button.textContent = '停止';
            this.button.className = 'btn btn-danger';
        } else {
            await this.sendOnce({ queue: true });
        }
    }

    changeMode() {
        if (this.mode.value === 'protocol' || this.previousMode === 'protocol') {
            this.previousMode = this.mode.value;
            this.stop();
            return;
        }
        try {
            const bytes = this.loadedBytes || this.previewBytes ||
                (this.previousMode === 'hex'
                    ? sendByteUtils.hexToBytes(this.input.value)
                    : sendByteUtils.textToBytes(this.input.value));
            this.previewBytes = bytes;
            this.input.value = this.mode.value === 'hex'
                ? sendByteUtils.bytesToHex(bytes) : sendByteUtils.bytesToText(bytes);
        } catch (_) {
            // Keep the original input when it cannot be converted.
        }
        this.previousMode = this.mode.value;
    }

    async loadFile(event) {
        if (this.disposed) return;
        const file = event.target.files[0];
        if (!file) return;
        const generation = ++this.fileGeneration;
        this.loadedBytes = null;
        this.previewBytes = null;
        this.input.value = '';
        try {
            const bytes = new Uint8Array(await file.arrayBuffer());
            if (this.disposed || generation !== this.fileGeneration) return;
            this.loadedBytes = bytes;
            this.input.value = this.mode.value === 'hex'
                ? sendByteUtils.bytesToHex(this.loadedBytes)
                : sendByteUtils.bytesToText(this.loadedBytes);
        } catch (error) {
            if (!this.disposed && generation === this.fileGeneration) this.onInputError(error);
        } finally {
            event.target.value = '';
        }
    }
}

globalThis.SerialPlotter ??= {};
globalThis.SerialPlotter.SendController = SendController;
if (typeof module !== 'undefined') module.exports = { SendController };
