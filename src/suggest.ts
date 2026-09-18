import {
  App,
  Editor,
  EditorPosition,
  EditorSuggest,
  EditorSuggestContext,
  EditorSuggestTriggerInfo,
  Notice,
  TFile,
} from 'obsidian';
import Indexer from './indexer';
import Registry, {
  getVariableShape,
  getVariableType,
  type VariableShape,
  type VariableType,
} from './registry';
import Resolver from './resolver';
import {
  automaticCapturedTimeNameBase,
  capturedTimeShortcutLabel,
  defaultFormatForCapturedTime,
  formatCapturedDateTime,
  parseCapturedTimeCreationQuery,
  type CapturedTimeCreationQuery,
  type CapturedTimeShortcut,
} from './dateTime';
import {
  isValidNamedCreationName,
  parseFixedCreationSource,
  parseNamedCreationQuery,
  type NamedCreationQuery,
  type NamedCreationType,
} from './creationSyntax';
import { parsePropertyLink, toFileLink } from './linkSyntax';
import {
  formatSuggestionValue,
  parseSuggestionSearchMode,
  parseSuggestionQuery,
  scoreSuggestionFields,
  suggestionSearchModeLabel,
  truncateSuggestionValue,
  type SuggestionSearchMode,
} from './suggestionSearch';
import {
  appendVariableSelector,
  canRepresentVariableTextCase,
  findVariableTokenTrigger,
  formatVariableSelector,
  formatVariableToken,
  getRecognizedTokenSyntaxes,
  getTokenSyntax,
  hasVariableTokenSuffixAt,
  parseVariableSelector,
  parseVariableSelectorStep,
  type VariableSelector,
  type VariableSelectorStep,
} from './tokenSyntax';
import { splitGraphemes } from './selectorUtils';
import {
  getVariableTextCaseLabel,
  parseVariableTextCaseQuery,
  wrapVariableNameWithTextCase,
  type VariableTextCase,
} from './textCase';

interface SuggestItem {
  name: string;
  kind: 'variable' | 'shortcut' | 'property' | 'creation' | 'capture' | 'search-help' | 'hint-toggle' | 'mode-message';
  alreadyMapped?: boolean;
  display?: string;
  file?: string;
  property?: string;
  value?: string;
  variableType?: VariableType;
  variableShape?: VariableShape;
  hidden?: boolean;
  selector?: VariableSelector;
  textCase?: VariableTextCase;
  creationType?: NamedCreationType;
  creationSource?: string;
  creationError?: string;
  captureType?: CapturedTimeShortcut;
  captureFormat?: string;
  searchMode?: SuggestionSearchMode;
  shortcutCode?: string;
  helpVariant?: 'opening' | 'full';
  message?: string;
  toggleChecked?: boolean;
  toggleTargetEnabled?: boolean;
}

export interface VariableCreationHandoff {
  type: NamedCreationType;
  name: string;
  editor: Editor;
  from: EditorPosition;
  to: EditorPosition;
  originalText: string;
  textCase?: VariableTextCase;
}

interface CachedSuggestionValue {
  expires: number;
  signature: string;
  value: string | null;
}

export default class VariableSuggest extends EditorSuggest<SuggestItem> {
  private suggestionGeneration = 0;
  private valueCache = new Map<string, CachedSuggestionValue>();

  constructor(
    app: App,
    private readonly indexer: Indexer,
    private readonly registry: Registry,
    private readonly resolver: Resolver,
    private readonly onVariableCreated: (name: string) => Promise<void>,
    private readonly onVariableCreationRequested: (
      request: VariableCreationHandoff,
    ) => Promise<void>,
  ) {
    super(app);
  }

  onTrigger(cursor: EditorPosition, editor: Editor, _file: TFile | null): EditorSuggestTriggerInfo | null {
    const line = editor.getLine(cursor.line);
    const trigger = findVariableTokenTrigger(
      line,
      cursor.ch,
      getRecognizedTokenSyntaxes(this.registry.plugin.settings),
    );
    if (!trigger) {
      this.suggestionGeneration++;
      return null;
    }
    return {
      start: { line: cursor.line, ch: trigger.start },
      end: { line: cursor.line, ch: cursor.ch },
      query: trigger.query,
    };
  }

