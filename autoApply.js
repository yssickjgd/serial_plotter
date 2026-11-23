/** Commit a configuration group when leaving it or pressing Enter in a field. */
function bindAutoApply(group, apply, listen = (target, event, handler) => target.addEventListener(event, handler)) {
    listen(group, 'pointerleave', () => apply());
    listen(group, 'keydown', event => {
        if (event.defaultPrevented || event.isComposing || event.keyCode === 229 || event.repeat || event.key !== 'Enter' ||
            event.shiftKey || event.ctrlKey || event.altKey || event.metaKey ||
            !['INPUT', 'SELECT', 'TEXTAREA'].includes(event.target?.tagName)) return;
        event.preventDefault();
        apply(true);
    });
}

/** Let a text or number setting commit without waiting for native blur. */
function bindSettingField(field, apply, listen = (target, event, handler) => target.addEventListener(event, handler)) {
    if (!field) return;
    if (field.tagName !== 'INPUT' || !['text', 'number'].includes(field.type)) {
        listen(field, 'change', apply);
        return;
    }
    let pending = false, appliedValue;
    listen(field, 'input', () => { pending = true; appliedValue = undefined; });
    listen(field, 'change', () => {
        const changed = field.value !== appliedValue;
        pending = false; appliedValue = undefined;
        if (changed) apply();
    });
    bindAutoApply(field, () => {
        if (!pending || field.disabled) return;
        pending = false;
        apply();
        appliedValue = field.value;
    }, listen);
}

globalThis.SerialPlotter ??= {};
Object.assign(globalThis.SerialPlotter, { bindAutoApply, bindSettingField });
if (typeof module !== 'undefined') module.exports = { bindAutoApply, bindSettingField };
