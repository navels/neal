#!/usr/bin/env node
// scripts/diagnose-run.mjs — size-and-shape report for a neal run directory.
//
// Prints only counts, byte sizes, and kinds. Repository file names appear as
// extension + size only, commit SHAs are collapsed, and labels that look like
// file names are redacted. It never prints repository paths, commit subjects,
// findings text, summaries, guidance content, or prompt text, so the output is
// safe to paste into a public issue.
//
// Usage: node diagnose-run.mjs <run-dir> [--repo <checkout>]
//   <run-dir>  a .neal/runs/<run-id> directory
//   --repo     the repository checkout the run worked in (default: the cwd
//              recorded in RUN_STATE.json)
//
// Requires node >= 20 and git on PATH. No neal import, so it works against any
// installed neal version.

import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { extname, join, resolve } from 'node:path';

const args = process.argv.slice(2);
const runDir = args.find((a) => !a.startsWith('--'));
if (!runDir) {
  console.error('usage: node diagnose-run.mjs <run-dir> [--repo <checkout>]');
  process.exit(1);
}
const repoFlag = args.indexOf('--repo');
const repoOverride = repoFlag >= 0 ? args[repoFlag + 1] : null;

const out = [];
// The completion packet embeds the run's verification-command history, derived
// from command_completed events. Measured here so the prompt estimate below
// includes it — it is usually the largest packet term on a long run.
const commandHistory = { distinct: new Set(), recordsBytes: 0, summaryBytes: 0 };
const section = (title) => out.push('', `## ${title}`, '');
const line = (...parts) => out.push(parts.join(' '));
const kb = (n) => `${n} bytes (${(n / 1024).toFixed(1)} KiB)`;
const len = (v) => (typeof v === 'string' ? v.length : v == null ? 0 : JSON.stringify(v).length);
const readJson = (path) => {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return null;
  }
};
const fileSize = (path) => (existsSync(path) ? statSync(path).size : null);
const ext = (path) => extname(path) || '(none)';
// Labels and artifact names can carry repository file names (a review round
// labelled after a doc, an archived review keyed by commit). Collapse commit
// SHAs and anything containing a path separator or a file extension.
const redactLabel = (value) => {
  const text = String(value ?? '');
  if (/[\/\\]/.test(text) || /\.[A-Za-z0-9]{1,8}$/.test(text)) return '<redacted>';
  return text.replace(/[0-9a-f]{40}/g, '<sha>');
};
const git = (cwd, ...argv) => {
  try {
    return execFileSync('git', argv, { cwd, encoding: 'utf8', maxBuffer: 1 << 30 });
  } catch {
    return null;
  }
};
const version = (cmd) => {
  try {
    return execFileSync(cmd, ['--version'], { encoding: 'utf8' }).trim().split('\n')[0];
  } catch {
    return '(not on PATH)';
  }
};

// ---- environment ----
section('Environment');
line('node:', process.version);
line('neal:', version('neal'));
line('codex:', version('codex'));
line('claude:', version('claude'));
line('NEAL_GUIDANCE_DIR:', process.env.NEAL_GUIDANCE_DIR ? 'set' : 'unset');
// meta.json records the build that actually produced the run, which can differ
// from whatever `neal` is on PATH today.
const meta = readJson(join(runDir, 'meta.json'));
if (meta?.build) {
  line('run built by neal:', meta.build.packageVersion ?? '?', '| node', meta.build.nodeVersion ?? '?', '| source', meta.build.sourceGitSha ? String(meta.build.sourceGitSha).slice(0, 12) : meta.build.sourceGit ?? 'n/a');
}
if (meta) line('run resumed from an earlier state:', meta.resumedFromStatePath ? 'yes' : 'no');

