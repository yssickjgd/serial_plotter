/** Input/textarea completion with a bounded DOM window and IME-safe keyboard handling. */
let channelAutocompleteSequence = 0;

function channelCompletionRange(input) {
    const value = String(input.value ?? ''), caret = input.selectionStart ?? value.length;
    const prefix = value.slice(0, caret), match = prefix.match(/[\p{L}\p{N}\p{M}_]+$/u);
    const text = match?.[0] ?? '';
    const selectedEnd = input.selectionEnd ?? caret;
    const suffix = value.slice(selectedEnd).match(/^[\p{L}\p{N}\p{M}_]+/u)?.[0] ?? '';
    return { start: caret - text.length, end: selectedEnd + suffix.length, query: text };
}

class ChannelAutocomplete {
    constructor(input, options = {}) {
        if (!input?.ownerDocument) throw new Error('自动补全需要 input 或 textarea');
        this.input = input; this.options = options; this.document = input.ownerDocument;
        this.limit = Math.max(1, Math.min(30, options.limit ?? 30)); this.rowHeight = options.rowHeight ?? 30;
        this.items = []; this.total = 0; this.offset = 0; this.activeIndex = 0; this.composing = false; this.open = false;
        this.popup = this.document.createElement('div');
        this.popup.id = `channel-completion-${++channelAutocompleteSequence}`;
        this.popup.className = 'channel-autocomplete'; this.popup.setAttribute('role', 'listbox'); this.popup.hidden = true;
        Object.assign(this.popup.style, { position: 'absolute', zIndex: '10000', overflowY: 'auto', maxHeight: `${this.rowHeight * 8}px` });
        (options.container ?? this.document.body).appendChild(this.popup);
        this.listeners = [];
        this.listen(input, 'input', event => { if (!this.composing && !event.isComposing) this.refresh(); });
        this.listen(input, 'focus', () => this.refresh());
        this.listen(input, 'click', () => this.refresh());
        this.listen(input, 'keydown', event => this.keydown(event));
        this.listen(input, 'compositionstart', () => { this.composing = true; this.close(); });
        this.listen(input, 'compositionend', () => { this.composing = false; this.refresh(); });
        this.listen(input, 'blur', () => this.close());
        this.listen(this.popup, 'mousedown', event => event.preventDefault());
        this.listen(this.popup, 'scroll', () => {
            const offset = Math.max(0, Math.min(this.total - this.limit, Math.floor(this.popup.scrollTop / this.rowHeight)));
            if (offset !== this.offset) this.render(offset);
        });
        this.previousAria = new Map(['aria-autocomplete', 'aria-controls', 'aria-expanded', 'aria-activedescendant']
            .map(name => [name, input.getAttribute(name)]));
        input.setAttribute('aria-autocomplete', 'list'); input.setAttribute('aria-controls', this.popup.id);
        input.setAttribute('aria-expanded', 'false');
    }

    listen(target, name, handler) { target.addEventListener(name, handler); this.listeners.push([target, name, handler]); }
    registry() { return this.options.getRegistry?.() ?? this.options.registry; }
    candidates(offset) {
        const registry = this.registry();
        if (registry?.query) return registry.query(this.range.query, { offset, limit: this.limit });
        const items = registry?.complete?.(this.range.query, this.limit, offset) ?? [];
        return { items, total: items.length };
    }

    refresh() {
        if (this.composing) return;
        this.range = (this.options.getRange ?? channelCompletionRange)(this.input); this.activeIndex = 0; this.offset = 0;
        // Numbers and incomplete numeric literals are not channel aliases.
        if (/^\d/.test(this.range.query)) { this.close(); return; }
        const result = this.candidates(0); this.total = result.total;
        if (!this.total) { this.close(); return; }
        this.popup.scrollTop = 0; this.open = true; this.popup.hidden = false;
        this.input.setAttribute('aria-expanded', 'true');
        const bounds = this.input.getBoundingClientRect?.();
        if (bounds) {
            const view = this.document.defaultView;
            Object.assign(this.popup.style, { left: `${bounds.left + (view?.scrollX ?? 0)}px`,
                top: `${bounds.bottom + (view?.scrollY ?? 0)}px`, minWidth: `${bounds.width}px` });
        }
        this.render(0, result.items);
        this.options.positionPopup?.(this.popup, bounds);
    }

