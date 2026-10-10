const test = require('node:test');
const assert = require('node:assert/strict');

function element(value = '') {
    const listeners = new Map();
    return {
        value, textContent: '', className: '', files: [],
        addEventListener(name, callback) { listeners.set(name, callback); },
        removeEventListener(name, callback) { if (listeners.get(name) === callback) listeners.delete(name); },
        fire(name, event = {}) { return listeners.get(name)?.({ target: this, ...event }); },
        click() { return this.fire('click'); }
    };
}

test('seconds and hertz inputs produce millisecond timer periods', () => {
    const { SendController } = require('../sendController');
    const interval = element('0.025');
    const intervalUnit = element('s');
    const controller = new SendController({
        mode: element('hex'), input: element('AA'), fileInput: element(),
        interval, intervalUnit, button: element(), loadButton: element(),
        getEngine: () => null, onSent() {}
    });
    assert.equal(controller.periodMs(), 25);
    intervalUnit.value = 'hz';
    interval.value = '20';
    assert.equal(controller.periodMs(), 50);
    interval.value = '0';
    assert.equal(controller.periodMs(), 0);
});

test('disposing global sender removes handlers and ignores a late file read and write callback', async () => {
    const { SendController } = require('../sendController');
    let finishRead, finishWrite, sent = 0;
    const fileInput = element(), button = element(), input = element('AA');
    const controller = new SendController({ mode: element('hex'), input, fileInput,
        interval: element('0'), intervalUnit: element('s'), button, loadButton: element(),
        getEngine: () => ({ send: () => new Promise(resolve => { finishWrite = resolve; }) }),
        onSent() { sent++; }
    });
    const write = controller.sendOnce();
    fileInput.files = [{ arrayBuffer: () => new Promise(resolve => { finishRead = resolve; }) }];
    const read = fileInput.fire('change');
    controller.dispose();
    finishRead(Uint8Array.of(255).buffer); finishWrite(); await Promise.all([read, write]);
    assert.equal(sent, 0);
    assert.equal(controller.loadedBytes, null);
    assert.equal(await button.fire('click'), undefined);
    assert.equal(controller.timer, null);
});

test('file preview mode does not change bytes sent to an active engine', async () => {
    const { SendController } = require('../sendController');
    const mode = element('text');
    const input = element();
    const fileInput = element();
    const sent = [];
    const controller = new SendController({
        mode, input, fileInput,
        interval: element('0'), intervalUnit: element('ms'),
        button: element(), loadButton: element(),
        getEngine: () => ({ async send(bytes) { sent.push([...bytes]); } }),
        onSent() {}, onError() {}
    });
    fileInput.files = [{ async arrayBuffer() { return Uint8Array.of(0, 128, 255).buffer; } }];
    await fileInput.fire('change');
    await controller.sendOnce();
    assert.deepEqual(sent, [[0, 128, 255]]);
    controller.stop();
});

test('failed first send does not start a repeat timer', async () => {
    const { SendController } = require('../sendController');
    const controller = new SendController({
        mode: element('hex'), input: element('AA'), fileInput: element(),
        interval: element('10'), intervalUnit: element('ms'),
        button: element(), loadButton: element(),
        getEngine: () => ({ async send() { throw new Error('closed'); } }),
        onSent() {}, onSendError() {}
    });
    await controller.handleClick();
    assert.equal(controller.timer, null);
});

test('a second click cancels a repeat send while its first write is pending', async () => {
    const { SendController } = require('../sendController');
    let finishWrite;
    const controller = new SendController({
        mode: element('hex'), input: element('AA'), fileInput: element(),
        interval: element('10'), intervalUnit: element('ms'),
        button: element(), loadButton: element(),
        getEngine: () => ({ send: () => new Promise(resolve => { finishWrite = resolve; }) }),
        onSent() {}
    });
    const firstClick = controller.handleClick();
    await controller.handleClick();
    finishWrite();
    await firstClick;
    assert.equal(controller.timer, null);
});

test('switching Hex to text and back preserves the original byte', async () => {
    const { SendController } = require('../sendController');
    const mode = element('hex');
    const input = element('80');
    const sent = [];
    const controller = new SendController({
        mode, input, fileInput: element(), interval: element('0'),
        intervalUnit: element('ms'), button: element(), loadButton: element(),
        getEngine: () => ({ async send(bytes) { sent.push([...bytes]); } }),
        onSent() {}
    });
    mode.value = 'text';
    mode.fire('change');
    mode.value = 'hex';
    mode.fire('change');
    await controller.sendOnce();
    assert.equal(input.value, '80');
    assert.deepEqual(sent, [[128]]);
});

test('a failed replacement file load clears the previously loaded bytes', async () => {
    const { SendController } = require('../sendController');
    const fileInput = element();
    const sent = [];
    const controller = new SendController({
        mode: element('hex'), input: element(), fileInput,
        interval: element('0'), intervalUnit: element('ms'),
        button: element(), loadButton: element(),
        getEngine: () => ({ async send(bytes) { sent.push([...bytes]); } }),
        onSent() {}, onInputError() {}
    });
    fileInput.files = [{ async arrayBuffer() { return Uint8Array.of(0xAA).buffer; } }];
    await fileInput.fire('change');
    fileInput.files = [{ async arrayBuffer() { throw new Error('read failed'); } }];
    await fileInput.fire('change');
    await controller.sendOnce();
    assert.deepEqual(sent, []);
});
