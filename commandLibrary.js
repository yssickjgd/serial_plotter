/** Persistent command tree; payloads are compiled before a sequence starts. */
const commandBytes = typeof module !== 'undefined' ? require('./byteUtils').ByteUtils : globalThis.SerialPlotter.ByteUtils;
const COMMAND_LIMITS = Object.freeze({ nodes: 1000, depth: 32, content: 1048576, totalContent: 8388608 });

function normalizeCommands(input = []) {
    const ids = new Set();
    let count = 0, characters = 0;
    function visit(nodes, depth) {
        if (!Array.isArray(nodes)) throw new Error('指令列表无效');
        if (depth > COMMAND_LIMITS.depth) throw new Error('指令组最多嵌套 32 层');
        return nodes.map(node => {
            if (++count > COMMAND_LIMITS.nodes) throw new Error('指令与指令组合计最多 1000 项');
            if (!node || typeof node !== 'object' || !['group', 'command'].includes(node.type) ||
                typeof node.id !== 'string' || !/^[\w-]{1,80}$/.test(node.id) || ids.has(node.id))
                throw new Error('指令类型或编号无效、重复');
            ids.add(node.id);
            if (typeof node.name !== 'string' || !node.name.trim() || node.name.length > 120 ||
                node.collapsed !== undefined && typeof node.collapsed !== 'boolean') throw new Error('指令名称或折叠状态无效');
            const repeat = node.repeat ?? 1, interval = node.interval ?? 0;
            if (!Number.isSafeInteger(repeat) || repeat < 1 || repeat > 1000000 ||
                typeof interval !== 'number' || !Number.isFinite(interval) || interval < 0 || interval > 86400)
                throw new Error('指令总发送次数（1–1000000）或间隔（0–86400 s）无效');
            const common = { id: node.id, type: node.type, name: node.name.trim(), collapsed: node.collapsed ?? false, repeat, interval };
            if (node.type === 'group') return { ...common, children: visit(node.children ?? [], depth + 1) };
            if (!['hex', 'text'].includes(node.mode) || typeof node.content !== 'string' ||
                node.content.length > COMMAND_LIMITS.content || (characters += node.content.length) > COMMAND_LIMITS.totalContent)
                throw new Error('指令格式、内容、总发送次数（1–1000000）或间隔（0–86400 s）无效');
            return { ...common, mode: node.mode, content: node.content, repeat, interval };
        });
    }
    return visit(input, 0);
}

function locateCommand(nodes, id, parent = null) {
    for (let index = 0; index < nodes.length; index++) {
        const node = nodes[index];
        if (node.id === id) return { node, siblings: nodes, index, parent };
        const found = node.type === 'group' && locateCommand(node.children, id, node);
        if (found) return found;
    }
    return null;
}

