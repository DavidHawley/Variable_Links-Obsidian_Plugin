import type { CardConfig } from './card';
import {
  cloneCardBlocks,
  createCardBlockId,
  createPropertyEntry,
  deriveLegacyCardFields,
  getActiveCardBlocks,
  type CardBlock,
  type CardContentBlock,
  type CardPropertyTableBlock,
} from './cardBlocks';

export type BuiltInCardPreset = 'classic' | 'compact' | 'profile';

export function isBuiltInCardPreset(value: string): value is BuiltInCardPreset {
  return value === 'classic' || value === 'compact' || value === 'profile';
}

export function applyBuiltInCardPreset(
  sourceBlocks: readonly CardBlock[],
  preset: BuiltInCardPreset,
): CardConfig {
  const blocks = cloneCardBlocks([...sourceBlocks]);
  const layoutMode = preset === 'classic' ? 'stack' : 'grid';
  const gridColumns = preset === 'compact' ? 3 : 2;
  const layoutGap = preset === 'classic' ? 0 : preset === 'profile' ? 12 : 8;
  const cardStyle = preset === 'classic'
    ? undefined
    : {
      background: 'secondary' as const,
      border: 'subtle' as const,
      radius: preset === 'profile' ? 12 : 8,
      shadow: 'small' as const,
      maxWidth: preset === 'profile' ? 640 : 560,
      padding: preset === 'profile' ? 12 : 8,
    };

  for (const block of allCardBlocks(blocks)) {
    block.style = undefined;
    const topLevel = blocks.includes(block);
    if (!topLevel || preset === 'classic') {
      block.width = undefined;
    } else if (block.type === 'title'
      || block.type === 'source'
      || block.type === 'divider'
      || block.type === 'property-table'
      || block.type === 'stack'
      || (preset === 'profile' && block.type === 'note')) {
      block.width = 'full';
    } else {
      block.width = undefined;
    }
    if (block.type === 'property-table') {
      block.columns = preset === 'classic' ? undefined : 2;
      block.rowMode = undefined;
      block.rows = undefined;
    }
    if (block.type === 'stack') block.stackStyle = undefined;
  }

  return {
    blocks,
    useBlockLayout: true,
    layoutMode,
    gridColumns,
    layoutGap,
    cardStyle,
  };
}

export function createAutolinkCardSnapshot(
  variableName: string,
  preset: BuiltInCardPreset | 'none',
  propertyReferences: readonly string[],
): CardConfig | undefined {
  if (preset === 'none') return undefined;
  const properties = [...new Set(propertyReferences.map((value) => value.trim()).filter(Boolean))];
  const blocks: CardBlock[] = [
    {
      id: createCardBlockId('title'),
      type: 'title',
      text: variableName,
    },
    ...properties.map((reference): CardBlock => ({
      id: createCardBlockId('property'),
      type: 'property',
      property: createPropertyEntry(reference),
    })),
    {
      id: createCardBlockId('source'),
      type: 'source',
    },
  ];
  return applyBuiltInCardPreset(blocks, preset);
}

export function getCardPropertyReferences(card: CardConfig): string[] {
  return normalizePropertyReferences(deriveLegacyCardFields(getActiveCardBlocks(card)).fields ?? []);
}

export function updateCardPropertyReferences(
  card: CardConfig,
  propertyReferences: readonly string[],
): CardConfig {
  const references = normalizePropertyReferences(propertyReferences);
  if (card.useBlockLayout !== true) {
    return { ...card, fields: references.length ? references : undefined };
  }

  const blocks = cloneCardBlocks(getActiveCardBlocks(card));
  const state: {
    index: number;
    lastPropertyKind?: 'property' | 'table';
    lastTable?: CardPropertyTableBlock;
  } = { index: 0 };
  const updateBlocks = (source: readonly CardBlock[]): CardBlock[] => {
    const updated: CardBlock[] = [];
    for (const block of source) {
      if (block.type === 'property') {
        const reference = references[state.index++];
        if (reference === undefined) continue;
        updated.push({
          ...block,
          property: { ...block.property, reference },
        });
        state.lastPropertyKind = 'property';
      } else if (block.type === 'property-table') {
        const table: CardPropertyTableBlock = {
          ...block,
          properties: block.properties.flatMap((property) => {
            const reference = references[state.index++];
            return reference === undefined ? [] : [{ ...property, reference }];
          }),
        };
        state.lastTable = table;
        state.lastPropertyKind = 'table';
        updated.push(table);
      } else if (block.type === 'stack') {
        updated.push({
          ...block,
          blocks: updateBlocks(block.blocks) as CardContentBlock[],
        });
      } else {
        updated.push(block);
      }
    }
    return updated;
  };
  const updatedBlocks = updateBlocks(blocks);
  const remaining = references.slice(state.index);
  if (state.lastPropertyKind === 'table' && state.lastTable) {
    state.lastTable.properties.push(...remaining.map((reference) => createPropertyEntry(reference)));
  } else if (remaining.length) {
    let lastPropertyIndex = -1;
    updatedBlocks.forEach((block, index) => {
      if (blockContainsProperties(block)) lastPropertyIndex = index;
    });
    const sourceIndex = updatedBlocks.findIndex(({ type }) => type === 'source');
    const insertionIndex = lastPropertyIndex >= 0
      ? lastPropertyIndex + 1
      : sourceIndex === -1 ? updatedBlocks.length : sourceIndex;
    const propertyBlocks: CardBlock[] = remaining.map((reference) => ({
      id: createCardBlockId('property'),
      type: 'property',
      property: createPropertyEntry(reference),
    }));
    updatedBlocks.splice(insertionIndex, 0, ...propertyBlocks);
  }

  return {
    ...card,
    fields: references.length ? references : undefined,
    blocks: updatedBlocks,
  };
}

function normalizePropertyReferences(values: readonly string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))];
}

function blockContainsProperties(block: CardBlock): boolean {
  if (block.type === 'property') return true;
  if (block.type === 'property-table') return block.properties.length > 0;
  return block.type === 'stack' && block.blocks.some(blockContainsProperties);
}

function allCardBlocks(blocks: readonly CardBlock[]): CardBlock[] {
  return blocks.flatMap((block) => block.type === 'stack' ? [block, ...block.blocks] : [block]);
}
