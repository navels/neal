import test from 'node:test';
import assert from 'node:assert/strict';
import { chmod, mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  buildDiagnosticAnalysisPrompt,
  buildFinalCompletionReviewerPrompt,
  buildFinalCompletionSummaryPrompt,
  buildRecoveryPlanPrompt,
  buildReviewerPrompt,
} from '../src/neal/agents.js';
import {
  ADJUDICATION_ADJACENT_FLOWS,
  ADJUDICATION_SPECS,
  getAdjudicationSpec,
  getReviewerCapability,
  validateAdjudicationSpecContracts,
} from '../src/neal/adjudicator/specs.js';
import { clearConfigCache } from '../src/neal/config.js';
import { renderConsultMarkdown } from '../src/neal/consult.js';
import { buildFinalCompletionPacket } from '../src/neal/final-completion.js';
import { getFinalCompletionReviewArtifactPath, renderFinalCompletionReviewMarkdown } from '../src/neal/final-completion-review.js';
import { notifyInteractiveBlockedRecovery } from '../src/neal/orchestrator/notifications.js';
import { renderPlanProgressMarkdown, writePlanProgressArtifacts } from '../src/neal/progress.js';
import { getPromptSpec, PROMPT_SPECS } from '../src/neal/prompts/specs.js';
import { writeCheckpointRetrospective } from '../src/neal/retrospective.js';
import { renderReviewMarkdown } from '../src/neal/review.js';
import { createInitialState, getDefaultAgentConfig } from '../src/neal/state.js';
import type { AdjudicationSpec, AdjudicationTransitionSignal } from '../src/neal/adjudicator/specs.js';
import type { OrchestrationState } from '../src/neal/types.js';

process.env.HOME = join(tmpdir(), 'neal-test-home-review');

async function createState(overrides: Partial<OrchestrationState> = {}) {
  const root = await mkdtemp(join(tmpdir(), 'neal-review-artifacts-'));
  const cwd = join(root, 'repo');
  const stateDir = join(cwd, '.neal');
  const runDir = join(stateDir, 'runs', 'test-run');
  const planDoc = join(cwd, 'PLAN.md');

  await mkdir(runDir, { recursive: true });
  await writeFile(join(cwd, 'config.yml'), 'neal:\n  notify_bin: /usr/bin/true\n', 'utf8');
  clearConfigCache(cwd);
  await writeFile(planDoc, '# Plan\n', 'utf8');

  const state = await createInitialState(
    {
      cwd,
      planDoc,
      stateDir,
      runDir,
      topLevelMode: 'execute',
      ignoreLocalChanges: false,
      agentConfig: getDefaultAgentConfig(),
      progressJsonPath: join(runDir, 'plan-progress.json'),
      progressMarkdownPath: join(runDir, 'PLAN_PROGRESS.md'),
      reviewMarkdownPath: join(runDir, 'REVIEW.md'),
      consultMarkdownPath: join(runDir, 'CONSULT.md'),
      maxRounds: 3,
    },
    'abc123',
  );

  return { root, state: { ...state, ...overrides } };
}

