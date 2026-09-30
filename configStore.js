/** Persist UI configuration without writing partially restored state. */
class ConfigStore {
    constructor({ storage, key, validate, read, apply }) {
        this.storage = storage;
        this.key = key;
        this.validate = validate;
        this.read = read;
        this.apply = apply;
        this.restoring = false;
    }

    save() {
        if (this.restoring) return false;
        const config = this.validate(this.read());
        this.storage.setItem(this.key, JSON.stringify(config));
        return true;
    }

    load() {
        const raw = this.storage.getItem(this.key);
        if (!raw) return false;
        const config = this.validate(JSON.parse(raw));
        this.restoring = true;
        try {
            this.apply(config);
        } finally {
            this.restoring = false;
        }
        return true;
    }
}

if (typeof module !== 'undefined') module.exports = { ConfigStore };
globalThis.SerialPlotter ??= {};
globalThis.SerialPlotter.ConfigStore = ConfigStore;