  async getSuggestions(context: EditorSuggestContext): Promise<SuggestItem[]> {
    const generation = ++this.suggestionGeneration;
    const search = parseSuggestionSearchMode(context.query);
    if (context.query.length === 0) {
      return this.registry.plugin.settings.showSuggestionSearchHint
        ? this.getSearchHelpItems('opening')
        : [];
    }
    if (search.mode === 'help') {
      return this.getSearchHelpItems('full');
    }
    if (search.mode === 'shortcuts') {
      const shortcutCaseQuery = parseVariableTextCaseQuery(search.query);
      const shortcuts = this.getShortcutSuggestions(
        shortcutCaseQuery.query,
        shortcutCaseQuery.textCase,
      );
      return shortcuts.length ? shortcuts : [{
          name: '',
          kind: 'mode-message',
          searchMode: 'shortcuts',
          message: shortcutCaseQuery.query.trim()
            ? 'No shortcuts match this search.'
            : 'No enabled shortcuts are configured yet.',
        }];
    }

    const caseQuery = parseVariableTextCaseQuery(search.query);
    const selectorSuggestions = await this.getSelectorSuggestions(
      caseQuery.query,
      caseQuery.textCase,
    );
    if (selectorSuggestions) return selectorSuggestions;
    const exactVariable = this.registry.getVariable(caseQuery.query);
    if (search.mode === 'all' && !exactVariable) {
      const exactShortcut = this.getExactShortcutSuggestion(caseQuery.query, caseQuery.textCase);
      if (exactShortcut) return [exactShortcut];
    }
    const creationQuery = search.mode === 'all' && !exactVariable
      ? parseNamedCreationQuery(caseQuery.query)
      : null;
    const captureQuery = search.mode === 'all' && !exactVariable
      ? parseCapturedTimeCreationQuery(caseQuery.query)
      : null;
    const query = parseSuggestionQuery(
      search.mode === 'values'
        ? `*${caseQuery.query}`
        : creationQuery?.name ?? caseQuery.query,
    );
    const creationItems = search.mode === 'all'
      ? [
        ...this.getCapturedTimeSuggestions(captureQuery, context.file, caseQuery.textCase),
        ...this.getNamedCreationSuggestions(creationQuery, caseQuery.textCase),
      ]
      : [];
    const itemSearchMode = search.mode === 'all' ? undefined : search.mode;
    const variables: SuggestItem[] = Array.from(this.indexer.byName.values()).map((entry) => ({
      name: entry.name,
      kind: 'variable',
      display: entry.def.display,
      file: entry.filePath,
      property: getVariableType(entry.def) === 'property' ? entry.def.property : undefined,
      variableType: getVariableType(entry.def),
      variableShape: getVariableShape(entry.def),
      hidden: entry.def.hidden === true,
      searchMode: itemSearchMode,
    }));

    if (query.valueMode && !creationQuery) {
      if (!query.terms.length) {
        return [{
          name: '',
          kind: 'mode-message',
          searchMode: 'values',
          message: 'Type part of a resolved value to search.',
        }];
      }
      const resolved = await Promise.all(variables.map(async (item) => {
        const value = await this.getResolvedSuggestionValue(item.name);
        return value === null ? null : { ...item, value, searchMode: 'values' as const };
      }));
      if (generation !== this.suggestionGeneration) return [];
      const resolvedItems: SuggestItem[] = [];
      for (const item of resolved) if (item !== null) resolvedItems.push(item);
      return this.applyTextCaseToSuggestions(this.rankItems(
        resolvedItems,
        query.terms,
        (item) => [item.value],
      ).slice(0, 100), search.query, caseQuery.textCase);
    }

    if (search.mode === 'variables') {
      return this.applyTextCaseToSuggestions(this.rankItems(
        variables,
        query.terms,
        (item) => [item.name, item.display, item.file, item.property],
      ).slice(0, 100), search.query, caseQuery.textCase);
    }

    const properties: SuggestItem[] = [];
    const mappedProperties = new Set<string>();
    for (const entry of this.indexer.byName.values()) {
      if (getVariableType(entry.def) !== 'property' || !entry.filePath) continue;
      mappedProperties.add(this.propertyKey(entry.filePath, entry.def.property));
    }
    for (const file of this.app.vault.getMarkdownFiles()) {
      const frontmatter: unknown = this.app.metadataCache.getFileCache(file)?.frontmatter;
      if (!this.isRecord(frontmatter)) continue;
      for (const property of Object.keys(frontmatter)) {
        properties.push({
          name: property,
          kind: 'property',
          file: file.path,
          property,
          alreadyMapped: mappedProperties.has(this.propertyKey(file.path, property)),
          searchMode: search.mode === 'properties' ? 'properties' : undefined,
        });
      }
    }
    const propertyMatches = this.rankItems(
      properties,
      query.terms,
      (item) => [item.name, item.file, item.property],
    );
    const orderedProperties = [
      ...propertyMatches.filter((item) => !item.alreadyMapped),
      ...propertyMatches.filter((item) => item.alreadyMapped),
    ];
    if (search.mode === 'properties') {
      return this.applyTextCaseToSuggestions(
        orderedProperties.slice(0, 100),
        search.query,
        caseQuery.textCase,
      );
    }

    const variableMatches = this.rankItems(
      variables,
      query.terms,
      (item) => [item.name, item.display, item.file, item.property],
    );
    return [
      ...creationItems,
      ...this.applyTextCaseToSuggestions([
        ...variableMatches,
        ...orderedProperties,
      ].slice(0, Math.max(0, 100 - creationItems.length)), search.query, caseQuery.textCase),
    ];
  }

