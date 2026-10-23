/** Keep large workspace settings in IndexedDB and small compatibility copies in localStorage. */
class WorkspaceStorage {
    constructor(options = {}) {
        this.indexedDB = options.indexedDB === undefined ? globalThis.indexedDB : options.indexedDB;
        this.localStorage = options.localStorage === undefined ? globalThis.localStorage : options.localStorage;
        this.configKey = options.configKey ?? 'serialplot_v3_config';
        this.workspaceKey = options.workspaceKey ?? 'serialplot_v3_workspace';
        this.backupKey = this.configKey + '_legacy_backup';
        this.validate = options.validate;
        this.onError = options.onError;
        this.hasIndexedDB = Boolean(this.indexedDB && typeof this.indexedDB.open === 'function');
        this._database = null;
        this._opening = null;
        this._unavailable = false;
        this._disposed = false;
        this._tail = Promise.resolve();
        this._saved = null;
        this._lastError = null;
    }

    load() {
        return this._execute(() => this.hasIndexedDB ? this._loadDatabase() : this._loadLocal());
    }

    save(config) {
        // Snapshot before queuing: callers may edit the same object during an in-flight write.
        let snapshot, raw, failure;
        try {
            snapshot = this._validated(config, null);
            raw = JSON.stringify(snapshot);
        } catch (error) { failure = error; }
        return this._execute(() => {
            if (failure) throw failure;
            return this.hasIndexedDB ? this._saveDatabase(snapshot, raw) : this._saveLocal(snapshot, raw);
        });
    }

    async flush() {
        await this._tail;
        if (this._lastError) throw this._lastError;
        return this._copy(this._saved);
    }

    async dispose() {
        this._disposed = true;
        await this._tail;
        this._database?.close();
        this._database = null;
        this._opening = null;
    }

    _copy(value) { return value === null ? null : JSON.parse(JSON.stringify(value)); }

    _report(error) {
        try { this.onError?.(error); } catch (_) { /* A reporting callback cannot invalidate a committed save. */ }
    }

    _validated(value, workspace) {
        if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid workspace configuration');
        let result = this._copy(value);
        if (this.validate) {
            const validated = this.validate(result, workspace);
            if (validated === false) throw new Error('Invalid workspace configuration');
            if (validated !== undefined && validated !== true) result = validated;
        }
        if (!result || typeof result !== 'object' || Array.isArray(result) || typeof result.then === 'function')
            throw new Error('Invalid workspace configuration');
        return this._copy(result);
    }

    _execute(operation) {
        if (this._disposed) return Promise.reject(new Error('Workspace storage is disposed'));
        const success = value => {
            this._saved = this._copy(value);
            this._lastError = null;
            return this._copy(value);
        };
        const failure = error => {
            this._lastError = error;
            this._report(error);
            throw error;
        };
        let result;
        if (this.hasIndexedDB) {
            result = this._tail.then(operation).then(success, failure);
        } else {
            // Preserve synchronous compatibility mirrors in environments without IndexedDB.
            try { result = Promise.resolve(success(operation())); }
            catch (error) {
                this._lastError = error;
                this._report(error);
                result = Promise.reject(error);
            }
        }
        this._tail = result.catch(() => undefined);
        return result;
    }

    _localStorage() {
        if (!this.localStorage) throw new Error('Workspace localStorage is unavailable');
        return this.localStorage;
    }

    _isManifest(value) { return value && typeof value === 'object' && value.storage === 'indexedDB'; }

    _loadLocal() {
        const storage = this._localStorage(), raw = storage.getItem(this.configKey);
        if (raw === null || raw === '') return null;
        let candidate = JSON.parse(raw);
        if (this._isManifest(candidate)) {
            const error = new Error('IndexedDB workspace is unavailable; a legacy backup is required');
            const backup = storage.getItem(this.backupKey);
            if (!backup) throw error;
            candidate = JSON.parse(backup);
            if (this._isManifest(candidate)) throw error;
            this._report(error);
        }
        const workspace = storage.getItem(this.workspaceKey);
        return this._validated(candidate, workspace ? JSON.parse(workspace) : null);
    }

