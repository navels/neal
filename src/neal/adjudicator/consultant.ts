import { resolve } from 'node:path';

import { runConsultantRound } from '../agents/rounds.js';
import {
  createInlineSection,
  readTextForInlineSection,
  type InlineReviewerContext,
} from '../context/inline-review-context.js';
import { getChangedFilesForRange, getHeadCommit } from '../git.js';
import type { RunLogger } from '../logger.js';
import { getExecutionPlanPath } from '../scopes.js';
import type {
  ConsultantVerdict,
  InteractiveBlockedRecoveryState,
  OrchestrationState,
  RecentBlockRecord,
  ReviewFinding,
  ReviewRound,
} from '../types.js';

export type ConsultantSourcePhase = InteractiveBlockedRecoveryState['sourcePhase'];

// The candidate identity computed for a block before it is matched against, or
// appended to, the anti-thrash window. It carries everything that defines a
// repeat EXCEPT the bookkeeping fields (`count`/`recordedAt`), which only the
// window writer assigns.
export type RecentBlockCandidate = Omit<RecentBlockRecord, 'count' | 'recordedAt'>;

// Maximum number of most-recent reviewer rounds inlined as snapshots for the
// consultant. The deadlock signal is dominated by the latest rounds, so a small
// window keeps the prompt bounded while still showing how the disagreement
// evolved.
const RECENT_ROUND_SNAPSHOT_LIMIT = 5;

// The source phases the generalized consultant triages: a reviewer `review_stuck`
// deadlock (`reviewer_scope`/`reviewer_plan`) and a coder-blocked signal
// (`coder_scope`/`coder_response`/`coder_optional_response`, which after the
// split-plan reroute also carries the invalid-payload block). Every other accepted
// recovery source phase is ineligible and keeps today's generic recovery behavior;
// the recovery chokepoint enforces this gate.
export const CONSULTANT_ELIGIBLE_SOURCE_PHASES = new Set<ConsultantSourcePhase>([
  'reviewer_scope',
  'reviewer_plan',
  'coder_scope',
  'coder_response',
  'coder_optional_response',
]);

export function isReviewerConsultantPhase(sourcePhase: ConsultantSourcePhase): boolean {
  return sourcePhase === 'reviewer_scope' || sourcePhase === 'reviewer_plan';
}

function isCoderConsultantPhase(sourcePhase: ConsultantSourcePhase): boolean {
  return (
    sourcePhase === 'coder_scope' ||
    sourcePhase === 'coder_response' ||
    sourcePhase === 'coder_optional_response'
  );
}

// --- Anti-thrash guard ------------------------------------------------------------
// These helpers are PURE and read-only. They never write or persist state; the
// recovery chokepoint is the sole writer of `state.recentBlocks`.

function normalizeBlockerKey(input: string, cwd: string) {
  const escapedCwd = cwd.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return input
    .replace(new RegExp(escapedCwd, 'gi'), '')
    .replace(/(?:[A-Za-z]:)?(?:\/[^/\s:]+){2,}\/((?:src|test|tests|benchmark|docs|tmp|packages|lib|app)\/[^\s:]+)/g, '$1')
    .replace(/[^\S\r\n]+/g, ' ')
    .replace(/[!?.,;:]{2,}/g, (match) => match[0] ?? '')
    .replace(/[!?.,;:]+(?=\s|$)/g, '')
    .trim()
    .toLowerCase();
}

// The "new evidence" escape needs a signal that deterministically CHANGES when
// the underlying situation changes, even when the blocker wording does not. The
// blocker text itself cannot be that signal (subtracting the blocker from itself
// is always empty), so the fingerprint is derived from the one persisted artifact
// that moves exactly when the coder actually did new work: the scope's commit
// trail. `state.createdCommits` is append-only for the lifetime of the anti-thrash
// window (every transition that resets it also resets `recentBlocks`, and a scope
// boundary changes the scope identity anyway), and the coder phases append the
// blocked round's commits BEFORE the recovery chokepoint runs, so the tail hash
// alone captures "the coder committed new work since the recorded block".
// Deliberately NOT evidence: recovery turns/history (they accrue mechanically on
// every triaged block, so every repeat would escape and the guard would never
// fire) and LLM free-text summaries/rationales (never byte-stable across rounds,
// which would defeat the guard the same way).
function commitTrailEvidenceFingerprint(state: OrchestrationState): string {
  return state.createdCommits.at(-1) ?? '';
}

