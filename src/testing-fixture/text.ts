const COMMON_ACRONYMS = new Set(['API', 'CLI', 'SDK']);

export function normalizeWhitespace(value: string) {
  return value.trim().replace(/\s+/g, ' ');
}

export function toSentenceCase(value: string) {
  const normalized = normalizeWhitespace(value);
  if (!normalized) {
    return '';
  }

  const [firstWord, ...rest] = normalized.split(' ');
  const head = COMMON_ACRONYMS.has(firstWord.toUpperCase())
    ? firstWord.toUpperCase()
    : firstWord.charAt(0).toUpperCase() + firstWord.slice(1).toLowerCase();

  return [head, ...rest.map((part) => part.toLowerCase())].join(' ');
}
