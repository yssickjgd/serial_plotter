const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

test('index loads classic scripts with an explicit application namespace', () => {
    const root = path.resolve(__dirname, '..');
    const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
    const scripts = [...html.matchAll(/<script src="([^"]+)"/g)].map(match => match[1]);
    let ready;
    const context = vm.createContext({
        document: { addEventListener(name, callback) { if (name === 'DOMContentLoaded') ready = callback; } }
    });
    for (const file of scripts) {
        const source = fs.readFileSync(path.join(root, file), 'utf8');
        vm.runInContext(source, context, { filename: file });
    }
    const exports = context.SerialPlotter;
    for (const name of ['Limits', 'ByteUtils', 'FrameBuffer', 'Plotter',
        'DataParser', 'SerialEngine', 'NetEngine', 'MonitorView',
        'ConfigStore', 'SendController', 'exportFrameCsv',
        'collectConfigFromView', 'applyConfigToView']) {
        assert.ok(exports[name], `${name} is missing from the browser namespace`);
    }
    assert.equal(typeof ready, 'function');
});
