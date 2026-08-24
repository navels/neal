import { spawnSync } from 'node:child_process';
import { cpSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative, resolve, sep } from 'node:path';
import process from 'node:process';
import { Writable } from 'node:stream';
import { fileURLToPath } from 'node:url';

import { DEFAULT_REVIEW_INSTRUCTION, type ParsedReviewArgs } from '../cli.js';
import { assertWriterProvidersConfigured } from '../config.js';
import { createRunId } from '../logger.js';
import { loadOrInitialize } from '../orchestrator.js';
import { validatePlanDocument } from '../plan-validation.js';
import { getReviewFindingsArtifactPaths } from '../review-findings/artifacts.js';
import { createAgentReviewFindingsProviderAdapter } from '../review-findings/provider.js';
import { runNealReviewCli } from '../review-findings/run.js';
import type {
  ReviewFindingItem,
  ReviewFindingsProviderAdapter,
  ReviewFindingsRunResult,
} from '../review-findings/types.js';
import { enableAgentSettingsIsolation } from '../providers/agent-settings-isolation.js';
import { isNealProviderError, type NealProviderErrorKind } from '../providers/types.js';
import { getRunDisplayStatus } from '../run-status.js';
import { getRunDir } from '../storage-paths.js';
import type { AgentConfig, AgentProvider, OrchestrationState } from '../types.js';
import { verifyConfiguredProviders } from './check.js';
import { executeRun } from './runtime.js';

// Native adapters drive their providers' own CLIs/SDKs directly; every other
// provider id is "openai-compatible" and should be qualified via `neal compat`.
export const NATIVE_PROVIDER_IDS: ReadonlySet<AgentProvider> = new Set<AgentProvider>([
  'openai-codex',
  'anthropic-claude',
]);

export function isOpenAICompatibleProvider(provider: AgentProvider): boolean {
  return !NATIVE_PROVIDER_IDS.has(provider);
}

// Default model per native reference provider. `neal compat` routes the
// non-candidate roles onto a native adapter; these are the known-good models
// each adapter drives (effort omitted → native provider default).
export const REFERENCE_DEFAULT_MODELS: Record<'openai-codex' | 'anthropic-claude', string> = {
  'openai-codex': 'gpt-5.5',
  'anthropic-claude': 'claude-opus-4-8',
};

// A compat reference is either a native provider id (run at its built-in default model)
// or `openai-compatible:<openrouter-slug>` to use a *validated* OpenRouter model as the
// known-good partner. The latter is the follow-up the routing plan anticipated once a
// rock-solid OpenRouter reference was identified: it removes the codex reference and so
// uncaps parallelism (no shared native-provider capacity pool). Use ONLY a model that
// reliably passes all roles — a flaky partner makes a candidate FAIL unattributable.
export function resolveReference(
  reference: string | null,
): { provider: AgentProvider; model: string | null } {
  const id = reference ?? 'openai-codex';
  const colon = id.indexOf(':');
  if (colon === -1) {
    return {
      provider: id as AgentProvider,
      model: REFERENCE_DEFAULT_MODELS[id as 'openai-codex' | 'anthropic-claude'] ?? null,
    };
  }
  return { provider: id.slice(0, colon) as AgentProvider, model: id.slice(colon + 1) };
}

export type CompatRole = 'coder' | 'reviewer' | 'planner';
export type CompatRoleSelection = CompatRole | 'all';

export type CompatFailureMode =
  | 'protocol'
  | 'provider_failed'
  | 'block_unresolved'
  | 'max_step_loop'
  | 'wrong_or_empty_output'
  | 'structured_output'
  | 'finalization_error';

export type CompatReferenceFix = {
  file: string;
  from: string;
  to: string;
};

export type CompatReviewerDiffs = {
  goodDiff: string;
  brokenDiff: string;
};

export type CompatFixture = {
  id: string;
  roles: CompatRole[];
  projectDir: string;
  planDoc?: string;
  issuePrompt?: string;
  verifyCommand?: string;
  referenceFix: CompatReferenceFix;
  reviewer?: CompatReviewerDiffs;
};

export type CompatManifest = {
  fixtures: CompatFixture[];
};

export type ParsedCompatArgs = {
  model: string | null;
  role: CompatRoleSelection;
  reference: string | null;
  json: boolean;
};

export type CompatCell = {
  role: CompatRole;
  fixtureId: string;
  diffKind: 'good' | 'broken' | null;
  blockingCount: number | null;
  pass: boolean;
  failureMode: CompatFailureMode | null;
  detail: string | null;
};

export type CompatRoleRollup = {
  role: CompatRole;
  pass: boolean;
  cellCount: number;
  passCount: number;
};

export type CompatReport = {
  schemaVersion: 2;
  model: string | null;
  reference: string | null;
  role: CompatRoleSelection;
  candidateProviders: { coder: AgentProvider; reviewer: AgentProvider; planner: AgentProvider };
  cells: CompatCell[];
  roles: CompatRoleRollup[];
  overallPass: boolean;
};

// ---------------------------------------------------------------------------
// Manifest loading
// ---------------------------------------------------------------------------

export function getCompatExamplesDir(): string {
  // src/neal/commands/compat.ts -> ../../../examples/compat (repo/package root).
  return fileURLToPath(new URL('../../../examples/compat/', import.meta.url));
}

function asStringArray(value: unknown, context: string): string[] {
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== 'string')) {
    throw new Error(`compat manifest: ${context} must be an array of strings`);
  }
  return value as string[];
}

