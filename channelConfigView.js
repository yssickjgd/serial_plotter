/** Shared channel metadata with independent widget visibility and bounded DOM rows. */
class ChannelConfigView {
    constructor(document, controller) {
        this.document = document; this.controller = controller; this.expanded = new Set(); this.drafts = new Map(); this.listeners = new Map();
        this.rowHeight = 32; this.windowSize = 50; this.metadata = new Map(); this.windows = new Map();
    }
    clear(list) {
        if (!list) return;
        for (const cleanup of this.listeners.get(list) ?? []) cleanup();
        this.listeners.delete(list); this.metadata.delete(list); this.windows.delete(list); list.replaceChildren();
    }
    dispose() {
        for (const list of [...this.listeners.keys()]) this.clear(list);
        this.expanded.clear(); this.drafts.clear();
    }
    field(list, index, role) {
        const row = [...list.children].find(row => row.dataset.channelNumber === String(index + 1));
        return row ? [...row.children].find(child => child.getAttribute('data-role') === role) : null;
    }
    showError(widget, message) {
        const status = this.document.getElementById(`channel-edit-status-${widget.type}`);
        if (status) { status.textContent = message; status.hidden = !message; }
    }
    setChannelName(index, name) {
        for (const [list, channels] of this.metadata) {
            const channel = channels.find(channel => channel.index === index);
            if (!channel) continue;
            channel.name = name;
            const input = this.field(list, index, 'channel-name');
            if (input) {
                if (input.value !== name) input.value = name;
                input.title = name; input.removeAttribute('aria-invalid'); input.setCustomValidity?.('');
            }
            this.field(list, index, 'channel-visible')?.setAttribute('aria-label',
                `显示 ${globalThis.SerialPlotter.formatChannelId(index)} ${name}`);
            this.windows.get(list)?.refilter();
        }
    }
    setChannelColor(index, color) {
        for (const [list, channels] of this.metadata) {
            const channel = channels.find(channel => channel.index === index);
            if (!channel) continue;
            channel.color = color;
            const input = this.field(list, index, 'channel-color');
            if (input && input.value !== color) input.value = color;
        }
    }
    locateFirst(list) {
        this.windows.get(list)?.locateFirst();
    }
    render(list, widget) {
        if (!list || !widget) return;
        this.clear(list);
        const symbols = this.document.getElementById(`channel-symbols-${widget.type}`);
        if (symbols && !symbols.children.length) symbols.append(globalThis.SerialPlotter.createReservedNamesHelp(this.document, 'channel'));
        const help = this.document.getElementById(`channel-help-${widget.type}`);
        if (help) help.textContent = '名称和颜色全局共用；勾选仅控制当前控件的可见性。';
        const cleanups = []; this.listeners.set(list, cleanups);
        const all = this.controller.channelMeta().filter(channel => !widget.channelCategory || widget.channelCategory === 'all' ||
            (channel.definition?.type ?? 'raw') === widget.channelCategory);
        const query = String(this.controller.channelSearchText ?? '').trim().normalize('NFC').toLocaleLowerCase();
        const reference = /^ch0*(\d+)$/i.exec(query);
        const filter = () => all.filter(channel => !query || (reference ? channel.number === Number(reference[1]) :
            `${globalThis.SerialPlotter.formatChannelId(channel.index)} ${channel.name}`.normalize('NFC').toLocaleLowerCase().includes(query)));
        let channels = filter();
        const count = this.document.getElementById(`channel-search-status-${widget.type}`);
        if (count) count.textContent = `${channels.length} / ${all.length}`;
        this.showError(widget, '');
        this.metadata.set(list, all);
        list.style.overflowY = 'visible'; list.style.maxHeight = 'none';
        const scrollHost = list.closest?.('.tab-content') ?? list;
        let active = true;
        cleanups.push(() => { active = false; });
        let rowCleanups = [], previousStart = -1, previousEnd = -1;
        const clearRows = () => { for (const cleanup of rowCleanups) cleanup(); rowCleanups = []; };
        cleanups.push(clearRows);
        const listenRow = (input, event, handler) => {
            input.addEventListener(event, handler); rowCleanups.push(() => input.removeEventListener(event, handler));
        };
        const renderWindow = () => {
            if (!active) return;
            // Account for the controls above the list in the tab's scroll area.
            const offset = scrollHost === list ? list.scrollTop || 0 :
                Math.max(0, scrollHost.getBoundingClientRect().top - list.getBoundingClientRect().top);
            const windowSize = scrollHost === list ? this.windowSize :
                Math.max(this.windowSize, Math.ceil((scrollHost.clientHeight || 0) / this.rowHeight) + 10);
            const start = Math.max(0, Math.min(channels.length - windowSize, Math.floor(offset / this.rowHeight) - 5));
            const end = Math.min(channels.length, start + windowSize), rows = [];
            if (start === previousStart && end === previousEnd) return;
            previousStart = start; previousEnd = end; clearRows();
            const spacer = height => {
                const node = this.document.createElement('div'); node.style.height = `${height}px`;
                node.setAttribute('aria-hidden', 'true'); return node;
            };
            if (start) rows.push(spacer(start * this.rowHeight));
            for (let at = start; at < end; at++) {
                const channel = channels[at], { index, number } = channel;
                const row = this.document.createElement('div'); row.className = 'channel-config-row channel-config-main channel-visibility-row';
                row.dataset.channelNumber = String(number); row.style.minHeight = `${this.rowHeight}px`;
                row.style.gridTemplateColumns = '68px 22px minmax(0, 1fr) 18px';
                const label = this.document.createElement('span'); label.className = 'channel-label';
                label.textContent = globalThis.SerialPlotter.formatChannelId(index);
                const color = this.document.createElement('input'); color.type = 'color'; color.value = channel.color;
                color.setAttribute('data-role', 'channel-color'); color.setAttribute('aria-label', `${label.textContent} 颜色（全局共用）`);
                listenRow(color, 'input', () => {
                    try { this.controller.setChannelColor(index, color.value); channel.color = color.value; }
                    catch (error) { this.showError(widget, error.message); }
                });
                const name = this.document.createElement('input'); name.type = 'text'; name.className = 'channel-readonly-name channel-name-editor';
                name.value = channel.name; name.title = channel.name; name.setAttribute('data-role', 'channel-name');
                name.setAttribute('aria-label', `${label.textContent} 名称（全局共用）`);
                const clearError = () => { name.removeAttribute('aria-invalid'); name.setCustomValidity?.(''); name.title = channel.name; this.showError(widget, ''); };
                const commitName = () => {
                    try {
                        if (name.value !== channel.name) { this.controller.setChannelName(index, name.value); channel.name = name.value; }
                        clearError();
                    } catch (error) {
                        name.setAttribute('aria-invalid', 'true'); name.setCustomValidity?.(error.message); name.title = error.message;
                        this.showError(widget, error.message); name.reportValidity?.();
                    }
                };
                listenRow(name, 'change', commitName);
                listenRow(name, 'keydown', event => {
                    if (event.isComposing || event.keyCode === 229) return;
                    if (event.key === 'Enter') { event.preventDefault(); commitName(); }
                    if (event.key === 'Escape') { event.preventDefault(); name.value = channel.name; clearError(); }
                });
                const visible = this.document.createElement('input'); visible.type = 'checkbox';
                visible.checked = this.controller.channelVisible(widget, index); visible.disabled = !channel.signal;
                visible.setAttribute('data-role', 'channel-visible'); visible.setAttribute('aria-label', `显示 ${label.textContent} ${channel.name}`);
                visible.title = channel.signal ? '当前控件的可见性' : '此通道不是当前显示方式的信号';
                listenRow(visible, 'change', () => this.controller.setChannelVisible(index, visible.checked));
                row.append(label, color, name, visible); rows.push(row);
            }
            if (end < channels.length) rows.push(spacer((channels.length - end) * this.rowHeight));
            if (!channels.length) {
                const empty = this.document.createElement('p'); empty.className = 'hint-text'; empty.textContent = '没有匹配的通道'; rows.push(empty);
            }
            list.replaceChildren(...rows);
        };
        scrollHost.addEventListener('scroll', renderWindow);
        cleanups.push(() => scrollHost.removeEventListener('scroll', renderWindow));
        const Observer = this.document.defaultView?.ResizeObserver ?? globalThis.ResizeObserver;
        if (Observer && scrollHost !== list) {
            const observer = new Observer(renderWindow); observer.observe(scrollHost);
            cleanups.push(() => observer.disconnect());
        }
        this.windows.set(list, {
            refilter: () => {
                const next = filter();
                if (count) count.textContent = `${next.length} / ${all.length}`;
                if (channels.length === next.length && channels.every((channel, index) => channel === next[index])) return;
                channels = next; previousStart = previousEnd = -1; renderWindow();
            },
            locateFirst: () => {
                scrollHost.scrollTop = scrollHost === list ? 0 : Math.max(0,
                    scrollHost.scrollTop + list.getBoundingClientRect().top - scrollHost.getBoundingClientRect().top);
                renderWindow();
                [...list.children].find(row => row.dataset.channelNumber)?.scrollIntoView?.({ block: 'nearest' });
            }
        });
        renderWindow();
    }
}

globalThis.SerialPlotter ??= {};
globalThis.SerialPlotter.ChannelConfigView = ChannelConfigView;
if (typeof module !== 'undefined') module.exports = { ChannelConfigView };
