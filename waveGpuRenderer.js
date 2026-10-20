/** Draw the grid first, then waveform traces, below the crisp 2D axes and interaction overlay. */
class WaveGpuRenderer {
    constructor(canvas, onChange) {
        this.canvas = canvas;
        this.onChange = onChange;
        this.layer = null;
        this.gl = null;
        this.program = null;
        this.buffer = null;
        this.rendererName = '';
        this.vertices = new Float32Array(0);
        this.grid = null;
        this.width = 0;
        this.height = 0;
        this.pixelWidth = 0;
        this.pixelHeight = 0;
        if (!canvas?.ownerDocument?.createElement || !canvas.parentElement?.insertBefore) return;
        const layer = canvas.ownerDocument.createElement('canvas');
        layer.className = 'wave-gpu-canvas';
        layer.setAttribute?.('aria-hidden', 'true');
        const gl = layer.getContext?.('webgl', {
            alpha: true, antialias: true, depth: false, stencil: false, premultipliedAlpha: false,
            powerPreference: 'high-performance', failIfMajorPerformanceCaveat: true
        });
        if (!gl) return;
        this.layer = layer;
        this.gl = gl;
        if (!this._initialize()) { this.dispose(); return; }
        canvas.parentElement.insertBefore(layer, canvas);
        this._lost = event => {
            event.preventDefault();
            this.program = null;
            this.buffer = null;
            this.rendererName = '';
            this.layer.hidden = true;
            this.onChange?.();
        };
        this._restored = () => {
            if (this._initialize()) this.layer.hidden = false;
            this.onChange?.();
        };
        layer.addEventListener('webglcontextlost', this._lost);
        layer.addEventListener('webglcontextrestored', this._restored);
    }

    get available() { return !!(this.layer && this.program && !this.layer.hidden); }

