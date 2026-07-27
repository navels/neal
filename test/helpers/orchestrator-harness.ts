import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { chmod, mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { clearConfigCache } from '../../src/neal/config.js';
import { createRunLogger } from '../../src/neal/logger.js';
import { setProviderCapabilitiesOverrideForTesting } from '../../src/neal/providers/registry.js';
import { NealProviderError, type NealProviderErrorKind, type ProviderRole, type StructuredAdvisorAdapter, type StructuredAdvisorRoundArgs, type StructuredAdvisorRoundResult } from '../../src/neal/providers/types.js';
import { flushDerivedPlanNotifications } from '../../src/neal/orchestrator/notifications.js';
import { writeExecutionArtifacts } from '../../src/neal/orchestrator/artifacts.js';
import { nealCliInvocation } from './cli.js';
import { enterInteractiveBlockedRecovery } from '../../src/neal/orchestrator/phases/recovery.js';
import { UNATTENDED_AUTO_RESUME_GUIDANCE } from '../../src/neal/blocked-guidance.js';
import { persistBlockedScope } from '../../src/neal/orchestrator/phases/shared.js';
import { persistSplitPlanRecovery } from '../../src/neal/orchestrator/split-plan.js';
import { createInitialState, getDefaultAgentConfig, getRunStatePath, saveState } from '../../src/neal/state.js';
import type { ExecuteScopeProgressJustification, OrchestrationState, ReviewFinding } from '../../src/neal/types.js';

export const execFileAsync = promisify(execFile);

export async function writeRepoConfig(
  cwd: string,
  overrides?: { notifyBin?: string; finalCompletionContinueExecutionMax?: number; phaseHeartbeatMs?: number },
) {
  const extraConfig =
    typeof overrides?.finalCompletionContinueExecutionMax === 'number'
      ? `  final_completion_continue_execution_max: ${overrides.finalCompletionContinueExecutionMax}\n`
      : '';
  const heartbeatConfig =
    typeof overrides?.phaseHeartbeatMs === 'number' ? `  phase_heartbeat_ms: ${overrides.phaseHeartbeatMs}\n` : '';
  await writeFile(
    join(cwd, 'neal.yml'),
    `neal:\n  notify_bin: ${overrides?.notifyBin ?? '/usr/bin/true'}\n${heartbeatConfig}${extraConfig}`,
    'utf8',
  );
  clearConfigCache(cwd);
}

export async function createResumeFixture(overrides: Partial<OrchestrationState>) {
  const root = await mkdtemp(join(tmpdir(), 'neal-scope4-'));
  const cwd = join(root, 'repo');
  const stateDir = join(cwd, '.neal');
  const runDir = join(stateDir, 'runs', 'test-run');
  const planDoc = join(cwd, 'PLAN.md');
  await mkdir(runDir, { recursive: true });
  await writeRepoConfig(cwd);
  await writeFile(planDoc, '# Plan\n', 'utf8');
  await runGit(root, 'init', 'repo');
  await runGit(cwd, 'config', 'user.name', 'Neal Test');
  await runGit(cwd, 'config', 'user.email', 'neal@example.com');
  await runGit(cwd, 'config', 'commit.gpgsign', 'false');
  await runGit(cwd, 'add', 'PLAN.md', 'neal.yml');
  await runGit(cwd, 'commit', '-m', 'base commit');
  const baseCommit = await runGit(cwd, 'rev-parse', 'HEAD');

  const initialState = await createInitialState(
    {
      cwd,
      planDoc,
      stateDir,
      runDir,
      topLevelMode: 'execute',
      allowedDirtyPaths: [],
      agentConfig: getDefaultAgentConfig(),
      progressJsonPath: join(runDir, 'plan-progress.json'),
      progressMarkdownPath: join(runDir, 'PLAN_PROGRESS.md'),
      reviewMarkdownPath: join(runDir, 'REVIEW.md'),
      recoveryMarkdownPath: join(runDir, 'RECOVERY.md'),
      maxRounds: 3,
    },
    baseCommit,
  );

  const statePath = getRunStatePath(runDir);
  const mergedState: OrchestrationState = {
    ...initialState,
    ...overrides,
  };

  const state = await saveState(statePath, mergedState);

  return { cwd, statePath, state };
}

export function createPlanReviewGuidance(
  overrides: Partial<NonNullable<OrchestrationState['pendingPlanReviewGuidance']>> = {},
) {
  return {
    message: 'Use the narrower plan-review recovery path.',
    sourcePhase: 'reviewer_plan' as const,
    recordedAt: '2026-05-29T00:00:00.000Z',
    ...overrides,
  };
}

export function createOpenPlanReviewFinding(): ReviewFinding {
  return {
    id: 'R1-F1',
    canonicalId: 'C1',
    round: 1,
    source: 'reviewer',
    severity: 'blocking',
    files: ['/tmp/PLAN.md'],
    claim: 'The plan needs explicit recovery sequencing.',
    requiredAction: 'Revise the plan response to address recovery sequencing.',
    status: 'open',
    roundSummary: 'Recovery sequencing remains unclear.',
    coderDisposition: null,
    coderCommit: null,
  };
}

export type SplitPlanRecoverySourcePhase = Parameters<typeof persistSplitPlanRecovery>[2]['sourcePhase'];

export function createInvalidFixedMultiScopePlan() {
  return [
    '# Invalid Fixed Multi-Scope Plan',
    '',
    '## Execution Shape',
    '',
    'executionShape: multi_scope',
    '',
    '## Execution Queue',
    '',
    '### Scope 1: Replacement',
    '- Goal: Replace the current scope.',
    '- Verification: `pnpm typecheck`',
    '- Success Condition: Replacement is reviewable.',
    '',
    '## Completion Condition',
    '',
    'Stop when the replacement scope is done.',
    '',
  ].join('\n');
}

export function createValidFixedMultiScopePlan() {
  return [
    '# Corrected Fixed Multi-Scope Plan',
    '',
    '## Execution Shape',
    '',
    'executionShape: multi_scope',
    '',
    '## Execution Queue',
    '',
    '### Scope 1: Replacement',
    '- Goal: Replace the current scope.',
    '- Verification: `pnpm typecheck`',
    '- Success Condition: Replacement is reviewable.',
    '',
  ].join('\n');
}

export async function createPlanReviewGuidanceResponseFixture(overrides: Partial<OrchestrationState> = {}) {
  const guidance = createPlanReviewGuidance();
  const fixture = await createResumeFixture({
    topLevelMode: 'plan',
    phase: 'coder_plan_response',
    status: 'running',
    blockedFromPhase: null,
    plannerSessionHandle: 'planner-plan-response-session',
    plannerSessionProtocol: 'structured_json_v1',
    coderSessionHandle: null,
    coderSessionProtocol: null,
    pendingPlanReviewGuidance: guidance,
    interactiveBlockedRecovery: null,
    interactiveBlockedRecoveryHistory: [],
    findings: [createOpenPlanReviewFinding()],
    ...overrides,
  });

  return { ...fixture, guidance };
}

export async function writeRawResumeState(statePath: string, state: OrchestrationState) {
  await writeFile(statePath, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
}

export async function createNotifyCapture(root: string) {
  const notifyLogPath = join(root, 'notify.log');
  const notifyScriptPath = join(root, 'notify.sh');
  await writeFile(
    notifyScriptPath,
    `#!/bin/sh\nprintf '%s\n' "$1" >> "${notifyLogPath}"\n`,
    'utf8',
  );
  await chmod(notifyScriptPath, 0o755);
  return { notifyLogPath, notifyScriptPath };
}

export async function runGit(cwd: string, ...args: string[]) {
  const { stdout } = await execFileAsync('git', args, { cwd });
  return stdout.trim();
}

export async function createCoderScopeManualGateFixture() {
  const root = await mkdtemp(join(tmpdir(), 'neal-manual-gate-coder-'));
  const cwd = join(root, 'repo');
  const stateDir = join(cwd, '.neal');
  const runDir = join(stateDir, 'runs', 'manual-gate-run');
  const planDoc = join(cwd, 'PLAN.md');
  const progressMarkdownPath = join(runDir, 'PLAN_PROGRESS.md');
  const { notifyLogPath, notifyScriptPath } = await createNotifyCapture(root);

  await mkdir(runDir, { recursive: true });
  await writeRepoConfig(cwd, { notifyBin: notifyScriptPath });
  await writeFile(planDoc, '## Execution Shape\n\nexecutionShape: multi_scope\n', 'utf8');
  await writeFile(progressMarkdownPath, '## Current Scope\n- Number: 2\n', 'utf8');
  await writeFile(join(cwd, 'scope.txt'), 'base\n', 'utf8');

  await runGit(root, 'init', 'repo');
  await runGit(cwd, 'config', 'user.name', 'Neal Test');
  await runGit(cwd, 'config', 'user.email', 'neal@example.com');
  await runGit(cwd, 'config', 'commit.gpgsign', 'false');
  await runGit(cwd, 'add', 'PLAN.md', 'neal.yml', 'scope.txt');
  await runGit(cwd, 'commit', '-m', 'base commit');

  const baseCommit = await runGit(cwd, 'rev-parse', 'HEAD');
  const initialState = await createInitialState(
    {
      cwd,
      planDoc,
      stateDir,
      runDir,
      topLevelMode: 'execute',
      allowedDirtyPaths: [],
      agentConfig: {
        ...getDefaultAgentConfig(),
        coder: { provider: 'fake-manual-gate-coder', model: null },
      },
      progressJsonPath: join(runDir, 'plan-progress.json'),
      progressMarkdownPath,
      reviewMarkdownPath: join(runDir, 'REVIEW.md'),
      recoveryMarkdownPath: join(runDir, 'RECOVERY.md'),
      maxRounds: 3,
    },
    baseCommit,
  );
  const statePath = getRunStatePath(runDir);
  const state = await saveState(statePath, {
    ...initialState,
    currentScopeNumber: 2,
    phase: 'coder_scope',
    status: 'running',
    baseCommit,
    coderRetryCount: 2,
  });

  return { cwd, runDir, statePath, state, notifyLogPath };
}

export function getNealCliCommandArgs(args: string[]) {
  const repoRoot = process.cwd();
  return nealCliInvocation(join(repoRoot, 'src', 'neal', 'index.ts'), args);
}

export async function runNealCliResultInCwd(cwd: string, ...args: string[]) {
  const invocation = getNealCliCommandArgs(args);
  return execFileAsync(invocation.command, invocation.args, {
    cwd,
  });
}

export async function readRunEvents(runDir: string) {
  const eventsPath = join(runDir, 'events.ndjson');
  const content = await readFile(eventsPath, 'utf8');
  return content
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line) as { type: string; data?: Record<string, unknown> });
}