  renderSuggestion(item: SuggestItem, el: HTMLElement): void {
    if (item.kind === 'search-help') {
      this.renderSearchHelp(el, item.helpVariant ?? 'full');
      return;
    }
    if (item.kind === 'hint-toggle') {
      el.addClass('variable-links-suggest-help-toggle');
      const checkbox = el.createEl('input', {
        type: 'checkbox',
        attr: { tabindex: '-1', 'aria-hidden': 'true' },
      });
      checkbox.checked = item.toggleChecked === true;
      el.createSpan({
        text: item.helpVariant === 'opening'
          ? `Don't show this hint after ${getTokenSyntax(this.registry.plugin.settings).prefix}`
          : `Show this hint after ${getTokenSyntax(this.registry.plugin.settings).prefix}`,
      });
      return;
    }
    if (item.kind === 'mode-message') {
      el.addClass('variable-links-suggest-message');
      if (item.searchMode) {
        el.createDiv({
          text: `${suggestionSearchModeLabel(item.searchMode)} search`,
          cls: 'variable-links-suggest-mode',
        });
      }
      el.createDiv({ text: item.message ?? 'No matches found.', cls: 'suggest-sub' });
      return;
    }
    if (item.searchMode && item.searchMode !== 'all') {
      el.createDiv({
        text: `${suggestionSearchModeLabel(item.searchMode)} search`,
        cls: 'variable-links-suggest-mode',
      });
    }
    el.createDiv({
      text: item.kind === 'shortcut'
        ? item.display ?? item.shortcutCode ?? item.name
        : item.selector
        ? item.display ?? `${item.name} ${formatVariableSelector(item.selector)}`
        : item.kind === 'creation' || item.kind === 'capture'
        ? `Create ${item.name}`
        : item.name,
    });
    const detail = item.kind === 'capture'
      ? `${capturedTimeShortcutLabel(item.captureType ?? 'datetime')} · Captured fixed value`
      : item.kind === 'creation'
      ? item.creationSource === undefined
        ? `Open ${item.creationType === 'fixed' ? 'fixed value' : 'property value'} editor`
        : `Create ${item.creationType === 'fixed' ? 'fixed value' : 'property mapping'}`
      : item.kind === 'shortcut'
      ? `Shortcut ${item.shortcutCode ?? ''} → ${formatVariableToken(
          item.name,
          getTokenSyntax(this.registry.plugin.settings),
          item.textCase,
          item.selector,
        )}`
      : item.kind === 'variable'
      ? item.selector
        ? `${formatVariableSelector(item.selector)}${item.value !== undefined ? ` · ${item.value}` : ''}`
        : item.variableType === 'fixed'
        ? `${item.variableShape === 'list' ? 'Fixed list' : 'Fixed value'}${item.hidden ? ' · Hidden' : ''}${item.file ? ` · ${item.file}` : ''}`
        : `${item.variableShape === 'list' ? 'Property list' : 'Property value'}${item.hidden ? ' · Hidden' : ''} · ${item.file ?? ''}${item.property ? ` • ${item.property}` : ''}`
      : `Property · ${item.file ?? ''}`;
    el.createDiv({ text: detail, cls: 'suggest-meta' });
    if (item.creationError) {
      el.createDiv({ text: item.creationError, cls: 'suggest-sub mod-warning' });
    } else if (item.kind === 'capture') {
      el.createDiv({ text: `Value: ${item.value ?? ''}`, cls: 'suggest-sub' });
      el.createDiv({ text: `Format: ${item.captureFormat ?? ''}`, cls: 'suggest-sub' });
      el.createDiv({
        text: `Token: ${formatVariableToken(item.name, getTokenSyntax(this.registry.plugin.settings), item.textCase)}`,
        cls: 'suggest-sub',
      });
      el.createDiv({ text: `File link: ${item.file ?? ''}`, cls: 'suggest-sub' });
    } else if (item.kind === 'creation' && item.creationSource !== undefined) {
      el.createDiv({
        text: item.creationType === 'fixed'
          ? `Value: ${truncateSuggestionValue(item.creationSource)}`
          : item.creationSource,
        cls: 'suggest-sub',
      });
    }
    if (item.kind === 'shortcut' && item.value) {
      el.createDiv({ text: `Search terms: ${item.value}`, cls: 'suggest-sub' });
    } else if (item.display) el.createDiv({ text: item.display, cls: 'suggest-sub' });
    if (item.textCase) {
      el.createDiv({
        text: `Text case: ${getVariableTextCaseLabel(item.textCase)}`,
        cls: 'suggest-sub',
      });
    }
    if (typeof item.value === 'string') {
      el.createDiv({
        text: `Value: ${truncateSuggestionValue(item.value)}`,
        cls: 'suggest-sub variable-links-suggest-value',
      });
    }
  }

  selectSuggestion(item: SuggestItem, _event: MouseEvent | KeyboardEvent): void {
    const context = this.context;
    if (!context) return;
    if (item.kind === 'hint-toggle') {
      void this.setSuggestionSearchHint(
        item.toggleTargetEnabled === true,
        context.editor,
      );
      return;
    }
    if (item.kind === 'search-help' || item.kind === 'mode-message') {
      this.close();
      context.editor.focus();
      return;
    }
    void this.applySuggestion(item, context);
  }

