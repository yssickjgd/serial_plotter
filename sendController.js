const sendByteUtils = typeof module !== 'undefined'
    ? require('./byteUtils').ByteUtils : globalThis.SerialPlotter.ByteUtils;

/** Owns send-panel state, file bytes, and repeated-send lifecycle. */
class SendController {
    constructor({ mode, input, fileInput, interval, intervalUnit, button, loadButton,
        getEngine, onSent, onInputError, onSendError }) {
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
        this.loadedBytes = null;
        this.previewBytes = null;
        this.previousMode = mode.value;
        this.timer = null;
        this.inFlight = false;
        this.starting = false;

        mode.addEventListener('change', () => this.changeMode());
        input.addEventListener('input', () => {
            this.loadedBytes = null;
            this.previewBytes = null;
        });
        button.addEventListener('click', () => { void this.handleClick(); });
        loadButton.addEventListener('click', () => fileInput.click());
        fileInput.addEventListener('change', event => this.loadFile(event));
    }

    stop() {
        this.starting = false;
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

    async sendOnce() {
        if (this.inFlight) return false;
        const engine = this.getEngine();
        if (!engine) { this.stop(); return false; }
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
        this.inFlight = true;
        try {
            await engine.send(bytes);
            this.onSent(bytes);
            return true;
        } catch (error) {
            this.onSendError(error, bytes);
            this.stop();
            return false;
        } finally {
            this.inFlight = false;
        }
    }

    async handleClick() {
        if (this.timer !== null || this.starting) { this.stop(); return; }
        const period = this.periodMs();
        if (period > 0) {
            if (!this.getEngine()) return;
            this.starting = true;
            const sent = await this.sendOnce();
            if (!sent || !this.starting || !this.getEngine()) {
                this.starting = false;
                return;
            }
            this.timer = setInterval(() => { void this.sendOnce(); }, period);
            this.starting = false;
            this.button.textContent = '停止';
            this.button.className = 'btn btn-danger';
        } else {
            await this.sendOnce();
        }
    }

    changeMode() {
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
        const file = event.target.files[0];
        if (!file) return;
        this.loadedBytes = null;
        this.previewBytes = null;
        this.input.value = '';
        try {
            this.loadedBytes = new Uint8Array(await file.arrayBuffer());
            this.input.value = this.mode.value === 'hex'
                ? sendByteUtils.bytesToHex(this.loadedBytes)
                : sendByteUtils.bytesToText(this.loadedBytes);
        } catch (error) {
            this.onInputError(error);
        } finally {
            event.target.value = '';
        }
    }
}

globalThis.SerialPlotter ??= {};
globalThis.SerialPlotter.SendController = SendController;
if (typeof module !== 'undefined') module.exports = { SendController };
