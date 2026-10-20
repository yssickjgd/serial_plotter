const test = require('node:test');
const assert = require('node:assert/strict');

function gpuFixture(enabled = true) {
    const calls = [];
    const gl = new Proxy({
        ARRAY_BUFFER: 1, STREAM_DRAW: 2, FLOAT: 3, VERTEX_SHADER: 4, FRAGMENT_SHADER: 5,
        COMPILE_STATUS: 6, LINK_STATUS: 7, COLOR_BUFFER_BIT: 8, SCISSOR_TEST: 9,
        LINE_STRIP: 10, POINTS: 11, LINES: 12
    }, { get(target, key) {
        if (key in target) return target[key];
        if (key === 'createShader' || key === 'createProgram' || key === 'createBuffer') return () => ({});
        if (key === 'getShaderParameter' || key === 'getProgramParameter') return () => true;
        if (key === 'getAttribLocation') return () => 0;
        if (key === 'getUniformLocation') return () => ({});
        return (...args) => { calls.push([key, ...args]); };
    } });
    const listeners = new Map();
    const layer = { style: {}, width: 0, height: 0, hidden: false,
        getContext(name, options) { calls.push(['getContext', name, options]); return enabled ? gl : null; },
        addEventListener(name, handler) { listeners.set(name, handler); },
        removeEventListener(name) { listeners.delete(name); },
        remove() { calls.push(['remove']); }
    };
    const parent = { insertBefore(node, before) { calls.push(['insertBefore', node, before]); } };
    const canvas = { offsetLeft: 2, offsetTop: 35, offsetWidth: 800, offsetHeight: 400,
        parentElement: parent, ownerDocument: { createElement: () => layer } };
    return { canvas, layer, gl, calls, listeners };
}

test('GPU trace renderer requests a high-performance adapter and preserves gaps and plot clipping', () => {
    const { WaveGpuRenderer } = require('../waveGpuRenderer');
    const f = gpuFixture();
    const renderer = new WaveGpuRenderer(f.canvas, () => {});
    assert.equal(renderer.available, true);
    const request = f.calls.find(call => call[0] === 'getContext');
    assert.equal(request[2].powerPreference, 'high-performance');
    assert.equal(request[2].depth, false, '2D traces do not need a depth buffer');
    assert.equal(request[2].stencil, false);
    renderer.resize(800, 400, 1600, 800);
    assert.equal(f.layer.style.top, '35px');
    assert.equal(f.layer.width, 1600);
    assert.equal(renderer.render([{ color: '#ff0000', dots: false, points: [
        { x: 0, y: 10 }, { x: 10, y: 20 },
        { x: 20, y: 30, break: true }, { x: 30, y: 40 }
    ] }], 800, 400, 700, 378), true);
    const draws = f.calls.filter(call => call[0] === 'drawArrays' && call[1] === f.gl.LINE_STRIP);
    const firstTraceVertex = draws[0][2];
    assert.deepEqual(draws.map(call => call.slice(1)),
        [[f.gl.LINE_STRIP, firstTraceVertex, 2], [f.gl.LINE_STRIP, firstTraceVertex + 2, 2]]);
    assert.deepEqual(f.calls.find(call => call[0] === 'scissor').slice(1), [0, 44, 1400, 756]);
    renderer.dispose();
    assert.equal(f.calls.some(call => call[0] === 'remove'), true);
});

test('disposing a GPU renderer releases its context and CPU vertex storage immediately', () => {
    const { WaveGpuRenderer } = require('../waveGpuRenderer');
    const f = gpuFixture();
    let losses = 0;
    f.gl.getExtension = name => name === 'WEBGL_lose_context' ? { loseContext() { losses++; } } : null;
    const renderer = new WaveGpuRenderer(f.canvas, () => {});
    renderer.resize(800, 400, 1600, 800);
    renderer.render([{ color: '#ff0000', points: [{ x: 0, y: 1 }, { x: 1, y: 2 }] }], 800, 400, 700, 378);
    renderer.dispose(); renderer.dispose();
    assert.equal(losses, 1);
    assert.equal(renderer.vertices.byteLength, 0);
    assert.equal(f.layer.width * f.layer.height, 1);
    assert.equal(renderer.gl, null);
});

