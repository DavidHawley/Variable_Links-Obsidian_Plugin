/** Shared visible error text for rendered tokens and copied Markdown. */
export function resolutionErrorText(name: string, definition?: { type?: string } | null): string {
  return definition?.type === 'computed' || (!definition && name.startsWith('='))
    ? '[Expression error]'
    : `[Missing: ${name}]`;
}