  async completeTypedCapturedTimeExpression(
    editor: Editor,
    file: TFile,
    from: EditorPosition,
    to: EditorPosition,
    originalText: string,
    expression: string,
  ): Promise<boolean> {
    const caseQuery = parseVariableTextCaseQuery(expression.trim());
    if (this.registry.getVariable(caseQuery.query)) return false;
    const query = parseCapturedTimeCreationQuery(caseQuery.query);
    if (!query?.type) return false;
    const requestedName = query.requestedName?.trim();
    if (requestedName && this.registry.getVariable(requestedName)) {
      if (this.hasTextCaseNameConflict(requestedName, caseQuery.textCase)) return true;
      if (this.replaceCreationExpression(
        editor,
        from,
        to,
        originalText,
        requestedName,
        caseQuery.textCase,
        true,
      )) {
        new Notice(`Variable links: ${requestedName} already exists; inserted the existing token.`);
      }
      return true;
    }
    const item = this.getCapturedTimeSuggestions(query, file, caseQuery.textCase)
      .find((candidate) => candidate.captureType === query.type);
    if (!item) return false;
    await this.completeCapturedTimeItem(item, editor, file, from, to, originalText, true);
    return true;
  }

  private async applySuggestion(item: SuggestItem, context: EditorSuggestContext): Promise<void> {
    let variableName = item.name;
    let createdVariable = false;
    if (item.kind === 'capture') {
      const target = this.getReplacementTarget(context);
      await this.completeCapturedTimeItem(
        item,
        context.editor,
        context.file,
        context.start,
        target.replaceEnd,
        context.editor.getRange(context.start, target.replaceEnd),
        false,
      );
      return;
    }
    if (item.kind === 'creation') {
      if (item.creationError) {
        new Notice(`Variable links: ${item.creationError}`);
        return;
      }
      if (!item.creationType) return;
      if (this.registry.getVariable(variableName)) {
        new Notice(`Variable links: ${variableName} already exists. Select the existing variable instead.`);
        return;
      }
      if (this.hasTextCaseNameConflict(variableName, item.textCase)) return;
      const target = this.getReplacementTarget(context);
      if (item.creationSource === undefined) {
        await this.onVariableCreationRequested({
          type: item.creationType,
          name: variableName,
          editor: context.editor,
          from: context.start,
          to: target.replaceEnd,
          originalText: context.editor.getRange(context.start, target.replaceEnd),
          textCase: item.textCase,
        });
        return;
      }

      try {
        if (item.creationType === 'fixed') {
          const parsed = parseFixedCreationSource(item.creationSource);
          if (!parsed.ok) throw new Error(parsed.error);
          await this.registry.saveVariable(variableName, {
            type: 'fixed',
            shape: 'single',
            file: '',
            property: '',
            value: parsed.value,
          });
        } else {
          const propertyLink = parsePropertyLink(item.creationSource);
          await this.registry.saveVariable(variableName, {
            type: 'property',
            shape: 'single',
            file: propertyLink.file,
            property: propertyLink.property,
          });
        }
        createdVariable = true;
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        new Notice(`Variable links: could not create ${variableName}: ${detail}`);
        return;
      }
    }
    if ((item.kind === 'variable' || item.kind === 'shortcut') && this.hasTextCaseNameConflict(
      variableName,
      item.textCase,
      item.selector,
    )) {
      return;
    }
    if (item.kind === 'property') {
      const base = (item.property ?? item.name)
        .trim()
        .replace(/\s+/g, '_')
        .replace(/[{}]/g, '') || 'Variable';
      let number = 1;
      do {
        variableName = `${base}_${String(number).padStart(2, '0')}`;
        number++;
      } while (this.registry.getVariable(variableName) || this.indexer.byName.has(variableName));

      if (this.hasTextCaseNameConflict(variableName, item.textCase)) return;

      try {
        await this.registry.saveVariable(variableName, {
          type: 'property',
          shape: 'single',
          file: item.file ?? '',
          property: item.property ?? item.name,
          display: item.property ?? item.name,
        });
        createdVariable = true;
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        new Notice(`Variable Links: could not create ${variableName}: ${detail}`);
        return;
      }
    }

    const target = this.getReplacementTarget(context);
    const token = formatVariableToken(
      variableName,
      target.activeSyntax,
      item.textCase,
      item.selector,
    );
    context.editor.replaceRange(
      token,
      context.start,
      target.replaceEnd,
    );
    context.editor.setCursor({
      line: context.start.line,
      ch: context.start.ch + token.length,
    });
    context.editor.focus();
    if (createdVariable) {
      try {
        await this.onVariableCreated(variableName);
      } catch {
        new Notice('Variable links: the variable was created, but the properties panel could not be refreshed.');
      }
    }
  }