test('consult and progress artifacts preserve completed interactive blocked recovery history', async () => {
  const { state } = await createState({
    currentScopeNumber: 4,
    phase: 'coder_response',
    interactiveBlockedRecoveryHistory: [
      {
        enteredAt: '2026-04-16T00:00:00.000Z',
        sourcePhase: 'reviewer_scope',
        blockedReason: 'Review findings stopped converging.',
        maxTurns: 3,
        lastHandledTurn: 1,
        resolvedAt: '2026-04-16T00:03:00.000Z',
        resolvedByAction: 'resume_current_scope',
        resultPhase: 'coder_response',
        turns: [
          {
            number: 1,
            recordedAt: '2026-04-16T00:01:00.000Z',
            operatorGuidance: 'Apply the reviewer feedback and continue this scope.',
            disposition: {
              recordedAt: '2026-04-16T00:02:00.000Z',
              sessionHandle: 'coder-session-4b',
              action: 'resume_current_scope',
              summary: 'The scope can continue.',
              rationale: 'The operator clarified how to proceed.',
              blocker: '',
              replacementPlan: '',
              resultingPhase: 'coder_response',
            },
          },
        ],
      },
    ],
  });

  const consultMarkdown = renderConsultMarkdown(state);
  assert.match(consultMarkdown, /## Interactive Blocked Recovery History 1/);
  assert.match(consultMarkdown, /Resolution: resume_current_scope/);
  assert.match(consultMarkdown, /Recovery turn 1 coder action: resume_current_scope/);
  assert.match(consultMarkdown, /Recovery turn 1 resulting phase: coder_response/);

  const progressMarkdown = renderPlanProgressMarkdown(state);
  assert.match(progressMarkdown, /## Interactive Blocked Recovery History/);
  assert.match(progressMarkdown, /Sessions: 1/);
  assert.match(progressMarkdown, /Latest action: resume_current_scope/);
  assert.match(progressMarkdown, /Latest result phase: coder_response/);
  assert.match(progressMarkdown, /Latest blocked reason: Review findings stopped converging\./);
  assert.match(progressMarkdown, /Latest operator guidance: Apply the reviewer feedback and continue this scope\./);
  assert.match(progressMarkdown, /Latest coder summary: The scope can continue\./);
});

test('interactive blocked recovery notification is distinct from a terminal blocked notification', async () => {
  const { root, state } = await createState({
    currentScopeNumber: 3,
  });
  const notifyLogPath = join(root, 'notify.log');
  const notifyScriptPath = join(root, 'notify.sh');
  await writeFile(
    notifyScriptPath,
    `#!/bin/sh\nprintf '%s\n' "$1" >> "${notifyLogPath}"\n`,
    'utf8',
  );
  await chmod(notifyScriptPath, 0o755);
  await writeFile(join(state.cwd, 'config.yml'), `neal:\n  notify_bin: ${notifyScriptPath}\n`, 'utf8');
  clearConfigCache(state.cwd);

  await notifyInteractiveBlockedRecovery(state, 'Need operator guidance');
  const notifyLog = await readFile(notifyLogPath, 'utf8');
  assert.match(notifyLog, /interactive blocked recovery for scope 3: Need operator guidance/);
  assert.doesNotMatch(notifyLog, /: blocked:/);
});

test('execute reviewer prompt includes coder justification and recent parent-objective history', () => {
  const prompt = buildReviewerPrompt({
    planDoc: '/tmp/PLAN.md',
    baseCommit: 'base123',
    headCommit: 'head456',
    commits: ['head456 add gate logic'],
    previousHeadCommit: null,
    diffStat: ' src/neal/orchestrator.ts | 10 +++++-----',
    changedFiles: ['src/neal/orchestrator.ts'],
    round: 2,
    reviewMarkdownPath: '/tmp/REVIEW.md',
    parentScopeLabel: '5',
    progressJustification: {
      milestoneTargeted: 'Scope 3 reviewer verdict contract',
      newEvidence: 'The execute reviewer schema now includes a meaningful-progress action.',
      whyNotRedundant: 'The old review pass could only judge local correctness.',
      nextStepUnlocked: 'Neal can block acceptance when convergence fails.',
    },
    recentHistorySummary: 'Accepted scope history for parent objective 5...\nTouched-file concentration: src/shared.ts (3/3 scopes)',
  });

  assert.match(prompt, /active parent objective.*scope 5/i);
  assert.match(prompt, /meaningfulProgressAction/);
  assert.match(prompt, /Scope 3 reviewer verdict contract/);
  assert.match(prompt, /Touched-file concentration: src\/shared\.ts \(3\/3 scopes\)/);
});

test('diagnostic analysis prompt carries explicit baseline and artifact-writing contract', () => {
  const prompt = buildDiagnosticAnalysisPrompt({
    planDoc: '/tmp/PLAN.md',
    progressText: '## Current Scope\n- Status: blocked\n',
    question: 'Why is this scope strategically non-convergent?',
    target: 'src/neal/orchestrator.ts',
    analysisArtifactPath: '/tmp/DIAGNOSTIC_RECOVERY_1_ANALYSIS.md',
    baselineRef: 'abc123',
    baselineSource: 'explicit',
    blockedReason: 'Need a cleaner baseline',
  });

  assert.match(prompt, /Write the markdown body that Neal will save to \/tmp\/DIAGNOSTIC_RECOVERY_1_ANALYSIS\.md/);
  assert.match(prompt, /git show abc123:<path>/);
  assert.match(prompt, /Do not checkout or mutate that baseline/);
  assert.match(prompt, /Why is this scope strategically non-convergent\?/);
  assert.match(prompt, /## Recovery Implications/);
  assert.match(prompt, /AUTONOMY_DONE or AUTONOMY_BLOCKED/);
  assert.match(prompt, /Protocol markers are terminal-response control signals, not artifact content/);
});

test('recovery plan prompt keeps protocol markers out of the authored artifact', () => {
  const prompt = buildRecoveryPlanPrompt({
    planDoc: '/tmp/PLAN.md',
    progressText: '## Current Scope\n- Status: blocked\n',
    question: 'How should this blocker be recovered?',
    target: 'src/neal/orchestrator.ts',
    analysisArtifactPath: '/tmp/DIAGNOSTIC_RECOVERY_1_ANALYSIS.md',
    recoveryPlanPath: '/tmp/DIAGNOSTIC_RECOVERY_1_PLAN.md',
    baselineRef: 'abc123',
    baselineSource: 'explicit',
  });

  assert.match(prompt, /Write the markdown body that Neal will save to \/tmp\/DIAGNOSTIC_RECOVERY_1_PLAN\.md/);
  assert.match(prompt, /Protocol markers are terminal-response control signals, not artifact content/);
  assert.match(prompt, /Good example: leave the file content marker-free, then output the marker as the final line of your terminal response/);
});

test('prompt spec inventory covers the curated role-task surface with explicit schema targets', () => {
  assert.equal(PROMPT_SPECS.length, 9);
  assert.deepEqual(
    PROMPT_SPECS.map((spec) => spec.id),
    [
      'plan_author',
      'plan_reviewer',
      'scope_coder',
      'scope_reviewer',
      'diagnostic_analyst',
      'recovery_plan_author',
      'recovery_plan_reviewer',
      'completion_coder',
      'completion_reviewer',
    ],
  );

  const scopeReviewer = getPromptSpec('scope_reviewer');
  assert.equal(scopeReviewer.schemaTarget.kind, 'structured_json');
  assert.equal(scopeReviewer.schemaTarget.schemaBuilder, 'buildReviewerSchema');
  assert.equal(scopeReviewer.baseInstructions.modulePath, 'src/neal/prompts/execute.ts');
  assert.equal(scopeReviewer.currentHome, 'src/neal/prompts');
  assert.equal(scopeReviewer.variants.every((variant) => variant.baseInstructions.modulePath === 'src/neal/prompts/execute.ts'), true);
  assert.equal(scopeReviewer.variants.some((variant) => variant.kind === 'meaningful_progress'), true);

  const scopeCoder = getPromptSpec('scope_coder');
  assert.equal(scopeCoder.currentHome, 'mixed');
  assert.equal(scopeCoder.baseInstructions.modulePath, 'src/neal/prompts/execute.ts');
  assert.equal(
    scopeCoder.variants
      .filter((variant) => variant.status === 'migration_target')
      .every((variant) => variant.baseInstructions.modulePath === 'src/neal/prompts/execute.ts'),
    true,
  );

  const planAuthor = getPromptSpec('plan_author');
  assert.equal(planAuthor.firstMigrationPriority, 1);
  assert.equal(planAuthor.currentHome, 'src/neal/prompts');
  assert.equal(planAuthor.baseInstructions.modulePath, 'src/neal/prompts/planning.ts');
  assert.equal(planAuthor.variants.every((variant) => variant.baseInstructions.modulePath === 'src/neal/prompts/planning.ts'), true);

  const planReviewer = getPromptSpec('plan_reviewer');
  assert.equal(planReviewer.baseInstructions.modulePath, 'src/neal/prompts/planning.ts');
  assert.equal(planReviewer.variants.every((variant) => variant.baseInstructions.modulePath === 'src/neal/prompts/planning.ts'), true);

  const recoveryPlanReviewer = getPromptSpec('recovery_plan_reviewer');
  assert.equal(recoveryPlanReviewer.baseInstructions.exportName, 'buildPlanReviewerPrompt');
  assert.equal(recoveryPlanReviewer.baseInstructions.modulePath, 'src/neal/prompts/planning.ts');

  const diagnosticAnalyst = getPromptSpec('diagnostic_analyst');
  assert.equal(diagnosticAnalyst.baseInstructions.modulePath, 'src/neal/prompts/specialized.ts');
  assert.equal(diagnosticAnalyst.variants.every((variant) => variant.baseInstructions.modulePath === 'src/neal/prompts/specialized.ts'), true);

  const recoveryPlanAuthor = getPromptSpec('recovery_plan_author');
  assert.equal(recoveryPlanAuthor.baseInstructions.modulePath, 'src/neal/prompts/specialized.ts');
  assert.equal(
    recoveryPlanAuthor.variants
      .filter((variant) => variant.baseInstructions.exportName === 'buildRecoveryPlanPrompt')
      .every((variant) => variant.baseInstructions.modulePath === 'src/neal/prompts/specialized.ts'),
    true,
  );

  const completionCoder = getPromptSpec('completion_coder');
  assert.equal(completionCoder.baseInstructions.modulePath, 'src/neal/prompts/specialized.ts');
  assert.equal(completionCoder.variants.every((variant) => variant.baseInstructions.modulePath === 'src/neal/prompts/specialized.ts'), true);

  const completionReviewer = getPromptSpec('completion_reviewer');
  assert.equal(completionReviewer.baseInstructions.modulePath, 'src/neal/prompts/specialized.ts');
  assert.equal(completionReviewer.variants.every((variant) => variant.baseInstructions.modulePath === 'src/neal/prompts/specialized.ts'), true);
});

test('adjudication spec inventory maps in-scope loops and leaves consult-style flows adjacent', async () => {
  assert.deepEqual(
    ADJUDICATION_SPECS.map((spec) => spec.id),
    ['plan_review', 'derived_plan_review', 'execute_review', 'recovery_plan_review', 'final_completion_review'],
  );

  const executeReview = getAdjudicationSpec('execute_review');
  assert.equal(executeReview.family, 'execute_review');
  assert.equal(executeReview.reviewer.prompt.promptSpecId, 'scope_reviewer');
  assert.deepEqual(
    executeReview.reviewer.capabilities?.map((capability) => `${capability.promptSpecId}:${capability.variantKind}`),
    ['scope_reviewer:meaningful_progress'],
  );
  assert.equal(executeReview.coder.primary.output.protocol, 'terminal_marker');
  assert.equal(executeReview.coder.primary.output.companionParser, 'parseExecuteScopeProgressPayload');

  const planReview = getAdjudicationSpec('plan_review');
  assert.equal(planReview.family, 'plan_review');
  assert.equal(planReview.reviewer.output.schemaBuilder, 'buildPlanReviewerSchema');

  const finalCompletion = getAdjudicationSpec('final_completion_review');
  assert.equal(finalCompletion.family, 'final_completion');
  assert.equal(finalCompletion.coder.response, null);
  assert.equal(finalCompletion.transitionSignals.includes('continue_execution'), true);

  assert.deepEqual(
    ADJUDICATION_ADJACENT_FLOWS.map((flow) => flow.id),
    ['consult_review', 'interactive_blocked_recovery', 'diagnostic_analysis', 'recovery_plan_authoring'],
  );
  assert.equal(ADJUDICATION_ADJACENT_FLOWS.find((flow) => flow.id === 'consult_review')?.status, 'adjacent_v1');
  assert.equal(
    ADJUDICATION_ADJACENT_FLOWS.find((flow) => flow.id === 'diagnostic_analysis')?.status,
    'single_coder_adjacent_v1',
  );

  const inventoryDoc = await readFile(join(process.cwd(), 'docs', 'ADJUDICATOR_INVENTORY.md'), 'utf8');
  const landedLineCountMatch = inventoryDoc.match(/## Landed State[\s\S]*?`src\/neal\/orchestrator\.ts`: `(\d+)` lines/);
  assert.match(inventoryDoc, /use the terms `adjudicator` and `adjudication spec`/);
  assert.match(inventoryDoc, /src\/neal\/orchestrator\.ts`: `3810` lines/);
  assert.match(inventoryDoc, /phaseHandlers` branches: `17`/);
  assert.match(inventoryDoc, /Informal real-run prerequisite audit: `2026-04-18`/);
  assert.match(inventoryDoc, /evidence posture: this document records the audit checkpoint and the deterministic regression baseline/);
  assert.match(inventoryDoc, /## Landed State/);
  assert.match(inventoryDoc, /src\/neal\/orchestrator\/run-loop\.ts/);
  assert.match(inventoryDoc, /src\/neal\/orchestrator\/completion\.ts/);
  assert.match(inventoryDoc, /five in-scope adjudication specs now share three explicit adjudication-spec families/);
  assert.match(inventoryDoc, /runOnePass` handler entries in `src\/neal\/orchestrator\.ts`: `14`/);
  assert.match(inventoryDoc, /reduced from `8` to `4`/);
  assert.match(inventoryDoc, /meaningful-progress remains a capability of this family, not a separate adjudication spec/);
  assert.match(inventoryDoc, /transitionSignals.*validated allowed outcomes/);
  assert.match(inventoryDoc, /Import-time adjudication-spec validation checks them against one explicit family-level runtime contract/);
  assert.ok(landedLineCountMatch, 'expected landed-state orchestrator line count in adjudicator inventory');
  const documentedLineCount = Number(landedLineCountMatch[1]);
  assert.ok(documentedLineCount <= 3048, `expected documented orchestrator.ts line count <= 3048, got ${documentedLineCount}`);
  assert.match(inventoryDoc, /import-time contract validation against family-supported runtime behavior/);
  assert.match(inventoryDoc, /live routing re-checks that the resolved outcome is allowed for the active adjudication spec/);
  assert.match(
    inventoryDoc,
    /phase-routing helpers and state mutation in `src\/neal\/orchestrator\.ts`, `src\/neal\/orchestrator\/transitions\.ts`, and `src\/neal\/orchestrator\/completion\.ts`/,
  );
  assert.match(
    inventoryDoc,
    /live routing re-checks the resolved outcome against the active adjudication spec, and the transition layer still maps those outcomes explicitly in runtime code rather than dispatching off `transitionSignals` directly/,
  );

  const orchestratorSource = await readFile(join(process.cwd(), 'src', 'neal', 'orchestrator.ts'), 'utf8');
  const handlersBlock = orchestratorSource.match(/const handlers: RunLoopHandlers = \{([\s\S]*?)\n  \};/);
  assert.ok(handlersBlock, 'expected runOnePass handlers block in orchestrator source');
  const handlerCount = [...handlersBlock[1].matchAll(/^    [a-z_]+:/gm)].length;
  assert.equal(handlerCount, 14);

  const adjudicationWrapperCount = [
    'runPlanReviewPhase',
    'runReviewPhase',
    'runExecuteResponsePhase',
    'runPlanningResponsePhase',
  ].filter((name) => orchestratorSource.includes(`async function ${name}(`)).length;
  assert.equal(adjudicationWrapperCount, 4);
});

test('adjudication spec validation rejects impossible family transition signals', () => {
  const malformedSpecs: readonly AdjudicationSpec[] = ADJUDICATION_SPECS.map((spec) =>
    spec.id === 'plan_review'
      ? {
          ...spec,
          transitionSignals: [...spec.transitionSignals, 'replace_plan'] as readonly AdjudicationTransitionSignal[],
        }
      : spec,
  );

  assert.throws(
    () => validateAdjudicationSpecContracts(malformedSpecs),
    /Adjudication spec plan_review family plan_review declares impossible transition signal replace_plan\./,
  );
});

test('adjudication spec validation rejects missing runtime transition signals for a spec', () => {
  const malformedSpecs: readonly AdjudicationSpec[] = ADJUDICATION_SPECS.map((spec) =>
    spec.id === 'final_completion_review'
      ? {
          ...spec,
          transitionSignals: spec.transitionSignals.filter(
            (signal): signal is AdjudicationTransitionSignal => signal !== 'continue_execution',
          ),
        }
      : spec,
  );

  assert.throws(
    () => validateAdjudicationSpecContracts(malformedSpecs),
    /Adjudication spec final_completion_review family final_completion is missing runtime transition signal continue_execution\./,
  );
});

test('ordinary plan-review artifacts render the active adjudication contract without implying dispatch ownership', async () => {
  const { state } = await createState({
    topLevelMode: 'plan',
    currentScopeNumber: 1,
    phase: 'reviewer_plan',
    executionShape: 'one_shot',
    coderSessionHandle: 'coder-plan-1',
    reviewerSessionHandle: 'reviewer-plan-1',
  });

  const reviewMarkdown = renderReviewMarkdown(state);
  assert.match(reviewMarkdown, /## Adjudication Contract/);
  assert.match(reviewMarkdown, /- Adjudication spec id: plan_review/);
  assert.match(reviewMarkdown, /- Adjudication family: plan_review/);
  assert.match(reviewMarkdown, /- Allowed transition outcomes: accept_plan, request_revision, optional_revision, block_for_operator/);
  assert.match(reviewMarkdown, /- Contract role: validated allowed outcomes for debugging; runtime routing remains explicit elsewhere\./);

  const progressMarkdown = renderPlanProgressMarkdown(state);
  assert.match(progressMarkdown, /## Adjudication Contract/);
  assert.match(progressMarkdown, /- Adjudication spec id: plan_review/);
  assert.match(progressMarkdown, /- Adjudication family: plan_review/);
  assert.match(progressMarkdown, /- Allowed transition outcomes: accept_plan, request_revision, optional_revision, block_for_operator/);
  assert.match(progressMarkdown, /- Contract role: validated allowed outcomes for debugging; runtime routing remains explicit elsewhere\./);
});

test('execute review requires meaningful-progress as an adjudication-spec reviewer capability', () => {
  const executeReview = getAdjudicationSpec('execute_review');
  const capability = getReviewerCapability(executeReview, 'meaningful_progress');
  assert.equal(capability.promptSpecId, 'scope_reviewer');
  assert.equal(capability.variantKind, 'meaningful_progress');
  assert.equal(capability.exportName, 'buildReviewerPrompt');

  const malformedExecuteReview = {
    ...executeReview,
    reviewer: {
      ...executeReview.reviewer,
      capabilities: [],
    },
  };

  assert.throws(
    () => getReviewerCapability(malformedExecuteReview, 'meaningful_progress'),
    /execute_review reviewer is missing capability meaningful_progress/,
  );
});

test('final completion packet summarizes whole-plan completion context', async () => {
  const { state } = await createState({
    currentScopeNumber: 3,
    executionShape: 'multi_scope',
    createdCommits: ['scope-3-commit'],
    completedScopes: [
      {
        number: '1',
        marker: 'AUTONOMY_SCOPE_DONE',
        result: 'accepted',
        baseCommit: 'base-1',
        finalCommit: 'final-1',
        commitSubject: 'implement scope 1',
        changedFiles: ['src/a.ts'],
        reviewRounds: 1,
        findings: 0,
        archivedReviewPath: '/tmp/review-1.md',
        blocker: null,
        derivedFromParentScope: null,
        replacedByDerivedPlanPath: null,
      },
      {
        number: '2',
        marker: 'AUTONOMY_SCOPE_DONE',
        result: 'accepted',
        baseCommit: 'base-2',
        finalCommit: 'final-2',
        commitSubject: 'implement scope 2',
        changedFiles: ['src/b.ts'],
        reviewRounds: 1,
        findings: 0,
        archivedReviewPath: '/tmp/review-2.md',
        blocker: null,
        derivedFromParentScope: null,
        replacedByDerivedPlanPath: null,
      },
    ],
  });
  await writeFile(
    join(state.runDir, 'events.ndjson'),
    [
      JSON.stringify({ type: 'coder.command_execution', data: { command: 'pnpm typecheck' } }),
      JSON.stringify({ type: 'coder.command_execution', data: { command: 'pnpm exec tsx --test test/review.test.ts' } }),
      JSON.stringify({ type: 'coder.command_execution', data: { command: 'git status --short' } }),
      '',
    ].join('\n'),
    'utf8',
  );

  const packet = await buildFinalCompletionPacket({
    state,
    terminalScope: {
      finalCommit: 'final-3',
      commitSubject: 'finish scope 3',
      changedFiles: ['src/c.ts'],
      archivedReviewPath: '/tmp/review-3.md',
      marker: 'AUTONOMY_DONE',
    },
  });

  assert.equal(packet.executionShape, 'multi_scope');
  assert.equal(packet.currentScopeLabel, '3');
  assert.equal(packet.acceptedScopeCount, 3);
  assert.equal(packet.verificationOnlyCompletion, false);
  assert.deepEqual(packet.terminalChangedFiles, ['src/c.ts']);
  assert.deepEqual(packet.planChangedFiles, ['src/a.ts', 'src/b.ts', 'src/c.ts']);
  assert.match(packet.completedScopeSummary, /Scope 1: accepted/);
  assert.match(packet.completedScopeSummary, /Scope 3: accepted \(AUTONOMY_DONE\)/);
  assert.match(packet.terminalChangedFilesSummary, /src\/c\.ts/);
  assert.match(packet.planChangedFilesSummary, /src\/a\.ts/);
  assert.match(packet.verificationSummary, /pnpm typecheck/);
  assert.match(packet.verificationSummary, /Command exit statuses are not persisted separately/);
  assert.deepEqual(packet.lastNonEmptyImplementationScope, {
    number: '3',
    finalCommit: 'final-3',
    commitSubject: 'finish scope 3',
    changedFiles: ['src/c.ts'],
    archivedReviewPath: '/tmp/review-3.md',
  });
});

test('final completion packet models a verification-only terminal scope explicitly', async () => {
  const { state } = await createState({
    currentScopeNumber: 4,
    executionShape: 'multi_scope',
    createdCommits: [],
    completedScopes: [
      {
        number: '3',
        marker: 'AUTONOMY_SCOPE_DONE',
        result: 'accepted',
        baseCommit: 'base-3',
        finalCommit: 'final-3',
        commitSubject: 'implement scope 3',
        changedFiles: ['src/existing.ts'],
        reviewRounds: 1,
        findings: 0,
        archivedReviewPath: '/tmp/review-3.md',
        blocker: null,
        derivedFromParentScope: null,
        replacedByDerivedPlanPath: null,
      },
    ],
  });
  await writeFile(
    join(state.runDir, 'events.ndjson'),
    `${JSON.stringify({ type: 'coder.command_execution', data: { command: 'pnpm typecheck' } })}\n`,
    'utf8',
  );

  const packet = await buildFinalCompletionPacket({
    state,
    terminalScope: {
      finalCommit: 'head-4',
      commitSubject: 'verification-only finish',
      changedFiles: [],
      archivedReviewPath: '/tmp/review-4.md',
      marker: 'AUTONOMY_DONE',
    },
  });

  assert.equal(packet.verificationOnlyCompletion, true);
  assert.equal(packet.terminalChangedFilesSummary, 'none');
  assert.deepEqual(packet.planChangedFiles, ['src/existing.ts']);
  assert.match(packet.verificationSummary, /pnpm typecheck/);
  assert.deepEqual(packet.lastNonEmptyImplementationScope, {
    number: '3',
    finalCommit: 'final-3',
    commitSubject: 'implement scope 3',
    changedFiles: ['src/existing.ts'],
    archivedReviewPath: '/tmp/review-3.md',
  });
});

test('final completion summary prompt requests compact whole-plan completion JSON', async () => {
  const { state } = await createState({
    currentScopeNumber: 3,
    executionShape: 'multi_scope',
    createdCommits: ['scope-3-commit'],
    completedScopes: [
      {
        number: '1',
        marker: 'AUTONOMY_SCOPE_DONE',
        result: 'accepted',
        baseCommit: 'base-1',
        finalCommit: 'final-1',
        commitSubject: 'implement scope 1',
        changedFiles: ['src/a.ts'],
        reviewRounds: 1,
        findings: 0,
        archivedReviewPath: '/tmp/review-1.md',
        blocker: null,
        derivedFromParentScope: null,
        replacedByDerivedPlanPath: null,
      },
    ],
  });
  await writeFile(
    join(state.runDir, 'events.ndjson'),
    `${JSON.stringify({ type: 'coder.command_execution', data: { command: 'pnpm typecheck' } })}\n`,
    'utf8',
  );

  const packet = await buildFinalCompletionPacket({
    state,
    terminalScope: {
      finalCommit: 'final-3',
      commitSubject: 'finish scope 3',
      changedFiles: ['src/b.ts'],
      archivedReviewPath: '/tmp/review-3.md',
      marker: 'AUTONOMY_DONE',
    },
  });
  const prompt = buildFinalCompletionSummaryPrompt({
    planDoc: '/tmp/PLAN.md',
    packet,
  });

  assert.match(prompt, /Return only JSON that matches the required schema/);
  assert.match(prompt, /planGoalSatisfied/);
  assert.match(prompt, /whatChangedOverall/);
  assert.match(prompt, /verificationOnlyCompletion/);
  assert.match(prompt, /completedScopeSummary/);
  assert.match(prompt, /regressions, quality concerns, testing gaps/);
  assert.match(prompt, /Do not include markdown fences or prose outside the JSON object/);
});

test('final completion reviewer prompt requires a structured whole-plan verdict', async () => {
  const { state } = await createState({
    currentScopeNumber: 3,
    executionShape: 'multi_scope',
    completedScopes: [
      {
        number: '1',
        marker: 'AUTONOMY_SCOPE_DONE',
        result: 'accepted',
        baseCommit: 'base-1',
        finalCommit: 'final-1',
        commitSubject: 'implement scope 1',
        changedFiles: ['src/a.ts'],
        reviewRounds: 1,
        findings: 0,
        archivedReviewPath: '/tmp/review-1.md',
        blocker: null,
        derivedFromParentScope: null,
        replacedByDerivedPlanPath: null,
      },
    ],
  });

  const packet = await buildFinalCompletionPacket({
    state,
    terminalScope: {
      finalCommit: 'final-3',
      commitSubject: 'finish scope 3',
      changedFiles: ['src/b.ts'],
      archivedReviewPath: '/tmp/review-3.md',
      marker: 'AUTONOMY_DONE',
    },
  });
  const prompt = buildFinalCompletionReviewerPrompt({
    planDoc: '/tmp/PLAN.md',
    packet,
    summary: {
      planGoalSatisfied: false,
      whatChangedOverall: 'Implemented the completion packet and coder summary contract.',
      verificationSummary: 'Ran review tests and typecheck.',
      remainingKnownGaps: ['Reviewer completion verdict is still needed.'],
    },
  });

  assert.match(prompt, /whole-plan final completion review/i);
  assert.match(prompt, /Evaluate the totality of the work completed for this plan/);
  assert.match(prompt, /ordinary code review standards/);
  assert.match(prompt, /Do not treat prior per-scope acceptance as sufficient evidence/);
  assert.match(prompt, /accept_complete/);
  assert.match(prompt, /continue_execution/);
  assert.match(prompt, /block_for_operator/);
  assert.match(prompt, /missingWork/);
  assert.match(prompt, /requiredOutcome/);
  assert.match(prompt, /verificationOnlyCompletion/);
  assert.match(prompt, /continueExecutionCount/);
  assert.match(prompt, /continueExecutionMax/);
});

test('final completion review artifact records coder summary, reviewer verdict, and resulting action', async () => {
  const { state } = await createState({
    currentScopeNumber: 6,
    phase: 'blocked',
    status: 'blocked',
    executionShape: 'multi_scope',
    finalCommit: 'final-6',
    lastScopeMarker: 'AUTONOMY_DONE',
    finalCompletionContinueExecutionCount: 2,
    finalCompletionContinueExecutionCapReached: true,
    finalCompletionSummary: {
      planGoalSatisfied: false,
      whatChangedOverall: 'Completed the planned scopes, but one final gap remained.',
      verificationSummary: 'Ran orchestrator, review, and plan-review coverage.',
      remainingKnownGaps: ['One operator decision is still required.'],
    },
    finalCompletionReviewVerdict: {
      action: 'continue_execution',
      summary: 'Another repair scope would normally be required.',
      rationale: 'The requested completion state still has one concrete missing repair.',
      missingWork: {
        summary: 'Add the remaining audit-trail regression case.',
        requiredOutcome: 'Cover the final-completion operator-block path.',
        verification: 'Run orchestrator tests and typecheck.',
      },
    },
    finalCompletionResolvedAction: 'block_for_operator',
    reviewerSessionHandle: 'reviewer-final-6',
  });

  const markdown = renderFinalCompletionReviewMarkdown(state);
  assert.match(markdown, /# Final Completion Review/);
  assert.match(markdown, /- What changed overall: Completed the planned scopes, but one final gap remained\./);
  assert.match(markdown, /## Adjudication Contract/);
  assert.match(markdown, /- Adjudication spec id: final_completion_review/);
  assert.match(markdown, /- Adjudication family: final_completion/);
  assert.match(markdown, /- Allowed transition outcomes: accept_complete, continue_execution, block_for_operator/);
  assert.match(markdown, /- Reviewer action: continue_execution/);
  assert.match(markdown, /- Resulting action: block_for_operator/);
  assert.match(markdown, /- Missing work summary: Add the remaining audit-trail regression case\./);
  assert.match(markdown, /Run blocked for operator guidance\./);
  assert.equal(getFinalCompletionReviewArtifactPath(state.runDir), join(state.runDir, 'FINAL_COMPLETION_REVIEW.md'));
});

test('final completion review and retrospective surface interactive blocked recovery details', async () => {
  const { state } = await createState({
    currentScopeNumber: 3,
    phase: 'done',
    status: 'done',
    baseCommit: null,
    finalCommit: 'final-3',
    interactiveBlockedRecoveryHistory: [
      {
        enteredAt: '2026-04-16T00:00:00.000Z',
        sourcePhase: 'coder_scope',
        blockedReason: 'The validation gate hit an unrelated baseline failure.',
        maxTurns: 3,
        lastHandledTurn: 1,
        resolvedAt: '2026-04-16T00:03:00.000Z',
        resolvedByAction: 'resume_current_scope',
        resultPhase: 'coder_scope',
        turns: [
          {
            number: 1,
            recordedAt: '2026-04-16T00:01:00.000Z',
            operatorGuidance: 'Broaden the scope to include the blocking test fix.',
            disposition: {
              recordedAt: '2026-04-16T00:02:00.000Z',
              sessionHandle: 'coder-session-3',
              action: 'resume_current_scope',
              summary: 'The blocker is now authorized inside the current scope.',
              rationale: 'The operator folded the test fix into the current scope.',
              blocker: '',
              replacementPlan: '',
              resultingPhase: 'coder_scope',
            },
          },
        ],
      },
    ],
    finalCompletionSummary: {
      planGoalSatisfied: true,
      whatChangedOverall: 'Completed all requested cleanup work.',
      verificationSummary: 'Lint and the required test suites passed.',
      remainingKnownGaps: [],
    },
    finalCompletionReviewVerdict: {
      action: 'accept_complete',
      summary: 'The plan is complete.',
      rationale: 'All required work landed cleanly.',
      missingWork: null,
    },
    finalCompletionResolvedAction: 'accept_complete',
  });

  const completionMarkdown = renderFinalCompletionReviewMarkdown(state);
  assert.match(completionMarkdown, /## Interactive Blocked Recovery History/);
  assert.match(completionMarkdown, /Blocked reason: The validation gate hit an unrelated baseline failure\./);
  assert.match(completionMarkdown, /Turn 1 guidance: Broaden the scope to include the blocking test fix\./);
  assert.match(completionMarkdown, /Turn 1 coder summary: The blocker is now authorized inside the current scope\./);

  const { archivedPath } = await writeCheckpointRetrospective(state, 'done');
  const retrospective = await readFile(archivedPath, 'utf8');
  assert.match(retrospective, /## Interactive Blocked Recovery History/);
  assert.match(retrospective, /Resolution: resume_current_scope/);
  assert.match(retrospective, /Turn 1 guidance: Broaden the scope to include the blocking test fix\./);
});

test('final completion packet rolls derived sub-scope history into the whole-plan summary', async () => {
  const { state } = await createState({
    currentScopeNumber: 7,
    executionShape: 'multi_scope',
    completedScopes: [
      {
        number: '7.1',
        marker: 'AUTONOMY_SCOPE_DONE',
        result: 'accepted',
        baseCommit: 'base-7-1',
        finalCommit: 'final-7-1',
        commitSubject: 'derived scope 7.1',
        changedFiles: ['src/a.ts'],
        reviewRounds: 1,
        findings: 0,
        archivedReviewPath: '/tmp/review-7.1.md',
        blocker: null,
        derivedFromParentScope: '7',
        replacedByDerivedPlanPath: null,
      },
      {
        number: '7.2',
        marker: 'AUTONOMY_DONE',
        result: 'accepted',
        baseCommit: 'base-7-2',
        finalCommit: 'final-7-2',
        commitSubject: 'derived scope 7.2',
        changedFiles: ['src/b.ts'],
        reviewRounds: 1,
        findings: 0,
        archivedReviewPath: '/tmp/review-7.2.md',
        blocker: null,
        derivedFromParentScope: '7',
        replacedByDerivedPlanPath: null,
      },
      {
        number: '7',
        marker: 'AUTONOMY_DONE',
        result: 'accepted',
        baseCommit: 'base-7',
        finalCommit: 'final-7',
        commitSubject: 'rolled-up parent scope 7',
        changedFiles: ['src/a.ts', 'src/b.ts'],
        reviewRounds: 2,
        findings: 0,
        archivedReviewPath: '/tmp/review-7.md',
        blocker: null,
        derivedFromParentScope: null,
        replacedByDerivedPlanPath: '/tmp/DERIVED_PLAN_SCOPE_7.md',
      },
    ],
  });

  const packet = await buildFinalCompletionPacket({ state, terminalScope: null });
  assert.equal(packet.acceptedScopeCount, 3);
  assert.match(packet.completedScopeSummary, /Scope 7\.1: accepted \(AUTONOMY_SCOPE_DONE\).*parent 7/);
  assert.match(packet.completedScopeSummary, /Scope 7\.2: accepted \(AUTONOMY_DONE\).*parent 7/);
  assert.match(packet.completedScopeSummary, /Scope 7: accepted \(AUTONOMY_DONE\).*src\/a\.ts, src\/b\.ts/);
  assert.deepEqual(packet.planChangedFiles, ['src/a.ts', 'src/b.ts']);
});

test('recovery plan prompt carries analysis input and Neal-executable contract', () => {
  const prompt = buildRecoveryPlanPrompt({
    planDoc: '/tmp/PLAN.md',
    progressText: '## Diagnostic Recovery\n- Sequence: 1\n',
    question: 'Why is this scope strategically non-convergent?',
    target: 'src/neal/orchestrator.ts',
    analysisArtifactPath: '/tmp/DIAGNOSTIC_RECOVERY_1_ANALYSIS.md',
    recoveryPlanPath: '/tmp/DIAGNOSTIC_RECOVERY_1_PLAN.md',
    baselineRef: 'abc123',
    baselineSource: 'explicit',
  });

  assert.match(prompt, /Read the diagnostic analysis at \/tmp\/DIAGNOSTIC_RECOVERY_1_ANALYSIS\.md before you write the plan/);
  assert.match(prompt, /Write the markdown body that Neal will save to \/tmp\/DIAGNOSTIC_RECOVERY_1_PLAN\.md/);
  assert.match(prompt, /preserve the ordinary Neal-executable plan contract/);
  assert.match(prompt, /## Execution Shape/);
  assert.match(prompt, /## Execution Queue/);
  assert.match(prompt, /AUTONOMY_DONE or AUTONOMY_BLOCKED/);
});

test('progress artifact renders current meaningful-progress context and bounded recent history', async () => {
  const { state } = await createState({
    currentScopeNumber: 8,
    currentScopeProgressJustification: {
      milestoneTargeted: 'Audit trail for meaningful-progress gating',
      newEvidence: 'Progress markdown now shows the current gate inputs.',
      whyNotRedundant: 'The prior artifact hid reviewer convergence context.',
      nextStepUnlocked: 'Operators can inspect scope churn without reconstructing session state.',
    },
    currentScopeMeaningfulProgressVerdict: {
      action: 'block_for_operator',
      rationale: 'The recent scopes revisit the same hotspot without advancing the parent objective.',
    },
    completedScopes: [
      {
        number: '8.1',
        marker: 'AUTONOMY_SCOPE_DONE',
        result: 'accepted',
        baseCommit: 'base-8-1',
        finalCommit: 'final-8-1',
        commitSubject: 'scope 8.1',
        changedFiles: ['src/shared.ts', 'src/a.ts'],
        reviewRounds: 1,
        findings: 0,
        archivedReviewPath: '/tmp/review-8.1.md',
        blocker: null,
        derivedFromParentScope: '8',
        replacedByDerivedPlanPath: null,
      },
      {
        number: '8.2',
        marker: 'AUTONOMY_SCOPE_DONE',
        result: 'accepted',
        baseCommit: 'base-8-2',
        finalCommit: 'final-8-2',
        commitSubject: 'scope 8.2',
        changedFiles: ['src/shared.ts', 'src/b.ts'],
        reviewRounds: 1,
        findings: 0,
        archivedReviewPath: '/tmp/review-8.2.md',
        blocker: null,
        derivedFromParentScope: '8',
        replacedByDerivedPlanPath: null,
      },
      {
        number: '8.3',
        marker: 'AUTONOMY_SCOPE_DONE',
        result: 'accepted',
        baseCommit: 'base-8-3',
        finalCommit: 'final-8-3',
        commitSubject: 'scope 8.3',
        changedFiles: ['src/shared.ts', 'src/c.ts'],
        reviewRounds: 1,
        findings: 0,
        archivedReviewPath: '/tmp/review-8.3.md',
        blocker: null,
        derivedFromParentScope: '8',
        replacedByDerivedPlanPath: null,
      },
      {
        number: '8.4',
        marker: 'AUTONOMY_SCOPE_DONE',
        result: 'accepted',
        baseCommit: 'base-8-4',
        finalCommit: 'final-8-4',
        commitSubject: 'scope 8.4',
        changedFiles: ['src/shared.ts', 'src/d.ts'],
        reviewRounds: 1,
        findings: 0,
        archivedReviewPath: '/tmp/review-8.4.md',
        blocker: null,
        derivedFromParentScope: '8',
        replacedByDerivedPlanPath: null,
      },
      {
        number: '8.5',
        marker: 'AUTONOMY_SCOPE_DONE',
        result: 'accepted',
        baseCommit: 'base-8-5',
        finalCommit: 'final-8-5',
        commitSubject: 'scope 8.5',
        changedFiles: ['src/shared.ts', 'src/e.ts'],
        reviewRounds: 1,
        findings: 0,
        archivedReviewPath: '/tmp/review-8.5.md',
        blocker: null,
        derivedFromParentScope: '8',
        replacedByDerivedPlanPath: null,
      },
      {
        number: '8.6',
        marker: 'AUTONOMY_SCOPE_DONE',
        result: 'accepted',
        baseCommit: 'base-8-6',
        finalCommit: 'final-8-6',
        commitSubject: 'scope 8.6',
        changedFiles: ['src/shared.ts', 'src/f.ts'],
        reviewRounds: 1,
        findings: 0,
        archivedReviewPath: '/tmp/review-8.6.md',
        blocker: null,
        derivedFromParentScope: '8',
        replacedByDerivedPlanPath: null,
      },
    ],
  });

  const markdown = renderPlanProgressMarkdown(state);
  const historySection = markdown.split('## Completed Scopes')[0] ?? markdown;

  assert.match(markdown, /## Meaningful Progress/);
  assert.match(markdown, /- Active parent objective: 8/);
  assert.match(markdown, /## Adjudication Contract/);
  assert.match(markdown, /- Adjudication spec id: execute_review/);
  assert.match(markdown, /- Adjudication family: execute_review/);
  assert.match(markdown, /- Allowed transition outcomes: accept_scope, request_revision, optional_revision, block_for_operator, replace_plan/);
  assert.match(markdown, /- Coder milestone: Audit trail for meaningful-progress gating/);
  assert.match(markdown, /- Reviewer action: block_for_operator/);
  assert.match(markdown, /- Reviewer rationale: The recent scopes revisit the same hotspot without advancing the parent objective\./);
  assert.match(historySection, /Accepted scope history for parent objective 8 \(oldest to newest, last 5 max\):/);
  assert.doesNotMatch(historySection, /Scope 8\.1/);
  assert.match(historySection, /Scope 8\.2/);
  assert.match(historySection, /Scope 8\.6/);
  assert.match(historySection, /Touched-file concentration: src\/shared\.ts \(5\/5 scopes\)/);
});

test('plan progress json mirrors meaningful-progress context for external tooling', async () => {
  const { state } = await createState({
    currentScopeNumber: 4,
    currentScopeProgressJustification: {
      milestoneTargeted: 'JSON audit parity',
      newEvidence: 'plan-progress.json now carries the gate context',
      whyNotRedundant: 'External tooling should not have to scrape markdown',
      nextStepUnlocked: 'Operators can inspect machine-readable progress state',
    },
    currentScopeMeaningfulProgressVerdict: {
      action: 'replace_plan',
      rationale: 'The current objective needs replacement rather than another retry.',
    },
    completedScopes: [
      {
        number: '4.1',
        marker: 'AUTONOMY_SCOPE_DONE',
        result: 'accepted',
        baseCommit: 'base-4-1',
        finalCommit: 'final-4-1',
        commitSubject: 'scope 4.1',
        changedFiles: ['src/shared.ts', 'src/a.ts'],
        reviewRounds: 1,
        findings: 0,
        archivedReviewPath: '/tmp/review-4.1.md',
        blocker: null,
        derivedFromParentScope: '4',
        replacedByDerivedPlanPath: null,
      },
      {
        number: '4.2',
        marker: 'AUTONOMY_SCOPE_DONE',
        result: 'accepted',
        baseCommit: 'base-4-2',
        finalCommit: 'final-4-2',
        commitSubject: 'scope 4.2',
        changedFiles: ['src/shared.ts', 'src/b.ts'],
        reviewRounds: 1,
        findings: 0,
        archivedReviewPath: '/tmp/review-4.2.md',
        blocker: null,
        derivedFromParentScope: '4',
        replacedByDerivedPlanPath: null,
      },
    ],
  });

  await writePlanProgressArtifacts(state);
  const progress = JSON.parse(await readFile(state.progressJsonPath, 'utf8')) as {
    meaningfulProgress: {
      parentObjective: string;
      currentScopeProgressJustification: { milestoneTargeted: string };
      currentScopeMeaningfulProgressVerdict: { action: string };
      recentAcceptedScopeHistory: Array<{ number: string }>;
    };
  };

  assert.equal(progress.meaningfulProgress.parentObjective, '4');
  assert.equal(progress.meaningfulProgress.currentScopeProgressJustification.milestoneTargeted, 'JSON audit parity');
  assert.equal(progress.meaningfulProgress.currentScopeMeaningfulProgressVerdict.action, 'replace_plan');
  assert.deepEqual(
    progress.meaningfulProgress.recentAcceptedScopeHistory.map((scope) => scope.number),
    ['4.1', '4.2'],
  );
});

test('review artifact renders derived-parent meaningful-progress history and verdict', async () => {
  const { state } = await createState({
    currentScopeNumber: 6,
    phase: 'reviewer_scope',
    derivedPlanPath: '/tmp/DERIVED_PLAN_SCOPE_6.md',
    derivedPlanStatus: 'accepted',
    derivedFromScopeNumber: 6,
    derivedScopeIndex: 3,
    currentScopeProgressJustification: {
      milestoneTargeted: 'Derived scope churn detection',
      newEvidence: 'The review artifact now shows original-parent history for derived execution.',
      whyNotRedundant: 'Derived sub-scopes should not hide the parent convergence story.',
      nextStepUnlocked: 'Reviewers can judge whether the sub-scope still advances parent scope 6.',
    },
    currentScopeMeaningfulProgressVerdict: {
      action: 'replace_plan',
      rationale: 'The sub-scope keeps revisiting the same parent hotspot and should be replaced.',
    },
    completedScopes: [
      {
        number: '6.1',
        marker: 'AUTONOMY_SCOPE_DONE',
        result: 'accepted',
        baseCommit: 'base-6-1',
        finalCommit: 'final-6-1',
        commitSubject: 'scope 6.1',
        changedFiles: ['src/shared.ts', 'src/a.ts'],
        reviewRounds: 1,
        findings: 0,
        archivedReviewPath: '/tmp/review-6.1.md',
        blocker: null,
        derivedFromParentScope: '6',
        replacedByDerivedPlanPath: null,
      },
      {
        number: '6.2',
        marker: 'AUTONOMY_SCOPE_DONE',
        result: 'accepted',
        baseCommit: 'base-6-2',
        finalCommit: 'final-6-2',
        commitSubject: 'scope 6.2',
        changedFiles: ['src/shared.ts', 'src/b.ts'],
        reviewRounds: 1,
        findings: 0,
        archivedReviewPath: '/tmp/review-6.2.md',
        blocker: null,
        derivedFromParentScope: '6',
        replacedByDerivedPlanPath: null,
      },
      {
        number: '6',
        marker: 'AUTONOMY_SCOPE_DONE',
        result: 'accepted',
        baseCommit: 'base-6',
        finalCommit: 'final-6',
        commitSubject: 'rolled-up scope 6',
        changedFiles: ['src/shared.ts', 'src/b.ts'],
        reviewRounds: 1,
        findings: 0,
        archivedReviewPath: '/tmp/review-6.md',
        blocker: null,
        derivedFromParentScope: null,
        replacedByDerivedPlanPath: '/tmp/DERIVED_PLAN_SCOPE_6.md',
      },
    ],
  });

  const markdown = renderReviewMarkdown(state);

  assert.match(markdown, /## Meaningful Progress/);
  assert.match(markdown, /- Active parent objective: 6/);
  assert.match(markdown, /## Adjudication Contract/);
  assert.match(markdown, /- Adjudication spec id: execute_review/);
  assert.match(markdown, /- Adjudication family: execute_review/);
  assert.match(markdown, /- Allowed transition outcomes: accept_scope, request_revision, optional_revision, block_for_operator, replace_plan/);
  assert.match(markdown, /- Coder milestone: Derived scope churn detection/);
  assert.match(markdown, /- Reviewer action: replace_plan/);
  assert.match(markdown, /- Reviewer rationale: The sub-scope keeps revisiting the same parent hotspot and should be replaced\./);
  assert.match(markdown, /### Recent Accepted Scope History/);
  assert.match(markdown, /Accepted scope history for parent objective 6 \(oldest to newest, last 5 max\):/);
  assert.match(markdown, /Scope 6\.1/);
  assert.match(markdown, /Scope 6\.2/);
  assert.doesNotMatch(markdown, /Scope 6\n/);
  assert.match(markdown, /Touched-file concentration: src\/shared\.ts \(2\/2 scopes\)/);
});

test('review artifact labels diagnostic recovery plans as recovery candidates', async () => {
  const { state } = await createState({
    currentScopeNumber: 4,
    phase: 'diagnostic_recovery_adopt',
    diagnosticRecovery: {
      sequence: 1,
      startedAt: '2026-04-17T00:00:00.000Z',
      sourcePhase: 'blocked',
      resumePhase: 'reviewer_scope',
      parentScopeLabel: '4',
      blockedReason: 'Need deeper diagnosis',
      question: 'Why did scope 4 stop converging?',
      target: 'src/neal/orchestrator.ts',
      requestedBaselineRef: null,
      effectiveBaselineRef: 'base-commit-4',
      effectiveBaselineSource: 'active_parent_base_commit',
      analysisArtifactPath: '/tmp/DIAGNOSTIC_RECOVERY_1_ANALYSIS.md',
      recoveryPlanPath: '/tmp/DIAGNOSTIC_RECOVERY_1_PLAN.md',
    },
  });

  const markdown = renderReviewMarkdown(state);

  assert.match(markdown, /- Review target: \/tmp\/DIAGNOSTIC_RECOVERY_1_PLAN\.md/);
  assert.match(markdown, /- Review target kind: diagnostic recovery plan candidate/);
  assert.match(markdown, /## Adjudication Contract/);
  assert.match(markdown, /- Adjudication spec id: recovery_plan_review/);
  assert.match(markdown, /- Adjudication family: plan_review/);
  assert.match(markdown, /- Allowed transition outcomes: adopt_recovery_plan, request_revision, optional_revision, block_for_operator/);
  assert.match(markdown, /## Diagnostic Recovery/);
  assert.match(markdown, /- Recovery plan artifact: \/tmp\/DIAGNOSTIC_RECOVERY_1_PLAN\.md/);
  assert.match(markdown, /- Next operator step: neal --diagnostic-decision \[state-file\] --action <adopt\|reference\|cancel>/);
});

test('progress and review artifacts render diagnostic recovery decision history after adoption', async () => {
  const { state } = await createState({
    currentScopeNumber: 4,
    phase: 'awaiting_derived_plan_execution',
    derivedPlanPath: '/tmp/DIAGNOSTIC_RECOVERY_1_PLAN.normalized.md',
    derivedPlanStatus: 'accepted',
    derivedFromScopeNumber: 4,
    diagnosticRecoveryHistory: [
      {
        sequence: 1,
        startedAt: '2026-04-17T00:00:00.000Z',
        sourcePhase: 'blocked',
        resumePhase: 'reviewer_scope',
        parentScopeLabel: '4',
        blockedReason: 'Need broader diagnostic recovery',
        question: 'Why did the current scope stop converging?',
        target: 'src/neal/orchestrator.ts',
        requestedBaselineRef: null,
        effectiveBaselineRef: 'scope-base-commit',
        effectiveBaselineSource: 'active_parent_base_commit',
        analysisArtifactPath: '/tmp/DIAGNOSTIC_RECOVERY_1_ANALYSIS.md',
        recoveryPlanPath: '/tmp/DIAGNOSTIC_RECOVERY_1_PLAN.md',
        resolvedAt: '2026-04-17T00:30:00.000Z',
        decision: 'adopt_recovery_plan',
        rationale: 'The reviewed recovery plan is narrow enough to replace the failing parent objective.',
        resultPhase: 'awaiting_derived_plan_execution',
        adoptedPlanPath: '/tmp/DIAGNOSTIC_RECOVERY_1_PLAN.normalized.md',
        reviewArtifactPath: '/tmp/DIAGNOSTIC_RECOVERY_1_REVIEW.md',
        reviewRoundCount: 2,
        reviewFindingCount: 1,
      },
    ],
  });

  const progressMarkdown = renderPlanProgressMarkdown(state);
  assert.match(progressMarkdown, /## Diagnostic Recovery History/);
  assert.match(progressMarkdown, /Latest decision: adopt_recovery_plan/);
  assert.match(progressMarkdown, /Latest adopted plan: \/tmp\/DIAGNOSTIC_RECOVERY_1_PLAN\.normalized\.md/);
  assert.match(progressMarkdown, /Latest review artifact: \/tmp\/DIAGNOSTIC_RECOVERY_1_REVIEW\.md/);
  assert.match(progressMarkdown, /Latest review rounds: 2/);
  assert.match(progressMarkdown, /Latest review findings: 1/);

  const reviewMarkdown = renderReviewMarkdown(state);
  assert.match(reviewMarkdown, /## Diagnostic Recovery History/);
  assert.match(reviewMarkdown, /Latest decision: adopt_recovery_plan/);
  assert.match(reviewMarkdown, /Latest review artifact: \/tmp\/DIAGNOSTIC_RECOVERY_1_REVIEW\.md/);
  assert.match(
    reviewMarkdown,
    /Latest rationale: The reviewed recovery plan is narrow enough to replace the failing parent objective\./,
  );
});
