const wheelBoundSelects = new WeakSet();

/** Use the hovered select's vertical wheel to choose one enabled option. */
function bindSelectWheel(select) {
    if (wheelBoundSelects.has(select)) return;
    wheelBoundSelects.add(select);
    select.addEventListener('wheel', event => {
        if (select.disabled || select.matches?.(':disabled') || event.ctrlKey || !event.deltaY) return;
        event.preventDefault();
        const direction = event.deltaY > 0 ? 1 : -1;
        let index = select.selectedIndex;
        while (true) {
            index += direction;
            if (index < 0 || index >= select.options.length) return;
            const option = select.options[index];
            const group = option.parentElement;
            if (option.disabled || (group?.tagName === 'OPTGROUP' && group.disabled)) continue;
            select.selectedIndex = index;
            select.dispatchEvent(new Event('change', { bubbles: true }));
            return;
        }
    }, { passive: false });
}

function bindAllSelectWheels(root = document) {
    root.querySelectorAll('select').forEach(bindSelectWheel);
}

if (typeof module !== 'undefined') module.exports = { bindSelectWheel, bindAllSelectWheels };
globalThis.SerialPlotter ??= {};
Object.assign(globalThis.SerialPlotter, { bindSelectWheel, bindAllSelectWheels });
