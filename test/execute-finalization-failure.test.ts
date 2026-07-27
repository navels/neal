import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { chmod, mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

import { CoderRoundError } from '../src/neal/agents.js';
import { clearConfigCache } from '../src/neal/config.js';
import { getFinalCompletionReviewArtifactPath } from '../src/neal/final-completion-review.js';
import { RunLogger } from '../src/neal/logger.js';
import { writeExecutionArtifacts } from '../src/neal/orchestrator/artifacts.js';
import { runExecuteFinalizationPhase } from '../src/neal/orchestrator/completion.js';
import {
  clearProviderCapabilitiesOverridesForTesting,
  setProviderCapabilitiesOverrideForTesting,
} from '../src/neal/providers/registry.js';
import { NealProviderError, type StructuredAdvisorRoundArgs } from '../src/neal/providers/types.js';
import { createInitialState, getRunStatePath, saveState } from '../src/neal/state.js';
import type { OrchestrationState } from '../src/neal/types.js';
import { hermeticAgentConfig } from './helpers/hermetic-agent-config.js';

// Characterization baseline for the two summary-adjudication failure branches
// of runExecuteFinalizationPhase (P5 plan, Scope 8), pinned before Scope 9
// extracts shared execute-finalization helpers. This file is immutable through
// that refactor: if the extracted helpers cannot reproduce a behavior pinned
// here, the refactor is wrong, not this file.
//
// The two branches, in orchestrator/completion.ts:
//   Scenario A — the coder final-completion summary round throws a provider
//     error, translated to CoderRoundError by runCoderFinalCompletionSummaryRound.
//     The branch persists the error's session handle (with derived protocol),
//     writes the failed final-completion review artifact (source
//     'coder_summary'), writes the failed checkpoint retrospective, emits a
//     session-bearing phase.error, and notifies blocked when
//     shouldNotifyFailure(error) holds.
//   Scenario B — the round throws an ordinary non-provider error (a
//     payload-parse failure rethrown unchanged by translateCoderProviderError).
//     The generic branch persists the failed state with the coder session
//     fields left exactly as seeded, writes the retrospective and phase.error,
//     and writes NO failed final-completion review artifact and NO notification.
//
// Both scenarios share a pre-state that seeds coderSessionHandle /
// coderSessionProtocol with distinguishable non-default values (the protocol
// deliberately differs from the branch's 'structured_json_v1' fallback so the
// derivation is pinned) and satisfies the notification conditions (notify_bin
// capture script; Scenario A's provider error has kind 'timeout', for which
// shouldNotifyFailure returns true).

// This file pins notify behavior through its own fixture script; the
// suite-wide NEAL_NOTIFY_BIN= kill switch (pnpm test script) must not shadow
// it. Fixture repo configs pin notify_bin, so this stays hermetic.
delete process.env.NEAL_NOTIFY_BIN;

// This file drives config-reading orchestrator paths; user config resolves
// through homedir()/.neal/config.yml, so pin a private tmp HOME (unique across
// the flat test suite — parallel node:test child processes share tmpdir()).
process.env.HOME = join(tmpdir(), 'neal-test-home-execute-finalization-failure');

const execFileAsync = promisify(execFile);

async function runGit(cwd: string, ...args: string[]) {
  const { stdout } = await execFileAsync('git', args, { cwd });
  return stdout.trim();
}

const SEEDED_CODER_SESSION_HANDLE = 'seeded-coder-session-handle';
// Deliberately NOT 'structured_json_v1' (the CoderRoundError branch's ??
// fallback), so the persisted protocol distinguishes "derived from the seeded
// state" from "fell back to the default".
const SEEDED_CODER_SESSION_PROTOCOL = 'legacy_marker_v1' as const;
const ERROR_SESSION_HANDLE = 'coder-final-completion-error-session';
const FIXTURE_COMMIT_SUBJECT = 'finalize failure scope work';

// Shared pre-state for both scenarios: a real repository at the
// execute_finalization phase with one created commit, lastScopeMarker
// AUTONOMY_DONE (so finalization enters the final-completion summary
// adjudication), seeded coder session fields, and a notify_bin capture script.
async function createExecuteFinalizationFailureFixture(prefix: string) {
  const root = await mkdtemp(join(tmpdir(), prefix));
  const cwd = join(root, 'repo');
  const stateDir = join(cwd, '.neal');
  const runDir = join(stateDir, 'runs', 'test-run');
  const planDoc = join(cwd, 'PLAN.md');
  const trackedFile = join(cwd, 'scope.txt');
  const notifyLogPath = join(root, 'notify.log');
  const notifyScriptPath = join(root, 'notify.sh');

  await mkdir(runDir, { recursive: true });
  await writeFile(
    notifyScriptPath,
    `#!/bin/sh\nprintf '%s\n' "$1" >> "${notifyLogPath}"\n`,
    'utf8',
  );
  await chmod(notifyScriptPath, 0o755);
  await writeFile(join(cwd, 'neal.yml'), `neal:\n  notify_bin: ${notifyScriptPath}\n`, 'utf8');
  clearConfigCache(cwd);
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
      // Hermetic provider selection with the coder pinned to anthropic-claude:
      // the summary round is a coder-provider structured-advisor round, and
      // readFinalCompletionUnstructuredOutput matches only
      // provider 'anthropic-claude' assistant text.
      agentConfig: {
        ...hermeticAgentConfig(),
        coder: { provider: 'anthropic-claude', model: null, effort: null },
      },
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
  await runGit(cwd, 'commit', '-m', FIXTURE_COMMIT_SUBJECT);
  const createdCommit = await runGit(cwd, 'rev-parse', 'HEAD');

  const statePath = getRunStatePath(runDir);
  const state = await saveState(statePath, {
    ...initialState,
    currentScopeNumber: 5,
    phase: 'execute_finalization',
    status: 'running',
    baseCommit,
    lastScopeMarker: 'AUTONOMY_DONE',
    coderSessionHandle: SEEDED_CODER_SESSION_HANDLE,
    coderSessionProtocol: SEEDED_CODER_SESSION_PROTOCOL,
    createdCommits: [createdCommit],
  });

  return { root, cwd, runDir, statePath, state, baseCommit, createdCommit, notifyLogPath };
}

// One recorded milestone with a snapshot of every observable side-effect
// surface at the moment the milestone fired. Deep-comparing the whole array
// pins the ACTUAL ordering of state save, artifact writes, retrospective,
// phase.error, and notification as the fakes observed it.
type OrderedCall = {
  call: string;
  // status field of the persisted run state at this moment.
  persistedStatus: string;
  // Number of archived REVIEW-<commit>.md files in the run dir.
  archivedReviewCount: number;
  // FINAL_COMPLETION_REVIEW.md (the failed final-completion review artifact).
  completionArtifactExists: boolean;
  // RETROSPECTIVE-failed-scope-5.md (the failed checkpoint retrospective).
  failedRetrospectiveExists: boolean;
  // RETROSPECTIVE.md (the current-retrospective copy of the same write).
  currentRetrospectiveExists: boolean;
  // Content of the notify capture log ('' while the script has not run).
  notifyLog: string;
};

function createOrderRecorder(fixture: { statePath: string; runDir: string; notifyLogPath: string }) {
  const calls: OrderedCall[] = [];
  const record = (call: string) => {
    calls.push({
      call,
      persistedStatus: (JSON.parse(readFileSync(fixture.statePath, 'utf8')) as { status: string }).status,
      archivedReviewCount: readdirSync(fixture.runDir).filter((name) => /^REVIEW-.+\.md$/.test(name)).length,
      completionArtifactExists: existsSync(getFinalCompletionReviewArtifactPath(fixture.runDir)),
      failedRetrospectiveExists: existsSync(join(fixture.runDir, 'RETROSPECTIVE-failed-scope-5.md')),
      currentRetrospectiveExists: existsSync(join(fixture.runDir, 'RETROSPECTIVE.md')),
      notifyLog: existsSync(fixture.notifyLogPath) ? readFileSync(fixture.notifyLogPath, 'utf8') : '',
    });
  };
  return { calls, record };
}

// Real RunLogger (failure paths read events.ndjson back: the failed artifact
// collects provider.assistant_text events and the retrospective summarizes the
// event log) that additionally records every event call in the shared order
// log before appending it.
class OrderRecordingRunLogger extends RunLogger {
  private readonly record: (call: string) => void;

  constructor(runDir: string, record: (call: string) => void) {
    super(runDir);
    this.record = record;
  }

  override async event(type: string, data?: Record<string, unknown>) {
    this.record(`event:${type}`);
    await super.event(type, data);
  }
}

// Real execution-artifact writer wrapped only to record its position in the
// order log.
function createRecordingRuntime(record: (call: string) => void) {
  return {
    writeExecutionArtifacts: async (state: OrchestrationState) => {
      record('writeExecutionArtifacts');
      await writeExecutionArtifacts(state);
    },
  };
}

// The order recorder above snapshots only at logger-event and
// writeExecutionArtifacts milestones, and BOTH the failed final-completion
// artifact and the checkpoint retrospective land between the same two
// milestones (writeExecutionArtifacts and phase.error), so the milestones
// alone cannot order those two writes against each other. The observation
// point that can: writeCheckpointRetrospective renders BEFORE it writes, and
// its changed-files summary runs `git diff --name-only <base>..<final>`
// (getChangedFilesForRange — the only production call shape with `diff
// --name-only` as the first two argv words; `diff --cached --name-only` does
// not match), which the sequentially-awaited failure branch reaches only
// after the failed-artifact write has resolved. This PATH-interposed git
// records, for every `diff --name-only` invocation, a snapshot of the failed
// artifact and retrospective files at that exact moment, then execs the real
// git — a deterministic observation point with zero production edits. The
// LAST such invocation is the retrospective render's own.
async function createGitDiffNameOnlyObserver(fixture: { root: string; runDir: string }) {
  const binDir = join(fixture.root, 'git-interposer-bin');
  const logPath = join(fixture.root, 'git-diff-name-only.log');
  await mkdir(binDir, { recursive: true });
  // Resolve the real git before the interposer joins PATH.
  const { stdout } = await execFileAsync('/bin/sh', ['-c', 'command -v git']);
  const realGit = stdout.trim();
  const gitPath = join(binDir, 'git');
  await writeFile(
    gitPath,
    [
      '#!/bin/sh',
      'if [ "$1" = "diff" ] && [ "$2" = "--name-only" ]; then',
      '  artifact=absent',
      `  [ -e "${getFinalCompletionReviewArtifactPath(fixture.runDir)}" ] && artifact=present`,
      '  failed_retro=absent',
      `  [ -e "${join(fixture.runDir, 'RETROSPECTIVE-failed-scope-5.md')}" ] && failed_retro=present`,
      '  current_retro=absent',
      `  [ -e "${join(fixture.runDir, 'RETROSPECTIVE.md')}" ] && current_retro=present`,
      `  printf '%s|completionArtifact=%s|failedRetrospective=%s|currentRetrospective=%s\\n' "$*" "$artifact" "$failed_retro" "$current_retro" >> "${logPath}"`,
      'fi',
      `exec "${realGit}" "$@"`,
      '',
    ].join('\n'),
    'utf8',
  );
  await chmod(gitPath, 0o755);
  return {
    binDir,
    async readObservations() {
      return (await readFile(logPath, 'utf8')).split('\n').filter(Boolean);
    },
  };
}

async function readRunEvents(runDir: string) {
  const content = await readFile(join(runDir, 'events.ndjson'), 'utf8');
  return content
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line) as { type: string; data?: Record<string, unknown> });
}

