const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function bootApplication(config = null, options = {}) {
    const root = path.resolve(__dirname, '../..');
    const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
    const downloads = [], blobs = [], alerts = [], timers = new Map(), intervals = new Map(), rafs = new Map();
    let clock = 1000, nextId = 0, writes = 0;
    class Element {
        constructor(tag = 'div') {
            this.tagName = tag.toUpperCase(); this.children = []; this.dataset = {}; this.listeners = new Map();
            this.style = { setProperty(name, value) { this[name] = value; } };
            this.attributes = {}; this.className = ''; this._text = ''; this._value = undefined;
            this.checked = false; this.hidden = false; this.disabled = false;
            this.clientWidth = 800; this.clientHeight = 600; this.offsetWidth = 200; this.offsetHeight = 20;
            this.scrollTop = 0; this.scrollLeft = 0;
            this.classList = {
                contains: name => this.className.split(/\s+/).includes(name),
                add: (...names) => { this.className = [...new Set([...this.className.split(/\s+/).filter(Boolean), ...names])].join(' '); },
                remove: (...names) => { this.className = this.className.split(/\s+/).filter(name => !names.includes(name)).join(' '); },
                toggle: (name, force) => { const enabled = force ?? !this.classList.contains(name);
                    this.classList[enabled ? 'add' : 'remove'](name); return enabled; }
            };
        }
        get ownerDocument() { return document; }
        get parentElement() { return this.parentNode; }
        get firstElementChild() { return this.children[0] ?? null; }
        get options() { return this.children.filter(node => node.tagName === 'OPTION'); }
        get value() { return this._value ?? (this.tagName === 'SELECT'
            ? (this.options.find(option => option.selected) ?? this.options[0])?.value ?? '' : ''); }
        set value(value) { this._value = String(value); }
        get selectedIndex() { return this.options.findIndex(option => option.value === this.value); }
        set selectedIndex(index) { this.value = this.options[index]?.value ?? ''; }
        get textContent() { return this._text + this.children.map(child => child.textContent).join(''); }
        set textContent(text) { this._text = String(text ?? ''); this.children = []; }
        get scrollHeight() { return Math.max(this.clientHeight, ...this.children.map(child => parseFloat(child.style.height) || 0)); }
        get scrollWidth() { return this.clientWidth; }
        setAttribute(key, value = '') {
            this.attributes[key] = String(value);
            if (key === 'class') this.className = value;
            else if (key === 'style') { for (const declaration of value.split(';')) {
                const [name, setting] = declaration.split(':'); if (setting !== undefined) this.style[name.trim()] = setting.trim();
            } }
            else if (key.startsWith('data-')) this.dataset[key.slice(5).replace(/-([a-z])/g, (_, c) => c.toUpperCase())] = value;
            else if (['checked', 'disabled', 'hidden', 'selected'].includes(key)) this[key] = true;
            else this[key] = String(value);
        }
        getAttribute(key) { return this.attributes[key] ?? null; }
        addEventListener(name, fn) { if (!this.listeners.has(name)) this.listeners.set(name, new Set()); this.listeners.get(name).add(fn); }
        removeEventListener(name, fn) { this.listeners.get(name)?.delete(fn); }
        dispatchEvent(event) {
            event.target ??= this; event.preventDefault ??= () => {}; event.stopPropagation ??= () => {};
            for (const fn of [...(this.listeners.get(event.type) ?? [])]) fn(event);
            this[`on${event.type}`]?.(event);
            if (event.bubbles && this.parentNode) this.parentNode.dispatchEvent(event);
            return true;
        }
        click() { this.dispatchEvent({ type: 'click', target: this }); }
        append(...children) { children.forEach(child => this.appendChild(child)); }
        appendChild(child) {
            if (child.tagName === '#FRAGMENT') { [...child.children].forEach(node => this.appendChild(node)); return child; }
            child.remove(); child.parentNode = this; this.children.push(child); return child;
        }
        replaceChildren(...children) { this.children.forEach(child => { child.parentNode = null; }); this.children = []; this._text = ''; this.append(...children); }
        remove() { if (this.parentNode) this.parentNode.children = this.parentNode.children.filter(child => child !== this); this.parentNode = null; }
        contains(node) { return node === this || this.children.some(child => child.contains(node)); }
        matches(selector) {
            const attribute = selector.match(/\[([^=\]]+)(?:="?([^"\]]+)"?)?\]/);
            const cls = selector.match(/\.([\w-]+)/), id = selector.match(/#([\w-]+)/), tag = selector.match(/^[\w-]+/);
            return (!tag || this.tagName === tag[0].toUpperCase()) && (!cls || this.classList.contains(cls[1])) &&
                (!id || this.id === id[1]) && (!attribute || this.getAttribute(attribute[1]) !== null &&
                    (attribute[2] === undefined || this.getAttribute(attribute[1]) === attribute[2]));
        }
        closest(selector) { return selector.split(',').some(part => this.matches(part.trim())) ? this : this.parentNode?.closest(selector) ?? null; }
        querySelectorAll(selector) {
            const result = []; const choices = selector.split(',').map(part => part.trim());
            const walk = node => { for (const child of node.children) { if (choices.some(choice => child.matches(choice))) result.push(child); if (child.tagName !== 'TEMPLATE') walk(child); } };
            walk(this); return result;
        }
        querySelector(selector) { return this.querySelectorAll(selector)[0] ?? null; }
        cloneNode(deep) {
            const copy = new Element(this.tagName);
            for (const [key, value] of Object.entries(this.attributes)) copy.setAttribute(key, value);
            copy._text = this._text; copy._value = this._value;
            if (deep) this.children.forEach(child => copy.appendChild(child.cloneNode(true)));
            return copy;
        }
        getBoundingClientRect() { return { width: this.className === 'monitor-measure' ? 80 : this.clientWidth,
            height: this.clientHeight, left: 0, top: 0, right: this.clientWidth, bottom: this.clientHeight }; }
        getContext() { return new Proxy({}, { get: (_, key) => key === 'measureText' ? () => ({ width: 40 }) : () => {} }); }
        setPointerCapture(id) { this.capture = id; }
        hasPointerCapture(id) { return this.capture === id; }
        releasePointerCapture() { this.capture = null; }
    }
    const document = new Element('#document');
    document.createElement = tag => { const node = new Element(tag); if (tag === 'a') downloads.push(node); return node; };
    document.createDocumentFragment = () => new Element('#fragment');
    document.getElementById = id => document.querySelectorAll('*').find(node => node.id === id) ?? null;
    document.getSelection = () => null;
    const stack = [document], voids = new Set(['meta', 'link', 'input', 'br', 'hr', 'img']);
    for (const token of html.match(/<!--[\s\S]*?-->|<![^>]*>|<[^>]*>|[^<]+/g) ?? []) {
        if (token.startsWith('<!')) continue;
        if (token.startsWith('</')) { if (stack.length > 1) stack.pop(); continue; }
        if (token.startsWith('<')) {
            const match = /^<([\w-]+)/.exec(token); if (!match) continue;
            const tag = match[1], node = new Element(tag);
            for (const attribute of token.slice(match[0].length).matchAll(/([\w-]+)(?:="([^"]*)")?/g))
                node.setAttribute(attribute[1], attribute[2] ?? '');
            stack.at(-1).appendChild(node);
            if (tag === 'template') { node.content = new Element('#fragment'); stack.push(node.content); }
            else if (!voids.has(tag) && !token.endsWith('/>')) stack.push(node);
        } else stack.at(-1)._text += token;
    }
    document.body = document.querySelector('body');
    const window = new Element('window'); document.defaultView = window;
    const storage = new Map(config === null ? [] : [['serialplot_v3_config', typeof config === 'string' ? config : JSON.stringify(config)]]);
    if (options.layout) storage.set('serialplot_v3_workspace', JSON.stringify(options.layout));
    const context = vm.createContext({ document, window, navigator: {}, performance: { now: () => clock },
        Uint8Array, Float64Array, TextEncoder, TextDecoder, Blob, Date, console,
        URL: { createObjectURL(blob) { blobs.push(blob); return 'blob:test'; }, revokeObjectURL() {} },
        localStorage: { getItem: key => storage.get(key) ?? null, setItem: (key, value) => { writes++; storage.set(key, value); } },
        alert: message => alerts.push(message),
        setTimeout(fn, delay = 0) { const id = ++nextId; timers.set(id, { fn, due: clock + delay }); return id; },
        clearTimeout: id => timers.delete(id),
        setInterval(fn) { const id = ++nextId; intervals.set(id, fn); return id; }, clearInterval: id => intervals.delete(id),
        requestAnimationFrame(fn) { const id = ++nextId; rafs.set(id, fn); return id; }, cancelAnimationFrame: id => rafs.delete(id),
        ResizeObserver: class { observe() {} disconnect() {} },
        Event: class { constructor(type, options) { this.type = type; Object.assign(this, options); } }
    });
    for (const [, script] of html.matchAll(/<script src="([^"]+)"/g))
        vm.runInContext(fs.readFileSync(path.join(root, script), 'utf8'), context, { filename: script });
    document.dispatchEvent({ type: 'DOMContentLoaded' });
    return { app: context.SerialPlotter.application, S: context.SerialPlotter, document, context, window, timers, intervals, rafs,
        get: id => document.getElementById(id), alerts, blobs, downloads, storage, get writes() { return writes; },
        change(id, value) { const node = document.getElementById(id); if (typeof value === 'boolean') node.checked = value; else node.value = value;
            node.dispatchEvent({ type: 'change', bubbles: true }); },
        click: id => document.getElementById(id).click(),
        async tick(ms = 1000) {
            clock += ms;
            for (let i = 0; i < 1000; i++) { const due = [...timers].find(([, timer]) => timer.due <= clock); if (!due) break;
                timers.delete(due[0]); due[1].fn(); }
            const callbacks = [...rafs.values()]; rafs.clear(); callbacks.forEach(fn => fn(clock));
            intervals.forEach(fn => fn());
            for (let i = 0; i < 10; i++) await Promise.resolve();
        },
        async settle() { for (let i = 0; i < 50; i++) { await this.tick(10);
            if (![...this.app.service.sources].some(source => source.rebuilding)) return; } throw new Error('rebuild stalled'); }
    };
}

module.exports = { bootApplication };
