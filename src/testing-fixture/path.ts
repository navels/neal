export function fileLabel(path: string) {
  const name = path.split('/').filter(Boolean).at(-1) ?? '';
  return name.replace(/\.[^.]+$/, '').replace(/[-_]+/g, ' ');
}

export function pathSegments(path: string) {
  return path.split('/').filter(Boolean);
}
