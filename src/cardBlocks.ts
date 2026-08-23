export interface CardPropertyEntry {
  id: string;
  reference: string;
  editorLabel?: string;
  label?: string;
  labelPosition?: CardLabelPosition;
  alignment?: CardTextAlignment;
  labelWidth?: number;
}

export type CardLayoutMode = 'stack' | 'grid';
export type CardBlockWidth = 'full' | 'half' | 'third' | 'quarter';
export type CardGridColumns = 1 | 2 | 3 | 4;
export type CardTableRowMode = 'auto' | 'fixed';
export type CardTextAlignment = 'left' | 'center' | 'right';
export type CardLabelPosition = 'left' | 'above' | 'hidden';
export type CardBackgroundTone = 'default' | 'primary' | 'secondary' | 'accent' | 'transparent';
export type CardBorderStyle = 'default' | 'none' | 'subtle' | 'accent';
export type CardShadowStyle = 'none' | 'small' | 'medium' | 'large';
export type CardBlockTone = 'none' | 'soft' | 'strong' | 'accent';
export type CardBlockBorder = 'none' | 'outline' | 'divider';
export type CardStackDirection = 'vertical' | 'horizontal';

export interface CardStyleConfig {
  background?: CardBackgroundTone;
  border?: CardBorderStyle;
  radius?: number;
  shadow?: CardShadowStyle;
  maxWidth?: number;
  padding?: number;
  alignment?: CardTextAlignment;
  cssClasses?: string[];
}

export interface CardBlockStyle {
  tone?: CardBlockTone;
  padding?: number;
  border?: CardBlockBorder;
  alignment?: CardTextAlignment;
}

export interface CardStackStyle {
  tone?: CardBlockTone;
  border?: 'outline';
  padding?: number;
  gap?: number;
  radius?: number;
}

interface CardBlockBase {
  id: string;
  editorLabel?: string;
  width?: CardBlockWidth;
  style?: CardBlockStyle;
}

export interface CardTitleBlock extends CardBlockBase {
  type: 'title';
  text: string;
}

export interface CardNoteBlock extends CardBlockBase {
  type: 'note';
  markdown: string;
}

export interface CardPropertyBlock extends CardBlockBase {
  type: 'property';
  property: CardPropertyEntry;
}

export interface CardPropertyTableBlock extends CardBlockBase {
  type: 'property-table';
  properties: CardPropertyEntry[];
  columns?: CardGridColumns;
  rowMode?: CardTableRowMode;
  rows?: number;
}

export interface CardDividerBlock extends CardBlockBase {
  type: 'divider';
}

export interface CardSourceBlock extends CardBlockBase {
  type: 'source';
}

export type CardContentBlock = CardTitleBlock
  | CardNoteBlock
  | CardPropertyBlock
  | CardPropertyTableBlock
  | CardDividerBlock
  | CardSourceBlock;

export interface CardStackBlock extends CardBlockBase {
  type: 'stack';
  heading?: string;
  direction?: CardStackDirection;
  blocks: CardContentBlock[];
  stackStyle?: CardStackStyle;
}

export type CardBlock = CardContentBlock | CardStackBlock;

export interface LegacyCardFields {
  title?: string;
  note?: string;
  fields?: string[];
  showSourceLink?: boolean;
}

export interface CardLayoutFields extends LegacyCardFields {
  blocks?: CardBlock[];
  useBlockLayout?: boolean;
  layoutMode?: CardLayoutMode;
  gridColumns?: CardGridColumns;
  layoutGap?: number;
  cardStyle?: CardStyleConfig;
}