function validateFixture(raw: unknown, index: number): CompatFixture {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error(`compat manifest: fixtures[${index}] must be an object`);
  }
  const value = raw as Record<string, unknown>;
  if (typeof value.id !== 'string' || value.id.trim() === '') {
    throw new Error(`compat manifest: fixtures[${index}].id must be a non-empty string`);
  }
  const roles = asStringArray(value.roles, `fixtures[${index}].roles`);
  for (const role of roles) {
    if (role !== 'coder' && role !== 'reviewer' && role !== 'planner') {
      throw new Error(`compat manifest: ${value.id} has unsupported role ${JSON.stringify(role)}`);
    }
  }
  if (typeof value.projectDir !== 'string' || value.projectDir.trim() === '') {
    throw new Error(`compat manifest: ${value.id} must define a projectDir`);
  }
  const referenceFix = value.referenceFix as Record<string, unknown> | undefined;
  if (
    !referenceFix ||
    typeof referenceFix.file !== 'string' ||
    typeof referenceFix.from !== 'string' ||
    typeof referenceFix.to !== 'string'
  ) {
    throw new Error(`compat manifest: ${value.id} must define a referenceFix { file, from, to }`);
  }

  const fixture: CompatFixture = {
    id: value.id,
    roles: roles as CompatRole[],
    projectDir: value.projectDir,
    referenceFix: { file: referenceFix.file, from: referenceFix.from, to: referenceFix.to },
  };

  if (value.planDoc !== undefined) {
    if (typeof value.planDoc !== 'string') {
      throw new Error(`compat manifest: ${value.id}.planDoc must be a string`);
    }
    fixture.planDoc = value.planDoc;
  }
  if (value.issuePrompt !== undefined) {
    if (typeof value.issuePrompt !== 'string') {
      throw new Error(`compat manifest: ${value.id}.issuePrompt must be a string`);
    }
    fixture.issuePrompt = value.issuePrompt;
  }
  if (value.verifyCommand !== undefined) {
    if (typeof value.verifyCommand !== 'string') {
      throw new Error(`compat manifest: ${value.id}.verifyCommand must be a string`);
    }
    fixture.verifyCommand = value.verifyCommand;
  }
  if (value.reviewer !== undefined) {
    const reviewer = value.reviewer as Record<string, unknown>;
    if (typeof reviewer.goodDiff !== 'string' || typeof reviewer.brokenDiff !== 'string') {
      throw new Error(`compat manifest: ${value.id}.reviewer must define goodDiff and brokenDiff`);
    }
    fixture.reviewer = { goodDiff: reviewer.goodDiff, brokenDiff: reviewer.brokenDiff };
  }

  // Contract checks mirrored from the bundled-fixture structural test
  // (test/compat-fixtures.test.ts).
  if (fixture.roles.includes('coder') && !fixture.planDoc) {
    throw new Error(`compat manifest: ${value.id} carries the coder role but defines no planDoc`);
  }
  if (fixture.roles.includes('planner') && !fixture.issuePrompt) {
    throw new Error(`compat manifest: ${value.id} carries the planner role but defines no issuePrompt`);
  }
  if (fixture.roles.includes('reviewer')) {
    if (!fixture.reviewer) {
      throw new Error(`compat manifest: ${value.id} carries the reviewer role but defines no diffs`);
    }
    if (!fixture.verifyCommand) {
      throw new Error(`compat manifest: ${value.id} carries the reviewer role but defines no verifyCommand`);
    }
  }
  if ((fixture.roles.includes('coder') || fixture.roles.includes('reviewer')) && !fixture.verifyCommand) {
    throw new Error(`compat manifest: ${value.id} must define a verifyCommand`);
  }

  return fixture;
}

export function loadCompatManifest(compatDir: string = getCompatExamplesDir()): CompatManifest {
  const manifestPath = join(compatDir, 'manifest.json');
  const parsed = JSON.parse(readFileSync(manifestPath, 'utf8')) as unknown;
  if (parsed === null || typeof parsed !== 'object' || !Array.isArray((parsed as { fixtures?: unknown }).fixtures)) {
    throw new Error('compat manifest: top-level object must define a fixtures array');
  }
  const rawFixtures = (parsed as { fixtures: unknown[] }).fixtures;
  if (rawFixtures.length === 0) {
    throw new Error('compat manifest: must define at least one fixture');
  }
  return { fixtures: rawFixtures.map((fixture, index) => validateFixture(fixture, index)) };
}

// ---------------------------------------------------------------------------
// Argument parsing
// ---------------------------------------------------------------------------

export function parseCompatArgs(args: string[]): ParsedCompatArgs {
  if (args[0] !== 'compat') {
    throw new Error(`Unknown argument: ${args[0] ?? ''}`);
  }

  let model: string | null = null;
  let role: CompatRoleSelection = 'all';
  let reference: string | null = null;
  let json = false;
  let index = 1;

  function requireValue(flag: string): string {
    const value = args[index + 1];
    if (value === undefined || value.startsWith('--') || value.trim() === '') {
      throw new Error(`neal compat ${flag} requires a non-empty value`);
    }
    return value.trim();
  }

  while (index < args.length) {
    const flag = args[index];
    switch (flag) {
      case '--model':
        model = requireValue('--model');
        index += 2;
        break;
      case '--reference': {
        const value = requireValue('--reference');
        const colon = value.indexOf(':');
        if (colon === -1) {
          if (!NATIVE_PROVIDER_IDS.has(value as AgentProvider)) {
            throw new Error(
              'neal compat --reference must be a native provider id (openai-codex or anthropic-claude) or openai-compatible:<openrouter-model>',
            );
          }
        } else if (value.slice(0, colon) !== 'openai-compatible' || value.slice(colon + 1).trim() === '') {
          throw new Error(
            'neal compat --reference provider:model form must be openai-compatible:<openrouter-model>',
          );
        }
        reference = value;
        index += 2;
        break;
      }
      case '--role': {
        const value = requireValue('--role');
        if (value !== 'coder' && value !== 'reviewer' && value !== 'planner' && value !== 'all') {
          throw new Error('neal compat --role must be one of: coder, reviewer, planner, all');
        }
        role = value;
        index += 2;
        break;
      }
      case '--json':
        json = true;
        index += 1;
        break;
      default:
        throw new Error(`Unknown argument: ${flag}`);
    }
  }

  return { model, role, reference, json };
}

