const ISSUE_LINE_PATTERN = /^- \[(P\d+)\] ([^:]+): (.+)$/;

function incrementCounter(counter, key) {
  counter[key] = (counter[key] ?? 0) + 1;
}

function formatCounts(title, counts) {
  const lines = [`## ${title}`];

  for (const [key, count] of Object.entries(counts)) {
    lines.push(`- ${key}: ${count}`);
  }

  return lines.join('\n');
}

export function parseIssueLine(line) {
  const match = line.match(ISSUE_LINE_PATTERN);

  if (match === null) {
    throw new Error(`Invalid issue line: ${line}`);
  }

  const [, priority, area, details] = match;
  const tokens = details.split(' ');
  const ownerToken = tokens.find((token) => token.startsWith('@'));
  const tags = tokens
    .filter((token) => token.startsWith('#'))
    .map((token) => token.slice(1));
  const title = tokens
    .filter((token) => !token.startsWith('@') && !token.startsWith('#'))
    .join(' ');

  return {
    priority,
    area,
    title,
    owner: ownerToken?.slice(1) ?? null,
    tags,
  };
}

export function parseIssues(markdown) {
  return markdown
    .split(/\r?\n/u)
    .map((line) => line.trimEnd())
    .filter((line) => line.length > 0 && !line.startsWith('//'))
    .map((line) => parseIssueLine(line));
}

export function summarizeIssues(issues) {
  const summary = {
    total: issues.length,
    byPriority: {},
    byArea: {},
    byOwner: {},
    byTag: {},
  };

  for (const issue of issues) {
    incrementCounter(summary.byPriority, issue.priority);
    incrementCounter(summary.byArea, issue.area);
    incrementCounter(summary.byOwner, issue.owner);

    for (const tag of issue.tags) {
      incrementCounter(summary.byTag, tag);
    }
  }

  return summary;
}

export function formatSummary(summary) {
  return [
    '# Issue Summary',
    '',
    `Total: ${summary.total}`,
    '',
    formatCounts('Priorities', summary.byPriority),
    '',
    formatCounts('Areas', summary.byArea),
    '',
    formatCounts('Owners', summary.byOwner),
    '',
    formatCounts('Tags', summary.byTag),
  ].join('\n');
}