export function createCardBlockId(prefix = 'block'): string {
  if (typeof window.crypto?.randomUUID === 'function') {
    return `${prefix}-${window.crypto.randomUUID()}`;
  }
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

export function createPropertyEntry(reference = ''): CardPropertyEntry {
  return { id: createCardBlockId('property'), reference };
}

export function createCardBlock(type: CardBlock['type']): CardBlock {
  const id = createCardBlockId(type);
  if (type === 'title') return { id, type, text: '' };
  if (type === 'note') return { id, type, markdown: '' };
  if (type === 'property') return { id, type, property: createPropertyEntry() };
  if (type === 'property-table') return { id, type, properties: [] };
  if (type === 'stack') return { id, type, blocks: [] };
  return { id, type };
}

export function migrateLegacyCardBlocks(card: LegacyCardFields): CardBlock[] {
  const blocks: CardBlock[] = [];
  if (card.title) blocks.push({ id: 'legacy-title', type: 'title', text: card.title });
  if (card.note) blocks.push({ id: 'legacy-note', type: 'note', markdown: card.note });
  if (card.fields?.length) {
    blocks.push({
      id: 'legacy-property-table',
      type: 'property-table',
      properties: card.fields.map((reference, index) => ({
        id: `legacy-property-${index}`,
        reference,
      })),
    });
  }
  if (card.showSourceLink) blocks.push({ id: 'legacy-source', type: 'source' });
  return blocks;
}

export function getActiveCardBlocks(card: CardLayoutFields): CardBlock[] {
  if (card.useBlockLayout && card.blocks) return card.blocks;
  return migrateLegacyCardBlocks(card);
}

export function deriveLegacyCardFields(blocks: CardBlock[]): LegacyCardFields {
  const flattened = flattenCardBlocks(blocks);
  const title = flattened.find((block): block is CardTitleBlock => block.type === 'title');
  const note = flattened.find((block): block is CardNoteBlock => block.type === 'note');
  const fields: string[] = [];
  for (const block of flattened) {
    if (block.type === 'property') fields.push(block.property.reference);
    else if (block.type === 'property-table') {
      fields.push(...block.properties.map((property) => property.reference));
    }
  }
  return {
    title: title?.text || undefined,
    note: note?.markdown || undefined,
    fields: fields.length ? fields : undefined,
    showSourceLink: flattened.some((block) => block.type === 'source') || undefined,
  };
}

export function cloneCardBlocks(blocks: CardBlock[]): CardBlock[] {
  return blocks.map((block) => {
    if (block.type === 'stack') {
      return {
        ...block,
        style: block.style ? { ...block.style } : undefined,
        stackStyle: block.stackStyle ? { ...block.stackStyle } : undefined,
        blocks: cloneCardBlocks(block.blocks) as CardContentBlock[],
      };
    }
    if (block.type === 'property-table') {
      return {
        ...block,
        style: block.style ? { ...block.style } : undefined,
        properties: block.properties.map((property) => ({ ...property })),
      };
    }
    if (block.type === 'property') {
      return {
        ...block,
        style: block.style ? { ...block.style } : undefined,
        property: { ...block.property },
      };
    }
    return { ...block, style: block.style ? { ...block.style } : undefined };
  });
}

export function splitCardPropertyReferences(reference: string): string[] {
  const references = reference.split(',').map((item) => item.trim()).filter(Boolean);
  return references.length ? references : [''];
}

export function normalizeCardBlocks(value: unknown): CardBlock[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const usedBlockIds = new Set<string>();
  const usedPropertyIds = new Set<string>();
  return normalizeCardBlockArray(value, usedBlockIds, usedPropertyIds, true);
}

function normalizeCardBlockArray(
  value: unknown[],
  usedBlockIds: Set<string>,
  usedPropertyIds: Set<string>,
  allowStacks: boolean,
): CardBlock[] {
  const blocks: CardBlock[] = [];
  for (const raw of value) {
    if (!isRecord(raw) || typeof raw.type !== 'string') continue;
    const id = uniqueId(raw.id, raw.type, usedBlockIds);
    if (raw.type === 'title') {
      blocks.push({
        id,
        type: 'title',
        text: typeof raw.text === 'string' ? raw.text : '',
        ...normalizeBlockBase(raw),
      });
    } else if (raw.type === 'note') {
      blocks.push({
        id,
        type: 'note',
        markdown: typeof raw.markdown === 'string' ? raw.markdown : '',
        ...normalizeBlockBase(raw),
      });
    } else if (raw.type === 'property') {
      const property = normalizePropertyEntry(raw.property, usedPropertyIds);
      if (property) {
        const references = splitCardPropertyReferences(property.reference);
        references.forEach((reference, index) => {
          blocks.push({
            id: index === 0 ? id : uniqueId(undefined, 'property', usedBlockIds),
            type: 'property',
            ...normalizeBlockBase(raw),
            property: {
              ...property,
              id: index === 0
                ? property.id
                : uniqueId(undefined, 'property', usedPropertyIds),
              reference,
            },
          });
        });
      }
    } else if (raw.type === 'property-table') {
      const properties = Array.isArray(raw.properties)
        ? raw.properties
          .map((property) => normalizePropertyEntry(property, usedPropertyIds))
          .filter((property): property is CardPropertyEntry => property !== null)
          .flatMap((property) => splitCardPropertyReferences(property.reference)
            .map((reference, index) => ({
              ...property,
              id: index === 0
                ? property.id
                : uniqueId(undefined, 'property', usedPropertyIds),
              reference,
            })))
        : [];
      blocks.push({
        id,
        type: 'property-table',
        properties,
        ...normalizeBlockBase(raw),
        columns: normalizeGridColumns(raw.columns),
        rowMode: raw.rowMode === 'fixed' ? 'fixed' : undefined,
        rows: normalizeTableRows(raw.rows),
      });
    } else if (raw.type === 'divider') {
      blocks.push({ id, type: 'divider', ...normalizeBlockBase(raw) });
    } else if (raw.type === 'source') {
      blocks.push({ id, type: 'source', ...normalizeBlockBase(raw) });
    } else if (raw.type === 'stack' && allowStacks) {
      const children = Array.isArray(raw.blocks)
        ? normalizeCardBlockArray(raw.blocks, usedBlockIds, usedPropertyIds, false)
          .filter((block): block is CardContentBlock => block.type !== 'stack')
        : [];
      blocks.push({
        id,
        type: 'stack',
        ...normalizeBlockBase(raw),
        heading: typeof raw.heading === 'string' && raw.heading.trim()
          ? raw.heading.trim().slice(0, 120)
          : undefined,
        direction: raw.direction === 'horizontal' ? 'horizontal' : undefined,
        blocks: children,
        stackStyle: normalizeCardStackStyle(raw.stackStyle),
      });
    }
  }
  return blocks;
}

export function normalizeGridColumns(value: unknown): CardGridColumns | undefined {
  const number = typeof value === 'number' ? value : Number(value);
  return number === 1 || number === 2 || number === 3 || number === 4 ? number : undefined;
}

export function normalizeLayoutGap(value: unknown): number | undefined {
  const number = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(number)) return undefined;
  return Math.min(24, Math.max(0, Math.round(number)));
}