// Build the anti-thrash candidate identity for a block from its `reason` + the
// current scope identity. Identically worded blockers can hide genuinely
// different underlying causes, so the candidate also carries the commit-trail
// evidence fingerprint: when the coder has committed new work since a prior
// identical block, `findRepeatedRecentBlock` treats the block as carrying new
// evidence and the consultant runs instead of short-circuiting.
export function buildRecentBlockCandidate(
  state: OrchestrationState,
  reason: string,
  sourcePhase: ConsultantSourcePhase,
): RecentBlockCandidate {
  const blocker = reason.trim();
  return {
    scopeNumber: state.currentScopeNumber,
    derivedScopeIndex: state.derivedScopeIndex,
    sourcePhase,
    normalizedKey: normalizeBlockerKey(blocker, state.cwd),
    evidenceFingerprint: commitTrailEvidenceFingerprint(state),
  };
}

// Return the most-recent window record that the candidate repeats, or `null` when
// there is no repeat. A match requires the SAME scope identity (`scopeNumber` +
// `derivedScopeIndex`), the same `sourcePhase`, and the same normalized blocker
// key. When that record exists but the candidate carries materially new evidence
// (a non-empty `evidenceFingerprint` that differs from the prior one — i.e. the
// coder has committed new work since the recorded block), it is NOT a repeat —
// the underlying situation has changed even though the blocker text has not — so
// `null` is returned and the consultant gets to look again.
export function findRepeatedRecentBlock(
  recentBlocks: RecentBlockRecord[],
  candidate: RecentBlockCandidate,
): RecentBlockRecord | null {
  for (const prior of [...recentBlocks].reverse()) {
    if (prior.scopeNumber !== candidate.scopeNumber) {
      continue;
    }
    if (prior.derivedScopeIndex !== candidate.derivedScopeIndex) {
      continue;
    }
    if (prior.sourcePhase !== candidate.sourcePhase) {
      continue;
    }
    if (prior.normalizedKey !== candidate.normalizedKey) {
      continue;
    }
    if (candidate.evidenceFingerprint && candidate.evidenceFingerprint !== prior.evidenceFingerprint) {
      return null;
    }
    return prior;
  }
  return null;
}

// Return a NEW window array that either appends the candidate as a fresh record
// (`count:1`) or, on an exact match (per `findRepeatedRecentBlock`), increments the
// matched record's `count` and refreshes its `recordedAt`. Pure: the input array
// is never mutated.
export function upsertRecentBlock(
  recentBlocks: RecentBlockRecord[],
  candidate: RecentBlockCandidate,
  now: string = new Date().toISOString(),
): RecentBlockRecord[] {
  const match = findRepeatedRecentBlock(recentBlocks, candidate);
  if (match) {
    return recentBlocks.map((record) =>
      record === match ? { ...record, count: record.count + 1, recordedAt: now } : record,
    );
  }
  return [...recentBlocks, { ...candidate, count: 1, recordedAt: now }];
}

// --- Inline context ---------------------------------------------------------------

function renderOpenBlockingFindings(findings: ReviewFinding[]): string {
  if (findings.length === 0) {
    return '(no open blocking findings recorded)';
  }

  return findings
    .map((finding) =>
      [
        `- canonicalId: ${finding.canonicalId}`,
        `  claim: ${finding.claim}`,
        `  requiredAction: ${finding.requiredAction}`,
        `  coderDisposition: ${finding.coderDisposition ?? '(none recorded)'}`,
      ].join('\n'),
    )
    .join('\n');
}

function renderRecentRoundSnapshots(rounds: ReviewRound[]): string {
  if (rounds.length === 0) {
    return '(no reviewer rounds recorded)';
  }

  return rounds
    .slice(-RECENT_ROUND_SNAPSHOT_LIMIT)
    .map((round) => {
      const openBlocking = round.openBlockingCanonicalIds ?? [];
      const openBlockingText = openBlocking.length > 0 ? openBlocking.join(', ') : '(none)';
      return `- round ${round.round}: openBlockingCanonicalIds: ${openBlockingText}`;
    })
    .join('\n');
}