    render(offset = 0, items) {
        this.offset = offset; this.items = items ?? this.candidates(offset).items;
        if (this.activeIndex < offset || this.activeIndex >= offset + this.items.length) this.activeIndex = offset;
        this.popup.replaceChildren();
        const spacer = height => {
            const element = this.document.createElement('div'); element.setAttribute('aria-hidden', 'true');
            element.style.height = `${height}px`; return element;
        };
        if (offset) this.popup.appendChild(spacer(offset * this.rowHeight));
        for (let index = 0; index < this.items.length; index++) {
            const item = this.items[index], number = offset + index, choice = this.document.createElement('div');
            choice.className = 'channel-autocomplete-option'; choice.id = `${this.popup.id}-${number}`;
            choice.setAttribute('role', 'option'); choice.setAttribute('aria-selected', String(number === this.activeIndex));
            choice.setAttribute('aria-posinset', String(number + 1)); choice.setAttribute('aria-setsize', String(this.total));
            choice.textContent = item.name === item.label ? item.label : `${item.label}  ${item.name}`;
            if (item.description) choice.title = item.description;
            choice.style.height = `${this.rowHeight}px`; choice.style.boxSizing = 'border-box';
            choice.addEventListener('click', () => this.select(number)); this.popup.appendChild(choice);
        }
        const remaining = this.total - offset - this.items.length;
        if (remaining > 0) this.popup.appendChild(spacer(remaining * this.rowHeight));
        this.input.setAttribute('aria-activedescendant', `${this.popup.id}-${this.activeIndex}`);
    }

    keydown(event) {
        if (this.composing || event.isComposing || event.keyCode === 229) return;
        if (this.options.explicitShortcut && (event.ctrlKey || event.metaKey) && (event.key === ' ' || event.code === 'Space')) {
            event.preventDefault(); event.stopPropagation?.(); this.refresh(); return;
        }
        if (event.ctrlKey || event.metaKey || event.altKey) return;
        const handled = () => { event.preventDefault(); if (this.options.stopPropagation) event.stopPropagation?.(); };
        if (event.key === 'Escape' && this.open) { handled(); this.close(); return; }
        if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
            const wasOpen = this.open;
            if (!wasOpen) this.refresh();
            if (!this.open) return;
            handled();
            if (wasOpen) this.activeIndex = (this.activeIndex + (event.key === 'ArrowDown' ? 1 : -1) + this.total) % this.total;
            else if (event.key === 'ArrowUp') this.activeIndex = this.total - 1;
            const first = Math.max(0, Math.min(this.total - this.limit, this.activeIndex - Math.floor(this.limit / 2)));
            this.render(first);
            this.popup.scrollTop = Math.max(0, (this.activeIndex - 3) * this.rowHeight);
        } else if ((event.key === 'Enter' || event.key === 'Tab') && this.open) {
            handled(); this.select(this.activeIndex);
        }
    }

    select(index = this.activeIndex) {
        const item = index >= this.offset && index < this.offset + this.items.length
            ? this.items[index - this.offset] : this.candidates(index).items[0];
        if (!item || this.composing) return;
        const { start, end } = this.range;
        const value = String(this.input.value), text = item.value ?? item.label;
        this.input.value = value.slice(0, start) + text + value.slice(end);
        const caret = start + (item.caretOffset ?? text.length);
        this.input.setSelectionRange?.(caret, caret);
        this.close();
        const EventType = this.document.defaultView?.Event ?? globalThis.Event;
        if (EventType) this.input.dispatchEvent(new EventType('input', { bubbles: true }));
        // The synthetic input event must not reopen the list after committing a choice.
        this.close(); this.options.onSelect?.(item);
        return item;
    }

    close() {
        this.open = false; this.popup.hidden = true;
        this.input.setAttribute('aria-expanded', 'false'); this.input.removeAttribute('aria-activedescendant');
    }
    destroy() {
        for (const [target, name, handler] of this.listeners) target.removeEventListener(name, handler);
        this.popup.remove();
        for (const [name, value] of this.previousAria) {
            if (value === null) this.input.removeAttribute(name); else this.input.setAttribute(name, value);
        }
    }
    static attach(input, options) { return new ChannelAutocomplete(input, options); }
}

function attachChannelAutocomplete(input, options) { return ChannelAutocomplete.attach(input, options); }
const ChannelAutocompleteApi = { ChannelAutocomplete, attachChannelAutocomplete, channelCompletionRange };
globalThis.SerialPlotter ??= {};
Object.assign(globalThis.SerialPlotter, ChannelAutocompleteApi);
if (typeof module !== 'undefined') module.exports = ChannelAutocompleteApi;