// The completed scope appended by appendDerivedSubScopeAndParentCompletion
// before the summary adjudication runs; identical in both scenarios because
// the failure branches persist the completedScopes computed pre-failure.
function expectedCompletedScope(args: { baseCommit: string; finalCommit: string; archivedReviewPath: string }) {
  return {
    number: '5',
    marker: 'AUTONOMY_DONE',
    result: 'accepted',
    baseCommit: args.baseCommit,
    finalCommit: args.finalCommit,
    summary: null,
    commitSubject: FIXTURE_COMMIT_SUBJECT,
    changedFiles: ['scope.txt'],
    reviewRounds: 0,
    findings: 0,
    residualReviewDebt: [],
    archivedReviewPath: args.archivedReviewPath,
    blocker: null,
    derivedFromParentScope: null,
    replacedByDerivedPlanPath: null,
  };
}

// JSON-normalized deep compare against the persisted state file, so the pin is
// byte-faithful to what saveState serialized (undefined-valued keys dropped).
function assertPersistedFailedState(
  persisted: Record<string, unknown>,
  expected: Record<string, unknown>,
) {
  assert.equal(typeof persisted.updatedAt, 'string');
  assert.deepStrictEqual(
    persisted,
    JSON.parse(JSON.stringify({ ...expected, updatedAt: persisted.updatedAt })),
  );
}