// ---------------------------------------------------------------------------
// Candidate config derivation
// ---------------------------------------------------------------------------

export function deriveCandidateConfig(
  base: AgentConfig,
  options: { testedRole: CompatRole; model: string | null; reference: string | null },
): AgentConfig {
  const next: AgentConfig = {
    planner: { ...base.planner },
    coder: { ...base.coder },
    reviewer: { ...base.reviewer },
  };

  const routingActive = options.model !== null || options.reference !== null;
  const reference = resolveReference(options.reference);

  // Tested role: when a candidate slug is given, force the openai-compatible
  // provider and drop any configured effort so the slug drives a clean
  // OpenRouter call. Otherwise leave the configured provider/model untouched.
  if (options.model !== null) {
    next[options.testedRole] = { provider: 'openai-compatible', model: options.model };
  }

  // Non-tested roles: when either flag is given, route them onto the reference
  // (a native adapter at its default model, or openai-compatible:<slug> for a validated
  // OpenRouter partner). When neither flag is given, leave every role as configured
  // (pure pass-through).
  if (routingActive) {
    for (const role of ['planner', 'coder', 'reviewer'] as const) {
      if (role !== options.testedRole) {
        next[role] = { provider: reference.provider, model: reference.model };
      }
    }
  }

  return next;
}

export function rolesForSelection(role: CompatRoleSelection): CompatRole[] {
  if (role === 'all') {
    return ['coder', 'reviewer', 'planner'];
  }
  return [role];
}

// ---------------------------------------------------------------------------
// Throwaway worktree helpers
// ---------------------------------------------------------------------------

function gitInThrowaway(cwd: string, args: string[]): { status: number; stderr: string } {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8' });
  if (result.error) {
    throw result.error;
  }
  return { status: result.status ?? 1, stderr: result.stderr ?? '' };
}

function initThrowawayRepo(cwd: string): void {
  const steps: string[][] = [
    ['init', '-q'],
    ['config', 'user.name', 'Neal Compat'],
    ['config', 'user.email', 'compat@neal.local'],
    ['config', 'commit.gpgsign', 'false'],
    ['add', '-A'],
    ['commit', '-q', '-m', 'base'],
  ];
  for (const step of steps) {
    const { status, stderr } = gitInThrowaway(cwd, step);
    if (status !== 0) {
      throw new Error(`compat: throwaway git ${step[0]} failed: ${stderr.trim()}`);
    }
  }
}

function applyAndCommitDiff(cwd: string, diffPath: string, message: string): void {
  const apply = gitInThrowaway(cwd, ['apply', diffPath]);
  if (apply.status !== 0) {
    throw new Error(`compat: diff ${diffPath} did not apply cleanly: ${apply.stderr.trim()}`);
  }
  const add = gitInThrowaway(cwd, ['add', '-A']);
  if (add.status !== 0) {
    throw new Error(`compat: git add failed after applying ${diffPath}`);
  }
  const commit = gitInThrowaway(cwd, ['commit', '-q', '-m', message]);
  if (commit.status !== 0) {
    throw new Error(`compat: git commit failed after applying ${diffPath}`);
  }
}

function copyFixtureProject(compatDir: string, fixture: CompatFixture): string {
  const dir = mkdtempSync(join(tmpdir(), `neal-compat-${fixture.id}-`));
  cpSync(join(compatDir, fixture.projectDir), dir, {
    recursive: true,
    // Never hand committed neal run state to a candidate model: those artifacts
    // describe the pre-fix state and contradict an applied good diff.
    filter: (source) => !source.split(sep).includes('.neal'),
  });
  return dir;
}

function cleanProcessEnv(): NodeJS.ProcessEnv {
  // Strip NODE_TEST_* so a verifyCommand spawning `node --test` reports its own
  // real exit status instead of inheriting this process's test context.
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const key of Object.keys(env)) {
    if (key.startsWith('NODE_TEST')) {
      delete env[key];
    }
  }
  return env;
}

function runVerifyCommand(verifyCommand: string, cwd: string): number {
  const parts = verifyCommand.split(/\s+/u).filter(Boolean);
  const [command, ...commandArgs] = parts;
  if (!command) {
    throw new Error('compat: empty verifyCommand');
  }
  const result = spawnSync(command, commandArgs, { cwd, encoding: 'utf8', env: cleanProcessEnv() });
  if (result.error) {
    throw result.error;
  }
  return result.status ?? 1;
}

type RunEvent = { type: string; data?: Record<string, unknown> };

async function readRunEvents(runDir: string): Promise<RunEvent[]> {
  let content: string;
  try {
    content = await readFile(join(runDir, 'events.ndjson'), 'utf8');
  } catch {
    return [];
  }
  return content
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line) as RunEvent);
}

function hasEvent(events: RunEvent[], type: string): boolean {
  return events.some((event) => event.type === type);
}

