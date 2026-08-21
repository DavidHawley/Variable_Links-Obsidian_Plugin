'use strict';

var obsidian = require('obsidian');
var view = require('@codemirror/view');
var state = require('@codemirror/state');

const DEFAULT_SETTINGS = {
    registryFilePath: '.obsidian/plugins/variable-links/registry.json',
    enableInfoCards: true,
    openInNewPane: false,
    suggestionFuzzy: true,
    defaultDateFormat: 'YYYY-MM-DD'
};
class FilePickerModal extends obsidian.FuzzySuggestModal {
    constructor(app, onChoose) {
        super(app);
        this.app = app;
        this.onChoose = onChoose;
        this.setPlaceholder('Select a file to use as the registry');
    }
    getItems() {
        return this.app.vault.getFiles();
    }
    getItemText(item) {
        return item.path;
    }
    onChooseItem(item) {
        this.onChoose(item);
    }
}
class VariableLinksSettingTab extends obsidian.PluginSettingTab {
    constructor(app, plugin) {
        super(app, plugin);
        this.activeModal = null;
        this.disposed = false;
        this.plugin = plugin;
    }
    display() {
        if (this.disposed)
            return;
        const containerEl = this.containerEl;
        containerEl.empty();
        containerEl.createEl('h2', { text: 'Variable Links — Settings' });
        new obsidian.Setting(containerEl)
            .setName('Registry file')
            .setDesc('JSON, YAML, or Markdown registry. The default is a hidden registry.json in this plugin folder.')
            .addText((text) => text
            .setPlaceholder('.obsidian/plugins/variable-links/registry.json')
            .setValue(this.plugin.settings.registryFilePath)
            .onChange(async (value) => {
            var _a;
            this.plugin.settings.registryFilePath = value.trim();
            await this.plugin.saveSettings();
            // attempt to reload registry
            try {
                await ((_a = this.plugin.registry) === null || _a === void 0 ? void 0 : _a.load());
            }
            catch (e) {
                new obsidian.Notice('Failed to load registry: ' + String(e));
            }
        }))
            .addButton((btn) => btn.setButtonText('Choose...').onClick(() => {
            var _a;
            if (this.disposed)
                return;
            (_a = this.activeModal) === null || _a === void 0 ? void 0 : _a.close();
            const modal = new FilePickerModal(this.app, async (file) => {
                var _a;
                this.activeModal = null;
                if (this.disposed)
                    return;
                this.plugin.settings.registryFilePath = file.path;
                await this.plugin.saveSettings();
                modal.close();
                try {
                    await ((_a = this.plugin.registry) === null || _a === void 0 ? void 0 : _a.load());
                    new obsidian.Notice('Registry loaded: ' + file.path);
                }
                catch (e) {
                    new obsidian.Notice('Failed to load registry: ' + String(e));
                }
                this.display();
            });
            this.activeModal = modal;
            modal.open();
        }));
        new obsidian.Setting(containerEl)
            .setName('Enable info cards')
            .setDesc('Show info cards on hover over rendered variables')
            .addToggle((t) => t.setValue(this.plugin.settings.enableInfoCards).onChange(async (v) => { this.plugin.settings.enableInfoCards = v; await this.plugin.saveSettings(); }));
        new obsidian.Setting(containerEl)
            .setName('Open source in new pane')
            .setDesc('Open the source file in a new pane when clicking rendered variables')
            .addToggle((t) => t.setValue(this.plugin.settings.openInNewPane).onChange(async (v) => { this.plugin.settings.openInNewPane = v; await this.plugin.saveSettings(); }));
        new obsidian.Setting(containerEl)
            .setName('Suggestion fuzzy matching')
            .setDesc('Allow fuzzy matching for suggestions (variable name, display, source file, property)')
            .addToggle((t) => t.setValue(this.plugin.settings.suggestionFuzzy).onChange(async (v) => { this.plugin.settings.suggestionFuzzy = v; await this.plugin.saveSettings(); }));
        new obsidian.Setting(containerEl)
            .setName('Default date format')
            .setDesc('Format used for date properties if not specified per-variable')
            .addText((t) => t.setValue(this.plugin.settings.defaultDateFormat).onChange(async (v) => { this.plugin.settings.defaultDateFormat = v; await this.plugin.saveSettings(); }));
    }
    dispose() {
        var _a, _b, _c;
        this.disposed = true;
        (_a = this.activeModal) === null || _a === void 0 ? void 0 : _a.close();
        this.activeModal = null;
        try {
            (_c = (_b = this.containerEl) === null || _b === void 0 ? void 0 : _b.empty) === null || _c === void 0 ? void 0 : _c.call(_b);
        }
        catch (error) { }
    }
}

class Registry {
    constructor(app, plugin) {
        this.data = new Map();
        this.registryFile = null;
        this.registryPath = '';
        this.modifyHandler = null;
        this.reloadTimer = null;
        this.active = true;
        this.generation = 0;
        this.app = app;
        this.plugin = plugin;
        this.settings = plugin.settings;
    }
    initialContent(path) {
        const lower = path.toLowerCase();
        if (lower.endsWith('.json'))
            return JSON.stringify({ 'variable-links': {} }, null, 2) + '\n';
        if (lower.endsWith('.yml') || lower.endsWith('.yaml'))
            return 'variable-links: {}\n';
        return '---\nvariable-links: {}\n---\n';
    }
    async ensureAdapterFolders(path) {
        const adapter = this.app.vault.adapter;
        const parts = path.split('/').slice(0, -1);
        let current = '';
        for (const part of parts) {
            current = current ? `${current}/${part}` : part;
            if (!await adapter.exists(current))
                await adapter.mkdir(current);
        }
    }
    async createRegistry(path) {
        const vault = this.app.vault;
        const configDir = vault.configDir || '.obsidian';
        const hidden = path === configDir || path.startsWith(`${configDir}/`);
        const content = this.initialContent(path);
        if (hidden) {
            await this.ensureAdapterFolders(path);
            await vault.adapter.write(path, content);
            return null;
        }
        const parent = path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '';
        if (parent && !vault.getAbstractFileByPath(parent)) {
            const parts = parent.split('/');
            let current = '';
            for (const part of parts) {
                current = current ? `${current}/${part}` : part;
                if (!vault.getAbstractFileByPath(current))
                    await vault.createFolder(current);
            }
        }
        return await vault.create(path, content);
    }
    async load() {
        if (!this.active)
            return;
        const generation = this.generation;
        this.settings = this.plugin.settings;
        const path = this.settings.registryFilePath.replace(/\\/g, '/');
        if (!path) {
            new obsidian.Notice('Variable Links: registryFilePath not set');
            return;
        }
        this.registryPath = path;
        const adapter = this.app.vault.adapter;
        let abstractFile = this.app.vault.getAbstractFileByPath(path);
        let file = abstractFile instanceof obsidian.TFile ? abstractFile : null;
        if (!file && !await adapter.exists(path)) {
            file = await this.createRegistry(path);
            new obsidian.Notice('Variable Links: created registry at ' + path);
        }
        this.registryFile = file;
        const content = file ? await this.app.vault.read(file) : await adapter.read(path);
        if (!this.isCurrent(generation))
            return;
        // Try to parse registry using intelligent handling based on extension and content
        const parsed = this.parseRegistryFromContent(content, path);
        if (!parsed || typeof parsed !== 'object') {
            new obsidian.Notice('Variable Links: failed to parse registry from file: ' + path);
            this.data.clear();
            return;
        }
        const variableLinks = parsed['variable-links'];
        if (!variableLinks || typeof variableLinks !== 'object') {
            new obsidian.Notice('Variable Links: no "variable-links" section in registry file');
            this.data.clear();
            return;
        }
        this.data.clear();
        const generatedGuids = new Map();
        const usedGuids = new Set();
        for (const [key, raw] of Object.entries(variableLinks)) {
            if (typeof raw === 'object' && raw !== null) {
                let guid = typeof raw.guid === 'string' ? raw.guid.trim() : '';
                if (!guid || usedGuids.has(guid)) {
                    do {
                        guid = this.createGuid();
                    } while (usedGuids.has(guid));
                    generatedGuids.set(String(key), guid);
                }
                usedGuids.add(guid);
                const def = {
                    guid,
                    file: raw.file,
                    property: raw.property,
                    display: raw.display,
                    favorite: raw.favorite === true,
                    card: raw.card,
                    format: raw.format
                };
                this.data.set(String(key), def);
            }
        }
        if (generatedGuids.size) {
            await this.mutateRegistryLinks((links) => {
                for (const [name, guid] of generatedGuids) {
                    if (links[name])
                        links[name].guid = guid;
                }
            });
            if (!this.isCurrent(generation))
                return;
        }
        // register vault change listener to reload registry when the file is modified
        if (this.modifyHandler) {
            this.app.vault.off('modify', this.modifyHandler);
            this.modifyHandler = null;
        }
        if (file) {
            this.modifyHandler = (f) => {
                if (!this.active || !this.registryFile || f.path !== this.registryFile.path)
                    return;
                if (this.reloadTimer)
                    clearTimeout(this.reloadTimer);
                this.reloadTimer = setTimeout(() => {
                    this.reloadTimer = null;
                    if (this.active)
                        void this.load();
                }, 50);
            };
            this.app.vault.on('modify', this.modifyHandler);
        }
    }
    unload() {
        this.active = false;
        this.generation++;
        if (this.reloadTimer) {
            clearTimeout(this.reloadTimer);
            this.reloadTimer = null;
        }
        if (this.modifyHandler) {
            this.app.vault.off('modify', this.modifyHandler);
            this.modifyHandler = null;
        }
    }
    isCurrent(generation) {
        return this.active && this.generation === generation;
    }
    getVariable(name) {
        var _a;
        return (_a = this.data.get(name)) !== null && _a !== void 0 ? _a : null;
    }
    createGuid() {
        var _a;
        if (typeof ((_a = globalThis.crypto) === null || _a === void 0 ? void 0 : _a.randomUUID) === 'function')
            return globalThis.crypto.randomUUID();
        return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (character) => {
            const random = Math.random() * 16 | 0;
            return (character === 'x' ? random : (random & 0x3 | 0x8)).toString(16);
        });
    }
    async mutateRegistryLinks(mutator) {
        var _a;
        const file = this.registryFile;
        const adapter = this.app.vault.adapter;
        const path = this.registryPath;
        const lowerPath = path.toLowerCase();
        if ((lowerPath.endsWith('.md') || lowerPath.endsWith('.markdown') || lowerPath.endsWith('.mdx'))
            && file && typeof ((_a = this.app.fileManager) === null || _a === void 0 ? void 0 : _a.processFrontMatter) === 'function') {
            await this.app.fileManager.processFrontMatter(file, (frontmatter) => {
                frontmatter['variable-links'] = frontmatter['variable-links'] || {};
                mutator(frontmatter['variable-links']);
            });
            return;
        }
        const content = file ? await this.app.vault.read(file) : await adapter.read(path);
        const registry = this.parseRegistryFromContent(content, path);
        if (!registry || typeof registry !== 'object')
            throw new Error('The registry must contain valid JSON or YAML.');
        registry['variable-links'] = registry['variable-links'] || {};
        mutator(registry['variable-links']);
        let updatedContent;
        if (lowerPath.endsWith('.json'))
            updatedContent = JSON.stringify(registry, null, 2) + '\n';
        else {
            const yaml = obsidian.stringifyYaml(registry).trimEnd();
            if (lowerPath.endsWith('.md') || lowerPath.endsWith('.markdown') || lowerPath.endsWith('.mdx')) {
                const closing = content.indexOf('\n---', 3);
                if (closing === -1)
                    throw new Error('The registry frontmatter is not closed.');
                const bodyStart = content.indexOf('\n', closing + 4);
                const body = bodyStart === -1 ? '' : content.slice(bodyStart + 1);
                updatedContent = `---\n${yaml}\n---${body ? `\n${body}` : '\n'}`;
            }
            else
                updatedContent = yaml + '\n';
        }
        if (file)
            await this.app.vault.modify(file, updatedContent);
        else
            await adapter.write(path, updatedContent);
    }
    /** Persist a mapping. A rename keeps the GUID and updates verified token references. */
    async saveVariable(name, definition, previousName) {
        var _a, _b, _c, _d;
        const variableName = name.trim();
        const oldName = previousName === null || previousName === void 0 ? void 0 : previousName.trim();
        if (!variableName)
            throw new Error('Variable name is required.');
        if (!((_a = definition.file) === null || _a === void 0 ? void 0 : _a.trim()))
            throw new Error('A source note is required.');
        if (!((_b = definition.property) === null || _b === void 0 ? void 0 : _b.trim()))
            throw new Error('A property name is required.');
        if (!this.registryFile && !this.registryPath)
            throw new Error('The registry file is not loaded.');
        if (oldName && oldName !== variableName && this.data.has(variableName)) {
            throw new Error(`A Variable Link named “${variableName}” already exists.`);
        }
        const existing = this.data.get(oldName || variableName);
        const guid = (existing === null || existing === void 0 ? void 0 : existing.guid) || definition.guid || this.createGuid();
        const normalized = {
            guid,
            file: definition.file.trim(),
            property: definition.property.trim()
        };
        if (Object.prototype.hasOwnProperty.call(definition, 'card'))
            normalized.card = definition.card;
        if (Object.prototype.hasOwnProperty.call(definition, 'favorite'))
            normalized.favorite = definition.favorite === true;
        const rename = !!oldName && oldName !== variableName;
        const tokenCache = this.plugin.tokenCache;
        if (rename && !tokenCache) {
            throw new Error('The token cache is unavailable, so the rename was cancelled.');
        }
        const renamePlan = rename && tokenCache ? await tokenCache.prepareRename(guid, oldName, variableName) : null;
        if (renamePlan)
            await renamePlan.apply();
        try {
            await this.mutateRegistryLinks((links) => {
                var _a;
                const stored = links[oldName || variableName] || {};
                const updated = { ...stored, ...normalized };
                if ((_a = definition.display) === null || _a === void 0 ? void 0 : _a.trim())
                    updated.display = definition.display.trim();
                else
                    delete updated.display;
                if (Object.prototype.hasOwnProperty.call(definition, 'favorite') && !definition.favorite)
                    delete updated.favorite;
                if (Object.prototype.hasOwnProperty.call(definition, 'card') && !definition.card)
                    delete updated.card;
                links[variableName] = updated;
                if (rename)
                    delete links[oldName];
            });
        }
        catch (error) {
            if (renamePlan)
                await renamePlan.rollback();
            throw error;
        }
        // Once the registry write succeeds, the rename is authoritative. Derived
        // indexes may be rebuilt, but must never roll note text back independently.
        try {
            await this.load();
        }
        catch (error) {
            new obsidian.Notice('Variable Links: the rename was saved, but the registry view could not be refreshed. Reload Obsidian.');
            return;
        }
        try {
            await ((_c = this.plugin.indexer) === null || _c === void 0 ? void 0 : _c.build());
        }
        catch (error) { }
        if (renamePlan) {
            try {
                await renamePlan.commit();
            }
            catch (error) {
                try {
                    await tokenCache.rebuild();
                }
                catch (rebuildError) { }
            }
        }
        else if (!existing && tokenCache) {
            try {
                await tokenCache.rebuild();
            }
            catch (error) { }
        }
        (_d = this.plugin.livePreviewRenderer) === null || _d === void 0 ? void 0 : _d.refresh();
    }
    async deleteVariable(name) {
        var _a, _b, _c, _d;
        const variableName = name.trim();
        if (!variableName)
            return;
        const guid = (_a = this.data.get(variableName)) === null || _a === void 0 ? void 0 : _a.guid;
        await this.mutateRegistryLinks((links) => delete links[variableName]);
        await this.load();
        await ((_b = this.plugin.indexer) === null || _b === void 0 ? void 0 : _b.build());
        if (guid)
            await ((_c = this.plugin.tokenCache) === null || _c === void 0 ? void 0 : _c.removeGuid(guid));
        (_d = this.plugin.livePreviewRenderer) === null || _d === void 0 ? void 0 : _d.refresh();
    }
    extractFrontmatter(content) {
        // find the leading YAML frontmatter block
        if (!content.startsWith('---'))
            return null;
        const parts = content.split(/\r?\n/);
        // find closing '---' after first line
        let end = -1;
        for (let i = 1; i < parts.length; i++) {
            if (parts[i].trim() === '---') {
                end = i;
                break;
            }
        }
        if (end === -1)
            return null;
        const yamlLines = parts.slice(1, end).join('\n');
        try {
            const parsed = obsidian.parseYaml(yamlLines);
            return parsed;
        }
        catch (e) {
            new obsidian.Notice('Variable Links: failed to parse registry YAML: ' + String(e));
            return null;
        }
    }
    parseRegistryFromContent(content, filePath) {
        // Determine by extension
        const lower = (filePath || '').toLowerCase();
        try {
            if (lower.endsWith('.json')) {
                // parse entire file as JSON
                try {
                    const obj = JSON.parse(content);
                    return obj;
                }
                catch (e) {
                    new obsidian.Notice('Variable Links: failed to parse JSON registry: ' + String(e));
                    return null;
                }
            }
            if (lower.endsWith('.yml') || lower.endsWith('.yaml')) {
                try {
                    const obj = obsidian.parseYaml(content);
                    return obj;
                }
                catch (e) {
                    new obsidian.Notice('Variable Links: failed to parse YAML registry: ' + String(e));
                    return null;
                }
            }
            // If markdown, prefer frontmatter
            if (lower.endsWith('.md') || lower.endsWith('.markdown') || lower.endsWith('.mdx')) {
                const fm = this.extractFrontmatter(content);
                if (fm)
                    return fm;
                // search for fenced code blocks labeled json/yaml
                const fenceRe = /```(json|yaml|yml)\s([\s\S]*?)```/g;
                let m;
                while ((m = fenceRe.exec(content)) !== null) {
                    const lang = m[1].toLowerCase();
                    const body = m[2];
                    try {
                        if (lang === 'json') {
                            const obj = JSON.parse(body);
                            if (obj && obj['variable-links'])
                                return obj;
                        }
                        else {
                            const obj = obsidian.parseYaml(body);
                            if (obj && obj['variable-links'])
                                return obj;
                        }
                    }
                    catch (e) {
                        // ignore parse errors here and keep looking
                        continue;
                    }
                }
                // As a last resort, try parsing entire file as YAML (some users may use pure YAML files saved as .md)
                try {
                    const obj = obsidian.parseYaml(content);
                    if (obj && obj['variable-links'])
                        return obj;
                }
                catch (e) {
                    // ignore
                }
                return null;
            }
            // Unknown extension — try YAML then JSON
            try {
                const yamlObj = obsidian.parseYaml(content);
                if (yamlObj && yamlObj['variable-links'])
                    return yamlObj;
            }
            catch (e) {
                // ignore
            }
            try {
                const jsonObj = JSON.parse(content);
                if (jsonObj && jsonObj['variable-links'])
                    return jsonObj;
            }
            catch (e) {
                // ignore
            }
            return null;
        }
        catch (e) {
            new obsidian.Notice('Variable Links: error parsing registry file: ' + String(e));
            return null;
        }
    }
}

