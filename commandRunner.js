/** Executes a validated snapshot; cancellation never retracts an already submitted write. */
class CommandRunner {
    constructor({ library, send, getEngine, beforeStart = () => {}, onState = () => {}, onError = () => {},
        schedule = setTimeout, cancel = clearTimeout, protocolSession = null }) {
        Object.assign(this, { library, send, getEngine, beforeStart, onState, onError, schedule, cancel });
        this.task = null;
        this.disposed = false;
        const Session = typeof module !== 'undefined' ? require('./protocolSendView').ProtocolSendSession
            : globalThis.SerialPlotter.ProtocolSendSession;
        this.protocolSession = protocolSession || (Session ? new Session({ getProtocol: id => this.library.getProtocol?.(id) }) : null);
    }
    get running() { return this.task !== null; }
    stop() {
        const task = this.task;
        if (!task) return;
        this.task = null;
        task.cancelWait?.();
        this.onState({ running: false, sent: task.sent, total: task.total, message: `已停止，已发送 ${task.sent} / ${task.total} 次` });
    }
    dispose() { this.stop(); this.disposed = true; }
    _wait(task, ms) {
        return new Promise(resolve => {
            const timer = this.schedule(() => { task.cancelWait = null; resolve(); }, ms);
            task.cancelWait = () => { this.cancel(timer); task.cancelWait = null; resolve(); };
        });
    }
    async start(id) {
        if (this.disposed) return false;
        let plan;
        try {
            plan = this.library.prepareTree(id, { protocolSession: this.protocolSession });
            if (!this.getEngine()) throw new Error('请先连接通讯设备');
        } catch (error) { this.onError(error); return false; }
        this.stop(); this.beforeStart();
        const task = { sent: 0, total: plan.total, engine: this.getEngine() };
        this.task = task;
        const current = () => !this.disposed && this.task === task && this.getEngine() === task.engine;
        const active = () => {
            if (current()) return true;
            if (this.task === task) throw new Error('连接已改变，剩余指令已停止');
            return false;
        };
        const execute = async (item, followedByAnother) => {
            if (!item.total) return true;
            if (item.type === 'group') {
                for (let repetition = 0; repetition < item.repeat; repetition++) {
                    if (!active()) return false;
                    const remaining = repetition < item.repeat - 1 || followedByAnother;
                    for (let index = 0; index < item.children.length; index++) {
                        if (!await execute(item.children[index], index < item.children.length - 1 || remaining)) return false;
                    }
                    // Every level retains its own delay, so group boundaries accumulate.
                    if (remaining && item.interval > 0) await this._wait(task, item.interval * 1000);
                }
            } else {
                for (let repetition = 0; repetition < item.repeat; repetition++) {
                    if (!active()) return false;
                    this.onState({ running: true, currentId: item.id, sent: task.sent, total: task.total,
                        message: `正在发送 ${item.name} · ${task.sent} / ${task.total}` });
                    const sent = item.protocol ? await this.protocolSession.send(item.protocol, this.send, current)
                        : await this.send(item.bytes, current);
                    if (!sent) {
                        if (this.task === task) throw new Error('发送失败，剩余指令已停止');
                        return false;
                    }
                    task.sent++;
                    if (!active()) return false;
                    const remaining = repetition < item.repeat - 1 || followedByAnother;
                    if (remaining && (item.interval > 0 || task.sent % 64 === 0)) await this._wait(task, item.interval * 1000);
                }
            }
            return active();
        };
        try {
            if (!await execute(plan, false)) return false;
            if (!current()) return false;
            this.task = null;
            this.onState({ running: false, sent: task.sent, total: task.total, message: `发送完成，共 ${task.sent} 次` });
            return true;
        } catch (error) {
            if (this.task === task) { this.stop(); this.onError(error); }
            return false;
        }
    }
}

globalThis.SerialPlotter ??= {};
globalThis.SerialPlotter.CommandRunner = CommandRunner;
if (typeof module !== 'undefined') module.exports = { CommandRunner };