test('GPU trace renderer falls back when hardware is unavailable and redraws after context recovery', () => {
    const { WaveGpuRenderer } = require('../waveGpuRenderer');
    const unavailable = gpuFixture(false);
    const fallback = new WaveGpuRenderer(unavailable.canvas, () => {});
    assert.equal(fallback.available, false);
    assert.equal(fallback.render([], 800, 400, 700, 378), false);
    const f = gpuFixture();
    let updates = 0;
    const renderer = new WaveGpuRenderer(f.canvas, () => { updates++; });
    let prevented = false;
    f.listeners.get('webglcontextlost')({ preventDefault() { prevented = true; } });
    assert.equal(prevented, true);
    assert.equal(renderer.available, false);
    assert.equal(f.layer.hidden, true);
    f.listeners.get('webglcontextrestored')();
    assert.equal(renderer.available, true);
    assert.equal(f.layer.hidden, false);
    assert.equal(updates, 2);
    renderer.dispose();
});

test('GPU grid renders below traces and remains visible without samples after resize and recovery', () => {
    const { WaveGpuRenderer } = require('../waveGpuRenderer');
    const f = gpuFixture();
    const renderer = new WaveGpuRenderer(f.canvas, () => {});
    renderer.resize(100, 80, 200, 160);
    const trace = { color: '#ff0000', points: [{ x: 0, y: 10 }, { x: 30, y: 20 }] };
    f.calls.length = 0;
    renderer.render([trace], 100, 80, 30, 25);
    let draws = f.calls.filter(call => call[0] === 'drawArrays');
    assert.deepEqual(draws.map(call => call[1]), [f.gl.LINES, f.gl.LINES, f.gl.LINE_STRIP],
        'both grid shades must be drawn before the waveform in the same GPU layer');
    assert.deepEqual(draws.slice(0, 2).map(call => call[3]), [8, 4]);
    f.listeners.get('webglcontextlost')({ preventDefault() {} });
    f.listeners.get('webglcontextrestored')();
    renderer.resize(200, 160, 400, 320);
    f.calls.length = 0;
    renderer.render([], 200, 160, 130, 105);
    draws = f.calls.filter(call => call[0] === 'drawArrays');
    assert.deepEqual(draws.map(call => call[1]), [f.gl.LINES, f.gl.LINES]);
    assert.deepEqual(draws.map(call => call[3]), [26, 8],
        'clearing samples keeps a grid sized to the current plot bounds');
    renderer.dispose();
});

test('GPU diagnostics report the actual renderer once at initialization and refresh after recovery', () => {
    const { WaveGpuRenderer } = require('../waveGpuRenderer');
    const f = gpuFixture();
    let name = 'ANGLE (Intel, Intel(R) UHD Graphics, D3D11)', reads = 0;
    f.gl.getExtension = extension => extension === 'WEBGL_debug_renderer_info' ? { UNMASKED_RENDERER_WEBGL: 42 } : null;
    f.gl.getParameter = parameter => { assert.equal(parameter, 42); reads++; return name; };
    const renderer = new WaveGpuRenderer(f.canvas, () => {});
    assert.equal(renderer.rendererName, name);
    renderer.resize(800, 400, 800, 400);
    renderer.render([], 800, 400, 700, 378);
    renderer.render([], 800, 400, 700, 378);
    assert.equal(reads, 1, 'GPU diagnostics must not add synchronous reads to the frame loop');
    f.listeners.get('webglcontextlost')({ preventDefault() {} });
    assert.equal(renderer.rendererName, '');
    name = 'ANGLE (NVIDIA, NVIDIA GeForce RTX 4060 Laptop GPU, D3D11)';
    f.listeners.get('webglcontextrestored')();
    assert.equal(renderer.rendererName, name);
    assert.equal(reads, 2);
    renderer.dispose();
    assert.equal(renderer.rendererName, '');
});

test('unavailable or blocked renderer diagnostics never disable GPU rendering', () => {
    const { WaveGpuRenderer } = require('../waveGpuRenderer');
    for (const blocked of [false, true]) {
        const f = gpuFixture();
        f.gl.getExtension = () => { if (blocked) throw new Error('driver information blocked'); return null; };
        const renderer = new WaveGpuRenderer(f.canvas, () => {});
        assert.equal(renderer.available, true);
        assert.equal(renderer.rendererName, '', 'unknown hardware must not be reported as a discrete GPU');
        renderer.dispose();
    }
});
