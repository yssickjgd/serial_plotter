const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const childProcess = require('node:child_process');
const { mkdtemp, readFile, rmdir, unlink } = require('node:fs/promises');
const { tmpdir } = require('node:os');
const { join, resolve } = require('node:path');
const { startBridge } = require('../bridgeProcess');

async function setup(t) {
    const dir = await mkdtemp(join(tmpdir(), 'plotter-launcher-'));
    const replacementPath = join(dir, 'replace.key');
    const server = new EventEmitter();
    server.stop = t.mock.fn(() => server.emit('close'));
    t.after(async () => {
        server.emit('close');
        await unlink(replacementPath).catch(error => { if (error.code !== 'ENOENT') throw error; });
        await rmdir(dir);
    });
    const opener = new EventEmitter();
    opener.unref = () => {};
    const spawn = t.mock.method(childProcess, 'spawn', () => opener);
    t.mock.method(console, 'log', () => {});
    return { server, opener, spawn, launch: options => startBridge(() => server, { replacementPath, ...options }) };
}

test('one-click launchers opt in to opening the page after Bridge startup', async () => {
    for (const script of ['start-bridge.bat', 'start-bridge.sh']) {
        const contents = await readFile(resolve(__dirname, '..', script), 'utf8');
        const command = contents.match(/^.*\bnode bridge\.js\b.*$/m)?.[0];
        assert.match(command, /--replace\b/, script);
        assert.match(command, /--open\b/, script);
    }
});

test('startup opens the local workspace page exactly once after listening', async t => {
    const { server, spawn, launch } = await setup(t);
    const pending = launch({ openPage: true });
    assert.equal(spawn.mock.callCount(), 0);
    server.emit('listening');
    assert.equal(await pending, server);
    assert.equal(spawn.mock.callCount(), 1);
    const [, args, options] = spawn.mock.calls[0].arguments;
    assert.match(args.join(' '), /index\.html/);
    assert.equal(options.cwd, resolve(__dirname, '..'));
});

test('manual startup leaves the browser closed by default', async t => {
    const { server, spawn, launch } = await setup(t);
    const pending = launch();
    server.emit('listening');
    await pending;
    assert.equal(spawn.mock.callCount(), 0);
});

test('startup failure never opens the browser', async t => {
    const { server, spawn, launch } = await setup(t);
    const pending = launch({ openPage: true });
    server.emit('error', new Error('listen failed'));
    await assert.rejects(pending, /listen failed/);
    assert.equal(spawn.mock.callCount(), 0);
});

test('missing desktop opener gives the manual path and keeps the Bridge running', async t => {
    const { server, opener, launch } = await setup(t);
    const warn = t.mock.method(console, 'warn', () => {});
    const pending = launch({ openPage: true });
    server.emit('listening');
    await pending;
    opener.emit('error', new Error('no desktop opener'));
    assert.match(warn.mock.calls[0].arguments.join(' '), /index\.html/);
    assert.equal(server.stop.mock.callCount(), 0);
});
