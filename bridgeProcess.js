const { createHash, randomBytes, timingSafeEqual } = require('node:crypto');
const childProcess = require('node:child_process');
const { once } = require('node:events');
const { readFile, rename, unlink, writeFile } = require('node:fs/promises');
const { tmpdir, userInfo } = require('node:os');
const { join } = require('node:path');
const { setTimeout: delay } = require('node:timers/promises');
const WebSocket = require('ws');
const { serialDriver } = require('./serialBridge');

function replacementKeyPath(port) {
    const checkout = process.platform === 'win32' ? __dirname.toLowerCase() : __dirname;
    const id = createHash('sha256').update(JSON.stringify([userInfo().username, checkout, port])).digest('hex').slice(0, 24);
    return join(tmpdir(), 'serial-plotter-' + id + '.key');
}

async function requestReplacement(port, path) {
    const key = (await readFile(path, 'utf8')).trim();
    if (!/^[a-f0-9]{64}$/.test(key)) throw new Error('无效的本机接替凭据');
    const socket = new WebSocket('ws://127.0.0.1:' + port + '/_bridge/replace', {
        headers: { 'x-bridge-replacement-key': key }, handshakeTimeout: 1500
    });
    const timer = setTimeout(() => socket.terminate(), 2000);
    try {
        const reply = await Promise.race([
            once(socket, 'message').then(([data]) => JSON.parse(data)),
            once(socket, 'close').then(() => null)
        ]);
        if (reply?.event !== 'replacing') throw new Error('旧服务未确认接替');
    } finally {
        clearTimeout(timer);
        socket.close();
    }
}

function openPlotterPage() {
    const page = join(__dirname, 'index.html');
    const windows = process.platform === 'win32';
    const command = windows ? 'powershell.exe' : 'xdg-open';
    const args = windows
        ? ['-NoProfile', '-NonInteractive', '-Command', "Invoke-Item -LiteralPath './index.html' -ErrorAction Stop"]
        : [page];
    const warn = () => console.warn('[Bridge] 无法自动打开页面，请手动打开 ' + page);
    try {
        const opener = childProcess.spawn(command, args, { cwd: __dirname, windowsHide: true, detached: !windows, stdio: 'ignore' });
        opener.once('error', warn);
        opener.once('exit', code => { if (code !== 0) warn(); });
        opener.unref();
    } catch { warn(); }
}

async function startBridge(createBridge, { port = 8081, replacementPath = replacementKeyPath(port), replace = false, openPage = false } = {}) {
    const driver = serialDriver(), serialToken = randomBytes(18).toString('base64url');
    const key = Buffer.from(randomBytes(32).toString('hex'));
    const authorizeReplacement = supplied => typeof supplied === 'string' && Buffer.byteLength(supplied) === key.length &&
        timingSafeEqual(Buffer.from(supplied), key);
    const listen = async () => {
        const server = createBridge({ port, serialDriver: driver, serialToken, authorizeReplacement, exclusiveWorkspace: true });
        await once(server, 'listening');
        return server;
    };
    let server;
    try {
        server = await listen();
    } catch (error) {
        if (error.code !== 'EADDRINUSE') throw error;
        if (!replace) throw new Error('本机端口 ' + port + ' 已被占用');
        try {
            await requestReplacement(port, replacementPath);
        } catch {
            throw new Error('本机端口 ' + port + ' 已被占用，无法确认是可接替的 Bridge。请关闭旧服务后再启动。');
        }
        console.log('正在接替旧 Bridge…');
        const deadline = Date.now() + 5000;
        while (!server) {
            try { server = await listen(); }
            catch (retryError) {
                if (retryError.code !== 'EADDRINUSE') throw retryError;
                if (Date.now() >= deadline) throw new Error('等待旧 Bridge 释放端口超时');
                await delay(75);
            }
        }
    }

    const temporaryPath = replacementPath + '.' + process.pid;
    try {
        await writeFile(temporaryPath, key, { flag: 'wx', mode: 0o600 });
        await rename(temporaryPath, replacementPath);
    } catch (error) {
        await unlink(temporaryPath).catch(() => {});
        await server.stop();
        throw new Error('无法保存本机接替凭据：' + error.message);
    }
    const stop = () => { void server.stop(); };
    process.once('SIGINT', stop);
    process.once('SIGTERM', stop);
    server.once('close', () => {
        process.removeListener('SIGINT', stop);
        process.removeListener('SIGTERM', stop);
    });
    console.log('Bridge 已启动: ws://127.0.0.1:' + port);
    console.log('Bridge 访问码: ' + serialToken);
    if (!driver) console.log('原生串口依赖未加载，当前提供 TCP / UDP。');
    if (openPage) openPlotterPage();
    return server;
}

module.exports = { startBridge };