class Indexer {
    constructor(app, registry) {
        this.byName = new Map();
        this.byFile = new Map();
        this.byProperty = new Map();
        this.app = app;
        this.registry = registry;
    }
    async build() {
        this.byName.clear();
        this.byFile.clear();
        this.byProperty.clear();
        for (const [name, def] of Array.from(this.registry.data.entries())) {
            const filePath = this.normalizeFile(def.file);
            const entry = { name, def, filePath };
            this.byName.set(name, entry);
            if (filePath) {
                let s = this.byFile.get(filePath);
                if (!s) {
                    s = new Set();
                    this.byFile.set(filePath, s);
                }
                s.add(name);
            }
            if (def.property) {
                let ps = this.byProperty.get(def.property);
                if (!ps) {
                    ps = new Set();
                    this.byProperty.set(def.property, ps);
                }
                ps.add(name);
            }
        }
    }
    normalizeFile(raw) {
        if (!raw)
            return undefined;
        if (typeof raw !== 'string')
            return undefined;
        // already a wiki-link? strip [[ ]]
        const m = raw.match(/\[\[([^\]]+)\]\]/);
        let inner = m ? m[1].trim() : raw.trim();
        if (!/\.md$/i.test(inner))
            inner = inner + '.md';
        return inner;
    }
    getByName(name) {
        var _a;
        return (_a = this.byName.get(name)) !== null && _a !== void 0 ? _a : null;
    }
    getVarsByFile(path) {
        const s = this.byFile.get(path);
        return s ? Array.from(s) : [];
    }
    getVarsByProperty(property) {
        const s = this.byProperty.get(property);
        return s ? Array.from(s) : [];
    }
}

class Resolver {
    constructor(app, registry) {
        this.app = app;
        this.registry = registry;
    }
    async resolve(variableName) {
        var _a, _b, _c, _d;
        const def = this.registry.getVariable(variableName);
        if (!def) {
            return { ok: false, error: `Variable '${variableName}' not found in registry` };
        }
        let rawFile = def.file;
        if (!rawFile) {
            return { ok: false, error: `Variable '${variableName}' has no file configured` };
        }
        // normalize wiki-link to path
        let path = rawFile;
        const m = rawFile.match(/\[\[([^\]]+)\]\]/);
        if (m) {
            path = m[1];
        }
        if (!/\.md$/i.test(path))
            path = path + '.md';
        const file = this.app.vault.getAbstractFileByPath(path);
        if (!file) {
            return { ok: false, error: `Source file not found: ${path}`, sourceFile: null };
        }
        // Prefer metadataCache
        const cache = (_c = (_b = (_a = this.app.metadataCache) === null || _a === void 0 ? void 0 : _a.getFileCache) === null || _b === void 0 ? void 0 : _b.call(_a, file)) !== null && _c !== void 0 ? _c : null;
        let front = (_d = cache === null || cache === void 0 ? void 0 : cache.frontmatter) !== null && _d !== void 0 ? _d : null;
        if (!front) {
            // fallback: read file and parse frontmatter
            try {
                const content = await this.app.vault.read(file);
                const fm = this.extractFrontmatter(content);
                front = fm !== null && fm !== void 0 ? fm : {};
            }
            catch (e) {
                return { ok: false, error: `Failed to read source file: ${String(e)}`, sourceFile: file };
            }
        }
        const prop = def.property;
        if (!prop) {
            return { ok: false, error: `Variable '${variableName}' has no property configured`, sourceFile: file };
        }
        const value = front === null || front === void 0 ? void 0 : front[prop];
        if (typeof value === 'undefined') {
            return { ok: false, error: `Property '${prop}' not found in ${path}`, sourceFile: file, property: prop };
        }
        const res = { ok: true, value, sourceFile: file, property: prop };
        // derive type
        if (Array.isArray(value))
            res.type = 'array';
        else if (typeof value === 'boolean')
            res.type = 'boolean';
        else if (typeof value === 'number')
            res.type = 'number';
        else if (typeof value === 'string')
            res.type = 'string';
        else
            res.type = typeof value;
        return res;
    }
    extractFrontmatter(content) {
        if (!content.startsWith('---'))
            return null;
        const parts = content.split(/\r?\n/);
        let end = -1;
        for (let i = 1; i < parts.length; i++) {
            if (parts[i].trim() === '---') {
                end = i;
                break;
            }
        }
        if (end === -1)
            return null;
        const yamlLines = parts.slice(1, end).join('\n');
        try {
            const parsed = obsidian.parseYaml(yamlLines);
            return parsed;
        }
        catch (e) {
            // parsing failure
            return null;
        }
    }
}