    _initialize() {
        const gl = this.gl;
        const shader = (type, source) => {
            const item = gl.createShader(type);
            gl.shaderSource(item, source);
            gl.compileShader(item);
            if (gl.getShaderParameter(item, gl.COMPILE_STATUS)) return item;
            gl.deleteShader(item);
            return null;
        };
        const vertex = shader(gl.VERTEX_SHADER, `
            attribute vec2 position;
            uniform vec2 resolution;
            uniform float pointSize;
            void main() {
                vec2 clip = position / resolution * 2.0 - 1.0;
                gl_Position = vec4(clip.x, -clip.y, 0.0, 1.0);
                gl_PointSize = pointSize;
            }`);
        const fragment = shader(gl.FRAGMENT_SHADER, `
            precision mediump float;
            uniform vec4 color;
            void main() { gl_FragColor = color; }`);
        if (!vertex || !fragment) {
            if (vertex) gl.deleteShader(vertex);
            if (fragment) gl.deleteShader(fragment);
            return false;
        }
        const program = gl.createProgram();
        gl.attachShader(program, vertex);
        gl.attachShader(program, fragment);
        gl.linkProgram(program);
        gl.deleteShader(vertex);
        gl.deleteShader(fragment);
        if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
            gl.deleteProgram(program);
            return false;
        }
        this.program = program;
        this.buffer = gl.createBuffer();
        this.locations = {
            position: gl.getAttribLocation(program, 'position'),
            resolution: gl.getUniformLocation(program, 'resolution'),
            pointSize: gl.getUniformLocation(program, 'pointSize'),
            color: gl.getUniformLocation(program, 'color')
        };
        const ready = !!this.buffer && this.locations.position >= 0;
        if (ready) this.rendererName = this._readRendererName();
        return ready;
    }

    _readRendererName() {
        try {
            const info = this.gl.getExtension('WEBGL_debug_renderer_info');
            if (!info) return '';
            const name = this.gl.getParameter(info.UNMASKED_RENDERER_WEBGL);
            return typeof name === 'string' ? name.trim() : '';
        } catch { return ''; }
    }

    resize(width, height, pixelWidth, pixelHeight) {
        if (!this.layer) return;
        this.width = width;
        this.height = height;
        this.pixelWidth = pixelWidth;
        this.pixelHeight = pixelHeight;
        this.layer.style.left = `${this.canvas.offsetLeft || 0}px`;
        this.layer.style.top = `${this.canvas.offsetTop || 0}px`;
        this.layer.style.width = `${this.canvas.offsetWidth || width}px`;
        this.layer.style.height = `${this.canvas.offsetHeight || height}px`;
        if (this.layer.width !== pixelWidth) this.layer.width = pixelWidth;
        if (this.layer.height !== pixelHeight) this.layer.height = pixelHeight;
    }

    releaseTransientData() {
        this.vertices = new Float32Array(0); this.grid = null;
        if (this.buffer) {
            this.gl.bindBuffer(this.gl.ARRAY_BUFFER, this.buffer);
            this.gl.bufferData(this.gl.ARRAY_BUFFER, 0, this.gl.STREAM_DRAW);
        }
    }

    _gridFor(width, height) {
        if (this.grid?.width === width && this.grid.height === height) return this.grid;
        const vertices = [], counts = [];
        for (const step of [20, 100]) {
            const first = vertices.length / 2;
            for (let x = 0; x <= width; x += step) vertices.push(x, 0, x, height);
            for (let y = 0; y <= height; y += step) vertices.push(0, y, width, y);
            counts.push(vertices.length / 2 - first);
        }
        this.grid = { width, height, vertices: Float32Array.from(vertices), counts };
        return this.grid;
    }

    render(traces, width, height, plotWidth, plotHeight) {
        if (!this.available) return false;
        const gl = this.gl;
        if (gl.isContextLost?.()) { this.layer.hidden = true; this.onChange?.(); return false; }
        const grid = this._gridFor(plotWidth, plotHeight);
        const total = grid.vertices.length / 2 + traces.reduce((sum, trace) => sum + trace.points.length, 0);
        if (this.vertices.length < total * 2) {
            let size = Math.max(256, this.vertices.length);
            while (size < total * 2) size *= 2;
            this.vertices = new Float32Array(size);
        }
        this.vertices.set(grid.vertices);
        const commands = [
            { count: grid.counts[0], strips: [[0, grid.counts[0]]], color: '#1e1e1e', mode: gl.LINES },
            { count: grid.counts[1], strips: [[grid.counts[0], grid.counts[1]]], color: '#2e2e2e', mode: gl.LINES }
        ];
        let cursor = grid.vertices.length / 2;
        for (const trace of traces) {
            const first = cursor, strips = [];
            let stripStart = cursor;
            for (const point of trace.points) {
                if (point.break || !Number.isFinite(point.x) || !Number.isFinite(point.y)) {
                    if (cursor - stripStart >= 2) strips.push([stripStart, cursor - stripStart]);
                    stripStart = cursor;
                }
                if (!Number.isFinite(point.x) || !Number.isFinite(point.y)) continue;
                this.vertices[cursor * 2] = point.x;
                this.vertices[cursor * 2 + 1] = point.y;
                cursor++;
            }
            if (cursor - stripStart >= 2) strips.push([stripStart, cursor - stripStart]);
            commands.push({ first, count: cursor - first, strips, color: trace.color,
                dots: trace.dots || cursor - first === 1 });
        }
        gl.disable(gl.SCISSOR_TEST);
        gl.viewport(0, 0, this.pixelWidth, this.pixelHeight);
        gl.clearColor(0, 0, 0, 0);
        gl.clear(gl.COLOR_BUFFER_BIT);
        if (!cursor) return true;
        const densityX = this.pixelWidth / width, densityY = this.pixelHeight / height;
        const clipWidth = Math.min(this.pixelWidth, Math.ceil(plotWidth * densityX));
        const clipHeight = Math.min(this.pixelHeight, Math.ceil(plotHeight * densityY));
        gl.enable(gl.SCISSOR_TEST);
        gl.scissor(0, this.pixelHeight - clipHeight, clipWidth, clipHeight);
        gl.useProgram(this.program);
        gl.uniform2f(this.locations.resolution, width, height);
        gl.uniform1f(this.locations.pointSize, 3 * Math.min(densityX, densityY));
        gl.bindBuffer(gl.ARRAY_BUFFER, this.buffer);
        gl.bufferData(gl.ARRAY_BUFFER, this.vertices.subarray(0, cursor * 2), gl.STREAM_DRAW);
        gl.enableVertexAttribArray(this.locations.position);
        gl.vertexAttribPointer(this.locations.position, 2, gl.FLOAT, false, 0, 0);
        for (const command of commands) {
            if (!command.count) continue;
            const color = /^#[\da-f]{6}$/i.test(command.color) ? command.color : '#ffffff';
            gl.uniform4f(this.locations.color, parseInt(color.slice(1, 3), 16) / 255,
                parseInt(color.slice(3, 5), 16) / 255,
                parseInt(color.slice(5, 7), 16) / 255, 1);
            for (const [first, count] of command.strips) gl.drawArrays(command.mode ?? gl.LINE_STRIP, first, count);
            if (command.dots) gl.drawArrays(gl.POINTS, command.first, command.count);
        }
        gl.disable(gl.SCISSOR_TEST);
        return true;
    }

    dispose() {
        if (!this.layer) return;
        this.layer.removeEventListener?.('webglcontextlost', this._lost);
        this.layer.removeEventListener?.('webglcontextrestored', this._restored);
        if (this.program) this.gl.deleteProgram(this.program);
        if (this.buffer) this.gl.deleteBuffer(this.buffer);
        this.layer.width = this.layer.height = 1;
        try { this.gl.getExtension?.('WEBGL_lose_context')?.loseContext(); }
        catch { /* Some drivers block optional extensions; still release the remaining references. */ }
        this.layer.remove();
        this.layer = null;
        this.program = null;
        this.buffer = null;
        this.grid = null;
        this.vertices = new Float32Array(0);
        this.gl = null;
        this.rendererName = '';
    }
}

if (typeof module !== 'undefined') module.exports = { WaveGpuRenderer };
globalThis.SerialPlotter ??= {};
globalThis.SerialPlotter.WaveGpuRenderer = WaveGpuRenderer;
