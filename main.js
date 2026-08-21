'use strict';

var obsidian = require('obsidian');

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
        var _a, _b, _c;
        this.hideImmediate();
        // build container
        const container = document.createElement('div');
        container.className = 'variable-links-card';
        container.style.position = 'absolute';
        container.style.zIndex = '9999';
        // Title
        if (cardConfig === null || cardConfig === void 0 ? void 0 : cardConfig.title) {
            const h = document.createElement('div');
            h.style.fontWeight = '600';
            h.style.marginBottom = '6px';
            h.textContent = cardConfig.title;
            container.appendChild(h);
        }
        // Note
        if (cardConfig === null || cardConfig === void 0 ? void 0 : cardConfig.note) {
            const p = document.createElement('div');
            p.style.marginBottom = '6px';
            // render as markdown for convenience
            await obsidian.MarkdownRenderer.renderMarkdown(cardConfig.note || '', p, '', null);
            container.appendChild(p);
        }
        // Fields
        if ((cardConfig === null || cardConfig === void 0 ? void 0 : cardConfig.fields) && cardConfig.fields.length > 0) {
            const ul = document.createElement('ul');
            ul.style.margin = '4px 0';
            ul.style.paddingLeft = '18px';
            // Attempt to get frontmatter from metadataCache
            const file = this.app.vault.getAbstractFileByPath(sourceFilePath);
            let front = null;
            if (file) {
                front = (_c = (_b = (_a = this.app.metadataCache) === null || _a === void 0 ? void 0 : _a.getFileCache(file)) === null || _b === void 0 ? void 0 : _b.frontmatter) !== null && _c !== void 0 ? _c : null;
                if (!front) {
                    try {
                        const content = await this.app.vault.read(file);
                        // quick frontmatter parse
                        const m = content.match(/^---\n([\s\S]*?)\n---/);
                        if (m) {
                            try {
                                front = window.parseYaml ? window.parseYaml(m[1]) : null;
                            }
                            catch (e) {
                                front = null;
                            }
                        }
                    }
                    catch (e) {
                        front = null;
                    }
                }
            }
            for (const field of cardConfig.fields) {
                const li = document.createElement('li');
                const val = front === null || front === void 0 ? void 0 : front[field];
                if (typeof val === 'undefined') {
                    li.textContent = `${field}: (missing)`;
                }
                else if (Array.isArray(val)) {
                    li.textContent = `${field}: ${val.join(', ')}`;
                }
                else {
                    // render markdown/value
                    if (typeof val === 'string') {
                        // render markdown into a temporary container
                        const span = document.createElement('span');
                        await obsidian.MarkdownRenderer.renderMarkdown(String(val), span, '', null);
                        li.appendChild(document.createTextNode(`${field}: `));
                        li.appendChild(span);
                    }
                    else {
                        li.textContent = `${field}: ${String(val)}`;
                    }
                }
                ul.appendChild(li);
            }
            container.appendChild(ul);
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

const TOKEN_REGEX = /\{\{\s*([^\}\s]+)\s*\}\}/g;
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
            TOKEN_REGEX.lastIndex = 0;
            let any = false;
            while ((match = TOKEN_REGEX.exec(text)) !== null) {
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
                    const def = this.registry.getVariable(varName);
                    const cardCfg = def === null || def === void 0 ? void 0 : def.card;
                    if (cardCfg && ((_b = (_a = this.registry.plugin) === null || _a === void 0 ? void 0 : _a.settings) === null || _b === void 0 ? void 0 : _b.enableInfoCards) !== false) {
                        let enterTimer = null;
                        placeholder.addEventListener('mouseenter', () => {
                            if (enterTimer)
                                clearTimeout(enterTimer);
                            enterTimer = setTimeout(() => {
                                var _a, _b, _c;
                                const sourcePath = (_b = (_a = res.sourceFile) === null || _a === void 0 ? void 0 : _a.path) !== null && _b !== void 0 ? _b : ((_c = def === null || def === void 0 ? void 0 : def.file) !== null && _c !== void 0 ? _c : '');
                                this.infoCard.showFor(placeholder, sourcePath, cardCfg);
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
                lastIndex = TOKEN_REGEX.lastIndex;
            }
            if (!any)
                continue;
            const rest = text.slice(lastIndex);
            if (rest)
                frag.appendChild(document.createTextNode(rest));
            (_a = textNode.parentNode) === null || _a === void 0 ? void 0 : _a.replaceChild(frag, textNode);
        }
    }
}

const BaseSuggest = globalThis.EditorSuggest || null;
let VariableSuggestImpl;
if (BaseSuggest && typeof BaseSuggest === 'function') {
    VariableSuggestImpl = class VariableSuggest extends BaseSuggest {
        constructor(app, indexer, registry) {
            super(app);
            this.app = app;
            this.indexer = indexer;
            this.registry = registry;
        }
        onTrigger(cursor, editor, file) {
            const line = editor.getLine(cursor.line);
            const to = cursor.ch;
            const fromIndex = line.lastIndexOf('{{', to - 1);
            if (fromIndex === -1)
                return null;
            const after = line.slice(fromIndex + 2, to);
            const query = after;
            return { range: { from: { line: cursor.line, ch: fromIndex }, to: { line: cursor.line, ch: to } }, query };
        }
        getSuggestions(context) {
            var _a, _b, _c;
            const q = (context.query || '').toLowerCase();
            const results = [];
            for (const [name, entry] of this.indexer.byName.entries()) {
                const display = (_a = entry.def.display) !== null && _a !== void 0 ? _a : '';
                const file = (_b = entry.filePath) !== null && _b !== void 0 ? _b : '';
                const property = (_c = entry.def.property) !== null && _c !== void 0 ? _c : '';
                if (!q || name.toLowerCase().includes(q) || String(display).toLowerCase().includes(q) || file.toLowerCase().includes(q) || property.toLowerCase().includes(q)) {
                    results.push({ name, display, file, property });
                }
            }
            return results.slice(0, 100);
        }
        renderSuggestion(item, el) {
            const container = el;
            container.createEl('div', { text: item.name });
            if (item.display)
                container.createEl('div', { text: String(item.display), cls: 'suggest-sub' });
            if (item.file || item.property)
                container.createEl('div', { text: `${item.file || ''} • ${item.property || ''}`, cls: 'suggest-meta' });
        }
        selectSuggestion(item, evt) {
            const ctx = this.context;
            const editor = ctx === null || ctx === void 0 ? void 0 : ctx.editor;
            const range = ctx === null || ctx === void 0 ? void 0 : ctx.range;
            if (!editor || !range)
                return;
            editor.replaceRange(`{{${item.name}}}`, range.from, range.to);
        }
    };
}
else {
    // Fallback no-op implementation to avoid plugin load failure if EditorSuggest isn't available
    VariableSuggestImpl = class VariableSuggest {
        constructor(app, indexer, registry) {
            // no-op
        }
    };
}
var VariableSuggest = VariableSuggestImpl;

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
        console.log('Loading Variable Links plugin...');
        await this.loadSettings();
        this.addSettingTab(new VariableLinksSettingTab(this.app, this));
        this.registry = new Registry(this.app, this);
        await this.registry.load();
        this.indexer = new Indexer(this.app, this.registry);
        await this.indexer.build();
        this.resolver = new Resolver(this.app, this.registry);
        this.renderer = new Renderer(this.app, this.registry, this.resolver, this.indexer);
        // register markdown post processor using plugin API so it actually runs
        if (typeof this.registerMarkdownPostProcessor === 'function') {
            this.registerMarkdownPostProcessor((el, ctx) => {
                var _a;
                return (_a = this.renderer) === null || _a === void 0 ? void 0 : _a.processElement(el);
            });
        }
        else {
            // fallback: try renderer's own register (older code)
            try {
                this.renderer.register();
            }
            catch (e) { /* ignore */ }
        }
        // register suggest if enabled
        if (this.settings) {
            if (this.settings.autocomplete !== false) {
                this.suggest = new VariableSuggest(this.app, this.indexer, this.registry);
                // register EditorSuggest using plugin API if available
                if (typeof this.registerEditorSuggest === 'function') {
                    try {
                        this.registerEditorSuggest(this.suggest);
                    }
                    catch (e) { /* ignore */ }
                }
            }
        }
        // watch registry reloads to rebuild index
        const reloadIndex = async () => { if (this.indexer)
            await this.indexer.build(); };
        // listen to vault modify events so we can update index when registry changed
        this.app.vault.on('modify', (file) => {
            var _a;
            if (((_a = this.registry) === null || _a === void 0 ? void 0 : _a.registryFile) && file.path === this.registry.registryFile.path) {
                setTimeout(reloadIndex, 100);
            }
        });
        console.log('Variable Links loaded');
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

module.exports = VariableLinksPlugin;
//# sourceMappingURL=main.js.map