class InfoCard {
    constructor(app) {
        this.el = null;
        this.hideTimeout = null;
        this.animationFrame = null;
        this.renderChild = null;
        this.generation = 0;
        this.destroyed = false;
        this.app = app;
    }
    async showFor(targetEl, sourceFilePath, cardConfig) {
        var _a, _b;
        if (this.destroyed)
            return;
        this.hideImmediate();
        const generation = this.generation;
        // build container
        const container = document.createElement('div');
        container.className = 'variable-links-card';
        container.style.position = 'absolute';
        container.style.zIndex = '9999';
        this.el = container;
        this.renderChild = new obsidian.MarkdownRenderChild(container);
        (_b = (_a = this.renderChild).load) === null || _b === void 0 ? void 0 : _b.call(_a);
        // Title
        if (cardConfig === null || cardConfig === void 0 ? void 0 : cardConfig.title) {
            const h = document.createElement('div');
            h.className = 'variable-links-card-title';
            h.textContent = cardConfig.title;
            container.appendChild(h);
        }
        // Note
        if (cardConfig === null || cardConfig === void 0 ? void 0 : cardConfig.note) {
            const p = document.createElement('div');
            p.style.marginBottom = '6px';
            // render as markdown for convenience
            await obsidian.MarkdownRenderer.renderMarkdown(cardConfig.note || '', p, '', this.renderChild);
            if (!this.isCurrent(container, generation))
                return;
            container.appendChild(p);
        }
        // Fields
        if ((cardConfig === null || cardConfig === void 0 ? void 0 : cardConfig.fields) && cardConfig.fields.length > 0) {
            const table = document.createElement('table');
            table.className = 'variable-links-card-fields-table';
            const tbody = document.createElement('tbody');
            for (const fieldConfig of cardConfig.fields) {
                const external = fieldConfig.match(/^\[\[([^\]]+)\]\]#([^:]+)(?::([\s\S]*))?$/);
                const separator = external ? -1 : fieldConfig.indexOf(':');
                const field = (external ? external[2] : separator === -1 ? fieldConfig : fieldConfig.slice(0, separator)).trim();
                const customLabel = (external ? external[3] || '' : separator === -1 ? '' : fieldConfig.slice(separator + 1)).trim();
                const fieldSourcePath = external ? external[1] : sourceFilePath;
                const front = await this.getFrontmatter(fieldSourcePath);
                if (!this.isCurrent(container, generation))
                    return;
                const row = document.createElement('tr');
                const val = front === null || front === void 0 ? void 0 : front[field];
                const name = document.createElement('th');
                name.className = 'variable-links-card-field-name';
                name.scope = 'row';
                name.textContent = customLabel || (field ? field.charAt(0).toUpperCase() + field.slice(1) : field);
                const value = document.createElement('td');
                value.className = 'variable-links-card-field-value';
                if (typeof val === 'undefined')
                    value.textContent = '(missing)';
                else if (Array.isArray(val))
                    value.textContent = val.join(', ');
                else if (typeof val === 'string') {
                    await obsidian.MarkdownRenderer.renderMarkdown(val, value, '', this.renderChild);
                    if (!this.isCurrent(container, generation))
                        return;
                }
                else
                    value.textContent = String(val);
                row.appendChild(name);
                row.appendChild(value);
                tbody.appendChild(row);
            }
            table.appendChild(tbody);
            container.appendChild(table);
        }
        // Source link
        if (cardConfig === null || cardConfig === void 0 ? void 0 : cardConfig.showSourceLink) {
            const btn = document.createElement('div');
            btn.style.marginTop = '6px';
            const a = document.createElement('a');
            a.href = '#';
            a.textContent = 'Open source';
            a.addEventListener('click', (e) => {
                e.preventDefault();
                try {
                    this.app.workspace.openLinkText(sourceFilePath.replace(/\.md$/i, ''), '', false);
                }
                catch (err) {
                    const file = this.app.vault.getAbstractFileByPath(sourceFilePath);
                    if (file)
                        this.app.workspace.openFile(file);
                }
            });
            btn.appendChild(a);
            container.appendChild(btn);
        }
        // Append first so browser can compute layout, then adjust width/position dynamically
        // allow the card to size to its content but cap at a reasonable percentage of viewport
        container.style.maxWidth = '60vw';
        container.style.width = 'auto';
        container.style.boxSizing = 'border-box';
        if (!this.isCurrent(container, generation))
            return;
        document.body.appendChild(container);
        // After element is in DOM, measure and position on next frame to allow proper layout
        this.animationFrame = requestAnimationFrame(() => {
            this.animationFrame = null;
            if (!this.isCurrent(container, generation) || !targetEl.isConnected)
                return;
            // position near targetEl
            const rect = targetEl.getBoundingClientRect();
            const top = rect.bottom + window.scrollY + 6;
            // prefer aligning left with target, but ensure the card stays within viewport with an 12px margin
            const margin = 12;
            let left = rect.left + window.scrollX;
            // if card would overflow to the right, shift it left
            const cardWidth = container.offsetWidth || container.getBoundingClientRect().width;
            const maxRight = window.scrollX + window.innerWidth - margin;
            if (left + cardWidth > maxRight) {
                left = Math.max(margin + window.scrollX, maxRight - cardWidth);
            }
            // if card would overflow to the left, clamp
            const minLeft = margin + window.scrollX;
            if (left < minLeft)
                left = minLeft;
            container.style.top = `${top}px`;
            container.style.left = `${left}px`;
        });
        // attach handlers to hide when mouse leaves
        container.addEventListener('mouseenter', () => { this.clearHideTimeout(); });
        container.addEventListener('mouseleave', () => { this.hideWithDelay(150); });
    }
    async getFrontmatter(sourcePath) {
        var _a, _b, _c;
        const linkPath = sourcePath.replace(/^\[\[|\]\]$/g, '').replace(/\.md$/i, '');
        const cache = this.app.metadataCache;
        const file = ((_a = cache === null || cache === void 0 ? void 0 : cache.getFirstLinkpathDest) === null || _a === void 0 ? void 0 : _a.call(cache, linkPath, ''))
            || this.app.vault.getAbstractFileByPath(/\.md$/i.test(sourcePath) ? sourcePath : `${sourcePath}.md`);
        if (!file)
            return null;
        const cached = (_c = (_b = cache === null || cache === void 0 ? void 0 : cache.getFileCache) === null || _b === void 0 ? void 0 : _b.call(cache, file)) === null || _c === void 0 ? void 0 : _c.frontmatter;
        if (cached)
            return cached;
        try {
            const content = await this.app.vault.read(file);
            const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---/);
            return match ? obsidian.parseYaml(match[1]) : null;
        }
        catch (e) {
            return null;
        }
    }
    hideWithDelay(ms = 150) {
        if (this.destroyed)
            return;
        this.clearHideTimeout();
        this.hideTimeout = setTimeout(() => this.hideImmediate(), ms);
    }
    clearHideTimeout() { if (this.hideTimeout) {
        clearTimeout(this.hideTimeout);
        this.hideTimeout = null;
    } }
    hideImmediate() {
        var _a, _b;
        this.generation++;
        this.clearHideTimeout();
        if (this.animationFrame !== null) {
            cancelAnimationFrame(this.animationFrame);
            this.animationFrame = null;
        }
        if (this.renderChild) {
            try {
                (_b = (_a = this.renderChild).unload) === null || _b === void 0 ? void 0 : _b.call(_a);
            }
            catch (error) { }
            this.renderChild = null;
        }
        if (this.el && this.el.parentElement) {
            this.el.parentElement.removeChild(this.el);
        }
        this.el = null;
    }
    destroy() {
        this.destroyed = true;
        this.hideImmediate();
    }
    isCurrent(container, generation) {
        return !this.destroyed && this.el === container && this.generation === generation;
    }
}

const TOKEN_REGEX$1 = /\{\{\s*([^\}\s]+)\s*\}\}/g;
class Renderer {
    constructor(app, registry, resolver, indexer) {
        this.enabled = true;
        this.hoverTimer = null;
        this.app = app;
        this.registry = registry;
        this.resolver = resolver;
        this.indexer = indexer;
        this.infoCard = new InfoCard(app);
        this.clickHandler = (event) => void this.onClick(event);
        this.mouseOverHandler = (event) => this.onMouseOver(event);
        this.mouseOutHandler = (event) => this.onMouseOut(event);
        document.addEventListener('click', this.clickHandler);
        document.addEventListener('mouseover', this.mouseOverHandler);
        document.addEventListener('mouseout', this.mouseOutHandler);
    }
    async processElement(el) {
        var _a;
        if (!this.enabled)
            return;
        // Walk text nodes and replace {{variable}} occurrences
        const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT, null);
        const nodes = [];
        let n;
        while ((n = walker.nextNode())) {
            // skip if parent is code or pre
            const parent = n.parentElement;
            if (!parent)
                continue;
            // Skipping our own rendered spans makes this processor idempotent without
            // storing a marker on Obsidian's reusable Reading View section elements.
            if (parent.closest('code, pre, .cm-s, .variable-links-token'))
                continue;
            if ((n.nodeValue || '').includes('{{'))
                nodes.push(n);
        }
        for (const textNode of nodes) {
            const text = textNode.nodeValue || '';
            let match;
            let lastIndex = 0;
            const frag = document.createDocumentFragment();
            TOKEN_REGEX$1.lastIndex = 0;
            let any = false;
            while ((match = TOKEN_REGEX$1.exec(text)) !== null) {
                any = true;
                const before = text.slice(lastIndex, match.index);
                if (before)
                    frag.appendChild(document.createTextNode(before));
                const varName = match[1].trim();
                const placeholder = document.createElement('span');
                placeholder.className = 'variable-links-token variable-links-token-reading';
                placeholder.textContent = '…';
                placeholder.dataset.var = varName;
                frag.appendChild(placeholder);
                // resolve async and then update placeholder
                this.resolver.resolve(varName).then(res => {
                    if (!this.enabled)
                        return;
                    if (!res.ok) {
                        placeholder.textContent = `[Missing: ${varName}]`;
                        placeholder.classList.add('missing');
                        placeholder.setAttribute('title', res.error || 'Unknown error');
                        return;
                    }
                    // render value
                    let display = '';
                    if (res.type === 'array')
                        display = res.value.join(', ');
                    else
                        display = String(res.value);
                    placeholder.textContent = display;
                }).catch(() => { });
                lastIndex = TOKEN_REGEX$1.lastIndex;
            }
            if (!any)
                continue;
            const rest = text.slice(lastIndex);
            if (rest)
                frag.appendChild(document.createTextNode(rest));
            (_a = textNode.parentNode) === null || _a === void 0 ? void 0 : _a.replaceChild(frag, textNode);
        }
    }
    unload() {
        var _a, _b, _c, _d;
        if (!this.enabled)
            return;
        this.enabled = false;
        if (this.hoverTimer)
            clearTimeout(this.hoverTimer);
        this.hoverTimer = null;
        document.removeEventListener('click', this.clickHandler);
        document.removeEventListener('mouseover', this.mouseOverHandler);
        document.removeEventListener('mouseout', this.mouseOutHandler);
        this.infoCard.destroy();
        for (const leaf of ((_b = (_a = this.app.workspace).getLeavesOfType) === null || _b === void 0 ? void 0 : _b.call(_a, 'markdown')) || []) {
            const previewMode = (_c = leaf === null || leaf === void 0 ? void 0 : leaf.view) === null || _c === void 0 ? void 0 : _c.previewMode;
            try {
                if (typeof (previewMode === null || previewMode === void 0 ? void 0 : previewMode.rerender) === 'function')
                    previewMode.rerender(true);
                else if (typeof ((_d = previewMode === null || previewMode === void 0 ? void 0 : previewMode.renderer) === null || _d === void 0 ? void 0 : _d.rerender) === 'function')
                    previewMode.renderer.rerender(true);
            }
            catch (error) { }
        }
    }
    tokenFromEvent(event) {
        var _a;
        const target = event.target instanceof Element ? event.target : null;
        return (_a = target === null || target === void 0 ? void 0 : target.closest) === null || _a === void 0 ? void 0 : _a.call(target, '.variable-links-token-reading[data-var]');
    }
    async onClick(event) {
        var _a;
        if (!this.enabled)
            return;
        const token = this.tokenFromEvent(event);
        const name = (_a = token === null || token === void 0 ? void 0 : token.dataset.var) === null || _a === void 0 ? void 0 : _a.trim();
        if (!token || !name)
            return;
        const result = await this.resolver.resolve(name).catch(() => null);
        if (!this.enabled || !(result === null || result === void 0 ? void 0 : result.ok) || !result.sourceFile)
            return;
        try {
            this.app.workspace.openLinkText(result.sourceFile.path.replace(/\.md$/i, ''), '', false);
        }
        catch (error) {
            this.app.workspace.openFile(result.sourceFile);
        }
        event.stopPropagation();
    }
    onMouseOver(event) {
        var _a, _b, _c;
        if (!this.enabled || ((_b = (_a = this.registry.plugin) === null || _a === void 0 ? void 0 : _a.settings) === null || _b === void 0 ? void 0 : _b.enableInfoCards) === false)
            return;
        const token = this.tokenFromEvent(event);
        const name = (_c = token === null || token === void 0 ? void 0 : token.dataset.var) === null || _c === void 0 ? void 0 : _c.trim();
        if (!token || !name)
            return;
        if (event.relatedTarget instanceof Node && token.contains(event.relatedTarget))
            return;
        if (this.hoverTimer)
            clearTimeout(this.hoverTimer);
        this.hoverTimer = setTimeout(async () => {
            var _a, _b, _c;
            this.hoverTimer = null;
            if (!this.enabled || !token.isConnected || !token.matches(':hover'))
                return;
            const definition = this.registry.getVariable(name);
            if (!(definition === null || definition === void 0 ? void 0 : definition.card))
                return;
            const result = await this.resolver.resolve(name).catch(() => null);
            if (!this.enabled || !token.isConnected || !token.matches(':hover'))
                return;
            const sourcePath = (_c = (_b = (_a = result === null || result === void 0 ? void 0 : result.sourceFile) === null || _a === void 0 ? void 0 : _a.path) !== null && _b !== void 0 ? _b : definition.file) !== null && _c !== void 0 ? _c : '';
            void this.infoCard.showFor(token, sourcePath, definition.card);
        }, 200);
    }
    onMouseOut(event) {
        const token = this.tokenFromEvent(event);
        if (!token)
            return;
        if (event.relatedTarget instanceof Node && token.contains(event.relatedTarget))
            return;
        if (this.hoverTimer)
            clearTimeout(this.hoverTimer);
        this.hoverTimer = null;
        this.infoCard.hideWithDelay(100);
    }
}