  private renderSearchHelp(el: HTMLElement, variant: 'opening' | 'full'): void {
    el.addClass('variable-links-suggest-help');
    el.createDiv({
      text: variant === 'opening' ? 'Variable Links search' : 'Variable Links search help',
      cls: 'variable-links-suggest-help-title',
    });
    el.createDiv({
      text: variant === 'opening'
        ? 'Type a letter to search everything, or begin with a focused search symbol.'
        : 'A symbol immediately after the token prefix limits which suggestions are searched.',
      cls: 'variable-links-suggest-help-description',
    });

    const modes = el.createDiv({ cls: 'variable-links-suggest-help-modes' });
    const entries: Array<[string, string]> = [
      ['@', 'Existing Variable Links'],
      [';', 'Note properties'],
      ['!', 'Resolved values'],
      ['~', 'Shortcuts'],
      ['?', 'Search help'],
    ];
    for (const [symbol, label] of entries) {
      const row = modes.createDiv({ cls: 'variable-links-suggest-help-mode' });
      row.createEl('code', { text: symbol });
      row.createSpan({ text: label });
    }
    if (variant === 'full') {
      el.createDiv({
        text: 'The existing * value-search symbol remains supported. Prefix a reserved symbol with \\ to search for it literally.',
        cls: 'variable-links-suggest-help-description',
      });
    }
  }

  private getSearchHelpItems(variant: 'opening' | 'full'): SuggestItem[] {
    const enabled = this.registry.plugin.settings.showSuggestionSearchHint;
    return [
      {
        name: '',
        kind: 'search-help',
        helpVariant: variant,
        searchMode: variant === 'full' ? 'help' : undefined,
      },
      {
        name: '',
        kind: 'hint-toggle',
        helpVariant: variant,
        toggleChecked: variant === 'full' ? enabled : false,
        toggleTargetEnabled: variant === 'full' ? !enabled : false,
      },
    ];
  }

