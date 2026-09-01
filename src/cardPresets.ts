import type { CardConfig } from './card';
import {
  cloneCardBlocks,
  createCardBlockId,
  createPropertyEntry,
  type CardBlock,
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

function allCardBlocks(blocks: readonly CardBlock[]): CardBlock[] {
  return blocks.flatMap((block) => block.type === 'stack' ? [block, ...block.blocks] : [block]);
}