/** Suggest registry variables and unregistered frontmatter properties after {{. */
class VariableSuggest extends obsidian.EditorSuggest {
    constructor(app, indexer, registry) {
        super(app);
        this.app = app;
        this.indexer = indexer;
        this.registry = registry;
    }
    onTrigger(cursor, editor, _file) {
        const line = editor.getLine(cursor.line);
        const fromIndex = line.lastIndexOf('{{', cursor.ch - 1);
        if (fromIndex === -1)
            return null;
        const query = line.slice(fromIndex + 2, cursor.ch);
        if (query.includes('}}') || /\s/.test(query))
            return null;
        return {
            start: { line: cursor.line, ch: fromIndex },
            end: { line: cursor.line, ch: cursor.ch },
            query
        };
    }
    getSuggestions(context) {
        var _a, _b, _c, _d, _e;
        const query = (context.query || '').toLowerCase();
        const matches = (item) => !query || [item.name, item.display, item.file, item.property]
            .filter(Boolean).some((value) => String(value).toLowerCase().includes(query));
        const variables = Array.from(this.indexer.byName.values()).map((entry) => ({
            name: entry.name, kind: 'variable', display: entry.def.display, file: entry.filePath, property: entry.def.property
        }));
        const properties = [];
        const files = ((_b = (_a = this.app.vault).getMarkdownFiles) === null || _b === void 0 ? void 0 : _b.call(_a)) || [];
        for (const file of files) {
            const frontmatter = (_e = (_d = (_c = this.app.metadataCache) === null || _c === void 0 ? void 0 : _c.getFileCache) === null || _d === void 0 ? void 0 : _d.call(_c, file)) === null || _e === void 0 ? void 0 : _e.frontmatter;
            if (!frontmatter)
                continue;
            for (const property of Object.keys(frontmatter)) {
                const alreadyMapped = Array.from(this.indexer.byName.values()).some((entry) => entry.filePath === file.path && entry.def.property === property);
                if (alreadyMapped)
                    continue;
                properties.push({ name: property, kind: 'property', file: file.path, property });
            }
        }
        return [...variables.filter(matches), ...properties.filter(matches)].slice(0, 100);
    }
    renderSuggestion(item, el) {
        const container = el;
        container.createEl('div', { text: item.name });
        const detail = item.kind === 'variable'
            ? `Variable · ${item.file || ''}${item.property ? ` • ${item.property}` : ''}`
            : `Property · ${item.file || ''}`;
        container.createEl('div', { text: detail, cls: 'suggest-meta' });
        if (item.display)
            container.createEl('div', { text: String(item.display), cls: 'suggest-sub' });
    }
    async selectSuggestion(item, _event) {
        const context = this.context;
        if (!(context === null || context === void 0 ? void 0 : context.editor) || !(context === null || context === void 0 ? void 0 : context.start) || !(context === null || context === void 0 ? void 0 : context.end))
            return;
        let variableName = item.name;
        if (item.kind === 'property') {
            const base = (item.property || item.name)
                .trim()
                .replace(/\s+/g, '_')
                .replace(/[{}]/g, '') || 'Variable';
            let number = 1;
            do {
                variableName = `${base}_${String(number).padStart(2, '0')}`;
                number++;
            } while (this.registry.getVariable(variableName) || this.indexer.byName.has(variableName));
            try {
                await this.registry.saveVariable(variableName, {
                    file: item.file || '',
                    property: item.property || item.name,
                    display: item.property || item.name
                });
            }
            catch (error) {
                new obsidian.Notice(`Variable Links: could not create ${variableName}: ${error instanceof Error ? error.message : String(error)}`);
                return;
            }
        }
        const line = context.editor.getLine(context.end.line);
        const hasAutoCloser = line.slice(context.end.ch, context.end.ch + 2) === '}}';
        context.editor.replaceRange(hasAutoCloser ? `{{${variableName}` : `{{${variableName}}}`, context.start, context.end);
    }
}

const TOKEN_REGEX = /\{\{\s*([^\}\s]+)\s*\}\}/g;
const refreshVariableLinks = state.StateEffect.define();
/**
 * Uses CodeMirror's native replacement decorations rather than positioned DOM
 * overlays. The original token remains in the document and is restored while
 * its range contains the editor selection.
 */
class LivePreviewRenderer {
    constructor(app, resolver) {
        this.revision = 0;
        this.active = true;
        this.timers = new Set();
        this.app = app;
        this.resolver = resolver;
    }
    /** Force open Markdown panes to resolve their variables again. */
    refresh() {
        var _a, _b, _c, _d;
        if (!this.active)
            return;
        this.revision++;
        const leaves = this.getMarkdownLeaves();
        for (const leaf of leaves) {
            const editorView = (_b = (_a = leaf === null || leaf === void 0 ? void 0 : leaf.view) === null || _a === void 0 ? void 0 : _a.editor) === null || _b === void 0 ? void 0 : _b.cm;
            if (typeof (editorView === null || editorView === void 0 ? void 0 : editorView.dispatch) === 'function') {
                try {
                    editorView.dispatch({ effects: refreshVariableLinks.of(undefined) });
                }
                catch (error) { }
            }
            const previewMode = (_c = leaf === null || leaf === void 0 ? void 0 : leaf.view) === null || _c === void 0 ? void 0 : _c.previewMode;
            try {
                if (typeof (previewMode === null || previewMode === void 0 ? void 0 : previewMode.rerender) === 'function')
                    previewMode.rerender(true);
                else if (typeof ((_d = previewMode === null || previewMode === void 0 ? void 0 : previewMode.renderer) === null || _d === void 0 ? void 0 : _d.rerender) === 'function')
                    previewMode.renderer.rerender(true);
            }
            catch (error) { }
        }
        // File-change rendering can be queued just after a vault write. Run a
        // second Reading View pass once that queue has settled.
        const timer = setTimeout(() => {
            var _a, _b;
            this.timers.delete(timer);
            if (!this.active)
                return;
            for (const leaf of leaves) {
                const previewMode = (_a = leaf === null || leaf === void 0 ? void 0 : leaf.view) === null || _a === void 0 ? void 0 : _a.previewMode;
                try {
                    if (typeof (previewMode === null || previewMode === void 0 ? void 0 : previewMode.rerender) === 'function')
                        previewMode.rerender(true);
                    else if (typeof ((_b = previewMode === null || previewMode === void 0 ? void 0 : previewMode.renderer) === null || _b === void 0 ? void 0 : _b.rerender) === 'function')
                        previewMode.renderer.rerender(true);
                }
                catch (error) { }
            }
        }, 50);
        this.timers.add(timer);
    }
    /** Cancel delayed work and remove this plugin's visible editor decorations. */
    unload() {
        var _a, _b, _c, _d;
        if (!this.active)
            return;
        this.active = false;
        this.revision++;
        for (const timer of this.timers)
            clearTimeout(timer);
        this.timers.clear();
        for (const leaf of this.getMarkdownLeaves()) {
            const editorView = (_b = (_a = leaf === null || leaf === void 0 ? void 0 : leaf.view) === null || _a === void 0 ? void 0 : _a.editor) === null || _b === void 0 ? void 0 : _b.cm;
            try {
                if (typeof (editorView === null || editorView === void 0 ? void 0 : editorView.dispatch) === 'function') {
                    editorView.dispatch({ effects: refreshVariableLinks.of(undefined) });
                }
            }
            catch (error) { }
            const previewMode = (_c = leaf === null || leaf === void 0 ? void 0 : leaf.view) === null || _c === void 0 ? void 0 : _c.previewMode;
            try {
                if (typeof (previewMode === null || previewMode === void 0 ? void 0 : previewMode.rerender) === 'function')
                    previewMode.rerender(true);
                else if (typeof ((_d = previewMode === null || previewMode === void 0 ? void 0 : previewMode.renderer) === null || _d === void 0 ? void 0 : _d.rerender) === 'function')
                    previewMode.renderer.rerender(true);
            }
            catch (error) { }
        }
    }
    getMarkdownLeaves() {
        var _a, _b, _c;
        const leaves = [];
        if (typeof ((_a = this.app.workspace) === null || _a === void 0 ? void 0 : _a.iterateAllLeaves) === 'function') {
            this.app.workspace.iterateAllLeaves((leaf) => {
                var _a, _b;
                if (((_b = (_a = leaf === null || leaf === void 0 ? void 0 : leaf.view) === null || _a === void 0 ? void 0 : _a.getViewType) === null || _b === void 0 ? void 0 : _b.call(_a)) === 'markdown')
                    leaves.push(leaf);
            });
        }
        else
            leaves.push(...(((_c = (_b = this.app.workspace) === null || _b === void 0 ? void 0 : _b.getLeavesOfType) === null || _c === void 0 ? void 0 : _c.call(_b, 'markdown')) || []));
        return leaves;
    }
    createExtension() {
        const renderer = this;
        class VariableWidget extends view.WidgetType {
            constructor(name, revision) {
                super();
                this.name = name;
                this.revision = revision;
            }
            eq(other) { return other.name === this.name && other.revision === this.revision; }
            toDOM() {
                const el = document.createElement('span');
                el.className = 'variable-links-token variable-links-token-live-preview';
                el.textContent = '…';
                el.dataset.var = this.name;
                void renderer.resolver.resolve(this.name).then((result) => {
                    if (!renderer.active)
                        return;
                    if (!result.ok) {
                        el.textContent = `[Missing: ${this.name}]`;
                        el.classList.add('missing');
                        el.title = result.error || '';
                        return;
                    }
                    el.textContent = Array.isArray(result.value) ? result.value.join(', ') : String(result.value);
                }).catch(() => {
                    if (!renderer.active)
                        return;
                    el.textContent = `[Missing: ${this.name}]`;
                    el.classList.add('missing');
                });
                return el;
            }
            // Let CodeMirror process mouse and keyboard events, including moving the
            // caret into this token so the source text becomes editable again.
            ignoreEvent() { return false; }
        }
        const buildDecorations = (view$1) => {
            const builder = new state.RangeSetBuilder();
            if (!renderer.active)
                return builder.finish();
            const text = view$1.state.doc.toString();
            const selection = view$1.state.selection.main;
            let match;
            TOKEN_REGEX.lastIndex = 0;
            while ((match = TOKEN_REGEX.exec(text)) !== null) {
                const from = match.index;
                const to = TOKEN_REGEX.lastIndex;
                // Do not replace the token while the caret or selection touches it.
                if (selection.from <= to && selection.to >= from)
                    continue;
                builder.add(from, to, view.Decoration.replace({ widget: new VariableWidget(match[1].trim(), renderer.revision) }));
            }
            return builder.finish();
        };
        return view.ViewPlugin.fromClass(class {
            constructor(view) { this.decorations = buildDecorations(view); }
            update(update) {
                const refreshRequested = update.transactions.some((transaction) => transaction.effects.some((effect) => effect.is(refreshVariableLinks)));
                if (update.docChanged || update.selectionSet || update.viewportChanged || refreshRequested) {
                    this.decorations = buildDecorations(update.view);
                }
            }
        }, { decorations: (value) => value.decorations });
    }
}

