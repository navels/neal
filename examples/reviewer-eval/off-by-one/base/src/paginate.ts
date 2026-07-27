export function pageSlice<T>(items: T[], page: number, size: number): T[] {
  const start = page * size;
  const end = start + size;
  return items.slice(start, end);
}
