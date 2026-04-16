export function buildReviewLabel(title: string, findings: number, status: 'open' | 'resolved') {
  const safeTitle = title.trim() || 'Untitled';
  const findingLabel = findings === 1 ? '1 finding' : `${findings} findings`;

  return `${safeTitle} (${findingLabel}, ${status})`;
}
