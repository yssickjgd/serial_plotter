/** Shared navigation for the channel menus in the inspector and workspace search. */
(function (root) {
    const size = 40;
    const clamp = (page, pages) => Math.max(0, Math.min(page, pages - 1));
    function toolbar(doc, filterId, filterLabel) {
        const bar = doc.createElement('div'); bar.className = 'channel-picker-toolbar channel-menu-toolbar';
        const filter = doc.createElement('input'); filter.type = 'search'; filter.id = filterId;
        filter.placeholder = '通道编号或名称'; filter.setAttribute?.('aria-label', filterLabel);
        const previous = doc.createElement('button'), next = doc.createElement('button'), summary = doc.createElement('span');
        previous.type = next.type = 'button'; previous.textContent = '上一页'; next.textContent = '下一页';
        summary.setAttribute?.('role', 'status');
        bar.append(filter, previous, summary, next);
        return { toolbar: bar, filter, previous, next, summary, update(total, page, disabled = false) {
            filter.disabled = disabled;
            previous.disabled = disabled || page <= 0; next.disabled = disabled || (page + 1) * size >= total;
            summary.textContent = total ? `${page * size + 1}–${Math.min(total, (page + 1) * size)} / ${total}` : '无匹配通道';
        } };
    }
    function channelName(index, name) {
        const code = 'CH' + String(index + 1).padStart(5, '0');
        return !name || /^CH0*\d+$/i.test(name) && Number(name.slice(2)) === index + 1 ? code : code + ' · ' + name;
    }
    class Single {
        constructor(doc, input, { filterId, filterLabel }) {
            this.doc = doc; this.input = input; this.page = 0; this.channels = [];
            this.win = doc.defaultView; this.cleanups = [];
            const { update, ...controls } = toolbar(doc, filterId, filterLabel);
            Object.assign(this, controls); this.updateToolbar = update;
            const wrap = input.parentElement, label = wrap.querySelector('label');
            this.trigger = doc.createElement('button'); this.trigger.type = 'button';
            this.caption = doc.createElement('span'); this.trigger.append(this.caption);
            this.trigger.id = input.id + '-toggle'; this.trigger.className = 'channel-binding-toggle';
            this.trigger.setAttribute('aria-haspopup', 'dialog'); this.trigger.setAttribute('aria-expanded', 'false');
            this.popup = doc.createElement('div'); this.popup.className = 'search-channel-options binding-channel-options';
            this.popup.id = input.id + '-options'; this.popup.hidden = true; this.popup.setAttribute('role', 'dialog');
            if (this.popup.showPopover) this.popup.setAttribute('popover', 'manual');
            this.trigger.setAttribute('aria-controls', this.popup.id);
            if (label) {
                label.id ||= input.id + '-label'; label.setAttribute('for', this.trigger.id);
                this.trigger.setAttribute('aria-labelledby', label.id + ' ' + this.trigger.id);
                this.popup.setAttribute('aria-labelledby', label.id);
            }
            this.rows = doc.createElement('div'); this.rows.className = 'search-channel-results';
            this.popup.append(this.toolbar, this.rows); wrap.append(this.trigger, this.popup); input.hidden = true;
            this.trigger.addEventListener('click', () => this.popup.hidden ? this.open() : this.close(true));
            this.filter.addEventListener('input', () => {
                this.page = 0; this.render(); this.rows.scrollTop = 0;
            });
            const step = delta => { this.page += delta; this.render(); this.rows.scrollTop = 0; };
            this.previous.addEventListener('click', () => step(-1)); this.next.addEventListener('click', () => step(1));
            this.popup.addEventListener('keydown', event => {
                if (event.isComposing || event.keyCode === 229) return;
                if (event.key === 'Escape') {
                    event.preventDefault(); event.stopPropagation(); this.close(true);
                } else if (event.target === this.filter && ['ArrowDown', 'Enter'].includes(event.key)) {
                    event.preventDefault();
                    const candidates = this.rows.querySelectorAll('input');
                    candidates[1]?.focus();
                }
            });
        }
        update(channels, selectedIndex, emptyLabel = '未绑定') {
            this.channels = channels; this.index = selectedIndex ?? null; this.emptyLabel = emptyLabel;
            this.render();
        }
        render() {
            const query = this.filter.value.trim().toLocaleLowerCase(), exact = /^ch0*(\d+)$/i.exec(query);
            const matches = query ? this.channels.filter(c => exact ? c.index + 1 === Number(exact[1]) :
                channelName(c.index, c.name).toLocaleLowerCase().includes(query)) : this.channels;
            this.page = clamp(this.page, Math.ceil(matches.length / size));
            const visible = matches.slice(this.page * size, (this.page + 1) * size);
            this.updateToolbar(matches.length, this.page);
            const current = this.channels[this.index]?.index === this.index ? this.channels[this.index] :
                this.index == null ? null : this.channels.find(c => c.index === this.index);
            const selected = this.index == null ? '' : String(this.index);
            const title = this.index == null ? this.emptyLabel : channelName(this.index, current?.name);
            this.caption.textContent = title; this.trigger.title = title;
            const items = [['', this.emptyLabel], ...visible.map(c => [String(c.index), channelName(c.index, c.name)])];
            const values = [...items];
            if (selected && !values.some(([value]) => value === selected)) values.push([selected, title]);
            this.input.replaceChildren(...values.map(([value, text]) => {
                const option = this.doc.createElement('option'); option.value = value; option.textContent = text; return option;
            }));
            this.input.value = selected;
            if (this.popup.hidden) return;
            this.rows.replaceChildren(...items.map(([value, text]) => {
                const row = this.doc.createElement('label'), radio = this.doc.createElement('input'), name = this.doc.createElement('span');
                radio.type = 'radio'; radio.name = this.input.id + '-choice'; radio.value = value; radio.checked = value === selected;
                name.className = 'search-channel-name'; name.textContent = text; row.title = text; row.append(radio, name);
                const choose = () => {
                    if (this.popup.hidden) return;
                    this.close(true);
                    if (value === this.input.value) return;
                    this.input.value = value;
                    const EventClass = this.win?.Event ?? root.Event;
                    this.input.dispatchEvent(EventClass ? new EventClass('change', { bubbles: true }) : { type: 'change', bubbles: true });
                };
                radio.addEventListener('click', choose);
                radio.addEventListener('change', choose);
                radio.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); choose(); } });
                return row;
            }));
            this.position();
        }
        position() {
            const rect = this.trigger.getBoundingClientRect(), viewport = this.doc.documentElement;
            const width = viewport?.clientWidth || this.win?.innerWidth, height = viewport?.clientHeight || this.win?.innerHeight;
            if (!width || !height) return;
            const w = Math.min(Math.max(rect.width, 320), width - 12);
            this.popup.style.width = w + 'px';
            this.popup.style.left = Math.max(6, Math.min(rect.left, width - w - 6)) + 'px';
            const popupHeight = this.popup.getBoundingClientRect().height, below = height - rect.bottom - 4;
            const y = below < popupHeight && rect.top > below ? rect.top - popupHeight - 4 : rect.bottom + 4;
            this.popup.style.top = Math.max(4, Math.min(y, height - popupHeight - 4)) + 'px';
        }
        open() {
            if (!this.popup.hidden) return;
            this.popup.hidden = false; this.popup.showPopover?.(); this.trigger.setAttribute('aria-expanded', 'true');
            this.render(); this.filter.focus({ preventScroll: true });
            const listen = (node, type, fn) => {
                if (!node?.addEventListener) return;
                node.addEventListener(type, fn, true); this.cleanups.push(() => node.removeEventListener(type, fn, true));
            };
            const outside = e => { if (!this.popup.contains(e.target) && !this.trigger.contains(e.target)) this.close(); };
            listen(this.doc, 'pointerdown', outside); listen(this.doc, 'focusin', outside);
            listen(this.win, 'resize', () => this.position());
            listen(this.doc, 'scroll', e => { if (!this.popup.contains(e.target)) this.position(); });
        }
        close(focus = false) {
            if (this.popup.hidden) return;
            for (const remove of this.cleanups.splice(0)) remove();
            this.popup.hidePopover?.(); this.popup.hidden = true; this.trigger.setAttribute('aria-expanded', 'false');
            this.rows.replaceChildren(); if (focus) this.trigger.focus({ preventScroll: true });
        }
        dispose() { this.close(); }
    }
    const sameChannels = (a, b) => a === b || a?.length === b.length &&
        a.every((channel, i) => channel.index === b[i].index && channel.name === b[i].name);
    const ChannelPages = { size, clamp, toolbar, Single, sameChannels };
    (root.SerialPlotter ??= {}).ChannelPages = ChannelPages;
    if (typeof module !== 'undefined') module.exports = { ChannelPages };
})(globalThis);