  private async setSuggestionSearchHint(enabled: boolean, editor: Editor): Promise<void> {
    const previous = this.registry.plugin.settings.showSuggestionSearchHint;
    this.registry.plugin.settings.showSuggestionSearchHint = enabled;
    try {
      await this.registry.plugin.saveSettings();
      this.close();
      editor.focus();
    } catch (error) {
      this.registry.plugin.settings.showSuggestionSearchHint = previous;
      new Notice(`Variable links: could not save the suggestion hint setting: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  private rankItems(
    items: SuggestItem[],
    terms: readonly string[],
    fields: (item: SuggestItem) => readonly (string | undefined)[],
  ): SuggestItem[] {
    const ranked: Array<{ item: SuggestItem; score: number; index: number }> = [];
    items.forEach((item, index) => {
      const score = scoreSuggestionFields(terms, fields(item));
      if (score !== null) ranked.push({ item, score, index });
    });
    ranked.sort((left, right) => left.score - right.score || left.index - right.index);
    return ranked.map(({ item }) => item);
  }

  private getReplacementTarget(context: EditorSuggestContext): {
    activeSyntax: ReturnType<typeof getTokenSyntax>;
    replaceEnd: EditorPosition;
  } {
    const line = context.editor.getLine(context.end.line);
    const activeSyntax = getTokenSyntax(this.registry.plugin.settings);
    const trigger = findVariableTokenTrigger(
      line,
      context.end.ch,
      getRecognizedTokenSyntaxes(this.registry.plugin.settings),
    );
    const triggerSyntax = trigger?.start === context.start.ch ? trigger.syntax : activeSyntax;
    const suffixStart = this.findExistingTokenSuffix(
      line,
      context.start.ch + triggerSyntax.prefix.length,
      context.end.ch,
      triggerSyntax,
    );
    return {
      activeSyntax,
      replaceEnd: suffixStart !== null
        ? { line: context.end.line, ch: suffixStart + triggerSyntax.suffix.length }
        : context.end,
    };
  }

  private findExistingTokenSuffix(
    line: string,
    contentStart: number,
    cursor: number,
    syntax: ReturnType<typeof getTokenSyntax>,
  ): number | null {
    if (hasVariableTokenSuffixAt(line, cursor, syntax)) return cursor;
    const suffixStart = line.indexOf(
      syntax.suffix,
      Math.max(contentStart, cursor - syntax.suffix.length + 1),
    );
    if (suffixStart === -1) return null;
    if (suffixStart + syntax.suffix.length < cursor) return null;
    const nextPrefix = line.indexOf(syntax.prefix, Math.max(contentStart, cursor));
    return nextPrefix !== -1 && nextPrefix < suffixStart ? null : suffixStart;
  }

  private getNamedCreationSuggestions(
    query: NamedCreationQuery | null,
    textCase: VariableTextCase | undefined,
  ): SuggestItem[] {
    if (!query?.name || this.registry.getVariable(query.name)) return [];
    const syntax = getTokenSyntax(this.registry.plugin.settings);
    let nameError = '';
    if (!isValidNamedCreationName(query.name)) {
      nameError = 'Variable names in creation expressions cannot contain spaces.';
    } else if (query.name.includes(syntax.prefix) || query.name.includes(syntax.suffix)) {
      nameError = 'The variable name contains the active token prefix or suffix.';
    }

    const types: NamedCreationType[] = ['fixed', 'property'];
    return types
      .filter((type) => !query.typeQuery || type.startsWith(query.typeQuery))
      .map((type) => {
        let creationError = nameError;
        if (!creationError && query.hasSource) {
          if (type === 'fixed') {
            const parsed = parseFixedCreationSource(query.source ?? '');
            if (!parsed.ok) creationError = parsed.error;
          } else {
            try {
              parsePropertyLink(query.source ?? '');
            } catch (error) {
              creationError = error instanceof Error ? error.message : String(error);
            }
          }
        }
        return {
          name: query.name,
          kind: 'creation' as const,
          creationType: type,
          creationSource: query.hasSource ? query.source ?? '' : undefined,
          creationError: creationError || undefined,
          textCase,
        };
      });
  }

  private getCapturedTimeSuggestions(
    query: CapturedTimeCreationQuery | null,
    file: TFile,
    textCase: VariableTextCase | undefined,
  ): SuggestItem[] {
    if (!query) return [];
    const requestedName = query.requestedName?.trim();
    if (query.requestedName !== undefined && !requestedName) return [];
    if (requestedName && this.registry.getVariable(requestedName)) return [];
    const syntax = getTokenSyntax(this.registry.plugin.settings);
    const capturedAt = new Date();
    const types: CapturedTimeShortcut[] = ['date', 'time', 'datetime'];
    return types
      .filter((type) => query.type
        ? type === query.type
        : !query.typeQuery || type.startsWith(query.typeQuery))
      .map((type) => {
        const name = requestedName ?? this.nextCapturedTimeName(file.basename, type);
        const format = query.hasFormat
          ? query.format ?? ''
          : defaultFormatForCapturedTime(type, this.registry.plugin.settings);
        let creationError = '';
        if (!isValidNamedCreationName(name)) {
          creationError = 'Variable names in creation expressions cannot contain spaces.';
        } else if (name.includes(syntax.prefix) || name.includes(syntax.suffix)) {
          creationError = requestedName
            ? 'The variable name contains the active token prefix or suffix.'
            : 'The automatic name conflicts with the active token format. Use Name=DATE, Name=TIME, or Name=DATETIME.';
        }
        const formatted = formatCapturedDateTime(capturedAt, format);
        if (!creationError && !formatted.ok) creationError = formatted.error;
        return {
          name,
          kind: 'capture' as const,
          file: toFileLink(file.path),
          value: formatted.ok ? formatted.value : '',
          captureType: type,
          captureFormat: format,
          creationError: creationError || undefined,
          textCase,
        };
      });
  }

  private async completeCapturedTimeItem(
    item: SuggestItem,
    editor: Editor,
    file: TFile,
    from: EditorPosition,
    to: EditorPosition,
    originalText: string,
    preserveCursorAfterRange: boolean,
  ): Promise<void> {
    if (item.creationError) {
      new Notice(`Variable links: ${item.creationError}`);
      return;
    }
    if (this.registry.getVariable(item.name)) {
      new Notice(`Variable links: ${item.name} already exists. The creation expression was not applied.`);
      return;
    }
    if (this.hasTextCaseNameConflict(item.name, item.textCase)) return;
    if (editor.getRange(from, to) !== originalText) return;
    try {
      await this.registry.saveVariable(item.name, {
        type: 'fixed',
        shape: 'single',
        file: '',
        property: '',
        value: item.value ?? '',
        link: toFileLink(file.path),
      });
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      new Notice(`Variable links: could not create ${item.name}: ${detail}`);
      return;
    }
    if (!this.replaceCreationExpression(
      editor,
      from,
      to,
      originalText,
      item.name,
      item.textCase,
      preserveCursorAfterRange,
    )) {
      new Notice(`Variable links: ${item.name} was created, but the edited expression was not replaced.`);
      return;
    }
    try {
      await this.indexer.build();
      await this.onVariableCreated(item.name);
    } catch {
      new Notice('Variable links: the variable was created, but dependent views could not be refreshed.');
    }
  }

  private replaceCreationExpression(
    editor: Editor,
    from: EditorPosition,
    to: EditorPosition,
    originalText: string,
    name: string,
    textCase: VariableTextCase | undefined,
    preserveCursorAfterRange: boolean,
  ): boolean {
    if (editor.getRange(from, to) !== originalText) return false;
    const token = formatVariableToken(
      name,
      getTokenSyntax(this.registry.plugin.settings),
      textCase,
    );
    const cursor = editor.getCursor();
    editor.replaceRange(token, from, to);
    const cursorAfterRange = preserveCursorAfterRange
      && cursor.line === to.line
      && cursor.ch >= to.ch;
    editor.setCursor(cursorAfterRange
      ? { line: cursor.line, ch: cursor.ch + token.length - originalText.length }
      : { line: from.line, ch: from.ch + token.length });
    editor.focus();
    return true;
  }

  private nextCapturedTimeName(fileName: string, type: CapturedTimeShortcut): string {
    const base = automaticCapturedTimeNameBase(fileName);
    const label = capturedTimeShortcutLabel(type);
    let number = 1;
    let name = '';
    do {
      name = `${base}_${label}_${String(number).padStart(2, '0')}`;
      number++;
    } while (this.registry.getVariable(name) || this.indexer.byName.has(name));
    return name;
  }

  private async getSelectorSuggestions(
    query: string,
    textCase: VariableTextCase | undefined,
  ): Promise<SuggestItem[] | null> {
    if (this.registry.getVariable(query)) return null;
    const separator = query.lastIndexOf('::');
    if (separator <= 0) return null;
    const parsedPrefix = parseVariableSelector(
      query.slice(0, separator),
      (name) => this.registry.getVariable(name) !== null,
    );
    const name = parsedPrefix.name;
    const currentSelector = parsedPrefix.selector;
    const rawSelectorQuery = query.slice(separator + 2).trim();
    const selectorQuery = rawSelectorQuery.toLocaleLowerCase();
    const definition = this.registry.getVariable(name);
    if (!definition) return null;
    const result = await this.resolver.resolve(name, currentSelector).catch(() => null);
    if (!result?.ok) {
      return [{
        name: '',
        kind: 'mode-message',
        message: `${name} does not currently resolve to a selectable value.`,
      }];
    }
    const base: Omit<SuggestItem, 'selector' | 'display' | 'value'> = {
      name,
      kind: 'variable',
      variableType: getVariableType(definition),
      variableShape: getVariableShape(definition),
      hidden: definition.hidden === true,
      textCase,
    };
    const withStep = (step: VariableSelectorStep): VariableSelector =>
      appendVariableSelector(currentSelector, step);
    const items: SuggestItem[] = [];
    if (Array.isArray(result.value)) {
      result.value.forEach((value, index) => items.push({
        ...base,
        selector: withStep({ type: 'index', index: index + 1 }),
        display: `Item ${index + 1}`,
        value: formatSuggestionValue(value),
      }));
      if (result.value.length) {
        items.unshift({
          ...base,
          selector: withStep({ type: 'index', index: -1 }),
          display: 'Last item',
          value: formatSuggestionValue(result.value[result.value.length - 1]),
        });
      }
      const metadata = getVariableType(definition) === 'fixed'
        ? definition.fixedItems ?? []
        : definition.propertyItems ?? [];
      for (const item of metadata) {
        if (!item.key) continue;
        items.unshift({
          ...base,
          selector: withStep({ type: 'item', key: item.key }),
          display: item.display || item.key,
          value: item.value,
        });
      }
    } else {
      const text = this.selectorValueText(result.value);
      const words = text.trim().split(/\s+/u).filter(Boolean);
      words.forEach((word, index) => items.push({
        ...base,
        selector: withStep({ type: 'word', indexes: [index + 1] }),
        display: `Word ${index + 1}`,
        value: word,
      }));
      if (words.length) {
        items.unshift({
          ...base,
          selector: withStep({ type: 'word', indexes: [-1] }),
          display: 'Last word',
          value: words[words.length - 1],
        });
      }
      const characters = splitGraphemes(text);
      if (characters.length) {
        items.push(...characters.slice(0, 100).map((character, index) => ({
          ...base,
          selector: withStep({ type: 'char', indexes: [index + 1] }),
          display: `Character ${index + 1}`,
          value: character,
        })));
        items.push({
          ...base,
          selector: withStep({ type: 'char', indexes: [-1] }),
          display: 'Last character',
          value: characters[characters.length - 1],
        });
      }
      items.push({
        ...base,
        selector: withStep({ type: 'upper', indexes: [] }),
        display: 'Uppercase all',
        value: text.toLocaleUpperCase(),
      }, {
        ...base,
        selector: withStep({ type: 'lower', indexes: [] }),
        display: 'Lowercase all',
        value: text.toLocaleLowerCase(),
      });
      if (characters.length) {
        items.push({
          ...base,
          selector: withStep({ type: 'upper', indexes: [1] }),
          display: 'Uppercase first character',
          value: characters.map((part, index) => index === 0 ? part.toLocaleUpperCase() : part).join(''),
        }, {
          ...base,
          selector: withStep({ type: 'lower', indexes: [1] }),
          display: 'Lowercase first character',
          value: characters.map((part, index) => index === 0 ? part.toLocaleLowerCase() : part).join(''),
        });
      }
    }
    const typedStep = parseVariableSelectorStep(rawSelectorQuery);
    if (typedStep) {
      const selector = withStep(typedStep);
      if (!items.some((item) => formatVariableSelector(item.selector) === formatVariableSelector(selector))) {
        const typedResult = await this.resolver.resolve(name, selector).catch(() => null);
        if (typedResult?.ok) {
          items.unshift({
            ...base,
            selector,
            display: this.selectorStepLabel(typedStep),
            value: formatSuggestionValue(typedResult.value),
          });
        }
      }
    }
    if (!selectorQuery) return items.slice(0, 100);
    const normalizedQuery = selectorQuery.replace(/\s+/gu, '');
    return items.filter((item) => [
      formatVariableSelector(item.selector),
      item.display ?? '',
      item.value ?? '',
    ].some((field) => field.toLocaleLowerCase().replace(/\s+/gu, '').includes(normalizedQuery))).slice(0, 100);
  }

  private selectorStepLabel(step: VariableSelectorStep): string {
    if (step.type === 'item') return `Item ${step.key}`;
    if (step.type === 'index') return `Item ${step.index}`;
    if (step.type === 'word') return `Word${step.indexes.length === 1 ? '' : 's'} ${step.indexes.join(', ')}`;
    if (step.type === 'char') {
      return `Character${step.indexes.length === 1 ? '' : 's'} ${step.indexes.join(', ')}`;
    }
    if (!step.indexes.length) return `${step.type === 'upper' ? 'Uppercase' : 'Lowercase'} all`;
    return `${step.type === 'upper' ? 'Uppercase' : 'Lowercase'} character${step.indexes.length === 1 ? '' : 's'} ${step.indexes.join(', ')}`;
  }

  private selectorValueText(value: unknown): string {
    if (value === undefined || value === null) return '';
    if (typeof value === 'string'
      || typeof value === 'number'
      || typeof value === 'boolean'
      || typeof value === 'bigint') return String(value);
    try {
      return JSON.stringify(value) ?? '';
    } catch {
      return '';
    }
  }

  private getExactShortcutSuggestion(
    query: string,
    textCase: VariableTextCase | undefined,
  ): SuggestItem | null {
    const shortcut = this.registry.getShortcutByCode(query);
    if (!shortcut) return null;
    const name = this.registry.getVariableNameByGuid(shortcut.targetGuid);
    if (!name) return null;
    const definition = this.registry.getVariable(name);
    if (!definition) return null;
    return {
      name,
      kind: 'shortcut',
      shortcutCode: shortcut.code,
      display: shortcut.displayName || shortcut.code,
      selector: shortcut.selector,
      variableType: getVariableType(definition),
      variableShape: getVariableShape(definition),
      hidden: definition.hidden === true,
      textCase,
    };
  }

  private getShortcutSuggestions(
    query: string,
    textCase: VariableTextCase | undefined,
  ): SuggestItem[] {
    const terms = query.toLocaleLowerCase().trim().split(/\s+/u).filter(Boolean);
    const items = this.registry.shortcuts.flatMap((shortcut): SuggestItem[] => {
      if (!shortcut.enabled) return [];
      const name = this.registry.getVariableNameByGuid(shortcut.targetGuid);
      if (!name) return [];
      const definition = this.registry.getVariable(name);
      if (!definition) return [];
      return [{
        name,
        kind: 'shortcut',
        shortcutCode: shortcut.code,
        display: shortcut.displayName || shortcut.code,
        selector: shortcut.selector,
        variableType: getVariableType(definition),
        variableShape: getVariableShape(definition),
        hidden: definition.hidden === true,
        searchMode: 'shortcuts',
        textCase,
        value: shortcut.searchTerms.join(', '),
      }];
    });
    if (!terms.length) return items.slice(0, 100);
    return this.rankItems(items, terms, (item) => {
      const shortcut = this.registry.shortcuts.find((candidate) =>
        candidate.code === item.shortcutCode
      );
      return [
        item.shortcutCode,
        item.display,
        item.name,
        formatVariableSelector(item.selector),
        ...(shortcut?.searchTerms ?? []),
      ];
    }).slice(0, 100);
  }

  private applyTextCaseToSuggestions(
    items: SuggestItem[],
    rawQuery: string,
    textCase: VariableTextCase | undefined,
  ): SuggestItem[] {
    if (!textCase) return items;
    const literalPrefix = rawQuery.trim().toLocaleLowerCase();
    return items.map((item) => {
      const selectsLiteralPunctuationName = item.kind === 'variable'
        && literalPrefix.length > 0
        && item.name.toLocaleLowerCase().startsWith(literalPrefix);
      return selectsLiteralPunctuationName ? item : { ...item, textCase };
    });
  }

  private hasTextCaseNameConflict(
    variableName: string,
    textCase: VariableTextCase | undefined,
    selector?: VariableSelector,
  ): boolean {
    if (!textCase) return false;
    if (canRepresentVariableTextCase(
      variableName,
      textCase,
      (name) => this.registry.getVariable(name) !== null,
      selector,
    )) return false;
    const wrappedName = wrapVariableNameWithTextCase(
      `${variableName}${formatVariableSelector(selector)}`,
      textCase,
    );
    new Notice(`Variable links: cannot apply this text case because ${wrappedName} conflicts with an existing variable name.`);
    return true;
  }

  private async getResolvedSuggestionValue(name: string): Promise<string | null> {
    const definition = this.registry.getVariable(name);
    if (!definition) return null;
    const signature = JSON.stringify([
      definition.guid,
      getVariableType(definition),
      definition.file,
      definition.property,
      definition.value,
    ]);
    const now = Date.now();
    const cached = this.valueCache.get(name);
    if (cached && cached.signature === signature && cached.expires > now) return cached.value;

    const result = await this.resolver.resolve(name).catch(() => null);
    const formatted = result?.ok ? formatSuggestionValue(result.value) : '';
    const value = formatted.length ? formatted : null;
    this.valueCache.set(name, {
      expires: now + 2000,
      signature,
      value,
    });
    return value;
  }

  private propertyKey(file: string, property: string): string {
    return `${file}\u0000${property}`;
  }

  private isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
  }
}
