export function splitGraphemes(value: string): string[] {
  const Segmenter = (Intl as unknown as {
    Segmenter?: new (
      locales?: string | string[],
      options?: { granularity: 'grapheme' },
    ) => { segment(input: string): Iterable<{ segment: string }> };
  }).Segmenter;
  if (!Segmenter) return Array.from(value);
  return Array.from(
    new Segmenter(undefined, { granularity: 'grapheme' }).segment(value),
    ({ segment }) => segment,
  );
}