// ---- run state ----
const statePath = join(runDir, 'RUN_STATE.json');
const state = readJson(statePath);
section('Run state');
if (!state) {
  line('RUN_STATE.json: missing or unreadable in the given run directory');
} else {
  line('RUN_STATE.json:', kb(fileSize(statePath)));
  line('state version:', state.version, '| mode:', state.topLevelMode, '| shape:', state.executionShape);
  line('phase:', state.phase, '| status:', state.status, '| blockedFromPhase:', state.blockedFromPhase ?? 'null');
  line('currentScopeNumber:', state.currentScopeNumber, '| derivedPlanDepth:', state.derivedPlanDepth ?? 'n/a');
  for (const role of ['planner', 'coder', 'reviewer']) {
    const cfg = state.agentConfig?.[role];
    line(`${role} provider:`, cfg?.provider ?? 'n/a', '| model set:', cfg?.model ? 'yes' : 'no', '| effort:', cfg?.effort ?? 'n/a');
  }
  line('initialBaseCommit set:', state.initialBaseCommit ? 'yes' : 'no', '| finalCommit set:', state.finalCommit ? 'yes' : 'no');
  line('rounds:', state.rounds?.length ?? 0, '| findings:', state.findings?.length ?? 0, '| completedScopes:', state.completedScopes?.length ?? 0);
  line('inheritedPlanReviewDebt:', state.inheritedPlanReviewDebt?.length ?? 0, '| planReviewDebt:', state.planReviewDebt?.length ?? 0);
  line('blockerReason length:', len(state.blockerReason));
}

// ---- run-dir artifacts ----
section('Run directory artifacts (neal-owned names, commit SHAs redacted)');
try {
  const groups = new Map();
  for (const e of readdirSync(runDir, { withFileTypes: true })) {
    const name = e.isDirectory() ? `${e.name}/` : e.name.replace(/[0-9a-f]{40}/g, '<sha>');
    const size = e.isDirectory() ? 0 : statSync(join(runDir, e.name)).size;
    const g = groups.get(name) ?? { count: 0, bytes: 0, dir: e.isDirectory() };
    g.count += 1;
    g.bytes += size;
    groups.set(name, g);
  }
  for (const [name, g] of [...groups.entries()].sort((a, b) => b[1].bytes - a[1].bytes)) {
    line(`${name}:`, g.dir ? '(directory)' : `${g.count > 1 ? `${g.count} files, ` : ''}${kb(g.bytes)}`);
  }
} catch {
  line('cannot list the run directory');
}

// ---- operator guidance ----
section('Operator guidance files (inlined verbatim into prompts)');
const guidanceDir = process.env.NEAL_GUIDANCE_DIR ?? join(homedir(), '.neal', 'guidance');
for (const role of ['coder', 'reviewer', 'planner']) {
  const p = join(guidanceDir, `${role}.md`);
  line(`${role}.md:`, existsSync(p) ? kb(fileSize(p)) : 'absent');
}

// ---- completed scopes ----
if (state?.completedScopes?.length) {
  section('Completed scopes');
  for (const s of state.completedScopes) {
    line(
      `scope ${s.number}:`,
      s.result,
      `| marker ${s.marker}`,
      `| changedFiles ${s.changedFiles?.length ?? 0}`,
      `| reviewRounds ${s.reviewRounds ?? 0}`,
      `| findings ${s.findings ?? 0}`,
      `| residualDebt ${s.residualReviewDebt?.length ?? 0}`,
      `| summary length ${len(s.summary)}`,
      `| parent ${s.derivedFromParentScope ?? 'none'}`,
      `| range ${s.baseCommit && s.finalCommit ? 'recorded' : 'missing'}`,
    );
  }
  const all = state.completedScopes.flatMap((s) => s.changedFiles ?? []);
  line('changedFiles entries total:', all.length, '| distinct:', new Set(all).size);
}

// ---- findings ----
if (state?.findings?.length) {
  section('Findings (current scope)');
  const sum = (k) => state.findings.reduce((n, f) => n + len(f[k]), 0);
  line('count:', state.findings.length, '| open:', state.findings.filter((f) => f.status === 'open').length);
  line('total claim chars:', sum('claim'), '| requiredAction:', sum('requiredAction'), '| evidence:', sum('evidence'));
}

// ---- final completion ----
section('Final completion');
if (state?.finalCompletionSummary) {
  const s = state.finalCompletionSummary;
  line('summary present: yes | planGoalSatisfied:', s.planGoalSatisfied);
  line('whatChangedOverall chars:', len(s.whatChangedOverall), '| verificationSummary chars:', len(s.verificationSummary));
  line('remainingKnownGaps:', s.remainingKnownGaps?.length ?? 0, 'items,', len(s.remainingKnownGaps), 'chars');
  line('summary JSON total chars:', len(s));
} else {
  line('summary present: no');
}
line('finalCompletionReviewVerdict present:', state?.finalCompletionReviewVerdict ? 'yes' : 'no');
line('continueExecutionCount:', state?.finalCompletionContinueExecutionCount ?? 0);