async function buildReviewerInlineContext(state: OrchestrationState): Promise<InlineReviewerContext> {
  const planContent = await readTextForInlineSection(resolve(state.cwd, getExecutionPlanPath(state)));
  const openBlockingFindings = state.findings.filter(
    (finding) => finding.severity === 'blocking' && finding.status === 'open',
  );

  return {
    sections: [
      createInlineSection('Execution plan content', planContent || '(plan document content unavailable)'),
      createInlineSection('Open blocking findings', renderOpenBlockingFindings(openBlockingFindings)),
      createInlineSection('Recent reviewer-round snapshots', renderRecentRoundSnapshots(state.rounds)),
    ],
  };
}

async function readChangedFilesBestEffort(state: OrchestrationState): Promise<string> {
  const base = state.baseCommit;
  if (!base) {
    return '(no scope base commit recorded)';
  }
  try {
    const head = await getHeadCommit(state.cwd);
    const files = await getChangedFilesForRange(state.cwd, base, head);
    return files.length > 0 ? files.map((file) => `- ${file}`).join('\n') : '(no changed files in the current scope)';
  } catch {
    return '(changed-file context unavailable)';
  }
}

async function buildCoderInlineContext(state: OrchestrationState, reason: string): Promise<InlineReviewerContext> {
  const planContent = await readTextForInlineSection(resolve(state.cwd, getExecutionPlanPath(state)));
  const changedFiles = await readChangedFilesBestEffort(state);

  return {
    sections: [
      createInlineSection('Execution plan content', planContent || '(plan document content unavailable)'),
      createInlineSection('Coder blocker summary', reason.trim() || '(no blocker summary provided)'),
      createInlineSection('Changed files since scope base', changedFiles),
    ],
  };
}

// Always supplies a non-null InlineReviewerContext built entirely from in-memory
// OrchestrationState artifacts, so the consultant works for every reviewer
// provider including no-read providers. Throws for any source phase outside
// `CONSULTANT_ELIGIBLE_SOURCE_PHASES`, so an ineligible phase can never silently
// reach an LLM round.
async function buildConsultantInlineContext(
  state: OrchestrationState,
  reason: string,
  sourcePhase: ConsultantSourcePhase,
): Promise<InlineReviewerContext> {
  if (isReviewerConsultantPhase(sourcePhase)) {
    return buildReviewerInlineContext(state);
  }
  if (isCoderConsultantPhase(sourcePhase)) {
    return buildCoderInlineContext(state, reason);
  }
  throw new Error(`Consultant cannot build context for ineligible source phase: ${String(sourcePhase)}`);
}

// Thin, read-only consultant for every triaged block class. It first applies the
// pure anti-thrash guard against `state.recentBlocks`: if this block repeats a
// recent block for the same scope identity + sourcePhase + normalized key with no
// new evidence, it returns a non-recoverable verdict WITHOUT running an LLM round.
// Otherwise it assembles the InlineReviewerContext for the source phase and runs
// the reviewer round. The module performs NO writes and NO commits — it only
// returns a `ConsultantVerdict`; `state.recentBlocks` is written elsewhere
// (the recovery chokepoint), never here.
export async function runConsultant(
  state: OrchestrationState,
  reason: string,
  sourcePhase: ConsultantSourcePhase,
  logger?: RunLogger,
): Promise<ConsultantVerdict> {
  const candidate = buildRecentBlockCandidate(state, reason, sourcePhase);
  if (findRepeatedRecentBlock(state.recentBlocks, candidate)) {
    return {
      recoverable: false,
      triageCategory: 'impossible_task',
      resolutionDirective: '',
      rationale:
        'This blocker repeats a recent block for the same scope with no new evidence; the consultant short-circuited to avoid thrashing without re-running a reviewer round.',
    };
  }

  const inlineContext = await buildConsultantInlineContext(state, reason, sourcePhase);
  const { verdict } = await runConsultantRound({
    reviewer: state.agentConfig.reviewer,
    cwd: state.cwd,
    blockedReason: reason,
    inlineContext,
    logger,
  });

  return verdict;
}
