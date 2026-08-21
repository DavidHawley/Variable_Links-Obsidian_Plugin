/** Utility functions for Variable Links plugin */

/**
 * parseWikiLink("[[Folder/File]]") -> "Folder/File.md" (best-effort)
 */
export function parseWikiLink(raw: string): string {
  if (!raw) return raw;
  const m = raw.match(/\[\[([^\]]+)\]\]/);
  if (!m) return raw;
  let inner = m[1].trim();
  // If the link already has an extension, return as-is
  if (/\.[a-zA-Z0-9]+$/.test(inner)) return inner;
  return inner + '.md';
}

export function normalizeVariableName(name: string): string {
  return (name || '').trim();
}
