const { createHash, randomUUID, timingSafeEqual } = require('node:crypto');
const WebSocket = require('ws');

const protocol = 'serial-plotter/1';
const rxHeaderSize = 16;
const subscriberLimit = 8 * 1024 * 1024;

function graceDeadline(milliseconds) {
    if (milliseconds == null) return null;
    if (!Number.isFinite(milliseconds) || milliseconds < 0 || milliseconds > 2147483647)
        throw new Error('采集宽限时间无效');
    return Date.now() + milliseconds;
}

function serialDriver() {
    try { return require('serialport').SerialPort; }
    catch { return null; }
}

function describePort(port) {
    const path = port.path;
    const hardware = [path, port.vendorId, port.productId, port.serialNumber, port.pnpId, port.locationId];
    return { path, identity: createHash('sha256').update(JSON.stringify(hardware)).digest('hex'),
        label: [path, port.manufacturer].filter(Boolean).join(' · ') };
}

function portSettings(input) {
    const { baudRate, dataBits, stopBits, parity } = input ?? {};
    if (!Number.isSafeInteger(baudRate) || baudRate <= 0 || baudRate > 2147483647 ||
        ![5, 6, 7, 8].includes(dataBits) || ![1, 2].includes(stopBits) || !['none', 'even', 'odd'].includes(parity))
        throw new Error('串口参数无效');
    return { baudRate, dataBits, stopBits, parity };
}

function invoke(port, method, ...args) {
    return new Promise((resolve, reject) => port[method](...args, error => error ? reject(error) : resolve()));
}

function sendMessage(ws, event, fields = {}) {
    if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ event, ...fields }));
}

function sendBytes(ws, packet) {
    if (ws.readyState !== WebSocket.OPEN) return;
    if (ws.bufferedAmount > subscriberLimit) { ws.close(1013, 'Serial stream backlog'); return; }
    ws.send(packet, { binary: true });
}

/** Physical ports belong to the Bridge process. A WebSocket only subscribes to one port. */
class SerialBridge {
    constructor(driver, token, { historyBytes = 4 * 1024 * 1024 } = {}) {
        this.driver = driver;
        this.token = Buffer.from(token ?? '');
        this.historyBytes = historyBytes;
        this.sessions = new Map();
    }

    get available() { return Boolean(this.driver && this.token.length); }

    authorized(value) {
        if (!this.token.length || typeof value !== 'string' || value.length > 128) return false;
        const token = Buffer.from(value);
        return token.length === this.token.length && timingSafeEqual(token, this.token);
    }

    async list() { return (await this.driver.list()).map(describePort); }

    async open(path, identity, settings) {
        if (typeof path !== 'string' || !path || path.length > 512) throw new Error('请选择串口');
        const port = (await this.list()).find(port => port.path === path && port.identity === identity);
        if (!port) throw new Error('串口未找到或设备身份已变化，请重新绑定');
        if (this.closed) throw new Error('Bridge 已停止');
        const config = portSettings(settings);
        const previous = this.sessions.get(path);
        if (previous) {
            if (previous.identity !== identity || previous.signature !== JSON.stringify(config) || previous.closing)
                throw new Error('此串口已有不同的采集设置，请先断开或等待关闭');
            await previous.ready;
            return previous;
        }
        const device = new this.driver({ path, ...config, autoOpen: false, lock: true });
        const session = { id: randomUUID(), path, identity, device, signature: JSON.stringify(config), offset: 0,
            oldest: 0, storage: [], first: 0, listeners: new Map(), closing: null };
        this.sessions.set(path, session);
        const retired = error => {
            if (this.sessions.get(path) !== session) return;
            this.sessions.delete(path);
            for (const ws of session.listeners.keys()) sendMessage(ws, 'disconnected', { reason: error?.message });
            session.listeners.clear();
        };
        device.on('data', bytes => this.record(session, bytes));
        device.on('close', retired);
        device.on('error', error => {
            // Hardware errors are associated with the affected port only.
            if (device.isOpen && !session.closing) void this.close(session).catch(() => retired(error));
        });
        session.ready = invoke(device, 'open').catch(error => { retired(error); throw error; });
        await session.ready;
        if (this.closed) {
            await this.close(session);
            throw new Error('Bridge 已停止');
        }
        return session;
    }

    record(session, bytes) {
        if (!bytes.length || session.closing) return;
        const packet = Buffer.allocUnsafe(rxHeaderSize + bytes.length);
        const received = Date.now(), offset = session.offset;
        packet.writeDoubleLE(received, 0);
        packet.writeDoubleLE(offset, 8);
        bytes.copy(packet, rxHeaderSize);
        session.offset += bytes.length;
        session.storage.push({ end: session.offset, packet });
        const keepFrom = session.offset - this.historyBytes;
        while (session.first < session.storage.length && session.storage[session.first].end <= keepFrom) {
            const index = session.first++;
            session.oldest = session.storage[index].end;
            session.storage[index] = null;
        }
        if (session.first >= 256) {
            session.storage.splice(0, session.first);
            session.first = 0;
        }
        for (const [ws, subscription] of session.listeners) {
            if (!subscription.visible) continue;
            // Check at the actual Bridge receive boundary, independent of browser timers.
            if (subscription.deadline !== null && received >= subscription.deadline) subscription.skippedFrom ??= offset;
            else sendBytes(ws, packet);
        }
    }

