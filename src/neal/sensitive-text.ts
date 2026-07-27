const REDACTED = '[redacted]';

const SECRET_VALUE_PATTERN =
  /\b(?:sk-[A-Za-z0-9_./=-]+|ghp_[A-Za-z0-9_]+|github_pat_[A-Za-z0-9_]+|glpat-[A-Za-z0-9_-]+|xox[baprs]-[A-Za-z0-9-]+)\b/g;

const SENSITIVE_ASSIGNMENT_PATTERN =
  /\b([A-Z0-9_]*?(?:API[_ -]?KEY|TOKEN|SECRET|PASSWORD|CREDENTIALS?)[A-Z0-9_]*|api[ _-]?key|token|secret|password|credentials?)\b\s*[:=]\s*(?:"[^"\r\n]*"|'[^'\r\n]*'|[^\s,;]+)/gi;

export function sanitizeSensitiveText(value: string) {
  return value
    .replace(SECRET_VALUE_PATTERN, REDACTED)
    .replace(SENSITIVE_ASSIGNMENT_PATTERN, (_match, key: string) => `${key}=${REDACTED}`);
}