test('execute finalization CoderRoundError failure pins session override, failed artifact, retrospective, phase.error, and blocked notification order (Scenario A)', async () => {
  const fixture = await createExecuteFinalizationFailureFixture('neal-exec-final-fail-coder-round-');
  const { cwd, runDir, statePath, state, baseCommit, createdCommit, notifyLogPath } = fixture;
  const gitObserver = await createGitDiffNameOnlyObserver(fixture);
  const originalPath = process.env.PATH;
  const { calls, record } = createOrderRecorder(fixture);
  const logger = new OrderRecordingRunLogger(runDir, record);
  const runtime = createRecordingRuntime(record);
  // kind 'timeout' makes isCoderTimeoutError — and therefore
  // shouldNotifyFailure — true, so this scenario exercises the gated
  // notifyBlocked call.
  const providerErrorMessage = 'final completion summary round timed out before structured output';

  setProviderCapabilitiesOverrideForTesting('anthropic-claude', {
    createStructuredAdvisorAdapter() {
      return {
        async runStructuredRound<TStructured>(
          args: StructuredAdvisorRoundArgs<TStructured>,
        ): Promise<never> {
          assert.equal(args.label, 'final-completion');
          // Prose from an unrelated session must NOT enter the failed
          // artifact; the two failed-session texts must, joined by newline.
          await args.events?.({
            type: 'assistant_text',
            provider: 'anthropic-claude',
            role: 'structured-advisor',
            label: 'final-completion',
            sessionHandle: 'other-final-completion-session',
            text: 'Unrelated-session prose that must stay out of the failed artifact.',
          });
          await args.events?.({
            type: 'assistant_text',
            provider: 'anthropic-claude',
            role: 'structured-advisor',
            label: 'final-completion',
            sessionHandle: ERROR_SESSION_HANDLE,
            text: 'Failed-session coder prose, part one.',
          });
          await args.events?.({
            type: 'assistant_text',
            provider: 'anthropic-claude',
            role: 'structured-advisor',
            label: 'final-completion',
            sessionHandle: ERROR_SESSION_HANDLE,
            text: 'Failed-session coder prose, part two.',
          });
          throw new NealProviderError({
            message: providerErrorMessage,
            provider: 'anthropic-claude',
            role: 'structured-advisor',
            // Distinct from the seeded state handle so the persisted override
            // is distinguishable from preservation.
            sessionHandle: ERROR_SESSION_HANDLE,
            kind: 'timeout',
          });
        },
      };
    },
  });

  try {
    process.env.PATH = `${gitObserver.binDir}:${originalPath ?? ''}`;
    await assert.rejects(
      () => runExecuteFinalizationPhase(state, statePath, logger, runtime),
      (error: unknown) => {
        assert.ok(error instanceof CoderRoundError);
        assert.equal(error.message, providerErrorMessage);
        assert.equal(error.sessionHandle, ERROR_SESSION_HANDLE);
        assert.equal(error.kind, 'timeout');
        return true;
      },
    );

    // The finalization squash (reset --soft + commit) can reproduce the
    // created commit's hash byte-for-byte when timestamps land in the same
    // second, so the only stable pins are HEAD != base and the persisted
    // finalCommit == HEAD (asserted via the complete-state compare below).
    const finalCommit = await runGit(cwd, 'rev-parse', 'HEAD');
    assert.notEqual(finalCommit, baseCommit);
    const archivedReviewPath = join(runDir, `REVIEW-${finalCommit}.md`);

    // Complete persisted failed state: the CoderRoundError branch overrides
    // coderSessionHandle with the error's handle and derives the protocol from
    // the seeded state (NOT the 'structured_json_v1' fallback).
    const persisted = JSON.parse(await readFile(statePath, 'utf8')) as Record<string, unknown>;
    assertPersistedFailedState(persisted, {
      ...state,
      finalCommit,
      archivedReviewPath,
      completedScopes: [expectedCompletedScope({ baseCommit, finalCommit, archivedReviewPath })],
      coderSessionHandle: ERROR_SESSION_HANDLE,
      coderSessionProtocol: SEEDED_CODER_SESSION_PROTOCOL,
      status: 'failed',
    });

    // Failed final-completion review artifact: written with source
    // 'coder_summary' and only the failed session's prose, unambiguous match.
    const completionArtifact = await readFile(getFinalCompletionReviewArtifactPath(runDir), 'utf8');
    assert.match(completionArtifact, /- Status: failed/);
    assert.match(completionArtifact, new RegExp(`- Final commit: ${finalCommit}`));
    assert.match(completionArtifact, /- Last marker: AUTONOMY_DONE/);
    assert.match(completionArtifact, /## Coder Completion Summary\n\nPending\./);
    assert.match(completionArtifact, /## Unstructured Coder Summary Output/);
    assert.match(completionArtifact, /Claude returned this prose but failed to provide SDK structured output\./);
    assert.match(
      completionArtifact,
      /Failed-session coder prose, part one\.\nFailed-session coder prose, part two\./,
    );
    assert.doesNotMatch(completionArtifact, /Unrelated-session prose/);
    assert.doesNotMatch(completionArtifact, /the match may be ambiguous/);

    // Failed checkpoint retrospective: rendered from the failed state (error
    // session handle), duplicated to RETROSPECTIVE.md, and written BEFORE
    // phase.error reached the event log (its event-derived assessment saw no
    // phase.error event).
    const failedRetrospective = await readFile(join(runDir, 'RETROSPECTIVE-failed-scope-5.md'), 'utf8');
    assert.match(failedRetrospective, /- Summary: Scope 5 failed/);
    assert.match(failedRetrospective, /- Status: failed/);
    assert.match(failedRetrospective, new RegExp(`- Final commit: ${finalCommit}`));
    assert.match(failedRetrospective, new RegExp(`- Coder session: ${ERROR_SESSION_HANDLE}`));
    assert.match(failedRetrospective, /Neal failed while working on scope 5 for PLAN\.md\./);
    assert.match(failedRetrospective, /- No blocker summary was captured\./);
    assert.doesNotMatch(failedRetrospective, /phase error event/);
    assert.equal(await readFile(join(runDir, 'RETROSPECTIVE.md'), 'utf8'), failedRetrospective);

    // phase.error event payload: session handle present (the error's), message
    // present, and no other keys.
    const events = await readRunEvents(runDir);
    const phaseError = events.find((event) => event.type === 'phase.error');
    assert.ok(phaseError);
    assert.deepStrictEqual(phaseError.data, {
      phase: 'execute_finalization',
      sessionHandle: ERROR_SESSION_HANDLE,
      message: providerErrorMessage,
    });

    // notifyBlocked fired: notify.blocked event logged, then the notify script
    // invoked with the blocked message.
    const notifyBlockedEvent = events.find((event) => event.type === 'notify.blocked');
    assert.ok(notifyBlockedEvent);
    assert.deepStrictEqual(notifyBlockedEvent.data, {
      reason: providerErrorMessage,
      planName: 'PLAN.md',
      consultantAdvice: null,
    });
    assert.equal(await readFile(notifyLogPath, 'utf8'), `[neal] PLAN.md: ${providerErrorMessage}\n`);

    // Observable ordering, exactly as the fakes recorded it: the archived
    // review exists before the summary round runs; the failed state is
    // persisted first, then execution artifacts, then the failed
    // final-completion artifact and retrospective, then phase.error, then the
    // notify.blocked event, and the notify script runs last (its log is still
    // empty at every recorded milestone).
    assert.deepStrictEqual(calls, [
      {
        call: 'event:phase.start',
        persistedStatus: 'running',
        archivedReviewCount: 0,
        completionArtifactExists: false,
        failedRetrospectiveExists: false,
        currentRetrospectiveExists: false,
        notifyLog: '',
      },
      {
        call: 'event:provider.assistant_text',
        persistedStatus: 'running',
        archivedReviewCount: 1,
        completionArtifactExists: false,
        failedRetrospectiveExists: false,
        currentRetrospectiveExists: false,
        notifyLog: '',
      },
      {
        call: 'event:provider.assistant_text',
        persistedStatus: 'running',
        archivedReviewCount: 1,
        completionArtifactExists: false,
        failedRetrospectiveExists: false,
        currentRetrospectiveExists: false,
        notifyLog: '',
      },
      {
        call: 'event:provider.assistant_text',
        persistedStatus: 'running',
        archivedReviewCount: 1,
        completionArtifactExists: false,
        failedRetrospectiveExists: false,
        currentRetrospectiveExists: false,
        notifyLog: '',
      },
      {
        call: 'writeExecutionArtifacts',
        persistedStatus: 'failed',
        archivedReviewCount: 1,
        completionArtifactExists: false,
        failedRetrospectiveExists: false,
        currentRetrospectiveExists: false,
        notifyLog: '',
      },
      {
        call: 'event:phase.error',
        persistedStatus: 'failed',
        archivedReviewCount: 1,
        completionArtifactExists: true,
        failedRetrospectiveExists: true,
        currentRetrospectiveExists: true,
        notifyLog: '',
      },
      {
        call: 'event:notify.blocked',
        persistedStatus: 'failed',
        archivedReviewCount: 1,
        completionArtifactExists: true,
        failedRetrospectiveExists: true,
        currentRetrospectiveExists: true,
        notifyLog: '',
      },
    ]);

    // Ordering of the two writes the milestone log cannot separate: every
    // `git diff --name-only` invocation the run made, in order, with the
    // artifact/retrospective snapshot the interposer took at that moment. The
    // last entry is writeCheckpointRetrospective's own changed-files render:
    // the failed final-completion artifact ALREADY exists there while neither
    // retrospective file does yet — the failed final-completion artifact
    // write completes BEFORE the checkpoint retrospective write begins.
    assert.deepStrictEqual(await gitObserver.readObservations(), [
      // Finalization entry: changed files since base, at the pre-squash HEAD.
      `diff --name-only ${baseCommit}..${createdCommit}|completionArtifact=absent|failedRetrospective=absent|currentRetrospective=absent`,
      // buildFinalCompletionPacket's aggregate completion git context.
      `diff --name-only ${baseCommit}..${finalCommit}|completionArtifact=absent|failedRetrospective=absent|currentRetrospective=absent`,
      // The failure branch's writeExecutionArtifacts: the run-narrative status
      // snapshot's patch summary (initialBaseCommit..finalCommit). Artifact
      // still absent — the failed final-completion artifact is written by
      // writeFailedFinalCompletionReviewArtifact after this, not by
      // writeExecutionArtifacts.
      `diff --name-only ${baseCommit}..${finalCommit}|completionArtifact=absent|failedRetrospective=absent|currentRetrospective=absent`,
      // writeCheckpointRetrospective's render: artifact present, retro absent.
      `diff --name-only ${baseCommit}..${finalCommit}|completionArtifact=present|failedRetrospective=absent|currentRetrospective=absent`,
    ]);
  } finally {
    if (originalPath === undefined) {
      delete process.env.PATH;
    } else {
      process.env.PATH = originalPath;
    }
    clearProviderCapabilitiesOverridesForTesting();
  }
});

test('execute finalization generic failure pins seeded session preservation, no failed artifact, no notification (Scenario B)', async () => {
  const fixture = await createExecuteFinalizationFailureFixture('neal-exec-final-fail-generic-');
  const { cwd, runDir, statePath, state, baseCommit, notifyLogPath } = fixture;
  const { calls, record } = createOrderRecorder(fixture);
  const logger = new OrderRecordingRunLogger(runDir, record);
  const runtime = createRecordingRuntime(record);
  // The adapter returns successfully with a malformed payload;
  // parseFinalCompletionSummaryPayload throws an ordinary Error that
  // translateCoderProviderError rethrows unchanged into the generic branch.
  const parseErrorMessage = 'Final completion summary payload.whatChangedOverall must be a string.';

  setProviderCapabilitiesOverrideForTesting('anthropic-claude', {
    createStructuredAdvisorAdapter() {
      return {
        async runStructuredRound<TStructured>(args: StructuredAdvisorRoundArgs<TStructured>) {
          assert.equal(args.label, 'final-completion');
          // Prose is available, yet the generic branch must still write NO
          // failed final-completion review artifact.
          await args.events?.({
            type: 'assistant_text',
            provider: 'anthropic-claude',
            role: 'structured-advisor',
            label: 'final-completion',
            sessionHandle: 'summary-b-session-unused',
            text: 'Generic-branch coder prose that must not produce a failed artifact.',
          });
          return {
            sessionHandle: 'summary-b-session-unused',
            structured: {
              planGoalSatisfied: true,
              whatChangedOverall: 42,
              verificationSummary: 'Ran the fixture suite.',
              remainingKnownGaps: [],
            } as TStructured,
          };
        },
      };
    },
  });

  try {
    await assert.rejects(
      () => runExecuteFinalizationPhase(state, statePath, logger, runtime),
      (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.ok(!(error instanceof CoderRoundError));
        assert.ok(!(error instanceof NealProviderError));
        assert.equal(error.message, parseErrorMessage);
        return true;
      },
    );

    // Same squash-hash caveat as Scenario A: pin HEAD != base and the
    // persisted finalCommit == HEAD via the complete-state compare below.
    const finalCommit = await runGit(cwd, 'rev-parse', 'HEAD');
    assert.notEqual(finalCommit, baseCommit);
    const archivedReviewPath = join(runDir, `REVIEW-${finalCommit}.md`);

    // Complete persisted failed state: the generic branch leaves
    // coderSessionHandle/coderSessionProtocol exactly as seeded.
    const persisted = JSON.parse(await readFile(statePath, 'utf8')) as Record<string, unknown>;
    assertPersistedFailedState(persisted, {
      ...state,
      finalCommit,
      archivedReviewPath,
      completedScopes: [expectedCompletedScope({ baseCommit, finalCommit, archivedReviewPath })],
      coderSessionHandle: SEEDED_CODER_SESSION_HANDLE,
      coderSessionProtocol: SEEDED_CODER_SESSION_PROTOCOL,
      status: 'failed',
    });

    // No failed final-completion review artifact on the generic branch.
    assert.equal(existsSync(getFinalCompletionReviewArtifactPath(runDir)), false);

    // Failed checkpoint retrospective still written, from the state whose
    // coder session is the seeded one, before phase.error reached the log.
    const failedRetrospective = await readFile(join(runDir, 'RETROSPECTIVE-failed-scope-5.md'), 'utf8');
    assert.match(failedRetrospective, /- Summary: Scope 5 failed/);
    assert.match(failedRetrospective, /- Status: failed/);
    assert.match(failedRetrospective, new RegExp(`- Final commit: ${finalCommit}`));
    assert.match(failedRetrospective, new RegExp(`- Coder session: ${SEEDED_CODER_SESSION_HANDLE}`));
    assert.match(failedRetrospective, /Neal failed while working on scope 5 for PLAN\.md\./);
    assert.match(failedRetrospective, /- No blocker summary was captured\./);
    assert.doesNotMatch(failedRetrospective, /phase error event/);
    assert.equal(await readFile(join(runDir, 'RETROSPECTIVE.md'), 'utf8'), failedRetrospective);

    // phase.error event payload: the SEEDED session handle (the generic branch
    // has no error handle) and the parse error message.
    const events = await readRunEvents(runDir);
    const phaseError = events.find((event) => event.type === 'phase.error');
    assert.ok(phaseError);
    assert.deepStrictEqual(phaseError.data, {
      phase: 'execute_finalization',
      sessionHandle: SEEDED_CODER_SESSION_HANDLE,
      message: parseErrorMessage,
    });

    // No notification of any kind on the generic branch.
    assert.equal(events.some((event) => event.type.startsWith('notify.')), false);
    assert.equal(existsSync(notifyLogPath), false);

    // Observable ordering, exactly as the fakes recorded it: state save, then
    // execution artifacts, then retrospective, then phase.error — with the
    // failed final-completion artifact never appearing and no notification
    // milestone at all.
    assert.deepStrictEqual(calls, [
      {
        call: 'event:phase.start',
        persistedStatus: 'running',
        archivedReviewCount: 0,
        completionArtifactExists: false,
        failedRetrospectiveExists: false,
        currentRetrospectiveExists: false,
        notifyLog: '',
      },
      {
        call: 'event:provider.assistant_text',
        persistedStatus: 'running',
        archivedReviewCount: 1,
        completionArtifactExists: false,
        failedRetrospectiveExists: false,
        currentRetrospectiveExists: false,
        notifyLog: '',
      },
      {
        call: 'writeExecutionArtifacts',
        persistedStatus: 'failed',
        archivedReviewCount: 1,
        completionArtifactExists: false,
        failedRetrospectiveExists: false,
        currentRetrospectiveExists: false,
        notifyLog: '',
      },
      {
        call: 'event:phase.error',
        persistedStatus: 'failed',
        archivedReviewCount: 1,
        completionArtifactExists: false,
        failedRetrospectiveExists: true,
        currentRetrospectiveExists: true,
        notifyLog: '',
      },
    ]);
  } finally {
    clearProviderCapabilitiesOverridesForTesting();
  }
});