export function normalizeTableRows(value: unknown): number | undefined {
  const number = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(number)) return undefined;
  return Math.min(12, Math.max(1, Math.round(number)));
}

export function normalizeCardStyle(value: unknown): CardStyleConfig | undefined {
  if (!isRecord(value)) return undefined;
  const style: CardStyleConfig = {};
  if (isBackgroundTone(value.background)) style.background = value.background;
  if (isBorderStyle(value.border)) style.border = value.border;
  if (isShadowStyle(value.shadow)) style.shadow = value.shadow;
  if (isTextAlignment(value.alignment)) style.alignment = value.alignment;
  style.radius = normalizeNumber(value.radius, 0, 24);
  style.maxWidth = normalizeNumber(value.maxWidth, 240, 900);
  style.padding = normalizeNumber(value.padding, 0, 32);
  if (Array.isArray(value.cssClasses)) {
    const classes = value.cssClasses
      .filter((item): item is string => typeof item === 'string')
      .map((item) => item.trim())
      .filter((item) => /^[A-Za-z_][\w-]*$/.test(item));
    if (classes.length) style.cssClasses = [...new Set(classes)].slice(0, 12);
  }
  return Object.keys(style).length ? style : undefined;
}

export function normalizeCardBlockStyle(value: unknown): CardBlockStyle | undefined {
  if (!isRecord(value)) return undefined;
  const style: CardBlockStyle = {};
  if (value.tone === 'soft' || value.tone === 'strong' || value.tone === 'accent') {
    style.tone = value.tone;
  }
  if (value.border === 'outline' || value.border === 'divider') style.border = value.border;
  if (isTextAlignment(value.alignment)) style.alignment = value.alignment;
  style.padding = normalizeNumber(value.padding, 0, 24);
  return Object.keys(style).length ? style : undefined;
}