class TokenCache {
    constructor(app, plugin, registry) {
        var _a;
        this.data = { version: 1, files: {}, tokens: {} };
        this.listeners = [];
        this.timers = new Map();
        this.active = true;
        this.generation = 0;
        this.app = app;
        this.plugin = plugin;
        this.registry = registry;
        const configDir = app.vault.configDir || '.obsidian';
        const pluginId = ((_a = plugin.manifest) === null || _a === void 0 ? void 0 : _a.id) || 'variable-links';
        this.cachePath = `${configDir}/plugins/${pluginId}/token-cache.json`;
    }
    async initialize() {
        const generation = this.generation;
        const adapter = this.app.vault.adapter;
        try {
            if (await adapter.exists(this.cachePath)) {
                const parsed = JSON.parse(await adapter.read(this.cachePath));
                if ((parsed === null || parsed === void 0 ? void 0 : parsed.version) === 1 && parsed.files && parsed.tokens)
                    this.data = parsed;
            }
        }
        catch (error) {
            this.data = { version: 1, files: {}, tokens: {} };
        }
        if (!this.isCurrent(generation))
            return;
        await this.synchronize();
        if (this.isCurrent(generation))
            this.attach();
    }
    stop() {
        if (!this.active)
            return;
        this.active = false;
        this.generation++;
        const vault = this.app.vault;
        for (const listener of this.listeners)
            vault.off(listener.event, listener.callback);
        this.listeners = [];
        for (const timer of this.timers.values())
            clearTimeout(timer);
        this.timers.clear();
    }
    async rebuild() {
        if (!this.active)
            return;
        this.data = { version: 1, files: {}, tokens: {} };
        await this.synchronize(true);
    }
    async synchronize(force = false) {
        var _a, _b;
        if (!this.active)
            return;
        const generation = this.generation;
        const files = ((_b = (_a = this.app.vault).getMarkdownFiles) === null || _b === void 0 ? void 0 : _b.call(_a)) || [];
        const currentPaths = new Set(files.map((file) => file.path));
        for (const path of Object.keys(this.data.files)) {
            if (!currentPaths.has(path))
                this.removeFile(path);
        }
        for (const file of files) {
            if (!this.isCurrent(generation))
                return;
            const stat = file.stat || {};
            const cached = this.data.files[file.path];
            if (force || !cached || cached.mtime !== stat.mtime || cached.size !== stat.size)
                await this.indexFile(file);
        }
        if (!this.isCurrent(generation))
            return;
        this.syncTokenNames();
        await this.persist();
    }
    async removeGuid(guid) {
        if (!this.active)
            return;
        delete this.data.tokens[guid];
        await this.persist();
    }
    async prepareRename(guid, oldName, newName) {
        var _a, _b, _c;
        if (!this.active)
            throw new Error('The token cache is not active.');
        await this.synchronize();
        if (!this.data.tokens[guid])
            await this.rebuild();
        let paths = Array.from(new Set((((_a = this.data.tokens[guid]) === null || _a === void 0 ? void 0 : _a.locations) || []).map((location) => location.file)));
        if (!paths.length)
            paths = (((_c = (_b = this.app.vault).getMarkdownFiles) === null || _c === void 0 ? void 0 : _c.call(_b)) || []).map((file) => file.path);
        const files = paths
            .map((path) => this.app.vault.getAbstractFileByPath(path))
            .filter((file) => file instanceof obsidian.TFile);
        const applied = [];
        const cache = this;
        const rollback = async () => {
            for (const change of [...applied].reverse()) {
                try {
                    await cache.app.vault.process(change.file, (current) => current === change.updated ? change.original : current);
                }
                catch (error) { }
            }
            applied.length = 0;
            await cache.rebuild();
        };
        return {
            apply: async () => {
                try {
                    for (const file of files) {
                        const preview = await cache.app.vault.read(file);
                        if (cache.replaceToken(preview, oldName, newName) === preview)
                            continue;
                        let original = '';
                        let updated = '';
                        await cache.app.vault.process(file, (current) => {
                            original = current;
                            updated = cache.replaceToken(current, oldName, newName);
                            return updated;
                        });
                        if (updated !== original)
                            applied.push({ file, original, updated });
                    }
                }
                catch (error) {
                    await rollback();
                    throw error;
                }
            },
            rollback,
            commit: async () => {
                for (const change of applied)
                    await cache.indexFile(change.file);
                if (!cache.data.tokens[guid])
                    cache.data.tokens[guid] = { guid, name: newName, locations: [] };
                cache.data.tokens[guid].name = newName;
                cache.syncTokenNames();
                await cache.persist();
            }
        };
    }
    attach() {
        if (!this.active || this.listeners.length)
            return;
        const vault = this.app.vault;
        const add = (event, callback) => {
            if (!this.active)
                return;
            vault.on(event, callback);
            this.listeners.push({ event, callback });
        };
        add('modify', (file) => this.schedule(file));
        add('create', (file) => this.schedule(file));
        add('delete', (file) => {
            if (!this.active)
                return;
            if (!this.isMarkdown(file))
                return;
            this.removeFile(file.path);
            void this.persist();
        });
        add('rename', (file, oldPath) => {
            if (!this.active)
                return;
            this.removeFile(oldPath);
            this.schedule(file);
        });
    }
    schedule(file) {
        if (!this.active || !this.isMarkdown(file))
            return;
        const prior = this.timers.get(file.path);
        if (prior)
            clearTimeout(prior);
        this.timers.set(file.path, setTimeout(async () => {
            this.timers.delete(file.path);
            if (!this.active)
                return;
            try {
                await this.indexFile(file);
                await this.persist();
            }
            catch (error) { }
        }, 150));
    }
    isMarkdown(file) {
        return file instanceof obsidian.TFile && /\.md$/i.test(file.path);
    }
    async indexFile(file) {
        if (!this.active)
            return;
        const generation = this.generation;
        const content = await this.app.vault.read(file);
        if (!this.isCurrent(generation))
            return;
        this.removeFile(file.path);
        for (const occurrence of this.findTokens(content)) {
            const definition = this.registry.getVariable(occurrence.name);
            if (!(definition === null || definition === void 0 ? void 0 : definition.guid))
                continue;
            const token = this.data.tokens[definition.guid] || {
                guid: definition.guid,
                name: occurrence.name,
                locations: []
            };
            token.name = occurrence.name;
            token.locations.push({ file: file.path, line: occurrence.line, ch: occurrence.ch });
            this.data.tokens[definition.guid] = token;
        }
        const stat = file.stat || {};
        this.data.files[file.path] = { mtime: stat.mtime || 0, size: stat.size || content.length };
    }
    removeFile(path) {
        delete this.data.files[path];
        for (const token of Object.values(this.data.tokens)) {
            token.locations = token.locations.filter((location) => location.file !== path);
        }
    }
    syncTokenNames() {
        const validGuids = new Set();
        for (const [name, definition] of this.registry.data) {
            if (!definition.guid)
                continue;
            validGuids.add(definition.guid);
            const token = this.data.tokens[definition.guid] || { guid: definition.guid, name, locations: [] };
            token.name = name;
            this.data.tokens[definition.guid] = token;
        }
        for (const guid of Object.keys(this.data.tokens))
            if (!validGuids.has(guid))
                delete this.data.tokens[guid];
    }
    replaceToken(content, oldName, newName) {
        const occurrences = this.findTokens(content).filter((occurrence) => occurrence.name === oldName);
        let updated = content;
        for (const occurrence of occurrences.reverse()) {
            updated = updated.slice(0, occurrence.start) + `{{${newName}}}` + updated.slice(occurrence.end);
        }
        return updated;
    }
    findTokens(content) {
        const occurrences = [];
        const linePattern = /[^\r\n]*(?:\r\n|\n|\r|$)/g;
        let offset = 0;
        let lineNumber = 1;
        let fence = null;
        let fenceLength = 0;
        let lineMatch;
        while ((lineMatch = linePattern.exec(content)) !== null) {
            const raw = lineMatch[0];
            if (!raw && linePattern.lastIndex >= content.length)
                break;
            const line = raw.replace(/\r\n$|\n$|\r$/, '');
            const fenceMatch = line.match(/^\s*(`{3,}|~{3,})/);
            if (fenceMatch) {
                const marker = fenceMatch[1][0];
                if (!fence) {
                    fence = marker;
                    fenceLength = fenceMatch[1].length;
                }
                else if (fence === marker && fenceMatch[1].length >= fenceLength) {
                    fence = null;
                    fenceLength = 0;
                }
            }
            else if (!fence) {
                const tokenPattern = /\{\{\s*([^}\s]+)\s*\}\}/g;
                let tokenMatch;
                while ((tokenMatch = tokenPattern.exec(line)) !== null) {
                    if (this.isInsideInlineCode(line, tokenMatch.index))
                        continue;
                    occurrences.push({
                        name: tokenMatch[1].trim(),
                        start: offset + tokenMatch.index,
                        end: offset + tokenPattern.lastIndex,
                        line: lineNumber,
                        ch: tokenMatch.index + 1
                    });
                }
            }
            offset += raw.length;
            lineNumber++;
        }
        return occurrences;
    }
    isInsideInlineCode(line, index) {
        let openLength = 0;
        for (let position = 0; position < index;) {
            if (line[position] !== '`') {
                position++;
                continue;
            }
            let end = position;
            while (end < index && line[end] === '`')
                end++;
            const length = end - position;
            if (!openLength)
                openLength = length;
            else if (length === openLength)
                openLength = 0;
            position = end;
        }
        return openLength > 0;
    }
    async persist() {
        if (!this.active)
            return;
        const adapter = this.app.vault.adapter;
        await adapter.write(this.cachePath, JSON.stringify(this.data, null, 2) + '\n');
    }
    isCurrent(generation) {
        return this.active && this.generation === generation;
    }
}

class VariableLinksPlugin extends obsidian.Plugin {
    constructor() {
        super(...arguments);
        this.registry = null;
        this.indexer = null;
        this.resolver = null;
        this.renderer = null;
        this.livePreviewRenderer = null;
        this.tokenCache = null;
        this.suggest = null;
        this.caretTracker = null;
        this.settingTab = null;
        this.active = false;
        this.timers = new Set();
        this.contextMenuCleanups = [];
        this.vaultModifyHandler = null;
        this.editorMenuHandler = null;
        this.contextMenuHandler = null;
        this.lastContextClick = null;
    }
    async onload() {
        this.active = true;
        try {
            await this.loadSettings();
            if (!this.active)
                return;
            this.settingTab = new VariableLinksSettingTab(this.app, this);
            this.addSettingTab(this.settingTab);
            // Initialize registry/indexer/resolver/renderer with defensive try/catch so one failure doesn't break plugin
            try {
                this.registry = new Registry(this.app, this);
                await this.registry.load();
                if (!this.active)
                    return;
            }
            catch (e) {
                try {
                    const N = globalThis.Notice;
                    if (typeof N === 'function')
                        new N('Variable Links: registry failed to load.');
                }
                catch (e) { }
            }
            try {
                this.indexer = new Indexer(this.app, this.registry);
                await this.indexer.build();
                if (!this.active)
                    return;
            }
            catch (e) { }
            try {
                this.tokenCache = new TokenCache(this.app, this, this.registry);
                await this.tokenCache.initialize();
                if (!this.active)
                    return;
            }
            catch (e) { }
            try {
                this.resolver = new Resolver(this.app, this.registry);
            }
            catch (e) { }
            try {
                if (typeof this.registerMarkdownPostProcessor !== 'function') {
                    throw new Error('registerMarkdownPostProcessor is unavailable.');
                }
                this.renderer = new Renderer(this.app, this.registry, this.resolver, this.indexer);
                this.registerMarkdownPostProcessor((el, ctx) => {
                    var _a;
                    try {
                        return (_a = this.renderer) === null || _a === void 0 ? void 0 : _a.processElement(el);
                    }
                    catch (err) { }
                });
            }
            catch (e) { }
            // Use native CodeMirror decorations in Live Preview. Unlike positioned
            // overlays, they replace the text in the editor's normal layout.
            try {
                if (typeof this.registerEditorExtension !== 'function')
                    throw new Error('registerEditorExtension is unavailable.');
                this.livePreviewRenderer = new LivePreviewRenderer(this.app, this.resolver);
                this.registerEditorExtension(this.livePreviewRenderer.createExtension());
                const refreshOpenViews = () => {
                    var _a;
                    if (this.active)
                        (_a = this.livePreviewRenderer) === null || _a === void 0 ? void 0 : _a.refresh();
                };
                this.schedule(refreshOpenViews, 0);
            }
            catch (e) { }
            try {
                // register view
                const panelMod = await Promise.resolve().then(function () { return panel; });
                if (!this.active)
                    return;
                this.registerView(panelMod.VIEW_TYPE_VARIABLE_PANEL, (leaf) => new panelMod.VariablePropertiesView(leaf, this));
                this.addCommand({
                    id: 'open-variable-properties',
                    name: 'Open Variable Properties',
                    callback: () => this.openVariableProperties()
                });
                this.registerVariableContextMenu();
                // start caret tracker
                const CaretTracker = (await Promise.resolve().then(function () { return caretTracker; })).default;
                if (!this.active)
                    return;
                const ct = new CaretTracker(this.app, this, this.registry, this.resolver);
                ct.start();
                this.caretTracker = ct;
            }
            catch (e) { }
            // register suggest if enabled
            try {
                if (this.settings) {
                    if (this.settings.autocomplete !== false) {
                        this.suggest = new VariableSuggest(this.app, this.indexer, this.registry);
                        if (typeof this.registerEditorSuggest === 'function') {
                            try {
                                this.registerEditorSuggest(this.suggest);
                            }
                            catch (e) { }
                        }
                    }
                }
            }
            catch (e) { }
            // watch registry reloads to rebuild index
            const reloadIndex = async () => {
                if (this.active && this.indexer)
                    await this.indexer.build();
            };
            // listen to vault modify events so we can update index when registry changed
            try {
                this.vaultModifyHandler = (file) => {
                    var _a;
                    if (!this.active)
                        return;
                    try {
                        if (((_a = this.registry) === null || _a === void 0 ? void 0 : _a.registryFile) && file.path === this.registry.registryFile.path) {
                            this.schedule(() => void reloadIndex(), 100);
                        }
                    }
                    catch (e) { }
                };
                const modifyRef = this.app.vault.on('modify', this.vaultModifyHandler);
                if (typeof this.registerEvent === 'function')
                    this.registerEvent(modifyRef);
            }
            catch (e) { }
            // expose helper for panel: when caret tracker notifies, refresh any open panel views
            this.onCaretVariableChanged = (last) => {
                if (!this.active)
                    return;
                try {
                    Promise.resolve().then(function () { return panel; }).then(async (mod) => {
                        if (!this.active)
                            return;
                        try {
                            const leaves = this.app.workspace.getLeavesOfType(mod.VIEW_TYPE_VARIABLE_PANEL);
                            if (leaves && leaves.length > 0) {
                                for (let i = 0; i < leaves.length; i++) {
                                    if (!this.active)
                                        return;
                                    try {
                                        const view = leaves[i].view;
                                        if (view && typeof view.refresh === 'function') {
                                            await view.refresh();
                                        }
                                        else if (view && typeof view.renderContent === 'function') {
                                            await view.renderContent();
                                        }
                                    }
                                    catch (e) { }
                                }
                            }
                        }
                        catch (e) { }
                    });
                }
                catch (e) { }
            };
        }
        catch (e) {
            try {
                const N = globalThis.Notice;
                if (typeof N === 'function')
                    new N('Variable Links failed to load: ' + String(e));
            }
            catch { }
        }
    }
    onunload() {
        var _a, _b, _c, _d, _e, _f, _g, _h, _j, _k;
        this.active = false;
        if (this.vaultModifyHandler) {
            try {
                this.app.vault.off('modify', this.vaultModifyHandler);
            }
            catch (error) { }
            this.vaultModifyHandler = null;
        }
        if (this.editorMenuHandler) {
            try {
                this.app.workspace.off('editor-menu', this.editorMenuHandler);
            }
            catch (error) { }
            this.editorMenuHandler = null;
        }
        if (this.contextMenuHandler) {
            try {
                document.removeEventListener('contextmenu', this.contextMenuHandler, true);
            }
            catch (error) { }
            this.contextMenuHandler = null;
        }
        for (const timer of this.timers)
            clearTimeout(timer);
        this.timers.clear();
        this.clearContextMenuResources();
        (_a = this.settingTab) === null || _a === void 0 ? void 0 : _a.dispose();
        this.lastContextClick = null;
        try {
            (_c = (_b = this.suggest) === null || _b === void 0 ? void 0 : _b.close) === null || _c === void 0 ? void 0 : _c.call(_b);
        }
        catch (error) { }
        (_d = this.caretTracker) === null || _d === void 0 ? void 0 : _d.stop();
        (_e = this.tokenCache) === null || _e === void 0 ? void 0 : _e.stop();
        (_f = this.registry) === null || _f === void 0 ? void 0 : _f.unload();
        (_g = this.renderer) === null || _g === void 0 ? void 0 : _g.unload();
        (_h = this.livePreviewRenderer) === null || _h === void 0 ? void 0 : _h.unload();
        // Explicitly close plugin-owned views. registerView removes the factory,
        // while this removes already-created ItemView instances and their DOM.
        try {
            const viewType = 'variable-links-panel';
            (_k = (_j = this.app.workspace).detachLeavesOfType) === null || _k === void 0 ? void 0 : _k.call(_j, viewType);
        }
        catch (error) { }
        this.onCaretVariableChanged = undefined;
        this.caretTracker = null;
        this.tokenCache = null;
        this.registry = null;
        this.renderer = null;
        this.livePreviewRenderer = null;
        this.resolver = null;
        this.indexer = null;
        this.suggest = null;
        this.settingTab = null;
    }
    schedule(callback, delay) {
        if (!this.active)
            return null;
        const timer = setTimeout(() => {
            this.timers.delete(timer);
            if (this.active)
                callback();
        }, delay);
        this.timers.add(timer);
        return timer;
    }
    async loadSettings() {
        var _a;
        const saved = await this.loadData() || {};
        const configDir = this.app.vault.configDir || '.obsidian';
        const pluginId = ((_a = this.manifest) === null || _a === void 0 ? void 0 : _a.id) || 'variable-links';
        const defaultRegistryPath = `${configDir}/plugins/${pluginId}/registry.json`;
        this.settings = Object.assign({}, DEFAULT_SETTINGS, { registryFilePath: defaultRegistryPath }, saved);
    }
    async saveSettings() {
        await this.saveData(this.settings);
    }
    async openVariableProperties(variableName) {
        var _a, _b;
        if (!this.active)
            return;
        const panelMod = await Promise.resolve().then(function () { return panel; });
        if (!this.active)
            return;
        let leaf = (_a = this.app.workspace.getLeavesOfType(panelMod.VIEW_TYPE_VARIABLE_PANEL)) === null || _a === void 0 ? void 0 : _a[0];
        if (!leaf) {
            leaf = this.app.workspace.getRightLeaf(false);
            if (!leaf)
                throw new Error('A sidebar could not be opened.');
            await leaf.setViewState({ type: panelMod.VIEW_TYPE_VARIABLE_PANEL });
        }
        if (variableName && typeof ((_b = leaf.view) === null || _b === void 0 ? void 0 : _b.selectVariable) === 'function') {
            await leaf.view.selectVariable(variableName);
        }
        this.app.workspace.revealLeaf(leaf);
    }
    registerVariableContextMenu() {
        if (typeof this.registerDomEvent === 'function') {
            this.contextMenuHandler = (event) => {
                if (!this.active)
                    return;
                this.lastContextClick = {
                    x: event.clientX,
                    y: event.clientY,
                    target: event.target,
                    time: Date.now()
                };
            };
            this.registerDomEvent(document, 'contextmenu', this.contextMenuHandler, true);
        }
        this.editorMenuHandler = (menu, editor) => {
            var _a, _b, _c, _d, _e, _f, _g;
            if (!this.active)
                return;
            this.clearContextMenuResources();
            const variableName = this.getContextVariableName(editor);
            const insertionPosition = this.getContextEditorPosition(editor);
            const definition = variableName ? (_a = this.registry) === null || _a === void 0 ? void 0 : _a.getVariable(variableName) : null;
            const isFavorite = (definition === null || definition === void 0 ? void 0 : definition.favorite) === true;
            const favorites = Array.from(((_d = (_c = (_b = this.registry) === null || _b === void 0 ? void 0 : _b.data) === null || _c === void 0 ? void 0 : _c.entries) === null || _d === void 0 ? void 0 : _d.call(_c)) || [])
                .filter((entry) => { var _a; return ((_a = entry[1]) === null || _a === void 0 ? void 0 : _a.favorite) === true; })
                .map((entry) => String(entry[0]))
                .sort((a, b) => a.localeCompare(b));
            const allLinks = Array.from(((_g = (_f = (_e = this.registry) === null || _e === void 0 ? void 0 : _e.data) === null || _f === void 0 ? void 0 : _f.keys) === null || _g === void 0 ? void 0 : _g.call(_f)) || [])
                .map((name) => String(name))
                .sort((a, b) => a.localeCompare(b));
            menu.addItem((parentItem) => {
                parentItem.setTitle('Variable Links').setIcon('braces');
                if (typeof parentItem.setSubmenu === 'function') {
                    const submenu = parentItem.setSubmenu();
                    submenu.addItem((item) => {
                        item.setTitle('Properties').setIcon('list').setDisabled(!variableName);
                        if (variableName)
                            item.onClick(() => void this.openVariableProperties(variableName));
                    });
                    submenu.addItem((item) => {
                        item
                            .setTitle(isFavorite ? 'Unfavorite' : 'Favorite')
                            .setIcon('star')
                            .setDisabled(!definition);
                        if (definition && variableName) {
                            item.onClick(() => void this.setVariableFavorite(variableName, !isFavorite));
                        }
                    });
                    if (typeof submenu.addSeparator === 'function')
                        submenu.addSeparator();
                    submenu.addItem((insertItem) => {
                        insertItem.setTitle('Insert Favorite').setIcon('text-cursor-input').setDisabled(!favorites.length);
                        if (!favorites.length || typeof insertItem.setSubmenu !== 'function')
                            return;
                        const favoritesMenu = insertItem.setSubmenu();
                        this.enableNestedSubmenuSwitch(submenu, insertItem, favoritesMenu);
                        for (const favoriteName of favorites) {
                            favoritesMenu.addItem((item) => item
                                .setTitle(favoriteName)
                                .setIcon('star')
                                .onClick(() => this.insertVariable(editor, favoriteName, insertionPosition)));
                        }
                    });
                    submenu.addItem((insertItem) => {
                        insertItem.setTitle('Insert').setIcon('text-cursor-input').setDisabled(!allLinks.length);
                        if (!allLinks.length || typeof insertItem.setSubmenu !== 'function')
                            return;
                        const linksMenu = insertItem.setSubmenu();
                        this.enableNestedSubmenuSwitch(submenu, insertItem, linksMenu);
                        for (const linkName of allLinks) {
                            linksMenu.addItem((item) => item
                                .setTitle(linkName)
                                .onClick(() => this.insertVariable(editor, linkName, insertionPosition)));
                        }
                    });
                    return;
                }
                // Older Obsidian versions do not expose nested menu items.
                parentItem
                    .setTitle('Variable Links: Properties')
                    .setDisabled(!variableName);
                if (variableName)
                    parentItem.onClick(() => void this.openVariableProperties(variableName));
            });
        };
        const eventRef = this.app.workspace.on('editor-menu', this.editorMenuHandler);
        if (typeof this.registerEvent === 'function')
            this.registerEvent(eventRef);
    }
    getContextVariableName(editor) {
        var _a, _b, _c, _d, _e;
        const click = this.lastContextClick;
        const recentClick = click && Date.now() - click.time < 1000 ? click : null;
        if (recentClick) {
            const tokenElement = (_b = (_a = recentClick.target) === null || _a === void 0 ? void 0 : _a.closest) === null || _b === void 0 ? void 0 : _b.call(_a, '.variable-links-token[data-var]');
            const renderedName = (_d = (_c = tokenElement === null || tokenElement === void 0 ? void 0 : tokenElement.dataset) === null || _c === void 0 ? void 0 : _c.var) === null || _d === void 0 ? void 0 : _d.trim();
            if (renderedName)
                return renderedName;
            return this.getVariableAtPosition(editor, this.getContextEditorPosition(editor));
        }
        return this.getVariableAtPosition(editor, (_e = editor === null || editor === void 0 ? void 0 : editor.getCursor) === null || _e === void 0 ? void 0 : _e.call(editor));
    }
    getVariableAtPosition(editor, position) {
        var _a;
        if (!position || typeof position.line !== 'number' || typeof position.ch !== 'number')
            return null;
        const line = (_a = editor === null || editor === void 0 ? void 0 : editor.getLine) === null || _a === void 0 ? void 0 : _a.call(editor, position.line);
        if (typeof line !== 'string')
            return null;
        const pattern = /\{\{\s*([^\}\s]+)\s*\}\}/g;
        let match;
        while ((match = pattern.exec(line)) !== null) {
            if (position.ch >= match.index && position.ch <= pattern.lastIndex)
                return match[1].trim();
        }
        return null;
    }
    getContextEditorPosition(editor) {
        var _a, _b, _c, _d, _e;
        const click = this.lastContextClick;
        const recentClick = click && Date.now() - click.time < 1000 ? click : null;
        if (!recentClick)
            return ((_a = editor === null || editor === void 0 ? void 0 : editor.getCursor) === null || _a === void 0 ? void 0 : _a.call(editor)) || null;
        if (!((_c = (_b = recentClick.target) === null || _b === void 0 ? void 0 : _b.closest) === null || _c === void 0 ? void 0 : _c.call(_b, '.cm-editor')))
            return null;
        const offset = (_e = (_d = editor === null || editor === void 0 ? void 0 : editor.cm) === null || _d === void 0 ? void 0 : _d.posAtCoords) === null || _e === void 0 ? void 0 : _e.call(_d, { x: recentClick.x, y: recentClick.y });
        if (typeof offset !== 'number')
            return null;
        return typeof editor.offsetToPos === 'function'
            ? editor.offsetToPos(offset)
            : this.positionFromOffset(editor.getValue(), offset);
    }
    insertVariable(editor, variableName, contextPosition) {
        var _a;
        const position = contextPosition || ((_a = editor === null || editor === void 0 ? void 0 : editor.getCursor) === null || _a === void 0 ? void 0 : _a.call(editor));
        if (!position || typeof (editor === null || editor === void 0 ? void 0 : editor.replaceRange) !== 'function') {
            new obsidian.Notice('Variable Links: the insertion position is unavailable.');
            return;
        }
        editor.replaceRange(`{{${variableName}}}`, position);
    }
    /** Work around Obsidian retaining the first open sibling sub-submenu. */
    enableNestedSubmenuSwitch(parentMenu, item, itemSubmenu) {
        const itemElement = item === null || item === void 0 ? void 0 : item.dom;
        if (!(itemElement === null || itemElement === void 0 ? void 0 : itemElement.addEventListener))
            return;
        let timer = null;
        const onMouseEnter = () => {
            const current = parentMenu === null || parentMenu === void 0 ? void 0 : parentMenu.currentSubmenu;
            if (!current || current === itemSubmenu)
                return;
            if (timer)
                clearTimeout(timer);
            timer = setTimeout(() => {
                var _a, _b, _c;
                timer = null;
                if (!this.active || !itemElement.isConnected || !((_a = itemElement.matches) === null || _a === void 0 ? void 0 : _a.call(itemElement, ':hover')))
                    return;
                try {
                    if (typeof parentMenu.closeSubmenu === 'function')
                        parentMenu.closeSubmenu();
                    else if (typeof current.hide === 'function')
                        current.hide();
                    try {
                        parentMenu.currentSubmenu = null;
                    }
                    catch (_) { }
                    const MouseEventCtor = ((_c = (_b = itemElement.ownerDocument) === null || _b === void 0 ? void 0 : _b.defaultView) === null || _c === void 0 ? void 0 : _c.MouseEvent) || MouseEvent;
                    itemElement.dispatchEvent(new MouseEventCtor('mouseover', { bubbles: true, cancelable: true }));
                }
                catch (error) { }
            }, 300);
        };
        const onMouseLeave = () => {
            if (!timer)
                return;
            clearTimeout(timer);
            timer = null;
        };
        itemElement.addEventListener('mouseenter', onMouseEnter);
        itemElement.addEventListener('mouseleave', onMouseLeave);
        this.contextMenuCleanups.push(() => {
            if (timer)
                clearTimeout(timer);
            timer = null;
            itemElement.removeEventListener('mouseenter', onMouseEnter);
            itemElement.removeEventListener('mouseleave', onMouseLeave);
        });
    }
    clearContextMenuResources() {
        for (const cleanup of this.contextMenuCleanups.splice(0)) {
            try {
                cleanup();
            }
            catch (error) { }
        }
    }
    async setVariableFavorite(variableName, favorite) {
        var _a, _b;
        const definition = (_a = this.registry) === null || _a === void 0 ? void 0 : _a.getVariable(variableName);
        if (!definition || !this.registry) {
            new obsidian.Notice(`Variable Links: {{${variableName}}} is not configured.`);
            return;
        }
        try {
            await this.registry.saveVariable(variableName, { ...definition, favorite });
            const panelMod = await Promise.resolve().then(function () { return panel; });
            for (const leaf of this.app.workspace.getLeavesOfType(panelMod.VIEW_TYPE_VARIABLE_PANEL) || []) {
                if (typeof ((_b = leaf.view) === null || _b === void 0 ? void 0 : _b.refresh) === 'function')
                    await leaf.view.refresh();
            }
            new obsidian.Notice(`Variable Links: ${favorite ? 'favorited' : 'unfavorited'} {{${variableName}}}`);
        }
        catch (error) {
            new obsidian.Notice(`Variable Links: ${error instanceof Error ? error.message : String(error)}`);
        }
    }
    positionFromOffset(text, offset) {
        const before = text.slice(0, offset).split(/\r?\n/);
        return { line: before.length - 1, ch: before[before.length - 1].length };
    }
}

