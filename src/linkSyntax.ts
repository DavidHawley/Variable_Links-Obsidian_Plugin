export interface PropertyLink {
  file: string;
  property: string;
}

export function filePathFromLink(value: string): string {
  let path = value.trim();
  const wikiLink = path.match(/^\[\[([^\]]+)\]\]$/);
  if (wikiLink?.[1]) path = wikiLink[1].trim();
  const alias = path.indexOf('|');
  if (alias !== -1) path = path.slice(0, alias).trim();
  return path.replace(/\\/g, '/').replace(/\.md$/i, '');
}

export function toFileLink(value: string): string {
  const path = filePathFromLink(value);
  return path ? `[[${path}]]` : '';
}

export function formatPropertyLink(file: string, property: string): string {
  const fileLink = toFileLink(file);
  const propertyName = property.trim();
  return fileLink && propertyName ? `${fileLink}#${propertyName}` : '';
}

export function parsePropertyLink(value: string): PropertyLink {
  const match = value.trim().match(/^\[\[([^\]]+)\]\]#([\s\S]+)$/);
  if (!match?.[1] || !match[2]?.trim()) {
    throw new Error('Property link must use the format [[File path]]#property.');
  }
  const file = toFileLink(match[1]);
  if (!file) throw new Error('Property link requires a file path.');
  return { file, property: match[2].trim() };
}
