export function renderNamePatternHelp(parent: HTMLElement): void {
  parent.createEl('p', {
    text: 'A run of number signs inserts the row counter. Its length controls zero padding.',
  });
  const examples = parent.createEl('ul');
  for (const example of [
    '# → 1, 2, 3',
    '## → 01, 02, 03',
    '### → 001, 002, 003',
    '{filename} or {file} → source filename',
    '{path} → source path without .md',
    '{folder} → source folder',
    '{variable} → current Variable Link name',
    '{value} → current resolved value',
    '{property} → linked property name',
    '{property:Status} → Status value from the source note',
    '{property:FullName|word(2,1)} → selected words joined with underscores',
    '{property:FullName|char(1)} → selected characters',
    '{property:FullName|word(2)|char(1)} → wrappers run from left to right',
    '{property:FullName|word(-1)} → negative positions count from the end',
    '{property:Status|replace(Draft,Final)} → replace every literal match',
    '{profile} → managing Autolink profile name',
    '\\#, \\{, \\}, \\|, and \\, → literal characters',
  ]) examples.createEl('li', { text: example });
  parent.createEl('p', {
    text: 'Example: {filename}_##_text',
    cls: 'variable-links-hint-text',
  });
}