const VIEW_TYPE_VARIABLE_PANEL = 'variable-links-panel';
/** A split, editable sidebar for the selected variable and its info card. */
class VariablePropertiesView extends obsidian.ItemView {
    constructor(leaf, plugin) {
        super(leaf);
        this.contentEl = null;
        this.selectedVariableName = null;
        this.active = false;
        this.refreshGeneration = 0;
        this.timers = new Set();
        this.markdownChild = null;
        this.plugin = plugin;
    }
    getViewType() { return VIEW_TYPE_VARIABLE_PANEL; }
    getDisplayText() { return 'Variable Properties'; }
    getIcon() { return 'list'; }
    async onOpen() {
        this.active = true;
        this.containerEl.empty();
        this.containerEl.addClass('variable-links-panel');
        this.contentEl = this.containerEl.createDiv('variable-links-panel-inner');
        await this.refresh();
    }
    async onClose() {
        this.active = false;
        this.refreshGeneration++;
        for (const timer of this.timers)
            clearTimeout(timer);
        this.timers.clear();
        this.clearMarkdownChild();
        this.contentEl = null;
    }
    async selectVariable(name) {
        this.selectedVariableName = name.trim() || null;
        await this.refresh();
    }
    async refresh() {
        var _a, _b, _c, _d;
        if (!this.active || !this.contentEl)
            return;
        const generation = ++this.refreshGeneration;
        for (const timer of this.timers)
            clearTimeout(timer);
        this.timers.clear();
        this.clearMarkdownChild();
        this.contentEl.empty();
        const markdownChild = new obsidian.MarkdownRenderChild(this.contentEl);
        this.markdownChild = markdownChild;
        try {
            this.addChild(markdownChild);
        }
        catch (error) {
            (_a = markdownChild.load) === null || _a === void 0 ? void 0 : _a.call(markdownChild);
        }
        const registry = this.plugin.registry;
        const last = (_b = this.plugin.caretTracker) === null || _b === void 0 ? void 0 : _b.lastTouched;
        const names = Array.from(((_d = (_c = registry === null || registry === void 0 ? void 0 : registry.data) === null || _c === void 0 ? void 0 : _c.keys) === null || _d === void 0 ? void 0 : _d.call(_c)) || []).sort((a, b) => a.localeCompare(b));
        const activeName = this.selectedVariableName || (last === null || last === void 0 ? void 0 : last.name) || '';
        const definition = activeName ? (registry === null || registry === void 0 ? void 0 : registry.getVariable(activeName)) || {} : {};
        const toolbar = this.contentEl.createDiv('variable-links-panel-toolbar');
        const select = toolbar.createEl('select');
        select.add(new Option(activeName && !definition.file ? `[New] ${activeName}` : 'Select a Variable Link…', ''));
        for (const name of names)
            select.add(new Option(name, name));
        select.value = definition.file ? activeName : '';
        select.addEventListener('change', () => {
            this.selectedVariableName = select.value || null;
            void this.refresh();
        });
        const setButton = toolbar.createEl('button', { text: 'Set token' });
        setButton.disabled = !activeName || !definition.file || !(last === null || last === void 0 ? void 0 : last.editor) || !(last === null || last === void 0 ? void 0 : last.from) || !(last === null || last === void 0 ? void 0 : last.to);
        setButton.addEventListener('click', () => {
            if (setButton.disabled)
                return;
            last.editor.replaceRange(`{{${activeName}}}`, last.from, last.to);
            last.name = activeName;
            last.def = definition;
            new obsidian.Notice(`Variable Links: token set to {{${activeName}}}`);
        });
        const deleteButton = toolbar.createEl('button', { text: 'Delete' });
        deleteButton.disabled = !activeName || !definition.file;
        deleteButton.addEventListener('click', async () => {
            if (deleteButton.disabled || !window.confirm(`Delete Variable Link “${activeName}”?`))
                return;
            try {
                await registry.deleteVariable(activeName);
                if ((last === null || last === void 0 ? void 0 : last.name) === activeName) {
                    last.def = null;
                    last.value = undefined;
                }
                this.selectedVariableName = null;
                new obsidian.Notice(`Variable Links: deleted {{${activeName}}}`);
                await this.refresh();
            }
            catch (error) {
                new obsidian.Notice(`Variable Links: ${error instanceof Error ? error.message : String(error)}`);
            }
        });
        const layout = this.contentEl.createDiv('variable-links-panel-split');
        const propertiesPane = layout.createDiv('variable-links-panel-pane variable-links-panel-properties');
        const cardPane = layout.createDiv('variable-links-panel-pane variable-links-panel-infocard');
        propertiesPane.createEl('h4', { text: 'Variable properties' });
        cardPane.createEl('h4', { text: 'Info card' });
        if (!activeName) {
            propertiesPane.createEl('p', { text: 'No variable selected. Add a variable below or place the caret in a {{token}}.' });
            this.renderVariableForm(propertiesPane, '', {}, 'Add a variable');
            cardPane.createEl('p', { text: 'Select or create a variable to configure its info card.' });
            return;
        }
        const result = definition.file ? await this.plugin.resolver.resolve(activeName) : null;
        if (!this.isCurrent(generation))
            return;
        propertiesPane.createEl('h5', { text: `{{${activeName}}}` });
        const valueText = (result === null || result === void 0 ? void 0 : result.ok) ? String(result.value) : '[Missing]';
        const valueEl = propertiesPane.createDiv('variable-links-panel-value');
        await obsidian.MarkdownRenderer.renderMarkdown(valueText, valueEl, '', markdownChild);
        if (!this.isCurrent(generation))
            return;
        const actions = propertiesPane.createDiv('variable-links-panel-actions');
        actions.createEl('button', { text: 'Open source' }).addEventListener('click', async () => {
            if (result === null || result === void 0 ? void 0 : result.sourceFile)
                await this.app.workspace.openLinkText(result.sourceFile.path.replace(/\.md$/i, ''), '', false);
        });
        actions.createEl('button', { text: 'Copy value' }).addEventListener('click', () => { var _a; return void ((_a = navigator.clipboard) === null || _a === void 0 ? void 0 : _a.writeText(valueText)); });
        this.renderVariableForm(propertiesPane, activeName, definition, definition.file ? 'Edit mapping' : 'Set up this variable');
        if (definition.file)
            this.renderInfoCardForm(cardPane, activeName, definition);
        else
            cardPane.createEl('p', { text: 'Save the variable mapping before configuring its info card.' });
    }
    renderVariableForm(parent, name, definition, title) {
        const section = parent.createEl('details', { cls: 'variable-links-panel-editor' });
        section.open = true;
        section.createEl('summary', { text: title });
        const form = section.createEl('form');
        const nameInput = this.addInput(form, 'Variable name', name, 'e.g. customer');
        const fileInput = this.addInput(form, 'Source note', definition.file || '', '[[People/John Smith]] or People/John Smith.md');
        const propertyInput = this.addInput(form, 'Property', definition.property || '', 'e.g. company');
        const displayInput = this.addInput(form, 'Display name (optional)', definition.display || '', 'e.g. John Smith');
        const favoriteRow = form.createDiv('variable-links-panel-checkbox');
        const favoriteInput = favoriteRow.createEl('input', { attr: { type: 'checkbox' } });
        favoriteInput.checked = definition.favorite === true;
        favoriteRow.createEl('label', { text: 'Favorite' });
        this.addSaveButton(form, name ? 'Save properties' : 'Add variable', async () => {
            var _a;
            const newName = nameInput.value.trim();
            await this.plugin.registry.saveVariable(newName, {
                file: fileInput.value,
                property: propertyInput.value,
                display: displayInput.value,
                favorite: favoriteInput.checked
            }, definition.file ? name : undefined);
            const touched = (_a = this.plugin.caretTracker) === null || _a === void 0 ? void 0 : _a.lastTouched;
            if ((touched === null || touched === void 0 ? void 0 : touched.name) === name && newName !== name) {
                touched.name = newName;
                touched.def = this.plugin.registry.getVariable(newName);
            }
            this.selectedVariableName = newName;
            new obsidian.Notice(`Variable Links: saved {{${newName}}}`);
            await this.refresh();
        });
    }
    renderInfoCardForm(parent, name, definition) {
        const card = definition.card || {};
        parent.createEl('p', { text: 'Shown when hovering over this variable in Reading View.' });
        const form = parent.createEl('form', { cls: 'variable-links-panel-card-editor' });
        const titleInput = this.addInput(form, 'Title', card.title || '', 'e.g. John Smith');
        const noteInput = this.addTextarea(form, 'Note (Markdown supported)', card.note || '', 'Short description');
        const fieldsInput = this.addInput(form, 'Fields (property, [[File]]#property, or either with :Display Name)', Array.isArray(card.fields) ? card.fields.join(', ') : '', 'email:Email Address, [[Projects/Plan]]#due:Due Date');
        this.attachFieldSuggestions(fieldsInput, definition.file || '');
        const sourceRow = form.createDiv('variable-links-panel-checkbox');
        const sourceInput = sourceRow.createEl('input', { attr: { type: 'checkbox' } });
        sourceInput.checked = card.showSourceLink === true;
        sourceRow.createEl('label', { text: 'Show “Open source” link' });
        this.addSaveButton(form, 'Save info card', async () => {
            const fields = fieldsInput.value.split(',').map((field) => field.trim()).filter(Boolean);
            const nextCard = {
                ...(titleInput.value.trim() ? { title: titleInput.value.trim() } : {}),
                ...(noteInput.value.trim() ? { note: noteInput.value.trim() } : {}),
                ...(fields.length ? { fields } : {}),
                ...(sourceInput.checked ? { showSourceLink: true } : {})
            };
            await this.plugin.registry.saveVariable(name, {
                file: definition.file,
                property: definition.property,
                display: definition.display,
                card: Object.keys(nextCard).length ? nextCard : undefined
            });
            new obsidian.Notice(`Variable Links: info card saved for {{${name}}}`);
            await this.refresh();
        });
    }
    addSaveButton(form, text, save) {
        const button = form.createEl('button', { text, cls: 'mod-cta', attr: { type: 'submit' } });
        form.addEventListener('submit', async (event) => {
            event.preventDefault();
            button.disabled = true;
            try {
                await save();
            }
            catch (error) {
                new obsidian.Notice(`Variable Links: ${error instanceof Error ? error.message : String(error)}`);
            }
            finally {
                button.disabled = false;
            }
        });
    }
    addInput(form, label, value, placeholder) {
        const row = form.createDiv('variable-links-panel-field');
        row.createEl('label', { text: label });
        const input = row.createEl('input', { attr: { type: 'text', placeholder } });
        input.value = value;
        return input;
    }
    addTextarea(form, label, value, placeholder) {
        const row = form.createDiv('variable-links-panel-field');
        row.createEl('label', { text: label });
        const input = row.createEl('textarea', { attr: { placeholder, rows: '4' } });
        input.value = value;
        return input;
    }
    attachFieldSuggestions(input, sourceFile) {
        input.autocomplete = 'off';
        const row = input.parentElement;
        const menu = document.createElement('div');
        menu.className = 'variable-links-field-suggestions';
        row.appendChild(menu);
        let selected = 0;
        let visibleItems = [];
        const normalizedSource = sourceFile.replace(/^\[\[|\]\]$/g, '').replace(/\.md$/i, '') + '.md';
        const choose = (item) => {
            const comma = input.value.lastIndexOf(',');
            const prefix = comma === -1 ? '' : input.value.slice(0, comma + 1) + ' ';
            const local = item.file.path === normalizedSource;
            const fileLink = item.file.path.replace(/\.md$/i, '');
            input.value = prefix + (local ? item.property : `[[${fileLink}]]#${item.property}`);
            input.focus();
            input.setSelectionRange(input.value.length, input.value.length);
            menu.replaceChildren();
        };
        const render = () => {
            var _a, _b, _c, _d, _e;
            const comma = input.value.lastIndexOf(',');
            const segment = input.value.slice(comma + 1).trim();
            const query = segment.toLowerCase();
            visibleItems = [];
            for (const file of ((_b = (_a = this.app.vault).getMarkdownFiles) === null || _b === void 0 ? void 0 : _b.call(_a)) || []) {
                const frontmatter = (_e = (_d = (_c = this.app.metadataCache) === null || _c === void 0 ? void 0 : _c.getFileCache) === null || _d === void 0 ? void 0 : _d.call(_c, file)) === null || _e === void 0 ? void 0 : _e.frontmatter;
                if (!frontmatter)
                    continue;
                for (const property of Object.keys(frontmatter)) {
                    if (query && !property.toLowerCase().includes(query) && !file.path.toLowerCase().includes(query))
                        continue;
                    visibleItems.push({ file, property });
                    if (visibleItems.length >= 20)
                        break;
                }
                if (visibleItems.length >= 20)
                    break;
            }
            selected = Math.min(selected, Math.max(0, visibleItems.length - 1));
            menu.replaceChildren();
            for (const [index, item] of visibleItems.entries()) {
                const option = document.createElement('button');
                option.type = 'button';
                option.className = 'variable-links-field-suggestion' + (index === selected ? ' is-selected' : '');
                option.textContent = `${item.property} · ${item.file.path}`;
                option.addEventListener('mousedown', (event) => { event.preventDefault(); choose(item); });
                menu.appendChild(option);
            }
            menu.classList.toggle('is-visible', visibleItems.length > 0);
        };
        input.addEventListener('focus', render);
        input.addEventListener('input', () => { selected = 0; render(); });
        input.addEventListener('blur', () => {
            const timer = setTimeout(() => {
                this.timers.delete(timer);
                if (this.active)
                    menu.classList.remove('is-visible');
            }, 100);
            this.timers.add(timer);
        });
        input.addEventListener('keydown', (event) => {
            if (!menu.classList.contains('is-visible') || !visibleItems.length)
                return;
            if (event.key === 'ArrowDown') {
                event.preventDefault();
                selected = (selected + 1) % visibleItems.length;
                render();
            }
            else if (event.key === 'ArrowUp') {
                event.preventDefault();
                selected = (selected - 1 + visibleItems.length) % visibleItems.length;
                render();
            }
            else if (event.key === 'Enter') {
                event.preventDefault();
                choose(visibleItems[selected]);
            }
            else if (event.key === 'Escape')
                menu.classList.remove('is-visible');
        });
    }
    clearMarkdownChild() {
        var _a;
        if (!this.markdownChild)
            return;
        const child = this.markdownChild;
        this.markdownChild = null;
        try {
            this.removeChild(child);
        }
        catch (error) {
            try {
                (_a = child.unload) === null || _a === void 0 ? void 0 : _a.call(child);
            }
            catch (unloadError) { }
        }
    }
    isCurrent(generation) {
        return this.active && !!this.contentEl && this.refreshGeneration === generation;
    }
}