    _saveLocal(config, raw) {
        if (raw.length * 2 > 512 * 1024)
            throw new Error('IndexedDB is required to save a workspace larger than 512 KiB');
        const storage = this._localStorage();
        storage.setItem(this.configKey, raw);
        if (config.workspace !== undefined) storage.setItem(this.workspaceKey, JSON.stringify(config.workspace));
        return config;
    }

    async _loadDatabase() {
        let database;
        try { database = await this._openDatabase(); }
        catch (error) { this._report(error); return this._loadLocal(); }
        const config = await this._transaction(database, 'readonly');
        return config === undefined ? this._loadLocal() : this._validated(config, null);
    }

    async _saveDatabase(config, raw) {
        let database;
        try { database = await this._openDatabase(); }
        catch (error) { this._report(error); return this._saveLocal(config, raw); }
        await this._transaction(database, 'readwrite', config);
        try { this._mirror(config, raw); }
        catch (cause) {
            const error = new Error('Workspace saved in IndexedDB; localStorage compatibility copy failed: ' + cause.message);
            error.code = 'WORKSPACE_STORAGE_MIRROR_FAILED';
            error.cause = cause;
            this._report(error);
        }
        return config;
    }

    _mirror(config, raw) {
        if (raw.length * 2 <= 512 * 1024) { this._saveLocal(config, raw); return; }
        const storage = this._localStorage(), previous = storage.getItem(this.configKey);
        if (previous) {
            const candidate = JSON.parse(previous);
            if (!this._isManifest(candidate)) storage.setItem(this.backupKey, previous);
        }
        storage.setItem(this.configKey, JSON.stringify({ storage: 'indexedDB', database: 'serialplot_workspace',
            version: 1, store: 'config', key: this.configKey }));
    }

    _openDatabase() {
        if (this._database) return Promise.resolve(this._database);
        if (this._opening) return this._opening;
        if (this._unavailable) return Promise.reject(new Error('IndexedDB workspace storage is unavailable'));
        this._opening = new Promise((resolve, reject) => {
            let request, settled = false;
            const fail = error => {
                if (settled) return;
                settled = true;
                this._unavailable = true;
                reject(error);
            };
            try { request = this.indexedDB.open('serialplot_workspace', 1); }
            catch (error) { fail(error); return; }
            request.onupgradeneeded = () => {
                try {
                    if (!request.result.objectStoreNames.contains('config')) request.result.createObjectStore('config');
                } catch (error) { request.transaction?.abort(); fail(error); }
            };
            request.onerror = () => fail(request.error ?? new Error('Could not open IndexedDB workspace storage'));
            request.onblocked = () => fail(new Error('IndexedDB workspace storage is blocked by another open page'));
            request.onsuccess = () => {
                const database = request.result;
                if (settled) { database.close(); return; }
                settled = true;
                this._database = database;
                database.onversionchange = () => {
                    database.close();
                    if (this._database === database) { this._database = null; this._opening = null; }
                };
                resolve(database);
            };
        });
        return this._opening;
    }

    _transaction(database, mode, config) {
        return new Promise((resolve, reject) => {
            let transaction, request, value, requestError;
            try {
                transaction = database.transaction('config', mode);
                const store = transaction.objectStore('config');
                request = mode === 'readonly' ? store.get(this.configKey) : store.put(config, this.configKey);
            } catch (error) { reject(error); return; }
            request.onsuccess = () => { value = request.result; };
            request.onerror = () => { requestError = request.error; };
            transaction.oncomplete = () => resolve(value);
            transaction.onabort = transaction.onerror = () => reject(transaction.error ?? requestError ??
                new Error('IndexedDB workspace transaction failed'));
        });
    }
}

if (typeof module !== 'undefined') module.exports = { WorkspaceStorage };
globalThis.SerialPlotter ??= {};
globalThis.SerialPlotter.WorkspaceStorage = WorkspaceStorage;