export function normalizeCardStackStyle(value: unknown): CardStackStyle | undefined {
  if (!isRecord(value)) return undefined;
  const style: CardStackStyle = {};
  if (value.tone === 'soft' || value.tone === 'strong' || value.tone === 'accent') {
    style.tone = value.tone;
  }
  if (value.border === 'outline') style.border = value.border;
  style.padding = normalizeNumber(value.padding, 0, 24);
  style.gap = normalizeNumber(value.gap, 0, 24);
  style.radius = normalizeNumber(value.radius, 0, 24);
  return Object.keys(style).length ? style : undefined;
}

function normalizeBlockBase(value: Record<string, unknown>): {
  editorLabel?: string;
  width?: CardBlockWidth;
  style?: CardBlockStyle;
} {
  const base: {
    editorLabel?: string;
    width?: CardBlockWidth;
    style?: CardBlockStyle;
  } = {};
  base.editorLabel = normalizeEditorLabel(value.editorLabel);
  if (value.width === 'full'
    || value.width === 'half'
    || value.width === 'third'
    || value.width === 'quarter') {
    base.width = value.width;
  }
  base.style = normalizeCardBlockStyle(value.style);
  return base;
}

function normalizePropertyEntry(
  value: unknown,
  usedIds: Set<string>,
): CardPropertyEntry | null {
  if (!isRecord(value)) return null;
  return {
    id: uniqueId(value.id, 'property', usedIds),
    reference: typeof value.reference === 'string' ? value.reference : '',
    editorLabel: normalizeEditorLabel(value.editorLabel),
    label: typeof value.label === 'string' && value.label.trim() ? value.label.trim() : undefined,
    labelPosition: value.labelPosition === 'above' || value.labelPosition === 'hidden'
      ? value.labelPosition
      : undefined,
    alignment: isTextAlignment(value.alignment) ? value.alignment : undefined,
    labelWidth: normalizeNumber(value.labelWidth, 20, 70),
  };
}

function normalizeEditorLabel(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const label = value.trim();
  return label ? label.slice(0, 80) : undefined;
}

function normalizeNumber(
  value: unknown,
  minimum: number,
  maximum: number,
): number | undefined {
  const number = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(number)) return undefined;
  return Math.min(maximum, Math.max(minimum, Math.round(number)));
}

function isTextAlignment(value: unknown): value is CardTextAlignment {
  return value === 'left' || value === 'center' || value === 'right';
}

function isBackgroundTone(value: unknown): value is CardBackgroundTone {
  return value === 'default'
    || value === 'primary'
    || value === 'secondary'
    || value === 'accent'
    || value === 'transparent';
}

function isBorderStyle(value: unknown): value is CardBorderStyle {
  return value === 'default' || value === 'none' || value === 'subtle' || value === 'accent';
}

function isShadowStyle(value: unknown): value is CardShadowStyle {
  return value === 'none' || value === 'small' || value === 'medium' || value === 'large';
}

function flattenCardBlocks(blocks: CardBlock[]): CardContentBlock[] {
  return blocks.flatMap((block) => block.type === 'stack' ? block.blocks : [block]);
}

function uniqueId(value: unknown, prefix: string, usedIds: Set<string>): string {
  let id = typeof value === 'string' ? value.trim() : '';
  if (!id || usedIds.has(id)) id = createCardBlockId(prefix);
  usedIds.add(id);
  return id;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