var panel = /*#__PURE__*/Object.freeze({
    __proto__: null,
    VIEW_TYPE_VARIABLE_PANEL: VIEW_TYPE_VARIABLE_PANEL,
    VariablePropertiesView: VariablePropertiesView
});

class CaretTracker {
    constructor(app, plugin, registry, resolver, pollMs = 200) {
        this.pollMs = 200;
        this.timer = null;
        this.running = false;
        this.generation = 0;
        this.lastIndex = -1;
        this.lastTouched = null;
        this.app = app;
        this.plugin = plugin;
        this.registry = registry;
        this.resolver = resolver;
        this.pollMs = pollMs;
    }
    start() {
        if (this.running)
            return;
        this.running = true;
        const generation = ++this.generation;
        const loop = async () => {
            try {
                await this.checkCaret();
            }
            catch (e) { }
            if (!this.running || this.generation !== generation)
                return;
            this.timer = setTimeout(loop, this.pollMs);
        };
        loop();
    }
    stop() {
        this.running = false;
        this.generation++;
        if (this.timer) {
            clearTimeout(this.timer);
            this.timer = null;
        }
        this.lastIndex = -1;
        this.lastTouched = null;
    }
    async checkCaret() {
        var _a, _b, _c;
        if (!this.running)
            return;
        const generation = this.generation;
        const leaf = this.app.workspace.activeLeaf;
        if (!leaf)
            return;
        const view = leaf.view;
        if (!view || ((_a = view.getViewType) === null || _a === void 0 ? void 0 : _a.call(view)) !== 'markdown')
            return;
        const editor = view.editor;
        if (!editor || typeof editor.getValue !== 'function')
            return;
        // determine caret index
        let caretIndex = null;
        try {
            const cm = editor.cm;
            // CM6 path (head position)
            if (cm && cm.viewState && cm.viewState.state && cm.viewState.state.selection && cm.viewState.state.selection.main) {
                caretIndex = cm.viewState.state.selection.main.head;
            }
        }
        catch (e) { }
        // CM5/other fallback: compute index from cursor line/ch
        try {
            if (caretIndex === null && typeof editor.getCursor === 'function') {
                const cur = editor.getCursor();
                if (cur && typeof cur.line === 'number' && typeof cur.ch === 'number') {
                    const textForIndex = editor.getValue();
                    const lines = textForIndex.split(/\r?\n/);
                    let idx = 0;
                    for (let i = 0; i < cur.line; i++)
                        idx += ((_c = (_b = lines[i]) === null || _b === void 0 ? void 0 : _b.length) !== null && _c !== void 0 ? _c : 0) + 1;
                    idx += cur.ch;
                    caretIndex = idx;
                }
            }
        }
        catch (e) { }
        // If still null, give up
        if (caretIndex === null)
            return;
        if (caretIndex === this.lastIndex)
            return;
        this.lastIndex = caretIndex;
        const text = editor.getValue();
        const token = this.findTokenAtIndex(text, caretIndex);
        if (!token)
            return;
        const varName = token.name;
        // resolve and set lastTouched
        const res = await this.resolver.resolve(varName);
        if (!this.running || this.generation !== generation)
            return;
        const def = this.registry.getVariable(varName);
        this.lastTouched = {
            name: varName,
            value: res.ok ? res.value : undefined,
            type: res.type,
            sourceFile: res.sourceFile || null,
            def,
            editor,
            from: this.positionAtIndex(editor, text, token.start),
            to: this.positionAtIndex(editor, text, token.end),
            timestamp: Date.now(),
        };
        // notify plugin/view
        try {
            if (this.plugin && typeof this.plugin.onCaretVariableChanged === 'function')
                this.plugin.onCaretVariableChanged(this.lastTouched);
        }
        catch (e) { }
    }
    findTokenAtIndex(text, index) {
        if (!text || index < 0 || index > text.length)
            return null;
        // search backwards for '{{'
        const start = text.lastIndexOf('{{', index);
        if (start === -1)
            return null;
        const end = text.indexOf('}}', index);
        if (end === -1)
            return null;
        // extract between
        const inner = text.slice(start + 2, end).trim();
        // validate simple token name (no spaces, not empty)
        if (!inner)
            return null;
        if (/\s/.test(inner))
            return null;
        return { name: inner, start, end: end + 2 };
    }
    positionAtIndex(editor, text, index) {
        if (typeof editor.offsetToPos === 'function')
            return editor.offsetToPos(index);
        if (typeof editor.posFromIndex === 'function')
            return editor.posFromIndex(index);
        const before = text.slice(0, index).split(/\r?\n/);
        return { line: before.length - 1, ch: before[before.length - 1].length };
    }
}

var caretTracker = /*#__PURE__*/Object.freeze({
    __proto__: null,
    default: CaretTracker
});

module.exports = VariableLinksPlugin;
//# sourceMappingURL=main.js.map