    subscribe(ws, session, cursor, { captureVisible = true, liveStart = false } = {}, deadline = null) {
        const same = cursor?.session === session.id && Number.isSafeInteger(cursor.offset) && cursor.offset >= 0;
        const skipHistory = liveStart || !captureVisible || (deadline !== null && Date.now() >= deadline);
        const requested = skipHistory ? session.offset : same ? cursor.offset : session.oldest;
        const start = Math.min(session.offset, Math.max(session.oldest, requested));
        sendMessage(ws, 'connected', { path: session.path, session: session.id, start, end: session.offset,
            gap: !skipHistory && (cursor ? !same || start !== requested : session.oldest > 0) });
        session.listeners.set(ws, { visible: captureVisible, deadline, skippedFrom: null });
        this.replay(ws, session, start);
    }

    replay(ws, session, start) {
        if (start === session.offset) return;
        for (let at = session.first; at < session.storage.length; at++) {
            const { end, packet } = session.storage[at];
            if (end <= start) continue;
            const from = packet.readDoubleLE(8);
            if (from >= start) sendBytes(ws, packet);
            else {
                const suffix = Buffer.concat([packet.subarray(0, rxHeaderSize), packet.subarray(rxHeaderSize + start - from)]);
                suffix.writeDoubleLE(start, 8);
                sendBytes(ws, suffix);
            }
        }
    }

    close(session) {
        if (!session.closing) {
            session.closing = (session.device.isOpen ? invoke(session.device, 'close') : Promise.resolve()).catch(error => {
                session.closing = null;
                throw error;
            });
        }
        return session.closing;
    }

    attach(ws, { exclusive = false, authorizeConnection = () => true } = {}) {
        let session = null, pending = false, writing = false;
        sendMessage(ws, 'hello', { protocol, serial: this.available, exclusive, captureVisibility: true, captureGrace: true });
        ws.on('close', () => session?.listeners.delete(ws));
        ws.on('error', () => ws.terminate());
        ws.on('message', async (message, binary) => {
            if (ws.readyState !== WebSocket.OPEN) return;
            if (binary) {
                const id = message.length >= 4 ? message.readUInt32LE(0) : 0;
                if (!session || session.closing || !session.device.isOpen || writing || message.length <= 4) {
                    sendMessage(ws, 'send-error', { id, reason: '串口不可发送，或上一条发送尚未结束' });
                    return;
                }
                writing = true;
                try {
                    await invoke(session.device, 'write', message.subarray(4));
                    await invoke(session.device, 'drain');
                    sendMessage(ws, 'sent', { id });
                } catch (error) {
                    sendMessage(ws, 'send-error', { id, reason: error.message });
                } finally { writing = false; }
                return;
            }
            if (pending) { sendMessage(ws, 'error', { reason: '正在处理上一条串口命令' }); return; }
            pending = true;
            try {
                const request = JSON.parse(message.toString());
                if (request.cmd === 'disconnect' && session) {
                    await this.close(session);
                    session = null;
                    return;
                }
                if (request.cmd === 'capture-visibility' && session) {
                    if (typeof request.visible !== 'boolean' || !Number.isSafeInteger(request.revision))
                        throw new Error('采集可见性参数无效');
                    session.listeners.set(ws, { visible: request.visible, deadline: null, skippedFrom: null });
                    sendMessage(ws, 'capture-visibility', { revision: request.revision, start: session.offset });
                    return;
                }
                if (request.cmd === 'capture-grace' && session) {
                    const subscription = session.listeners.get(ws);
                    if (!subscription || !Number.isSafeInteger(request.revision)) throw new Error('采集订阅无效');
                    subscription.deadline = graceDeadline(request.graceMs);
                    const start = subscription.skippedFrom;
                    if (subscription.deadline === null && subscription.visible && start !== null) {
                        subscription.skippedFrom = null;
                        if (request.resumeHistory === true && start >= session.oldest) this.replay(ws, session, start);
                        else sendMessage(ws, 'capture-visibility', { revision: request.revision, start: session.offset, gap: true });
                    }
                    return;
                }
                if (!this.available || !this.authorized(request.token)) throw new Error('Bridge 访问码无效或串口能力不可用');
                if (request.cmd === 'list') sendMessage(ws, 'ports', { ports: await this.list() });
                else if (request.cmd === 'connect' && !session) {
                    if (!authorizeConnection(request.workspace)) throw new Error('请先获得当前页面的 Bridge 使用权');
                    const deadline = graceDeadline(request.captureGraceMs);
                    session = await this.open(request.path, request.identity, request.settings);
                    if (ws.readyState === WebSocket.OPEN) this.subscribe(ws, session, request.cursor, request, deadline);
                } else throw new Error('未知串口命令或已订阅串口');
            } catch (error) {
                sendMessage(ws, 'error', { reason: error.message });
            } finally { pending = false; }
        });
    }

    dispose() {
        this.closed = true;
        return Promise.allSettled([...this.sessions.values()].map(async session => {
            await session.ready;
            await this.close(session);
        }));
    }
}

module.exports = { SerialBridge, serialDriver };