// ---------------------------------------------------------------------------
// Writer-fixture execution (coder + planner share this path)
// ---------------------------------------------------------------------------

export type CompatWriterRunResult = {
  finalStatus: OrchestrationState['status'] | null;
  finalState: OrchestrationState | null;
  runDir: string;
  throwawayCwd: string;
  events: RunEvent[];
  threwDuringRun: boolean;
  errorMessage: string | null;
  verifyExitCode: number | null;
  finalDocument: string | null;
};

export type CompatWriterRunOptions = {
  compatDir: string;
  fixture: CompatFixture;
  candidateConfig: AgentConfig;
  mode: 'execute' | 'plan';
  // Relative path (under projectDir) of the plan/issue document fed to the run.
  documentRelativePath: string;
  // When set, run this command in the throwaway worktree after the run
  // completes (used by the coder PASS oracle).
  verifyCommand?: string;
  // When true, capture the final document content (used by the planner check).
  captureDocument?: boolean;
  onPrepared?: (info: { throwawayCwd: string; runDir: string; planDoc: string }) => void;
};

export async function runWriterFixture(options: CompatWriterRunOptions): Promise<CompatWriterRunResult> {
  const throwawayCwd = copyFixtureProject(options.compatDir, options.fixture);
  const runDir = getRunDir(throwawayCwd, createRunId());
  const planDoc = resolve(throwawayCwd, options.documentRelativePath);

  let finalStatus: OrchestrationState['status'] | null = null;
  let finalState: OrchestrationState | null = null;
  let threwDuringRun = false;
  let errorMessage: string | null = null;
  let verifyExitCode: number | null = null;
  let finalDocument: string | null = null;

  try {
    initThrowawayRepo(throwawayCwd);
    options.onPrepared?.({ throwawayCwd, runDir, planDoc });

    const loaded = await loadOrInitialize(planDoc, throwawayCwd, options.candidateConfig, undefined, options.mode, {
      runDir,
      allowedDirtyPaths: [planDoc],
    });

    // executeRun renders its final run summary to process.stdout (runtime.ts).
    // Capture and discard that here so it never leaks into the compat
    // command's own stdout (the PASS/FAIL table / `--json` matrix). Footer and
    // diagnostics already go to stderr, so only stdout needs redirecting.
    const realStdoutWrite = process.stdout.write.bind(process.stdout);
    process.stdout.write = (() => true) as typeof process.stdout.write;
    try {
      const result = await executeRun(loaded.state, loaded.statePath, loaded.logger);
      finalStatus = result.finalState.status;
      finalState = result.finalState;
    } catch (error) {
      threwDuringRun = true;
      errorMessage = error instanceof Error ? error.message : String(error);
    } finally {
      process.stdout.write = realStdoutWrite;
    }

    const events = await readRunEvents(runDir);

    if (options.verifyCommand && finalStatus === 'done') {
      verifyExitCode = runVerifyCommand(options.verifyCommand, throwawayCwd);
    }
    if (options.captureDocument) {
      try {
        finalDocument = await readFile(planDoc, 'utf8');
      } catch {
        finalDocument = null;
      }
    }

    return {
      finalStatus,
      finalState,
      runDir,
      throwawayCwd,
      events,
      threwDuringRun,
      errorMessage,
      verifyExitCode,
      finalDocument,
    };
  } finally {
    rmSync(throwawayCwd, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------
// Failure-mode classification for writer runs
// ---------------------------------------------------------------------------

// An operator stop, derived purely from the run's final persisted state. The
// signal mirrors the writer exit-code-2 mapping (writer-exit-codes.ts): the run
// is structurally waiting for the operator (the interactive-recovery wait, or a
// pending-guidance view) or persisted `status: 'blocked'` (the final-completion
// and top-level plan-review gates).
export function isOperatorStopFinalState(state: OrchestrationState): boolean {
  const displayStatus = getRunDisplayStatus(state);
  if (
    displayStatus.effectiveStatus === 'waiting_for_operator' ||
    displayStatus.pendingOperatorGuidance
  ) {
    return true;
  }
  return state.status === 'blocked';
}

export function classifyWriterFailure(args: {
  finalState: OrchestrationState | null;
  events: RunEvent[];
  threwDuringRun: boolean;
}): CompatFailureMode {
  const { events } = args;
  // Precedence follows the plan taxonomy (most specific first).
  const providerError = events.find((event) => event.type === 'provider.provider_error');
  if (providerError) {
    // A provider error names its own cause via `data.errorKind`. Structured-output
    // kinds are genuine schema failures (the model could not produce/honor
    // schema-enforced JSON) and route to the `structured_output` mode, matching
    // `classifyReviewerThrownFailure`. Every other kind (and an absent kind) stays
    // `provider_failed`.
    const errorKind = providerError.data?.errorKind;
    if (errorKind === 'structured_output_missing' || errorKind === 'structured_output_invalid') {
      return 'structured_output';
    }
    return 'provider_failed';
  }
  if (args.finalState !== null && isOperatorStopFinalState(args.finalState)) {
    return 'block_unresolved';
  }
  if (hasEvent(events, 'phase.error')) {
    return 'structured_output';
  }
  if (args.threwDuringRun || args.finalState === null) {
    return 'finalization_error';
  }
  // status 'failed' with no conclusive structural signal.
  return 'provider_failed';
}

function makeCell(
  role: CompatRole,
  fixtureId: string,
  pass: boolean,
  failureMode: CompatFailureMode | null,
  detail: string | null,
  diffKind: 'good' | 'broken' | null = null,
  blockingCount: number | null = null,
): CompatCell {
  return { role, fixtureId, diffKind, blockingCount, pass, failureMode, detail };
}

// ---------------------------------------------------------------------------
// Coder fixture evaluation
// ---------------------------------------------------------------------------

export async function evaluateCoderFixture(args: {
  compatDir: string;
  fixture: CompatFixture;
  candidateConfig: AgentConfig;
  onPrepared?: CompatWriterRunOptions['onPrepared'];
}): Promise<{ cell: CompatCell; run: CompatWriterRunResult }> {
  const { fixture } = args;
  if (!fixture.planDoc || !fixture.verifyCommand) {
    throw new Error(`compat: coder fixture ${fixture.id} is missing planDoc/verifyCommand`);
  }
  const documentRelativePath = relative(fixture.projectDir, fixture.planDoc);

  const run = await runWriterFixture({
    compatDir: args.compatDir,
    fixture,
    candidateConfig: args.candidateConfig,
    mode: 'execute',
    documentRelativePath,
    verifyCommand: fixture.verifyCommand,
    onPrepared: args.onPrepared,
  });

  if (run.finalStatus === 'done') {
    if (run.verifyExitCode === 0) {
      return { cell: makeCell('coder', fixture.id, true, null, null), run };
    }
    return {
      cell: makeCell(
        'coder',
        fixture.id,
        false,
        'wrong_or_empty_output',
        `run completed but verifyCommand exited ${run.verifyExitCode}`,
      ),
      run,
    };
  }

  const failureMode = classifyWriterFailure({
    finalState: run.finalState,
    events: run.events,
    threwDuringRun: run.threwDuringRun,
  });
  return { cell: makeCell('coder', fixture.id, false, failureMode, run.errorMessage), run };
}

// ---------------------------------------------------------------------------
// Planner fixture evaluation (secondary)
// ---------------------------------------------------------------------------

export async function evaluatePlannerFixture(args: {
  compatDir: string;
  fixture: CompatFixture;
  candidateConfig: AgentConfig;
  onPrepared?: CompatWriterRunOptions['onPrepared'];
}): Promise<{ cell: CompatCell; run: CompatWriterRunResult }> {
  const { fixture } = args;
  if (!fixture.issuePrompt) {
    throw new Error(`compat: planner fixture ${fixture.id} is missing issuePrompt`);
  }
  const documentRelativePath = relative(fixture.projectDir, fixture.issuePrompt);

  const run = await runWriterFixture({
    compatDir: args.compatDir,
    fixture,
    candidateConfig: args.candidateConfig,
    mode: 'plan',
    documentRelativePath,
    captureDocument: true,
    onPrepared: args.onPrepared,
  });

  if (run.finalStatus !== 'done') {
    const failureMode = classifyWriterFailure({
      finalState: run.finalState,
      events: run.events,
      threwDuringRun: run.threwDuringRun,
    });
    return { cell: makeCell('planner', fixture.id, false, failureMode, run.errorMessage), run };
  }

  const document = run.finalDocument;
  if (document === null) {
    return {
      cell: makeCell('planner', fixture.id, false, 'finalization_error', 'no plan document was emitted'),
      run,
    };
  }

  const validation = validatePlanDocument(document);
  if (validation.ok && validation.executionShape === 'one_shot') {
    return { cell: makeCell('planner', fixture.id, true, null, null), run };
  }

  const detail = validation.ok
    ? `emitted plan is ${validation.executionShape ?? 'unshaped'}, expected one_shot`
    : `emitted plan failed validation: ${validation.errors.join('; ')}`;
  return { cell: makeCell('planner', fixture.id, false, 'wrong_or_empty_output', detail), run };
}

// ---------------------------------------------------------------------------
// Reviewer fixture evaluation
// ---------------------------------------------------------------------------

export function collectBlockingFindings(result: ReviewFindingsRunResult): ReviewFindingItem[] {
  return result.draft.findings.filter((finding) => finding.severity === 'blocking');
}

export function countBlockingFindings(result: ReviewFindingsRunResult): number {
  return collectBlockingFindings(result).length;
}

function normalizeFindingText(text: string): string {
  const collapsed = text.replace(/\s+/gu, ' ').trim();
  return collapsed.length > 120 ? `${collapsed.slice(0, 120)}…` : collapsed;
}

export function summarizeBlockingFindings(findings: ReviewFindingItem[], limit = 2): string {
  return findings
    .slice(0, limit)
    .map(
      (finding) =>
        `${normalizeFindingText(finding.claim)} — ${normalizeFindingText(finding.requiredAction)}`,
    )
    .join('; ');
}

export function classifyNonAcceptedReviewOutcome(
  outcome: 'blocked' | 'failed' | 'cap_reached',
): CompatFailureMode {
  switch (outcome) {
    case 'blocked':
      return 'block_unresolved';
    case 'cap_reached':
      return 'max_step_loop';
    case 'failed':
      return 'structured_output';
  }
}

// Unwrap the underlying NealProviderError from a reviewer-loop throw. The
// reviewer fixture path surfaces provider failures in three shapes: a raw
// NealProviderError (the reviewDraft / structured-advisor path), or wrapped in
// a CoderRoundError (the draftFindings path via runCoderStructuredPrompt) or a
// ReviewerRoundError. Both wrappers expose the cause as a `providerError`
// field, so duck-typing that field covers every wrapper without importing the
// round-error classes.
function extractReviewProviderError(error: unknown): { kind: NealProviderErrorKind } | null {
  if (isNealProviderError(error)) {
    return error;
  }
  if (error !== null && typeof error === 'object' && 'providerError' in error) {
    const wrapped = (error as { providerError: unknown }).providerError;
    if (isNealProviderError(wrapped)) {
      return wrapped;
    }
  }
  return null;
}

// Classify a thrown error from the reviewer loop. A provider error names its own
// cause via `kind`: only the structured-output kinds are genuine schema
// failures; every other kind (timeout, api_error, permission, session,
// provider_failed, unknown) is a provider failure. Non-provider errors fall
// back to the persisted run outcome (`blocked`/`cap_reached`/`failed`), where
// `failed` denotes a schema/validation failure raised inside the review loop.
export function classifyReviewerThrownFailure(
  error: unknown,
  persistedOutcome: 'accepted' | 'blocked' | 'failed' | 'cap_reached' | null,
): CompatFailureMode {
  const providerError = extractReviewProviderError(error);
  if (providerError) {
    return providerError.kind === 'structured_output_missing' || providerError.kind === 'structured_output_invalid'
      ? 'structured_output'
      : 'provider_failed';
  }
  if (persistedOutcome && persistedOutcome !== 'accepted') {
    return classifyNonAcceptedReviewOutcome(persistedOutcome);
  }
  return 'provider_failed';
}

function buildReviewParsedArgs(): ParsedReviewArgs {
  return {
    instruction: DEFAULT_REVIEW_INSTRUCTION,
    instructionSource: 'default',
    selector: { kind: 'last', count: 1 },
  };
}

export type CreateReviewProvider = (args: {
  cwd: string;
  agentConfig: AgentConfig;
}) => ReviewFindingsProviderAdapter;

type ReviewerDiffOutcome =
  | { status: 'error'; cell: CompatCell }
  | { status: 'scored'; blockingCount: number; blockingSummary: string };

async function runReviewerDiff(args: {
  compatDir: string;
  fixture: CompatFixture;
  candidateConfig: AgentConfig;
  diffKind: 'good' | 'broken';
  createReviewProvider: CreateReviewProvider;
}): Promise<ReviewerDiffOutcome> {
  const { fixture, diffKind } = args;
  if (!fixture.reviewer || !fixture.verifyCommand) {
    throw new Error(`compat: reviewer fixture ${fixture.id} is missing diffs/verifyCommand`);
  }
  const diffRelative = diffKind === 'good' ? fixture.reviewer.goodDiff : fixture.reviewer.brokenDiff;
  const diffPath = join(args.compatDir, diffRelative);

  const throwawayCwd = copyFixtureProject(args.compatDir, fixture);
  const reviewId = createRunId();
  try {
    initThrowawayRepo(throwawayCwd);
    applyAndCommitDiff(throwawayCwd, diffPath, `apply ${diffKind} diff`);

    const provider = args.createReviewProvider({ cwd: throwawayCwd, agentConfig: args.candidateConfig });
    const sink = new Writable({ write(_chunk, _encoding, callback) { callback(); } });

    let result: ReviewFindingsRunResult;
    try {
      result = await runNealReviewCli({
        cwd: throwawayCwd,
        parsed: buildReviewParsedArgs(),
        stdout: sink,
        stderr: sink,
        provider,
        reviewId,
      });
    } catch (error) {
      // runNealReviewCli collapses every non-accepted run to a persisted
      // `failed` outcome, so a provider/API/timeout failure and a genuine
      // schema-validation failure both surface as `failed`. Classify the thrown
      // error structurally FIRST (a NealProviderError carries the real cause via
      // its `kind`) so provider failures stay `provider_failed` and only true
      // schema failures collapse to `structured_output`.
      const outcome = await readReviewOutcome(throwawayCwd, reviewId);
      const failureMode = classifyReviewerThrownFailure(error, outcome);
      return {
        status: 'error',
        cell: makeCell(
          'reviewer',
          fixture.id,
          false,
          failureMode,
          error instanceof Error ? error.message : String(error),
          diffKind,
          null,
        ),
      };
    }

    // No pass/fail judgement here: the verdict is a property of the pair.
    const blocking = collectBlockingFindings(result);
    return {
      status: 'scored',
      blockingCount: blocking.length,
      blockingSummary: summarizeBlockingFindings(blocking),
    };
  } finally {
    rmSync(throwawayCwd, { recursive: true, force: true });
  }
}

async function readReviewOutcome(
  cwd: string,
  reviewId: string,
): Promise<'accepted' | 'blocked' | 'failed' | 'cap_reached' | null> {
  const paths = getReviewFindingsArtifactPaths(cwd, reviewId);
  try {
    const meta = JSON.parse(await readFile(paths.meta, 'utf8')) as { outcome?: unknown };
    const outcome = meta.outcome;
    if (
      outcome === 'accepted' ||
      outcome === 'blocked' ||
      outcome === 'failed' ||
      outcome === 'cap_reached'
    ) {
      return outcome;
    }
    return null;
  } catch {
    return null;
  }
}

export async function evaluateReviewerFixture(args: {
  compatDir: string;
  fixture: CompatFixture;
  candidateConfig: AgentConfig;
  createReviewProvider: CreateReviewProvider;
}): Promise<{ good: CompatCell; broken: CompatCell }> {
  const good = await runReviewerDiff({ ...args, diffKind: 'good' });
  const broken = await runReviewerDiff({ ...args, diffKind: 'broken' });

  // Either diff erroring makes the pair unscoreable: no discrimination verdict
  // is computable, so attribute the systematic cause to both cells.
  if (good.status === 'error' && broken.status === 'error') {
    return { good: good.cell, broken: broken.cell };
  }
  if (good.status === 'error') {
    return {
      good: good.cell,
      broken:
        broken.status === 'scored'
          ? unscoreableCell(args.fixture.id, 'broken', broken.blockingCount, good.cell)
          : broken.cell,
    };
  }
  if (broken.status === 'error') {
    return {
      good: unscoreableCell(args.fixture.id, 'good', good.blockingCount, broken.cell),
      broken: broken.cell,
    };
  }

  // Discrimination criterion: severity calibration is not graded. A reviewer may
  // raise blocking findings on the good diff and still PASS, as long as the
  // broken diff draws strictly more.
  const pass = broken.blockingCount >= 1 && good.blockingCount < broken.blockingCount;
  if (pass) {
    return {
      good: makeCell('reviewer', args.fixture.id, true, null, null, 'good', good.blockingCount),
      broken: makeCell('reviewer', args.fixture.id, true, null, null, 'broken', broken.blockingCount),
    };
  }

  const base =
    broken.blockingCount === 0
      ? `reviewer raised no blocking finding on the broken diff (blocking good=${good.blockingCount}, broken=0)`
      : `reviewer did not discriminate: blocking good=${good.blockingCount} >= broken=${broken.blockingCount}`;
  const detailFor = (summary: string): string =>
    summary === '' ? base : `${base} | blocking: ${summary}`;
  return {
    good: makeCell(
      'reviewer',
      args.fixture.id,
      false,
      'wrong_or_empty_output',
      detailFor(good.blockingSummary),
      'good',
      good.blockingCount,
    ),
    broken: makeCell(
      'reviewer',
      args.fixture.id,
      false,
      'wrong_or_empty_output',
      detailFor(broken.blockingSummary),
      'broken',
      broken.blockingCount,
    ),
  };
}

// A scored diff whose partner errored: carry the partner's failure mode so
// smoke aggregation attributes the systematic cause rather than a bogus verdict.
function unscoreableCell(
  fixtureId: string,
  diffKind: 'good' | 'broken',
  blockingCount: number,
  partnerCell: CompatCell,
): CompatCell {
  const partnerDiffKind = diffKind === 'good' ? 'broken' : 'good';
  return makeCell(
    'reviewer',
    fixtureId,
    false,
    partnerCell.failureMode,
    `pair unscoreable: the ${partnerDiffKind} diff review failed (${partnerCell.failureMode ?? 'unknown'})`,
    diffKind,
    blockingCount,
  );
}

// ---------------------------------------------------------------------------
// Output formatting
// ---------------------------------------------------------------------------

export function buildRoleRollups(cells: CompatCell[], roles: CompatRole[]): CompatRoleRollup[] {
  return roles.map((role) => {
    const roleCells = cells.filter((cell) => cell.role === role);
    const passCount = roleCells.filter((cell) => cell.pass).length;
    return {
      role,
      cellCount: roleCells.length,
      passCount,
      pass: roleCells.length > 0 && passCount === roleCells.length,
    };
  });
}

export function formatCompatJson(report: CompatReport): string {
  return JSON.stringify(report, null, 2);
}

// Describe the native provider the non-candidate roles run on for the human
// table. `--reference` is a native provider id (not a model); when omitted but
// `--model` is set, routing is active and the reference defaults to
// `openai-codex`. With neither flag the non-candidate roles pass through to the
// configured providers.
export function describeReferenceProvider(report: CompatReport): string {
  if (report.reference !== null) {
    return report.reference;
  }
  if (report.model !== null) {
    return 'openai-codex (default)';
  }
  return '(configured / native pass-through)';
}

export function formatCompatTable(report: CompatReport): string {
  const lines: string[] = [];
  lines.push('neal compat - compatibility smoke test (PASS/FAIL, not a skill score)');
  lines.push('');
  lines.push(`Candidate model: ${report.model ?? '(configured model)'}`);
  lines.push(`Reference provider: ${describeReferenceProvider(report)}`);
  lines.push('');
  lines.push('Role      Fixture                Diff     Result  Failure mode');
  lines.push('--------  ---------------------  -------  ------  -----------------');
  for (const cell of report.cells) {
    const role = cell.role.padEnd(8);
    const fixture = cell.fixtureId.slice(0, 21).padEnd(21);
    const diff = (cell.diffKind ?? '-').padEnd(7);
    const result = (cell.pass ? 'PASS' : 'FAIL').padEnd(6);
    const mode = cell.pass ? '' : cell.failureMode ?? 'unknown';
    lines.push(`${role}  ${fixture}  ${diff}  ${result}  ${mode}`);
  }
  lines.push('');
  for (const rollup of report.roles) {
    lines.push(`${rollup.role}: ${rollup.pass ? 'PASS' : 'FAIL'} (${rollup.passCount}/${rollup.cellCount})`);
  }
  lines.push('');
  lines.push(`Overall: ${report.overallPass ? 'PASS' : 'FAIL'}`);
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Top-level orchestration
// ---------------------------------------------------------------------------

// Compat child runs must be structurally quiet: a child run that lands in an
// operator-stop state would otherwise invoke the operator's configured notify
// helper mid-matrix. `getNotifyBin` (config.ts) treats a defined-but-empty
// NEAL_NOTIFY_BIN as "notifications disabled", so setting the empty override at
// compat startup silences neal's own notifier for the whole process — the same
// process-env pattern as `enableAgentSettingsIsolation`, which only isolates
// the SDK adapters' settings, not neal's notifier.
export function suppressCompatRunNotifications(): void {
  process.env.NEAL_NOTIFY_BIN = '';
}

export type CompatDeps = {
  verifyProviders?: (args: { cwd: string; agentConfig: AgentConfig; stdout: Writable }) => Promise<void>;
  createReviewProvider?: CreateReviewProvider;
  compatDir?: string;
  manifest?: CompatManifest;
};

export type RunCompatArgs = {
  cwd: string;
  parsed: ParsedCompatArgs;
  deps?: CompatDeps;
};

export async function runCompat(args: RunCompatArgs): Promise<CompatReport> {
  const { cwd, parsed } = args;
  // compat is a hermetic capability probe that runs the whole role matrix
  // through the native SDKs. Isolate those adapters from the operator's
  // interactive config so the probe stays quiet (no per-turn notifier hooks)
  // and repeatable. Normal neal runs never call this, so they honor the config.
  enableAgentSettingsIsolation();
  suppressCompatRunNotifications();
  const deps = args.deps ?? {};
  const compatDir = deps.compatDir ?? getCompatExamplesDir();
  const manifest = deps.manifest ?? loadCompatManifest(compatDir);
  const verifyProviders = deps.verifyProviders ?? verifyConfiguredProviders;
  const createReviewProvider: CreateReviewProvider =
    deps.createReviewProvider ?? ((adapterArgs) => createAgentReviewFindingsProviderAdapter(adapterArgs));

  const baseConfig = assertWriterProvidersConfigured(cwd, { context: 'neal compat' });
  const targetedRoles = rolesForSelection(parsed.role);
  const cells: CompatCell[] = [];

  // Pre-filter: verify the candidate config for each tested role's provider can
  // emit the structured check payload. Per the plan, a candidate that fails the
  // pre-filter for ANY targeted role fails the whole candidate: every targeted
  // role records FAIL(protocol) and all fixtures are skipped. This keeps the
  // matrix complete (no role left without a cell/failure mode).
  const protocolErrors = new Map<CompatRole, string>();
  for (const role of targetedRoles) {
    const candidateConfig = deriveCandidateConfig(baseConfig, {
      testedRole: role,
      model: parsed.model,
      reference: parsed.reference,
    });
    const sink = new Writable({ write(_chunk, _encoding, callback) { callback(); } });
    try {
      // eslint-disable-next-line no-await-in-loop
      await verifyProviders({ cwd, agentConfig: candidateConfig, stdout: sink });
    } catch (error) {
      protocolErrors.set(role, error instanceof Error ? error.message : String(error));
    }
  }

  if (protocolErrors.size > 0) {
    for (const role of targetedRoles) {
      const detail =
        protocolErrors.get(role) ??
        'candidate skipped: provider pre-filter failed for another targeted role';
      cells.push(makeCell(role, `provider:${role}`, false, 'protocol', detail));
    }
  } else {
    for (const role of targetedRoles) {
      const candidateConfig = deriveCandidateConfig(baseConfig, {
        testedRole: role,
        model: parsed.model,
        reference: parsed.reference,
      });

      if (role === 'coder') {
        for (const fixture of manifest.fixtures.filter((f) => f.roles.includes('coder'))) {
          // eslint-disable-next-line no-await-in-loop
          const { cell } = await evaluateCoderFixture({ compatDir, fixture, candidateConfig });
          cells.push(cell);
        }
      } else if (role === 'planner') {
        for (const fixture of manifest.fixtures.filter((f) => f.roles.includes('planner'))) {
          // eslint-disable-next-line no-await-in-loop
          const { cell } = await evaluatePlannerFixture({ compatDir, fixture, candidateConfig });
          cells.push(cell);
        }
      } else {
        for (const fixture of manifest.fixtures.filter((f) => f.roles.includes('reviewer'))) {
          // eslint-disable-next-line no-await-in-loop
          const { good, broken } = await evaluateReviewerFixture({
            compatDir,
            fixture,
            candidateConfig,
            createReviewProvider,
          });
          cells.push(good, broken);
        }
      }
    }
  }

  const roles = buildRoleRollups(cells, targetedRoles);
  const overallPass = roles.length > 0 && roles.every((rollup) => rollup.pass);

  return {
    schemaVersion: 2,
    model: parsed.model,
    reference: parsed.reference,
    role: parsed.role,
    candidateProviders: {
      coder: parsed.model !== null ? 'openai-compatible' : baseConfig.coder.provider,
      reviewer: parsed.model !== null ? 'openai-compatible' : baseConfig.reviewer.provider,
      planner: parsed.model !== null ? 'openai-compatible' : baseConfig.planner.provider,
    },
    cells,
    roles,
    overallPass,
  };
}

export type RunCompatCliArgs = {
  cwd: string;
  parsed: ParsedCompatArgs;
  // Sink for the command's own report (table / `--json` matrix). Defaults to
  // process.stdout. Writer fixture runs never write here: runWriterFixture
  // redirects executeRun's stdout, so this channel carries only the report.
  stdout?: Writable;
  deps?: CompatDeps;
};

export async function runCompatCli(args: RunCompatCliArgs): Promise<CompatReport> {
  const stdout = args.stdout ?? process.stdout;
  const report = await runCompat({ cwd: args.cwd, parsed: args.parsed, deps: args.deps });
  stdout.write(`${args.parsed.json ? formatCompatJson(report) : formatCompatTable(report)}\n`);
  if (!report.overallPass) {
    process.exitCode = 1;
  }
  return report;
}

export async function runCompatCommand(args: string[]): Promise<void> {
  const parsed = parseCompatArgs(args);
  await runCompatCli({ cwd: process.cwd(), parsed });
}