export function delay(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function openAICodexProviderError(args: {
  message: string;
  sessionHandle: string | null;
  role?: ProviderRole;
  kind?: NealProviderErrorKind;
  retryable?: boolean;
}) {
  return new NealProviderError({
    message: args.message,
    provider: 'openai-codex',
    role: args.role ?? 'coder',
    sessionHandle: args.sessionHandle,
    kind: args.kind ?? 'provider_failed',
    retryable: args.retryable ?? false,
  });
}

export async function createExecuteFinalizationFixture(
  overrides: Partial<OrchestrationState>,
  options: { createdCommitMessage?: string } = {},
) {
  const root = await mkdtemp(join(tmpdir(), 'neal-execute-finalization-'));
  const cwd = join(root, 'repo');
  const stateDir = join(cwd, '.neal');
  const runDir = join(stateDir, 'runs', 'test-run');
  const planDoc = join(cwd, 'PLAN.md');
  const trackedFile = join(cwd, 'scope.txt');
  const { notifyLogPath, notifyScriptPath } = await createNotifyCapture(root);

  await mkdir(runDir, { recursive: true });
  await writeRepoConfig(cwd, { notifyBin: notifyScriptPath });
  await writeFile(planDoc, '# Plan\n', 'utf8');
  await writeFile(trackedFile, 'base\n', 'utf8');

  await runGit(root, 'init', 'repo');
  await runGit(cwd, 'config', 'user.name', 'Neal Test');
  await runGit(cwd, 'config', 'user.email', 'neal@example.com');
  await runGit(cwd, 'config', 'commit.gpgsign', 'false');
  await runGit(cwd, 'add', 'PLAN.md', 'neal.yml', 'scope.txt');
  await runGit(cwd, 'commit', '-m', 'base commit');

  const baseCommit = await runGit(cwd, 'rev-parse', 'HEAD');
  const initialState = await createInitialState(
    {
      cwd,
      planDoc,
      stateDir,
      runDir,
      topLevelMode: 'execute',
      allowedDirtyPaths: [],
      agentConfig: getDefaultAgentConfig(),
      progressJsonPath: join(runDir, 'plan-progress.json'),
      progressMarkdownPath: join(runDir, 'PLAN_PROGRESS.md'),
      reviewMarkdownPath: join(runDir, 'REVIEW.md'),
      recoveryMarkdownPath: join(runDir, 'RECOVERY.md'),
      maxRounds: 3,
    },
    baseCommit,
  );

  await writeFile(trackedFile, 'base\nchange\n', 'utf8');
  await runGit(cwd, 'add', 'scope.txt');
  await runGit(cwd, 'commit', '-m', options.createdCommitMessage ?? 'derived scope work');
  const createdCommit = await runGit(cwd, 'rev-parse', 'HEAD');
  const createdCommitsOverride = overrides.createdCommits;

  const statePath = getRunStatePath(runDir);
  const state = await saveState(statePath, {
    ...initialState,
    currentScopeNumber: 5,
    phase: 'execute_finalization',
    status: 'running',
    baseCommit,
    splitPlanStartedNotified: true,
    derivedPlanAcceptedNotified: true,
    splitPlanBlockedNotified: false,
    ...overrides,
    createdCommits: createdCommitsOverride ?? [createdCommit],
  });

  return { cwd, statePath, state, baseCommit, createdCommit, notifyLogPath, notifyScriptPath };
}

export async function createEmptyExecuteFinalizationFixture(overrides: Partial<OrchestrationState>) {
  const root = await mkdtemp(join(tmpdir(), 'neal-execute-finalization-empty-'));
  const cwd = join(root, 'repo');
  const stateDir = join(cwd, '.neal');
  const runDir = join(stateDir, 'runs', 'test-run');
  const planDoc = join(cwd, 'PLAN.md');
  const trackedFile = join(cwd, 'scope.txt');
  const { notifyLogPath, notifyScriptPath } = await createNotifyCapture(root);

  await mkdir(runDir, { recursive: true });
  await writeRepoConfig(cwd, { notifyBin: notifyScriptPath });
  await writeFile(planDoc, '# Plan\n', 'utf8');
  await writeFile(trackedFile, 'base\n', 'utf8');

  await runGit(root, 'init', 'repo');
  await runGit(cwd, 'config', 'user.name', 'Neal Test');
  await runGit(cwd, 'config', 'user.email', 'neal@example.com');
  await runGit(cwd, 'config', 'commit.gpgsign', 'false');
  await runGit(cwd, 'add', 'PLAN.md', 'neal.yml', 'scope.txt');
  await runGit(cwd, 'commit', '-m', 'base commit');

  const baseCommit = await runGit(cwd, 'rev-parse', 'HEAD');
  const initialState = await createInitialState(
    {
      cwd,
      planDoc,
      stateDir,
      runDir,
      topLevelMode: 'execute',
      allowedDirtyPaths: [],
      agentConfig: getDefaultAgentConfig(),
      progressJsonPath: join(runDir, 'plan-progress.json'),
      progressMarkdownPath: join(runDir, 'PLAN_PROGRESS.md'),
      reviewMarkdownPath: join(runDir, 'REVIEW.md'),
      recoveryMarkdownPath: join(runDir, 'RECOVERY.md'),
      maxRounds: 3,
    },
    baseCommit,
  );

  await runGit(cwd, 'commit', '--allow-empty', '-m', 'empty derived scope checkpoint');
  const createdCommit = await runGit(cwd, 'rev-parse', 'HEAD');
  const createdCommitsOverride = overrides.createdCommits;

  const statePath = getRunStatePath(runDir);
  const state = await saveState(statePath, {
    ...initialState,
    currentScopeNumber: 5,
    phase: 'execute_finalization',
    status: 'running',
    baseCommit,
    splitPlanStartedNotified: true,
    derivedPlanAcceptedNotified: true,
    splitPlanBlockedNotified: false,
    ...overrides,
    createdCommits: createdCommitsOverride ?? [createdCommit],
  });

  return { cwd, statePath, state, baseCommit, createdCommit, notifyLogPath, notifyScriptPath };
}

export function createParentAdvanceCompletedScopes(parentScopeLabel = '5'): OrchestrationState['completedScopes'] {
  return [
    {
      number: `${parentScopeLabel}.1`,
      marker: 'AUTONOMY_SCOPE_DONE',
      result: 'accepted',
      baseCommit: 'base-derived-1',
      finalCommit: 'final-derived-1',
      summary: 'Implemented the parent behavior.',
      commitSubject: 'substantive derived work',
      changedFiles: ['src/parent.ts', 'src/shared.ts'],
      reviewRounds: 1,
      findings: 0,
      residualReviewDebt: [],
      archivedReviewPath: '/tmp/review-derived-1.md',
      blocker: null,
      derivedFromParentScope: parentScopeLabel,
      replacedByDerivedPlanPath: null,
    },
    {
      number: `${parentScopeLabel}.2`,
      marker: 'AUTONOMY_SCOPE_DONE',
      result: 'accepted',
      baseCommit: 'base-derived-2',
      finalCommit: 'final-derived-2',
      summary: 'Verified the already-complete parent behavior.',
      commitSubject: 'empty derived verification',
      changedFiles: [],
      reviewRounds: 1,
      findings: 0,
      residualReviewDebt: [],
      archivedReviewPath: '/tmp/review-derived-2.md',
      blocker: null,
      derivedFromParentScope: parentScopeLabel,
      replacedByDerivedPlanPath: null,
    },
  ];
}

export function createAlreadySatisfiedTopLevelProgress(): ExecuteScopeProgressJustification {
  return {
    milestoneTargeted: 'Scope 4 already-satisfied acceptance.',
    newEvidence: 'Focused verification passed and the current changed-file list is empty.',
    whyNotRedundant: 'Prior accepted scopes already implemented the requested behavior.',
    nextStepUnlocked: 'The next top-level scope can start after ordinary acceptance.',
  };
}

export function createAlreadySatisfiedTopLevelCompletedScopes(): OrchestrationState['completedScopes'] {
  return [
    {
      number: '1',
      marker: 'AUTONOMY_SCOPE_DONE',
      result: 'accepted',
      baseCommit: 'base-scope-1',
      finalCommit: 'final-scope-1',
      summary: 'Initial implementation accepted.',
      commitSubject: 'scope 1',
      changedFiles: ['src/first.ts'],
      reviewRounds: 1,
      findings: 0,
      residualReviewDebt: [],
      archivedReviewPath: '/tmp/review-scope-1.md',
      blocker: null,
      derivedFromParentScope: null,
      replacedByDerivedPlanPath: null,
    },
    {
      number: '2.3',
      marker: 'AUTONOMY_SCOPE_DONE',
      result: 'accepted',
      baseCommit: 'base-scope-2-3',
      finalCommit: 'final-scope-2-3',
      summary: 'Derived work that satisfied a later top-level scope.',
      commitSubject: 'derived scope 2.3',
      changedFiles: ['src/shared.ts'],
      reviewRounds: 1,
      findings: 0,
      residualReviewDebt: [],
      archivedReviewPath: '/tmp/review-scope-2-3.md',
      blocker: null,
      derivedFromParentScope: '2',
      replacedByDerivedPlanPath: null,
    },
  ];
}

export async function createDerivedPlanExecutionFixture(overrides: Partial<OrchestrationState> = {}) {
  const root = await mkdtemp(join(tmpdir(), 'neal-derived-plan-execution-'));
  const cwd = join(root, 'repo');
  const stateDir = join(cwd, '.neal');
  const runDir = join(stateDir, 'runs', 'test-run');
  const planDoc = join(cwd, 'PLAN.md');
  const trackedFile = join(cwd, 'scope.txt');

  await mkdir(runDir, { recursive: true });
  await writeRepoConfig(cwd);
  await writeFile(planDoc, '# Plan\n', 'utf8');
  await writeFile(trackedFile, 'base\n', 'utf8');

  await runGit(root, 'init', 'repo');
  await runGit(cwd, 'config', 'user.name', 'Neal Test');
  await runGit(cwd, 'config', 'user.email', 'neal@example.com');
  await runGit(cwd, 'config', 'commit.gpgsign', 'false');
  await runGit(cwd, 'add', 'PLAN.md', 'neal.yml', 'scope.txt');
  await runGit(cwd, 'commit', '-m', 'base commit');

  const baseCommit = await runGit(cwd, 'rev-parse', 'HEAD');
  const initialState = await createInitialState(
    {
      cwd,
      planDoc,
      stateDir,
      runDir,
      topLevelMode: 'execute',
      allowedDirtyPaths: [],
      agentConfig: getDefaultAgentConfig(),
      progressJsonPath: join(runDir, 'plan-progress.json'),
      progressMarkdownPath: join(runDir, 'PLAN_PROGRESS.md'),
      reviewMarkdownPath: join(runDir, 'REVIEW.md'),
      recoveryMarkdownPath: join(runDir, 'RECOVERY.md'),
      maxRounds: 3,
    },
    baseCommit,
  );

  const derivedPlanPath = join(runDir, 'DERIVED_PLAN_SCOPE_5.md');
  await writeFile(
    derivedPlanPath,
    [
      '## Execution Shape',
      '',
      'executionShape: multi_scope',
      '',
      '## Execution Queue',
      '',
      '### Scope 1: Adopt the derived execution boundary',
      '- Goal: Run the first derived sub-scope after the accepted plan is adopted.',
      '- Verification: `pnpm exec tsx --test test/orchestrator.test.ts`',
      '- Success Condition: The first derived sub-scope is ready to execute.',
    ].join('\n'),
    'utf8',
  );

  const statePath = getRunStatePath(runDir);
  const state = await saveState(statePath, {
    ...initialState,
    currentScopeNumber: 5,
    phase: 'awaiting_derived_plan_execution',
    status: 'running',
    coderSessionHandle: 'stale-coder-session',
    reviewerSessionHandle: 'reviewer-session-derived-pass',
    derivedPlanPath,
    derivedPlanStatus: 'accepted',
    derivedFromScopeNumber: 5,
    derivedScopeIndex: null,
    blockedFromPhase: 'reviewer_plan',
    rounds: [
      {
        round: 1,
        reviewerSessionHandle: 'reviewer-session-derived-pass',
        reviewedPlanPath: derivedPlanPath,
        normalizationApplied: false,
        normalizationOperations: [],
        normalizationScopeLabelMappings: [],
        commitRange: { base: baseCommit, head: baseCommit },
        openBlockingCanonicalCount: 0,
        findings: [],
      },
    ],
    findings: [
      {
        id: 'R1-F1',
        canonicalId: 'C1',
        round: 1,
        source: 'reviewer',
        severity: 'blocking',
        files: [derivedPlanPath],
        claim: 'Clarify the first derived execution step.',
        requiredAction: 'Accept the plan and begin execution at derived scope 1.',
        status: 'fixed',
        roundSummary: 'Derived plan is ready for execution.',
        coderDisposition: 'Accepted the execution shape and verification.',
        coderCommit: null,
      },
    ],
    createdCommits: [],
    ...overrides,
  });

  return { cwd, statePath, state, baseCommit, derivedPlanPath };
}

export async function readEventTypes(runDir: string): Promise<string[]> {
  return (await readFile(join(runDir, 'events.ndjson'), 'utf8'))
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((line) => (JSON.parse(line) as { type: string }).type);
}

export async function readEvents(runDir: string): Promise<Array<Record<string, unknown>>> {
  return (await readFile(join(runDir, 'events.ndjson'), 'utf8'))
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

// ----------------------------------------------------------------------------
// Scope 3: bounded unattended review_stuck consultant interception inside
// enterInteractiveBlockedRecovery. The consultant runs through the real read-only
// reviewer plumbing; we control its verdict by overriding the reviewer
// provider's structured-advisor adapter (mirroring test/consultant.test.ts).
// ----------------------------------------------------------------------------

export const CONSULTANT_REVIEWER_PROVIDER = 'openai-compatible';

export const REVIEW_STUCK_REASON = 'review_stuck: blocking findings did not decrease across 5 consecutive reviewer rounds';

export function recoverableConsultantVerdict() {
  return {
    recoverable: true,
    triageCategory: 'misunderstanding' as const,
    resolutionDirective: 'Apply the requiredAction in finding C1 within the existing scope; no new authorization needed.',
    targetCanonicalIds: ['C1'],
    rationale: 'The coder and reviewer disagree on an already-specified in-scope requirement.',
  };
}

export function nonRecoverableConsultantVerdict() {
  return {
    recoverable: false,
    triageCategory: 'authorization' as const,
    resolutionDirective: '',
    targetCanonicalIds: [],
    rationale: 'Resolving the deadlock requires credentials the coder does not have.',
  };
}

export function installConsultantAdvisorOverride(behavior: { payload?: unknown; throwError?: Error }) {
  let calls = 0;
  const adapter: StructuredAdvisorAdapter = {
    async runStructuredRound<TStructured>(
      _args: StructuredAdvisorRoundArgs<TStructured>,
    ): Promise<StructuredAdvisorRoundResult<TStructured>> {
      calls += 1;
      if (behavior.throwError) {
        throw behavior.throwError;
      }
      return { sessionHandle: null, structured: behavior.payload as TStructured };
    },
  };
  setProviderCapabilitiesOverrideForTesting(CONSULTANT_REVIEWER_PROVIDER, {
    createStructuredAdvisorAdapter: () => adapter,
  });
  return { callCount: () => calls };
}

export async function createConsultantRecoveryFixture(overrides: Partial<OrchestrationState>) {
  return createResumeFixture({
    currentScopeNumber: 2,
    phase: 'reviewer_scope',
    status: 'running',
    blockedFromPhase: 'reviewer_scope',
    unattended: true,
    unattendedAutoResumeCount: 0,
    consultantAttemptCount: 0,
    agentConfig: {
      ...getDefaultAgentConfig(),
      reviewer: { provider: CONSULTANT_REVIEWER_PROVIDER, model: null },
    },
    ...overrides,
  });
}

export async function writeConsultantKnobConfig(cwd: string, maxAttempts: number) {
  await writeFile(
    join(cwd, 'neal.yml'),
    `neal:\n  notify_bin: /usr/bin/true\n  consultant_max_attempts: ${maxAttempts}\n`,
    'utf8',
  );
  clearConfigCache(cwd);
}

export async function createUnattendedPendingRecoveryFixture(autoResumeCount: number) {
  return createResumeFixture({
    currentScopeNumber: 2,
    phase: 'interactive_blocked_recovery',
    status: 'running',
    blockedFromPhase: 'reviewer_scope',
    coderSessionHandle: 'coder-session-1',
    unattended: true,
    unattendedAutoResumeCount: autoResumeCount,
    interactiveBlockedRecovery: {
      enteredAt: '2026-04-16T00:00:00.000Z',
      sourcePhase: 'reviewer_scope',
      blockedReason: 'Reviewer needs an operator decision.',
      maxTurns: 3,
      lastHandledTurn: 0,
      pendingDirective: null,
      turns: [
        {
          number: 1,
          recordedAt: '2026-04-16T00:01:00.000Z',
          operatorGuidance: UNATTENDED_AUTO_RESUME_GUIDANCE,
          disposition: null,
        },
      ],
    },
  });
}

export async function assertTerminalInvalidSplitPlanBlock(args: {
  sourcePhase: SplitPlanRecoverySourcePhase;
  phase?: OrchestrationState['phase'];
}) {
  const { cwd, statePath, state, createdCommit, notifyLogPath } = await createExecuteFinalizationFixture({
    currentScopeNumber: 5,
    phase: args.phase ?? (args.sourcePhase as OrchestrationState['phase']),
    status: 'running',
    derivedPlanPath: null,
    derivedPlanStatus: null,
    derivedFromScopeNumber: null,
    derivedScopeIndex: null,
    splitPlanCountForCurrentScope: 0,
  });
  await mkdir(join(cwd, 'tmp'), { recursive: true });
  await writeFile(join(cwd, 'scope.txt'), 'base\nchange\nterminal draft\n', 'utf8');
  await writeFile(join(cwd, 'tmp', 'terminal-wip.txt'), 'terminal worktree draft\n', 'utf8');
  const logger = await createRunLogger({
    cwd,
    stateDir: join(cwd, '.neal'),
    planDoc: state.planDoc,
    topLevelMode: state.topLevelMode,
    runDir: state.runDir,
  });

  const nextState = await persistSplitPlanRecovery(
    state,
    statePath,
    {
      sourcePhase: args.sourcePhase,
      derivedPlanMarkdown: createInvalidFixedMultiScopePlan(),
      createdCommits: [createdCommit],
      logger,
    },
    {
      persistBlockedScope,
      writeExecutionArtifacts,
    },
  );

  assert.equal(await runGit(cwd, 'rev-parse', 'HEAD'), createdCommit);
  const visibleStatus = await runGit(cwd, 'status', '--short', '--', 'scope.txt', 'tmp');
  assert.match(visibleStatus, /M scope\.txt/);
  assert.match(visibleStatus, /\?\? tmp\//);
  await assert.rejects(readFile(join(state.runDir, 'DERIVED_PLAN_SCOPE_5.md'), 'utf8'), /ENOENT/);
  await assert.rejects(readFile(join(state.runDir, 'SCOPE_5_DISCARDED.diff'), 'utf8'), /ENOENT/);
  const invalidPayloadArtifact = await readFile(join(state.runDir, 'SCOPE_5_INVALID_DERIVED_PLAN.md'), 'utf8');
  assert.match(invalidPayloadArtifact, /This artifact is diagnostic only/);
  assert.match(invalidPayloadArtifact, /must not include a `## Completion Condition` section/);

  assert.equal(nextState.phase, 'blocked');
  assert.equal(nextState.status, 'blocked');
  assert.equal(nextState.blockedFromPhase, args.sourcePhase);
  assert.equal(nextState.lastScopeMarker, 'AUTONOMY_SPLIT_PLAN');
  assert.equal(nextState.splitPlanBlockedNotified, true);
  assert.deepEqual(nextState.createdCommits, [createdCommit]);
  const blockedScope = nextState.completedScopes.at(-1);
  assert.equal(blockedScope?.result, 'blocked');
  assert.match(blockedScope?.blocker ?? '', /must not include a `## Completion Condition` section/);

  const events = await readRunEvents(state.runDir);
  const invalidEvents = events.filter((event) => event.type === 'split_plan.invalid_payload');
  assert.equal(invalidEvents.length, 1);
  assert.equal(invalidEvents[0]?.data?.scopeNumber, 5);
  assert.equal(invalidEvents[0]?.data?.sourcePhase, args.sourcePhase);
  assert.deepEqual(invalidEvents[0]?.data?.validationErrors, [
    '`executionShape: multi_scope` must not include a `## Completion Condition` section.',
  ]);
  assert.equal(invalidEvents[0]?.data?.invalidPayloadPath, join(state.runDir, 'SCOPE_5_INVALID_DERIVED_PLAN.md'));
  assert.equal(invalidEvents[0]?.data?.resetSkipped, true);
  assert.deepEqual(invalidEvents[0]?.data?.createdCommits, [createdCommit]);
  assert.equal(events.some((event) => event.type === 'split_plan.invalid_payload_recovery_started'), false);

  const notifyLogBefore = await readFile(notifyLogPath, 'utf8');
  const notifyLines = notifyLogBefore.trim().split('\n').filter(Boolean);
  assert.equal(notifyLines.length, 1);
  assert.match(notifyLines[0] ?? '', /split-plan recovery rejected for scope 5/);
  const flushedAgain = await flushDerivedPlanNotifications(nextState, statePath, logger, 'should not notify twice');
  assert.equal(flushedAgain.splitPlanBlockedNotified, true);
  assert.equal(await readFile(notifyLogPath, 'utf8'), notifyLogBefore);

  return nextState;
}

export async function assertSplitPlanGuardrailBlock(args: {
  sourcePhase: SplitPlanRecoverySourcePhase;
  stateOverrides: Partial<OrchestrationState>;
  reasonPattern: RegExp;
}) {
  const { cwd, statePath, state, createdCommit, notifyLogPath } = await createExecuteFinalizationFixture({
    currentScopeNumber: 5,
    phase: args.sourcePhase as OrchestrationState['phase'],
    status: 'running',
    derivedPlanPath: null,
    derivedPlanStatus: null,
    derivedFromScopeNumber: null,
    derivedScopeIndex: null,
    ...args.stateOverrides,
  });
  await writeFile(join(cwd, 'scope.txt'), 'base\nchange\nguardrail draft\n', 'utf8');
  const logger = await createRunLogger({
    cwd,
    stateDir: join(cwd, '.neal'),
    planDoc: state.planDoc,
    topLevelMode: state.topLevelMode,
    runDir: state.runDir,
  });

  const nextState = await persistSplitPlanRecovery(
    state,
    statePath,
    {
      sourcePhase: args.sourcePhase,
      derivedPlanMarkdown: createInvalidFixedMultiScopePlan(),
      createdCommits: [createdCommit],
      logger,
    },
    {
      persistBlockedScope,
      writeExecutionArtifacts,
    },
  );

  assert.equal(await runGit(cwd, 'rev-parse', 'HEAD'), createdCommit);
  assert.match(await runGit(cwd, 'status', '--short', '--', 'scope.txt'), /M scope\.txt/);
  await assert.rejects(readFile(join(state.runDir, 'DERIVED_PLAN_SCOPE_5.md'), 'utf8'), /ENOENT/);
  await assert.rejects(readFile(join(state.runDir, 'SCOPE_5_INVALID_DERIVED_PLAN.md'), 'utf8'), /ENOENT/);
  await assert.rejects(readFile(join(state.runDir, 'SCOPE_5_DISCARDED.diff'), 'utf8'), /ENOENT/);
  assert.equal(nextState.phase, 'blocked');
  assert.equal(nextState.status, 'blocked');
  assert.equal(nextState.blockedFromPhase, args.sourcePhase);
  assert.equal(nextState.lastScopeMarker, 'AUTONOMY_SPLIT_PLAN');
  assert.equal(nextState.splitPlanBlockedNotified, true);
  assert.deepEqual(nextState.createdCommits, [createdCommit]);
  assert.match(nextState.completedScopes.at(-1)?.blocker ?? '', args.reasonPattern);

  const events = await readRunEvents(state.runDir);
  assert.equal(events.some((event) => event.type === 'split_plan.invalid_payload'), false);
  const notifyLogBefore = await readFile(notifyLogPath, 'utf8');
  assert.equal(notifyLogBefore.trim().split('\n').filter(Boolean).length, 1);
  await flushDerivedPlanNotifications(nextState, statePath, logger, 'should not notify twice');
  assert.equal(await readFile(notifyLogPath, 'utf8'), notifyLogBefore);

  return nextState;
}

export function createCanonicalStucknessRound(
  round: number,
  openBlockingCanonicalIds: string[] | null,
  openBlockingCanonicalCount = openBlockingCanonicalIds?.length ?? 0,
): OrchestrationState['rounds'][number] {
  return {
    round,
    reviewerSessionHandle: null,
    reviewedPlanPath: null,
    normalizationApplied: false,
    normalizationOperations: [],
    normalizationScopeLabelMappings: [],
    commitRange: {
      base: 'base',
      head: `head-${round}`,
    },
    openBlockingCanonicalCount,
    ...(openBlockingCanonicalIds === null ? {} : { openBlockingCanonicalIds }),
    findings: [],
  };
}

export async function createStucknessCwd(reviewStuckWindow: number) {
  const cwd = await mkdtemp(join(tmpdir(), 'neal-canonical-stuckness-'));
  await writeFile(join(cwd, 'neal.yml'), `neal:\n  review_stuck_window: ${reviewStuckWindow}\n`, 'utf8');
  clearConfigCache(cwd);
  return cwd;
}