class CommandLibrary {
    constructor(nodes = []) { this.nodes = normalizeCommands(nodes); this.nextId = 1; }
    serialize() { return normalizeCommands(this.nodes); }
    replace(nodes) { this.nodes = normalizeCommands(nodes); }
    find(id) { return locateCommand(this.nodes, id)?.node ?? null; }
    location(id) { return locateCommand(this.nodes, id); }
    _edit(edit) { const next = this.serialize(); edit(next); this.replace(next); }
    add(type, parentId = null) {
        if (!['group', 'command'].includes(type)) throw new Error('指令类型无效');
        let id;
        do { id = `cmd-${this.nextId++}`; } while (this.find(id));
        this._edit(nodes => {
            const parent = parentId === null ? null : locateCommand(nodes, parentId)?.node;
            if (parentId !== null && parent?.type !== 'group') throw new Error('所属指令组不存在');
            (parent ? parent.children : nodes).push({ id, type, name: type === 'group' ? '新建指令组' : '新建指令',
                ...(type === 'group' ? { children: [] } : { mode: 'hex', content: '', repeat: 1, interval: 0 }) });
            if (parent) parent.collapsed = false;
        });
        return id;
    }
    update(id, changes) {
        this._edit(nodes => {
            const node = locateCommand(nodes, id)?.node;
            if (!node) throw new Error('指令不存在');
            for (const key of ['name', 'collapsed', 'mode', 'content', 'repeat', 'interval'])
                if (Object.hasOwn(changes, key)) node[key] = changes[key];
        });
    }
    remove(id) {
        this._edit(nodes => {
            const found = locateCommand(nodes, id);
            if (!found) throw new Error('指令不存在');
            found.siblings.splice(found.index, 1);
        });
    }
    duplicate(id) {
        let copyId;
        this._edit(nodes => {
            const found = locateCommand(nodes, id);
            if (!found) throw new Error('指令不存在');
            const used = new Set();
            const collect = items => items.forEach(node => { used.add(node.id); if (node.children) collect(node.children); });
            collect(nodes);
            const copyNode = node => {
                let next;
                do { next = `cmd-${this.nextId++}`; } while (used.has(next));
                used.add(next);
                return { ...node, id: next, ...(node.type === 'group' ? { children: node.children.map(copyNode) } : {}) };
            };
            const copied = copyNode(found.node);
            copied.name = `${copied.name.slice(0, 117)} 副本`;
            copyId = copied.id;
            found.siblings.splice(found.index + 1, 0, copied);
        });
        return copyId;
    }
    move(id, parentId = null, index = Infinity) {
        this._edit(nodes => {
            const found = locateCommand(nodes, id);
            if (!found) throw new Error('指令不存在');
            if (parentId === id || found.node.type === 'group' && locateCommand(found.node.children, parentId))
                throw new Error('不能将指令组放入自身或自己的子组');
            const parent = parentId === null ? null : locateCommand(nodes, parentId)?.node;
            if (parentId !== null && parent?.type !== 'group') throw new Error('所属指令组不存在');
            found.siblings.splice(found.index, 1);
            const target = parent ? parent.children : nodes;
            target.splice(Math.max(0, Math.min(target.length, index)), 0, found.node);
            if (parent) parent.collapsed = false;
        });
    }
    /** Drop positions refer to the tree before removing the dragged item. */
    moveRelative(id, targetId, placement) {
        if (!['before', 'after', 'inside'].includes(placement)) throw new Error('指令放置位置无效');
        const source = this.location(id), target = this.location(targetId);
        if (!source || !target) throw new Error('指令不存在');
        if (id === targetId) return;
        if (placement === 'inside') { this.move(id, targetId); return; }
        let index = target.index + (placement === 'after' ? 1 : 0);
        if (source.siblings === target.siblings && source.index < index) index--;
        this.move(id, target.parent?.id ?? null, index);
    }
    prepare(id) {
        const plan = [];
        const visit = node => { if (node.type === 'group') node.children.forEach(visit); else plan.push(node); };
        visit(this.prepareTree(id));
        return plan;
    }
    prepareTree(id) {
        const root = this.find(id);
        if (!root) throw new Error('指令不存在');
        const visit = node => {
            if (node.type === 'group') {
                const children = node.children.map(visit).filter(child => child.total > 0);
                const total = children.reduce((sum, child) => sum + child.total, 0) * node.repeat;
                if (!Number.isSafeInteger(total)) throw new Error('嵌套指令组的总发送次数超出安全整数范围');
                return { id: node.id, type: 'group', name: node.name, repeat: node.repeat, interval: node.interval, children, total };
            }
            try {
                const bytes = node.mode === 'hex' ? commandBytes.hexToBytes(node.content) : commandBytes.textToBytes(node.content);
                if (!bytes.length) throw new Error('发送内容不能为空');
                return { id: node.id, type: 'command', name: node.name, bytes, repeat: node.repeat,
                    interval: node.interval, total: node.repeat };
            } catch (error) { throw new Error(`${node.name}：${error.message}`); }
        };
        const prepared = visit(root);
        if (!prepared.total) throw new Error('指令组内没有可发送的指令');
        return prepared;
    }
}

globalThis.SerialPlotter ??= {};
Object.assign(globalThis.SerialPlotter, { CommandLibrary, normalizeCommands });
if (typeof module !== 'undefined') module.exports = { CommandLibrary, normalizeCommands };
