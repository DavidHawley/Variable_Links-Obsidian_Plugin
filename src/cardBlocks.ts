export interface CardPropertyEntry {
  id: string;
  reference: string;
}

export type CardLayoutMode = 'stack' | 'grid';
export type CardBlockWidth = 'full' | 'half' | 'third' | 'quarter';
export type CardGridColumns = 1 | 2 | 3 | 4;
export type CardTableRowMode = 'auto' | 'fixed';

interface CardBlockBase {
  id: string;
  width?: CardBlockWidth;
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

export type CardBlock = CardTitleBlock
  | CardNoteBlock
  | CardPropertyBlock
  | CardPropertyTableBlock
  | CardDividerBlock
  | CardSourceBlock;

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
  const title = blocks.find((block): block is CardTitleBlock => block.type === 'title');
  const note = blocks.find((block): block is CardNoteBlock => block.type === 'note');
  const fields: string[] = [];
  for (const block of blocks) {
    if (block.type === 'property') fields.push(block.property.reference);
    else if (block.type === 'property-table') {
      fields.push(...block.properties.map((property) => property.reference));
    }
  }
  return {
    title: title?.text || undefined,
    note: note?.markdown || undefined,
    fields: fields.length ? fields : undefined,
    showSourceLink: blocks.some((block) => block.type === 'source') || undefined,
  };
}

export function cloneCardBlocks(blocks: CardBlock[]): CardBlock[] {
  return blocks.map((block) => {
    if (block.type === 'property-table') {
      return { ...block, properties: block.properties.map((property) => ({ ...property })) };
    }
    if (block.type === 'property') return { ...block, property: { ...block.property } };
    return { ...block };
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
  const blocks: CardBlock[] = [];
  for (const raw of value) {
    if (!isRecord(raw) || typeof raw.type !== 'string') continue;
    const id = uniqueId(raw.id, raw.type, usedBlockIds);
    if (raw.type === 'title') {
      blocks.push({
        id,
        type: 'title',
        text: typeof raw.text === 'string' ? raw.text : '',
        ...normalizeBlockWidth(raw.width),
      });
    } else if (raw.type === 'note') {
      blocks.push({
        id,
        type: 'note',
        markdown: typeof raw.markdown === 'string' ? raw.markdown : '',
        ...normalizeBlockWidth(raw.width),
      });
    } else if (raw.type === 'property') {
      const property = normalizePropertyEntry(raw.property, usedPropertyIds);
      if (property) {
        const references = splitCardPropertyReferences(property.reference);
        references.forEach((reference, index) => {
          blocks.push({
            id: index === 0 ? id : uniqueId(undefined, 'property', usedBlockIds),
            type: 'property',
            ...normalizeBlockWidth(raw.width),
            property: {
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
        ...normalizeBlockWidth(raw.width),
        columns: normalizeGridColumns(raw.columns),
        rowMode: raw.rowMode === 'fixed' ? 'fixed' : undefined,
        rows: normalizeTableRows(raw.rows),
      });
    } else if (raw.type === 'divider') {
      blocks.push({ id, type: 'divider', ...normalizeBlockWidth(raw.width) });
    } else if (raw.type === 'source') {
      blocks.push({ id, type: 'source', ...normalizeBlockWidth(raw.width) });
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

function normalizeBlockWidth(value: unknown): { width?: CardBlockWidth } {
  return value === 'full' || value === 'half' || value === 'third' || value === 'quarter'
    ? { width: value }
    : {};
}

function normalizePropertyEntry(
  value: unknown,
  usedIds: Set<string>,
): CardPropertyEntry | null {
  if (!isRecord(value)) return null;
  return {
    id: uniqueId(value.id, 'property', usedIds),
    reference: typeof value.reference === 'string' ? value.reference : '',
  };
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