// ---- reviewer context packet ----
section('Reviewer continuity packet');
line('REVIEWER_CONTEXT.md:', fileSize(join(runDir, 'REVIEWER_CONTEXT.md')) == null ? 'absent' : kb(fileSize(join(runDir, 'REVIEWER_CONTEXT.md'))));
line('REVIEWER_CONTEXT.json:', fileSize(join(runDir, 'REVIEWER_CONTEXT.json')) == null ? 'absent' : kb(fileSize(join(runDir, 'REVIEWER_CONTEXT.json'))));

// ---- git ranges ----
const repo = repoOverride ? resolve(repoOverride) : state?.cwd ?? null;
section('Git ranges (sizes only; paths shown as extension + bytes)');
let aggregateDiffBytes = null;
if (!repo || !existsSync(repo)) {
  line('repository checkout not found; pass --repo <checkout>');
} else if (!git(repo, 'rev-parse', '--git-dir')) {
  line('not a git repository:', 'checkout unavailable');
} else {
  const describeRange = (label, base, head) => {
    if (!base || !head) {
      line(`${label}: range not recorded`);
      return null;
    }
    const diff = git(repo, 'diff', '--find-renames', `${base}..${head}`);
    if (diff == null) {
      line(`${label}: git diff failed (commits missing locally?)`);
      return null;
    }
    const names = (git(repo, 'diff', '--name-only', `${base}..${head}`) ?? '').split('\n').filter(Boolean);
    line(`${label}: diff ${kb(diff.length)} | files ${names.length} | commits ${(git(repo, 'rev-list', '--count', `${base}..${head}`) ?? '?').trim()}`);
    const perFile = names
      .map((p) => ({ ext: ext(p), bytes: (git(repo, 'diff', '--find-renames', `${base}..${head}`, '--', p) ?? '').length }))
      .sort((a, b) => b.bytes - a.bytes)
      .slice(0, 8);
    for (const f of perFile) {
      line(`  per-file diff: ${f.ext} ${kb(f.bytes)}`);
    }
    return diff.length;
  };
  aggregateDiffBytes = describeRange('aggregate (initialBaseCommit..finalCommit)', state?.initialBaseCommit, state?.finalCommit);
  for (const s of state?.completedScopes ?? []) {
    describeRange(`scope ${s.number} (baseCommit..finalCommit)`, s.baseCommit, s.finalCommit);
  }
  if (state?.finalCommit) {
    const sizes = [];
    for (const s of state.completedScopes ?? []) {
      for (const p of s.changedFiles ?? []) {
        const raw = git(repo, 'cat-file', '-s', `${state.finalCommit}:${p}`);
        if (raw != null) sizes.push({ ext: ext(p), bytes: Number(raw.trim()) });
      }
    }
    sizes.sort((a, b) => b.bytes - a.bytes);
    line('changed-file blob sizes at finalCommit (entries incl. repeats):', sizes.length, '| sum', kb(sizes.reduce((n, f) => n + f.bytes, 0)));
    for (const f of sizes.slice(0, 8)) line(`  blob: ${f.ext} ${kb(f.bytes)}`);
  }
}

