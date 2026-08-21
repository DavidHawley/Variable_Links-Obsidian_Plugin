'use strict';

var obsidian = require('obsidian');
var view = require('@codemirror/view');
var state = require('@codemirror/state');

const DEFAULT_SETTINGS = {
    registryFilePath: 'Variable Links.md',
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
        this.plugin = plugin;
    }
    display() {
        const containerEl = this.containerEl;
        containerEl.empty();
        containerEl.createEl('h2', { text: 'Variable Links — Settings' });
        new obsidian.Setting(containerEl)
            .setName('Registry file')
            .setDesc('Markdown file that contains the variable registry (frontmatter). Default: Variable Links.md')
            .addText((text) => text
            .setPlaceholder('Variable Links.md')
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
            const modal = new FilePickerModal(this.app, async (file) => {
                var _a;
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
}

class Registry {
    constructor(app, plugin) {
        this.data = new Map();
        this.registryFile = null;
        this.modifyHandler = null;
        this.app = app;
        this.plugin = plugin;
        this.settings = plugin.settings;
    }
    async load() {
        this.settings = this.plugin.settings;
        const path = this.settings.registryFilePath;
        if (!path) {
            new obsidian.Notice('Variable Links: registryFilePath not set');
            return;
        }
        const file = this.app.vault.getAbstractFileByPath(path);
        if (!file || !(file instanceof obsidian.TFile)) {
            new obsidian.Notice('Variable Links: registry file not found at ' + path);
            this.registryFile = null;
            this.data.clear();
            return;
        }
        this.registryFile = file;
        // read file content
        const content = await this.app.vault.read(file);
        // Try to parse registry using intelligent handling based on extension and content
        const parsed = this.parseRegistryFromContent(content, file.path);
        if (!parsed || typeof parsed !== 'object') {
            new obsidian.Notice('Variable Links: failed to parse registry from file: ' + file.path);
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
        for (const [key, raw] of Object.entries(variableLinks)) {
            if (typeof raw === 'object' && raw !== null) {
                const def = {
                    file: raw.file,
                    property: raw.property,
                    display: raw.display,
                    card: raw.card,
                    format: raw.format
                };
                this.data.set(String(key), def);
            }
        }
        // register vault change listener to reload registry when the file is modified
        if (this.modifyHandler) {
            this.app.vault.off('modify', this.modifyHandler);
            this.modifyHandler = null;
        }
        this.modifyHandler = (f) => {
            if (this.registryFile && f.path === this.registryFile.path) {
                // debounce briefly
                setTimeout(() => this.load(), 50);
            }
        };
        this.app.vault.on('modify', this.modifyHandler);
        console.log('Variable Links: registry loaded with', this.data.size, 'entries');
    }
    unload() {
        if (this.modifyHandler) {
            this.app.vault.off('modify', this.modifyHandler);
            this.modifyHandler = null;
        }
    }
    getVariable(name) {
        var _a;
        return (_a = this.data.get(name)) !== null && _a !== void 0 ? _a : null;
    }
    /** Persist a registry mapping while preserving any Markdown body below its frontmatter. */
    async saveVariable(name, definition) {
        var _a, _b, _c, _d, _e;
        const variableName = name.trim();
        if (!variableName)
            throw new Error('Variable name is required.');
        if (!((_a = definition.file) === null || _a === void 0 ? void 0 : _a.trim()))
            throw new Error('A source note is required.');
        if (!((_b = definition.property) === null || _b === void 0 ? void 0 : _b.trim()))
            throw new Error('A property name is required.');
        if (!this.registryFile)
            throw new Error('The registry file is not loaded.');
        const file = this.registryFile;
        const content = await this.app.vault.read(file);
        const normalized = {
            file: definition.file.trim(),
            property: definition.property.trim()
        };
        if (Object.prototype.hasOwnProperty.call(definition, 'card'))
            normalized.card = definition.card;
        const lowerPath = file.path.toLowerCase();
        const mergeDefinition = (existing) => {
            var _a;
            const updated = { ...(existing || {}), ...normalized };
            if ((_a = definition.display) === null || _a === void 0 ? void 0 : _a.trim())
                updated.display = definition.display.trim();
            else
                delete updated.display;
            if (Object.prototype.hasOwnProperty.call(definition, 'card') && !definition.card)
                delete updated.card;
            return updated;
        };
        // Let Obsidian update Markdown frontmatter instead of rewriting the note
        // ourselves. This is the reliable save path for a Markdown registry.
        if ((lowerPath.endsWith('.md') || lowerPath.endsWith('.markdown') || lowerPath.endsWith('.mdx'))
            && typeof ((_c = this.app.fileManager) === null || _c === void 0 ? void 0 : _c.processFrontMatter) === 'function') {
            await this.app.fileManager.processFrontMatter(file, (frontmatter) => {
                frontmatter['variable-links'] = frontmatter['variable-links'] || {};
                frontmatter['variable-links'][variableName] = mergeDefinition(frontmatter['variable-links'][variableName]);
            });
            await this.load();
            await ((_d = this.plugin.indexer) === null || _d === void 0 ? void 0 : _d.build());
            return;
        }
        if (lowerPath.endsWith('.json')) {
            const registry = JSON.parse(content || '{}');
            registry['variable-links'] = registry['variable-links'] || {};
            registry['variable-links'][variableName] = mergeDefinition(registry['variable-links'][variableName]);
            await this.app.vault.modify(file, JSON.stringify(registry, null, 2) + '\n');
        }
        else {
            const registry = this.parseRegistryFromContent(content, file.path);
            if (!registry || typeof registry !== 'object') {
                throw new Error('The registry must contain valid YAML or JSON.');
            }
            registry['variable-links'] = registry['variable-links'] || {};
            registry['variable-links'][variableName] = mergeDefinition(registry['variable-links'][variableName]);
            const yaml = obsidian.stringifyYaml(registry).trimEnd();
            if (lowerPath.endsWith('.md') || lowerPath.endsWith('.markdown') || lowerPath.endsWith('.mdx')) {
                if (!content.startsWith('---'))
                    throw new Error('The Markdown registry needs a YAML frontmatter block.');
                const closing = content.indexOf('\n---', 3);
                if (closing === -1)
                    throw new Error('The registry frontmatter is not closed.');
                const bodyStart = content.indexOf('\n', closing + 4);
                const body = bodyStart === -1 ? '' : content.slice(bodyStart + 1);
                await this.app.vault.modify(file, `---\n${yaml}\n---${body ? `\n${body}` : '\n'}`);
            }
            else {
                await this.app.vault.modify(file, yaml + '\n');
            }
        }
        await this.load();
        await ((_e = this.plugin.indexer) === null || _e === void 0 ? void 0 : _e.build());
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
        this.app = app;
    }
    async showFor(targetEl, sourceFilePath, cardConfig) {
        this.hideImmediate();
        // build container
        const container = document.createElement('div');
        container.className = 'variable-links-card';
        container.style.position = 'absolute';
        container.style.zIndex = '9999';
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
            await obsidian.MarkdownRenderer.renderMarkdown(cardConfig.note || '', p, '', this.app);
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
                else if (typeof val === 'string')
                    await obsidian.MarkdownRenderer.renderMarkdown(val, value, '', this.app);
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
        document.body.appendChild(container);
        this.el = container;
        // After element is in DOM, measure and position on next frame to allow proper layout
        requestAnimationFrame(() => {
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
        this.clearHideTimeout();
        this.hideTimeout = setTimeout(() => this.hideImmediate(), ms);
    }
    clearHideTimeout() { if (this.hideTimeout) {
        clearTimeout(this.hideTimeout);
        this.hideTimeout = null;
    } }
    hideImmediate() {
        this.clearHideTimeout();
        if (this.el && this.el.parentElement) {
            this.el.parentElement.removeChild(this.el);
        }
        this.el = null;
    }
}

const TOKEN_REGEX$1 = /\{\{\s*([^\}\s]+)\s*\}\}/g;
class Renderer {
    constructor(app, registry, resolver, indexer) {
        this.enabled = true;
        this.app = app;
        this.registry = registry;
        this.resolver = resolver;
        this.indexer = indexer;
        this.infoCard = new InfoCard(app);
    }
    register() {
        var _a, _b;
        if (!this.enabled)
            return;
        (_b = (_a = this.app).registerMarkdownPostProcessor) === null || _b === void 0 ? void 0 : _b.call(_a, async (el, ctx) => {
            await this.processElement(el);
        });
    }
    async processElement(el) {
        var _a;
        // Avoid processing the same element multiple times
        if (el.hasAttribute && el.hasAttribute('data-variable-links-processed'))
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
            if (parent.closest('code, pre, .cm-s'))
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
                placeholder.className = 'variable-links-token';
                placeholder.textContent = '…';
                frag.appendChild(placeholder);
                // resolve async and then update placeholder
                this.resolver.resolve(varName).then(res => {
                    var _a, _b;
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
                    // click to open source
                    placeholder.addEventListener('click', (ev) => {
                        if (res.sourceFile) {
                            try {
                                this.app.workspace.openLinkText(res.sourceFile.path.replace(/\.md$/i, ''), '', false);
                            }
                            catch (e) {
                                this.app.workspace.openFile(res.sourceFile);
                            }
                        }
                        ev.stopPropagation();
                    });
                    // hover -> info card (if configured and enabled)
                    if (((_b = (_a = this.registry.plugin) === null || _a === void 0 ? void 0 : _a.settings) === null || _b === void 0 ? void 0 : _b.enableInfoCards) !== false) {
                        let enterTimer = null;
                        placeholder.addEventListener('mouseenter', () => {
                            if (enterTimer)
                                clearTimeout(enterTimer);
                            const currentDef = this.registry.getVariable(varName);
                            if (!(currentDef === null || currentDef === void 0 ? void 0 : currentDef.card))
                                return;
                            enterTimer = setTimeout(() => {
                                var _a, _b, _c;
                                const latestDef = this.registry.getVariable(varName);
                                const latestCard = latestDef === null || latestDef === void 0 ? void 0 : latestDef.card;
                                if (!latestCard)
                                    return;
                                const sourcePath = (_b = (_a = res.sourceFile) === null || _a === void 0 ? void 0 : _a.path) !== null && _b !== void 0 ? _b : ((_c = latestDef === null || latestDef === void 0 ? void 0 : latestDef.file) !== null && _c !== void 0 ? _c : '');
                                this.infoCard.showFor(placeholder, sourcePath, latestCard);
                            }, 200);
                        });
                        placeholder.addEventListener('mouseleave', () => {
                            if (enterTimer) {
                                clearTimeout(enterTimer);
                                enterTimer = null;
                            }
                            this.infoCard.hideWithDelay(100);
                        });
                    }
                });
                lastIndex = TOKEN_REGEX$1.lastIndex;
            }
            if (!any)
                continue;
            const rest = text.slice(lastIndex);
            if (rest)
                frag.appendChild(document.createTextNode(rest));
            (_a = textNode.parentNode) === null || _a === void 0 ? void 0 : _a.replaceChild(frag, textNode);
        }
        try {
            el.setAttribute && el.setAttribute('data-variable-links-processed', '1');
        }
        catch (e) { }
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
/**
 * Uses CodeMirror's native replacement decorations rather than positioned DOM
 * overlays. The original token remains in the document and is restored while
 * its range contains the editor selection.
 */
class LivePreviewRenderer {
    constructor(app, resolver) {
        this.app = app;
        this.resolver = resolver;
    }
    createExtension() {
        const renderer = this;
        class VariableWidget extends view.WidgetType {
            constructor(name) {
                super();
                this.name = name;
            }
            eq(other) { return other.name === this.name; }
            toDOM() {
                const el = document.createElement('span');
                el.className = 'variable-links-token variable-links-token-live-preview';
                el.textContent = '…';
                el.dataset.var = this.name;
                void renderer.resolver.resolve(this.name).then((result) => {
                    if (!result.ok) {
                        el.textContent = `[Missing: ${this.name}]`;
                        el.classList.add('missing');
                        el.title = result.error || '';
                        return;
                    }
                    el.textContent = Array.isArray(result.value) ? result.value.join(', ') : String(result.value);
                }).catch(() => {
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
                builder.add(from, to, view.Decoration.replace({ widget: new VariableWidget(match[1].trim()) }));
            }
            return builder.finish();
        };
        return view.ViewPlugin.fromClass(class {
            constructor(view) { this.decorations = buildDecorations(view); }
            update(update) {
                if (update.docChanged || update.selectionSet || update.viewportChanged) {
                    this.decorations = buildDecorations(update.view);
                }
            }
        }, { decorations: (value) => value.decorations });
    }
}

class VariableLinksPlugin extends obsidian.Plugin {
    constructor() {
        super(...arguments);
        this.registry = null;
        this.indexer = null;
        this.resolver = null;
        this.renderer = null;
        this.suggest = null;
    }
    async onload() {
        console.log('Variable Links: onload start');
        try {
            await this.loadSettings();
            console.log('Variable Links: settings loaded', this.settings);
            this.addSettingTab(new VariableLinksSettingTab(this.app, this));
            // Initialize registry/indexer/resolver/renderer with defensive try/catch so one failure doesn't break plugin
            try {
                this.registry = new Registry(this.app, this);
                await this.registry.load();
                console.log('Variable Links: registry loaded');
            }
            catch (e) {
                console.error('Variable Links: registry failed to load', e);
                try {
                    const N = globalThis.Notice;
                    if (typeof N === 'function')
                        new N('Variable Links: registry failed to load. See console for details.');
                }
                catch (e) { }
            }
            try {
                this.indexer = new Indexer(this.app, this.registry);
                await this.indexer.build();
                console.log('Variable Links: index built');
            }
            catch (e) {
                console.error('Variable Links: indexer failed', e);
            }
            try {
                this.resolver = new Resolver(this.app, this.registry);
                console.log('Variable Links: resolver initialized');
            }
            catch (e) {
                console.error('Variable Links: resolver failed', e);
            }
            try {
                this.renderer = new Renderer(this.app, this.registry, this.resolver, this.indexer);
                // register markdown post processor using plugin API so it actually runs
                if (typeof this.registerMarkdownPostProcessor === 'function') {
                    this.registerMarkdownPostProcessor((el, ctx) => {
                        var _a;
                        try {
                            return (_a = this.renderer) === null || _a === void 0 ? void 0 : _a.processElement(el);
                        }
                        catch (err) {
                            console.error('renderer.processElement error', err);
                        }
                    });
                }
                else {
                    // fallback: try renderer's own register (older code)
                    try {
                        this.renderer.register();
                    }
                    catch (e) {
                        console.warn('renderer.register fallback failed', e);
                    }
                }
                console.log('Variable Links: renderer registered');
            }
            catch (e) {
                console.error('Variable Links: renderer failed', e);
            }
            // Use native CodeMirror decorations in Live Preview. Unlike positioned
            // overlays, they replace the text in the editor's normal layout.
            try {
                if (typeof this.registerEditorExtension !== 'function')
                    throw new Error('registerEditorExtension is unavailable.');
                const livePreviewRenderer = new LivePreviewRenderer(this.app, this.resolver);
                this.registerEditorExtension(livePreviewRenderer.createExtension());
                this.livePreviewRenderer = livePreviewRenderer;
                console.log('Variable Links: live preview renderer attached');
            }
            catch (e) {
                console.warn('Variable Links: failed to attach live preview renderer', e);
            }
            try {
                // register view
                const panelMod = await Promise.resolve().then(function () { return panel; });
                this.registerView(panelMod.VIEW_TYPE_VARIABLE_PANEL, (leaf) => new panelMod.VariablePropertiesView(leaf, this));
                this.addCommand({
                    id: 'open-variable-properties',
                    name: 'Open Variable Properties',
                    callback: async () => {
                        const right = this.app.workspace.getRightLeaf(false);
                        await right.setViewState({ type: panelMod.VIEW_TYPE_VARIABLE_PANEL });
                        this.app.workspace.revealLeaf(right);
                    }
                });
                // start caret tracker
                const CaretTracker = (await Promise.resolve().then(function () { return caretTracker; })).default;
                const ct = new CaretTracker(this.app, this, this.registry, this.resolver);
                ct.start();
                this.caretTracker = ct;
                console.log('Variable Links: caret tracker started and panel registered');
            }
            catch (e) {
                console.warn('Variable Links: failed to initialize caret tracker/panel', e);
            }
            // register suggest if enabled
            try {
                if (this.settings) {
                    if (this.settings.autocomplete !== false) {
                        this.suggest = new VariableSuggest(this.app, this.indexer, this.registry);
                        if (typeof this.registerEditorSuggest === 'function') {
                            try {
                                this.registerEditorSuggest(this.suggest);
                                console.log('Variable Links: suggest registered via registerEditorSuggest');
                            }
                            catch (e) {
                                console.warn('registerEditorSuggest failed', e);
                            }
                        }
                        else {
                            console.log('Variable Links: registerEditorSuggest missing; suggest not registered');
                        }
                    }
                }
            }
            catch (e) {
                console.error('Variable Links: suggest failed', e);
            }
            // watch registry reloads to rebuild index
            const reloadIndex = async () => { if (this.indexer)
                await this.indexer.build(); };
            // listen to vault modify events so we can update index when registry changed
            try {
                this.app.vault.on('modify', (file) => {
                    var _a;
                    try {
                        if (((_a = this.registry) === null || _a === void 0 ? void 0 : _a.registryFile) && file.path === this.registry.registryFile.path) {
                            setTimeout(reloadIndex, 100);
                        }
                    }
                    catch (e) {
                        console.error('modify handler error', e);
                    }
                });
            }
            catch (e) {
                console.error('Failed to register vault.modify handler', e);
            }
            // expose helper for panel: when caret tracker notifies, refresh any open panel views
            this.onCaretVariableChanged = (last) => {
                // TypeScript hint: ensure caretTracker typed access available in this scope
                const _self = this;
                try {
                    console.log('Variable Links: onCaretVariableChanged', last === null || last === void 0 ? void 0 : last.name);
                    Promise.resolve().then(function () { return panel; }).then(async (mod) => {
                        var _a, _b, _c, _d;
                        try {
                            const leaves = this.app.workspace.getLeavesOfType(mod.VIEW_TYPE_VARIABLE_PANEL);
                            console.log('Variable Links: panel leaves found', leaves === null || leaves === void 0 ? void 0 : leaves.length);
                            if (leaves && leaves.length > 0) {
                                for (let i = 0; i < leaves.length; i++) {
                                    try {
                                        const view = leaves[i].view;
                                        console.log('Variable Links: refreshing panel leaf', i, 'view present', !!view, 'has refresh', typeof (view === null || view === void 0 ? void 0 : view.refresh) === 'function');
                                        if (view && typeof view.refresh === 'function') {
                                            await view.refresh();
                                        }
                                        else if (view && typeof view.renderContent === 'function') {
                                            await view.renderContent();
                                        }
                                        else {
                                            // Fallback: try to directly render into the leaf/container element
                                            try {
                                                const container = leaves[i].containerEl || (view && view.containerEl) || (view && view.containerElInner) || null;
                                                let inner = null;
                                                if (container) {
                                                    inner = ((_a = container.querySelector) === null || _a === void 0 ? void 0 : _a.call(container, '.variable-links-panel-inner')) || ((_b = container.querySelector) === null || _b === void 0 ? void 0 : _b.call(container, '.variable-links-panel')) || null;
                                                    if (!inner) {
                                                        // create an inner container
                                                        inner = document.createElement('div');
                                                        inner.className = 'variable-links-panel-inner';
                                                        if (container.appendChild)
                                                            container.appendChild(inner);
                                                    }
                                                }
                                                if (inner) {
                                                    // render simple content mirroring renderContent()
                                                    const last = _self.caretTracker ? _self.caretTracker.lastTouched : null;
                                                    if (!last) {
                                                        inner.textContent = 'No variable selected.';
                                                    }
                                                    else {
                                                        inner.innerHTML = '';
                                                        const h = document.createElement('h4');
                                                        h.textContent = `{{${last.name}}}`;
                                                        inner.appendChild(h);
                                                        const valDiv = document.createElement('div');
                                                        valDiv.className = 'variable-links-panel-value';
                                                        inner.appendChild(valDiv);
                                                        const valueText = last.value === undefined ? '[Missing]' : String(last.value);
                                                        try {
                                                            await ((_c = this.app.markdownRenderer) === null || _c === void 0 ? void 0 : _c.renderMarkdown(valueText, valDiv, '', this));
                                                        }
                                                        catch (e) {
                                                            try {
                                                                await ((_d = this.app.markdownRenderer) === null || _d === void 0 ? void 0 : _d.renderMarkdown(valueText, valDiv, '', this));
                                                            }
                                                            catch (e2) {
                                                                valDiv.textContent = valueText;
                                                            }
                                                        }
                                                    }
                                                }
                                            }
                                            catch (e) {
                                                console.error('Variable Links: DOM fallback render failed for leaf', i, e);
                                            }
                                        }
                                    }
                                    catch (e) {
                                        console.error('Variable Links: error refreshing leaf', i, e);
                                    }
                                }
                            }
                        }
                        catch (e) {
                            console.error('Variable Links: error notifying panel', e);
                        }
                    });
                }
                catch (e) {
                    console.error('Variable Links: onCaretVariableChanged top-level error', e);
                }
            };
            console.log('Variable Links: onload complete');
        }
        catch (e) {
            console.error('Variable Links: onload top-level error', e);
            try {
                const N = globalThis.Notice;
                if (typeof N === 'function')
                    new N('Variable Links failed to load: ' + String(e));
            }
            catch { }
        }
    }
    onunload() {
        var _a;
        (_a = this.registry) === null || _a === void 0 ? void 0 : _a.unload();
        console.log('Variable Links unloaded');
    }
    async loadSettings() {
        this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
    }
    async saveSettings() {
        await this.saveData(this.settings);
    }
}

const VIEW_TYPE_VARIABLE_PANEL = 'variable-links-panel';
/** A split, editable sidebar for the selected variable and its info card. */
class VariablePropertiesView extends obsidian.ItemView {
    constructor(leaf, plugin) {
        super(leaf);
        this.contentEl = null;
        this.plugin = plugin;
    }
    getViewType() { return VIEW_TYPE_VARIABLE_PANEL; }
    getDisplayText() { return 'Variable Properties'; }
    getIcon() { return 'list'; }
    async onOpen() {
        this.containerEl.empty();
        this.containerEl.addClass('variable-links-panel');
        this.contentEl = this.containerEl.createDiv('variable-links-panel-inner');
        await this.refresh();
    }
    async onClose() { this.contentEl = null; }
    async refresh() {
        var _a, _b;
        if (!this.contentEl)
            return;
        this.contentEl.empty();
        const layout = this.contentEl.createDiv('variable-links-panel-split');
        const propertiesPane = layout.createDiv('variable-links-panel-pane variable-links-panel-properties');
        const cardPane = layout.createDiv('variable-links-panel-pane variable-links-panel-infocard');
        const last = (_a = this.plugin.caretTracker) === null || _a === void 0 ? void 0 : _a.lastTouched;
        propertiesPane.createEl('h4', { text: 'Variable properties' });
        cardPane.createEl('h4', { text: 'Info card' });
        if (!last) {
            propertiesPane.createEl('p', { text: 'No variable selected. Add a variable below or place the caret in a {{token}}.' });
            this.renderVariableForm(propertiesPane, '', {}, 'Add a variable');
            cardPane.createEl('p', { text: 'Select or create a variable to configure its info card.' });
            return;
        }
        // CaretTracker only resolves when the caret moves, so after a save it can
        // still hold an older definition. Always render the current registry value.
        const definition = ((_b = this.plugin.registry) === null || _b === void 0 ? void 0 : _b.getVariable(last.name)) || last.def || {};
        last.def = definition;
        propertiesPane.createEl('h5', { text: `{{${last.name}}}` });
        const valueText = last.value === undefined ? '[Missing]' : String(last.value);
        const valueEl = propertiesPane.createDiv('variable-links-panel-value');
        await obsidian.MarkdownRenderer.renderMarkdown(valueText, valueEl, '', this.plugin);
        const actions = propertiesPane.createDiv('variable-links-panel-actions');
        actions.createEl('button', { text: 'Open source' }).addEventListener('click', async () => {
            if (last.sourceFile)
                await this.app.workspace.openLinkText(last.sourceFile.path.replace(/\.md$/i, ''), '', false);
        });
        actions.createEl('button', { text: 'Copy value' }).addEventListener('click', () => { var _a; return void ((_a = navigator.clipboard) === null || _a === void 0 ? void 0 : _a.writeText(valueText)); });
        this.renderVariableForm(propertiesPane, last.name, definition, definition.file ? 'Edit mapping' : 'Set up this variable');
        this.renderInfoCardForm(cardPane, last.name, definition);
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
        this.addSaveButton(form, name ? 'Save properties' : 'Add variable', async () => {
            await this.plugin.registry.saveVariable(nameInput.value, {
                file: fileInput.value,
                property: propertyInput.value,
                display: displayInput.value
            });
            new obsidian.Notice(`Variable Links: saved {{${nameInput.value.trim()}}}`);
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
        input.addEventListener('blur', () => setTimeout(() => menu.classList.remove('is-visible'), 100));
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
        this.lastIndex = -1;
        this.lastTouched = null;
        this.app = app;
        this.plugin = plugin;
        this.registry = registry;
        this.resolver = resolver;
        this.pollMs = pollMs;
    }
    start() {
        if (this.timer)
            return;
        const loop = async () => {
            try {
                await this.checkCaret();
            }
            catch (e) {
                console.error('CaretTracker check error', e);
            }
            this.timer = setTimeout(loop, this.pollMs);
        };
        loop();
    }
    stop() {
        if (this.timer) {
            clearTimeout(this.timer);
            this.timer = null;
        }
    }
    async checkCaret() {
        var _a, _b, _c;
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
        const varName = token;
        // resolve and set lastTouched
        const res = await this.resolver.resolve(varName);
        const def = this.registry.getVariable(varName);
        this.lastTouched = {
            name: varName,
            value: res.ok ? res.value : undefined,
            type: res.type,
            sourceFile: res.sourceFile || null,
            def,
            timestamp: Date.now(),
        };
        // debug log when variable detected (use console.log to ensure visibility)
        try {
            console.log('Variable Links: caret detected variable', this.lastTouched.name, 'value:', this.lastTouched.value);
        }
        catch (e) { }
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
        return inner;
    }
}

var caretTracker = /*#__PURE__*/Object.freeze({
    __proto__: null,
    default: CaretTracker
});

module.exports = VariableLinksPlugin;
//# sourceMappingURL=main.js.map
