const SCOPE_PREFIX_PATTERN = /^Scope(?:\s+|:\s*)\d+(?:\.\d+)*(?:[A-Za-z])?(?:\s*(?::|-)\s*|$)/;

export function stripScopePrefixFromSubject(subject: string) {
  return subject.trim().replace(SCOPE_PREFIX_PATTERN, '').trim();
}

export function stripScopePrefixFromCommitMessage(message: string) {
  const normalized = message.replace(/\r\n/g, '\n');
  const lines = normalized.split('\n');
  const strippedSubject = stripScopePrefixFromSubject(lines[0] ?? '');
  if (strippedSubject) {
    return [strippedSubject, ...lines.slice(1)].join('\n');
  }

  const firstBodyLineIndex = lines.findIndex((line, index) => index > 0 && line.trim());
  if (firstBodyLineIndex === -1) {
    return '';
  }

  return lines.slice(firstBodyLineIndex).join('\n');
}