// ---- events ----
section('events.ndjson');
const eventsPath = join(runDir, 'events.ndjson');
if (!existsSync(eventsPath)) {
  line('absent');
} else {
  const raw = readFileSync(eventsPath, 'utf8');
  const lines = raw.split('\n').filter(Boolean);
  line('size:', kb(raw.length), '| events:', lines.length);
  const byType = new Map();
  const sized = [];
  let lastProviderError = null;
  let lastProviderErrorIndex = -1;
  const parsed = [];
  for (const l of lines) {
    let e;
    try {
      e = JSON.parse(l);
    } catch {
      continue;
    }
    const type = e.type ?? e.event ?? '(untyped)';
    byType.set(type, (byType.get(type) ?? 0) + 1);
    sized.push({ type, label: redactLabel(e.label ?? e.data?.label ?? ''), bytes: l.length });
    parsed.push({ type, label: redactLabel(e.label ?? e.data?.label ?? '') });
    if (/provider_error|provider\.error/.test(type)) {
      lastProviderError = e;
      lastProviderErrorIndex = parsed.length - 1;
    }
    if (type === 'provider.command_completed') {
      const cmd = e.data?.command ?? e.command;
      if (typeof cmd === 'string' && !commandHistory.distinct.has(cmd)) {
        commandHistory.distinct.add(cmd);
        // neal dedupes command results by command string, then embeds each as a
        // JSON record (~250 bytes of fixed fields plus the command) and again as
        // a one-line summary (~180 bytes plus the command).
        commandHistory.recordsBytes += cmd.length + 250;
        commandHistory.summaryBytes += cmd.length + 180;
      }
    }
  }
  const turnsByLabel = new Map();
  for (const p of parsed) {
    if (p.type === 'provider.turn_started') turnsByLabel.set(p.label, (turnsByLabel.get(p.label) ?? 0) + 1);
  }
  if (turnsByLabel.size) {
    line('provider turns by label:');
    for (const [l, n] of [...turnsByLabel.entries()].sort((a, b) => b[1] - a[1])) line(`  ${l || '(no label)'}: ${n}`);
  }
  const top = [...byType.entries()].sort((a, b) => b[1] - a[1]).slice(0, 12);
  for (const [t, n] of top) line(`  ${t}: ${n}`);
  sized.sort((a, b) => b.bytes - a.bytes);
  line('largest events:');
  for (const s of sized.slice(0, 5)) line(`  ${s.type}${s.label ? ` [${s.label}]` : ''}: ${kb(s.bytes)}`);
  if (lastProviderError) {
    const d = lastProviderError.data ?? lastProviderError;
    const msg = String(d.message ?? '');
    const m = msg.match(/"max_chars":(\d+),"actual_chars":(\d+)/);
    line('last provider error:', 'type', lastProviderError.type ?? '?', '| label', redactLabel(d.label ?? '?'), '| provider', d.provider ?? '?', '| role', d.role ?? '?', '| kind', d.kind ?? d.errorKind ?? '?', '| message chars', msg.length);
    if (m) line('  input_too_large: max_chars', m[1], '| actual_chars', m[2]);
    line('  events leading up to it:');
    for (const p of parsed.slice(Math.max(0, lastProviderErrorIndex - 10), lastProviderErrorIndex)) {
      line(`    ${p.type}${p.label ? ` [${p.label}]` : ''}`);
    }
  }
}

// ---- stderr.log ----
section('stderr.log');
const stderrPath = join(runDir, 'stderr.log');
if (!existsSync(stderrPath)) {
  line('absent');
} else {
  const raw = readFileSync(stderrPath, 'utf8');
  const lines = raw.split('\n');
  line('size:', kb(raw.length), '| lines:', lines.length);
  const prefixes = new Map();
  let largest = 0;
  for (const l of lines) {
    largest = Math.max(largest, l.length);
    const m = l.match(/^\[([^\]]+)\]/);
    if (m) prefixes.set(redactLabel(m[1]), (prefixes.get(redactLabel(m[1])) ?? 0) + 1);
  }
  line('largest line:', kb(largest));
  for (const [p, n] of [...prefixes.entries()].sort((a, b) => b[1] - a[1]).slice(0, 12)) line(`  [${p}]: ${n}`);
}

// ---- estimate ----
section('Final-completion reviewer prompt estimate');
const guidanceBytes = fileSize(join(guidanceDir, 'reviewer.md')) ?? 0;
const contextBytes = fileSize(join(runDir, 'REVIEWER_CONTEXT.md')) ?? 0;
const diffTerm = aggregateDiffBytes == null ? null : Math.min(aggregateDiffBytes, 200_000);
const summaryBytes = len(state?.finalCompletionSummary);
const scopeBytes = 4_000 + (state?.completedScopes ?? []).reduce((n, s) => n + len(s.changedFiles) + len(s.summary) + len(s.residualReviewDebt), 0);
const verificationBytes = commandHistory.recordsBytes + commandHistory.summaryBytes;
const fixed = 9_000;
const terms = [
  ['fixed instructions', fixed],
  ['inlined aggregate diff (capped at 200000)', diffTerm ?? 0],
  ['command history in packet (upper bound)', verificationBytes],
  ['scope accounting in packet', scopeBytes],
  ['reviewer continuity markdown', contextBytes],
  ['coder completion summary', summaryBytes],
  ['reviewer guidance file', guidanceBytes],
];
for (const [label, bytes] of terms.sort((a, b) => b[1] - a[1])) line(`  ${bytes}\t${label}`);
line(`command history: ${commandHistory.distinct.size} distinct commands (neal embeds the verification subset, so the term above is an upper bound)`);
const total = terms.reduce((n, [, b]) => n + b, 0);
line('estimated total ~', total, diffTerm == null ? '(diff unknown — no repo checkout)' : '');
line('This estimates neal\'s prompt, not the reviewer\'s later reads. If actual_chars is well above the total, compare it against the largest terms above.');

console.log(out.join('\n').trimStart());
