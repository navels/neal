import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { access, mkdir, mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

import { buildUsageLines, parseNewRunArgs, parseSquashArgs } from '../src/neal/cli.js';
import { loadOrInitialize } from '../src/neal/orchestrator.js';
import { getDefaultAgentConfig } from '../src/neal/state.js';
import { resolveExecuteInput } from '../src/neal/input-source.js';

const execFileAsync = promisify(execFile);
process.env.HOME = join(tmpdir(), 'neal-test-home-index');

async function runNealCliResult(...args: string[]) {
  return runNealCliResultInCwd(process.cwd(), ...args);
}

async function runNealCliResultInCwd(cwd: string, ...args: string[]) {
  return execFileAsync('pnpm', ['--dir', process.cwd(), 'exec', 'tsx', 'src/neal/index.ts', ...args], { cwd });
}

async function runGit(cwd: string, ...args: string[]) {
  const { stdout } = await execFileAsync('git', args, { cwd });
  return stdout.trim();
}

async function runNealCliFailure(...args: string[]) {
  try {
    await runNealCliResult(...args);
    throw new Error(`Expected failure for args: ${args.join(' ')}`);
  } catch (error) {
    const execError = error as { stdout?: string; stderr?: string; code?: number };
    return {
      stdout: execError.stdout ?? '',
      stderr: execError.stderr ?? '',
      code: execError.code ?? 1,
    };
  }
}

async function runNealCliFailureInCwd(cwd: string, ...args: string[]) {
  try {
    await runNealCliResultInCwd(cwd, ...args);
    throw new Error(`Expected failure for args: ${args.join(' ')}`);
  } catch (error) {
    const execError = error as { stdout?: string; stderr?: string; code?: number };
    return {
      stdout: execError.stdout ?? '',
      stderr: execError.stderr ?? '',
      code: execError.code ?? 1,
    };
  }
}

test('parseNewRunArgs treats bare --execute as default file mode', () => {
  const parsed = parseNewRunArgs(['--execute', 'plans/PLAN.md'], getDefaultAgentConfig());
  assert.equal(parsed.topLevelMode, 'execute');
  assert.deepEqual(parsed.executeInputSource, {
    mode: 'file_default',
    value: 'plans/PLAN.md',
  });
});

test('parseNewRunArgs supports explicit execute file mode', () => {
  const parsed = parseNewRunArgs(['--execute-file', 'plans/PLAN.md'], getDefaultAgentConfig());
  assert.deepEqual(parsed.executeInputSource, {
    mode: 'file_explicit',
    value: 'plans/PLAN.md',
  });
});

test('parseNewRunArgs supports explicit execute text mode', () => {
  const parsed = parseNewRunArgs(['--execute-text', '# Plan'], getDefaultAgentConfig());
  assert.deepEqual(parsed.executeInputSource, {
    mode: 'text_explicit',
    value: '# Plan',
  });
});

test('parseNewRunArgs allows execute-text values that begin with --', () => {
  const parsed = parseNewRunArgs(['--execute-text', '--foo bar'], getDefaultAgentConfig());
  assert.deepEqual(parsed.executeInputSource, {
    mode: 'text_explicit',
    value: '--foo bar',
  });
});

test('parseNewRunArgs rejects empty execute-text values directly', () => {
  assert.throws(
    () => parseNewRunArgs(['--execute-text', ''], getDefaultAgentConfig()),
    /--execute-text requires a non-empty inline plan string argument/,
  );
});

test('parseNewRunArgs rejects conflicting execute-input flags', () => {
  assert.throws(
    () => parseNewRunArgs(['--execute', 'plans/PLAN.md', '--execute-text', '# Plan'], getDefaultAgentConfig()),
    /Choose exactly one execute input source/,
  );
});

test('parseNewRunArgs rejects mixed top-level plan and execute modes consistently', () => {
  assert.throws(
    () => parseNewRunArgs(['--execute-text', '# Plan', '--plan', 'PLAN.md'], getDefaultAgentConfig()),
    /Choose exactly one execute input source/,
  );
});

test('parseNewRunArgs rejects missing execute-file values before option parsing continues', () => {
  assert.throws(
    () => parseNewRunArgs(['--execute-file', '--coder-model', 'gpt-5.4'], getDefaultAgentConfig()),
    /--execute-file requires a plan file path argument/,
  );
});

test('parseSquashArgs accepts dry-run and yes flags', () => {
  const parsed = parseSquashArgs(['--squash', 'plans/PLAN.md', '--dry-run', '--yes']);
  assert.deepEqual(parsed, {
    planDoc: 'plans/PLAN.md',
    dryRun: true,
    yes: true,
  });
});

test('parseSquashArgs rejects a missing plan path', () => {
  assert.throws(() => parseSquashArgs(['--squash', '--dry-run']), /--squash requires a plan file path argument/);
});

test('buildUsageLines documents the execute input modes clearly', () => {
  const usage = buildUsageLines().join('\n');
  assert.match(usage, /--execute <plan-doc>.*default file mode/);
  assert.match(usage, /--execute-file <plan-doc>.*explicit file mode/);
  assert.match(usage, /--execute-text "<plan markdown>"/);
  assert.match(usage, /--squash <plan-doc> \[--dry-run\] \[--yes\]/);
  assert.match(usage, /--diagnose \[state-file\] --question/);
  assert.match(usage, /--diagnostic-decision \[state-file\] --action <adopt\|reference\|cancel>/);
});

test('resolveExecuteInput keeps file mode on the provided plan path', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'neal-index-file-'));
  const planDoc = join(cwd, 'PLAN.md');
  await writeFile(planDoc, '# Plan\n', 'utf8');

  const resolved = await resolveExecuteInput({ mode: 'file_explicit', value: 'PLAN.md' }, cwd);
  assert.equal(resolved.planDoc, planDoc);
  assert.equal(resolved.runDir, undefined);
});

test('resolveExecuteInput materializes text mode into a run-owned plan artifact', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'neal-index-text-'));
  const resolved = await resolveExecuteInput(
    {
      mode: 'text_explicit',
      value: '# Inline Plan\n\n## Execution Shape\n\nexecutionShape: one_shot\n',
    },
    cwd,
  );

  assert.ok(resolved.runDir);
  assert.match(resolved.planDoc, /\.neal\/runs\/[^/]+\/INLINE_EXECUTE_PLAN\.md$/);
  assert.equal(resolved.planDoc, join(resolved.runDir!, 'INLINE_EXECUTE_PLAN.md'));
  await access(resolved.planDoc);
  assert.equal(await readFile(resolved.planDoc, 'utf8'), '# Inline Plan\n\n## Execution Shape\n\nexecutionShape: one_shot\n');
});

test('text-mode bootstrap records the materialized inline plan path in state and run artifacts', async () => {
  const root = await mkdtemp(join(tmpdir(), 'neal-index-bootstrap-'));
  const cwd = join(root, 'repo');
  await runGit(root, 'init', 'repo');
  await runGit(cwd, 'config', 'user.name', 'Neal Test');
  await runGit(cwd, 'config', 'user.email', 'neal@example.com');
  await runGit(cwd, 'config', 'commit.gpgsign', 'false');
  await writeFile(join(cwd, 'README.md'), 'bootstrap\n', 'utf8');
  await runGit(cwd, 'add', 'README.md');
  await runGit(cwd, 'commit', '-m', 'base commit');

  const resolved = await resolveExecuteInput(
    {
      mode: 'text_explicit',
      value: '# Inline Plan\n\n## Execution Shape\n\nexecutionShape: one_shot\n',
    },
    cwd,
  );

  const loaded = await loadOrInitialize(
    resolved.planDoc,
    cwd,
    getDefaultAgentConfig(),
    undefined,
    'execute',
    { runDir: resolved.runDir },
  );

  assert.equal(loaded.state.planDoc, resolved.planDoc);
  assert.equal(loaded.state.runDir, resolved.runDir);
  assert.equal(loaded.logger.runDir, resolved.runDir);

  const meta = JSON.parse(await readFile(join(resolved.runDir!, 'meta.json'), 'utf8')) as {
    planDoc: string;
    runDir: string;
  };
  assert.equal(meta.planDoc, resolved.planDoc);
  assert.equal(meta.runDir, resolved.runDir);

  const persistedState = JSON.parse(await readFile(loaded.statePath, 'utf8')) as {
    planDoc: string;
    runDir: string;
  };
  assert.equal(persistedState.planDoc, resolved.planDoc);
  assert.equal(persistedState.runDir, resolved.runDir);
});

test('plan-mode initialization creates a timestamped backup copy and persists its path', async () => {
  const root = await mkdtemp(join(tmpdir(), 'neal-index-plan-backup-'));
  const cwd = join(root, 'repo');
  await runGit(root, 'init', 'repo');
  await runGit(cwd, 'config', 'user.name', 'Neal Test');
  await runGit(cwd, 'config', 'user.email', 'neal@example.com');
  await runGit(cwd, 'config', 'commit.gpgsign', 'false');
  await mkdir(join(cwd, 'plans'), { recursive: true });
  const planDoc = join(cwd, 'plans', 'PLAN.md');
  await writeFile(planDoc, '## Goal\n\nBack me up.\n', 'utf8');
  await runGit(cwd, 'add', 'plans/PLAN.md');
  await runGit(cwd, 'commit', '-m', 'base commit');

  const loaded = await loadOrInitialize(
    planDoc,
    cwd,
    getDefaultAgentConfig(),
    undefined,
    'plan',
  );

  assert.equal(loaded.state.planDoc, planDoc);
  assert.match(loaded.state.planDocBackupPath ?? '', /\/plans\/archive\/PLAN\.pre-plan\.[^/]+\.md$/);
  await access(loaded.state.planDocBackupPath!);
  assert.equal(await readFile(loaded.state.planDocBackupPath!, 'utf8'), '## Goal\n\nBack me up.\n');

  const persistedState = JSON.parse(await readFile(loaded.statePath, 'utf8')) as {
    planDocBackupPath: string | null;
  };
  assert.equal(persistedState.planDocBackupPath, loaded.state.planDocBackupPath);
});

test('execute-mode initialization does not create a plan backup path', async () => {
  const root = await mkdtemp(join(tmpdir(), 'neal-index-execute-no-backup-'));
  const cwd = join(root, 'repo');
  await runGit(root, 'init', 'repo');
  await runGit(cwd, 'config', 'user.name', 'Neal Test');
  await runGit(cwd, 'config', 'user.email', 'neal@example.com');
  await runGit(cwd, 'config', 'commit.gpgsign', 'false');
  const planDoc = join(cwd, 'PLAN.md');
  await writeFile(planDoc, '## Execution Shape\n\nexecutionShape: one_shot\n', 'utf8');
  await runGit(cwd, 'add', 'PLAN.md');
  await runGit(cwd, 'commit', '-m', 'base commit');

  const loaded = await loadOrInitialize(
    planDoc,
    cwd,
    getDefaultAgentConfig(),
    undefined,
    'execute',
  );

  assert.equal(loaded.state.planDocBackupPath, null);
});

test('execute startup cleans up a materialized inline run directory when initialization fails', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'neal-index-cleanup-'));
  const result = await runNealCliFailureInCwd(
    cwd,
    '--execute-text',
    '# Inline Plan\n\n## Execution Shape\n\nexecutionShape: one_shot\n',
  );
  assert.equal(result.code, 1);
  assert.match(result.stderr, /Cannot start neal --execute with a dirty worktree|fatal|not a git repository/i);
  await assert.rejects(access(join(cwd, '.neal', 'runs')));
  const nealEntries = await readdir(join(cwd, '.neal')).catch(() => []);
  assert.deepEqual(nealEntries, []);
});

test('neal usage output documents execute-file and execute-text', async () => {
  const result = await runNealCliFailure();
  assert.equal(result.code, 1);
  assert.match(result.stderr, /--execute <plan-doc>.*default file mode/);
  assert.match(result.stderr, /--execute-file <plan-doc>/);
  assert.match(result.stderr, /--execute-text "<plan markdown>"/);
  assert.match(result.stderr, /--squash <plan-doc> \[--dry-run\] \[--yes\]/);
  assert.match(result.stderr, /--diagnose \[state-file\] --question/);
  assert.match(result.stderr, /--diagnostic-decision \[state-file\] --action <adopt\|reference\|cancel>/);
});

test('neal --diagnose records a diagnostic-recovery session for a blocked execute run', async () => {
  const root = await mkdtemp(join(tmpdir(), 'neal-diagnose-cli-'));
  const cwd = join(root, 'repo');
  await runGit(root, 'init', 'repo');
  await runGit(cwd, 'config', 'user.name', 'Neal Test');
  await runGit(cwd, 'config', 'user.email', 'neal@example.com');
  await runGit(cwd, 'config', 'commit.gpgsign', 'false');
  await writeFile(join(cwd, 'README.md'), 'bootstrap\n', 'utf8');
  await runGit(cwd, 'add', 'README.md');
  await runGit(cwd, 'commit', '-m', 'base commit');
  await writeFile(join(cwd, 'PLAN.md'), '# Plan\n', 'utf8');

  const loaded = await loadOrInitialize(join(cwd, 'PLAN.md'), cwd, getDefaultAgentConfig(), undefined, 'execute', {
    ignoreLocalChanges: true,
  });
  const blockedState = {
    ...loaded.state,
    phase: 'blocked' as const,
    status: 'blocked' as const,
    blockedFromPhase: 'reviewer_scope' as const,
    completedScopes: [
      {
        number: '1',
        marker: 'AUTONOMY_BLOCKED' as const,
        result: 'blocked' as const,
        baseCommit: loaded.state.baseCommit,
        finalCommit: null,
        commitSubject: null,
        changedFiles: [],
        reviewRounds: 1,
        findings: 1,
        archivedReviewPath: null,
        blocker: 'Need a cleaner baseline',
        derivedFromParentScope: null,
        replacedByDerivedPlanPath: null,
      },
    ],
  };
  await writeFile(loaded.statePath, JSON.stringify(blockedState, null, 2) + '\n', 'utf8');

  const { stdout } = await runNealCliResultInCwd(
    cwd,
    '--diagnose',
    loaded.statePath,
    '--question',
    'What is structurally different about this scope?',
    '--target',
    'src/neal/orchestrator.ts',
  );

  const result = JSON.parse(stdout) as {
    ok: boolean;
    phase: string;
    status: string;
    diagnosticRecovery: { question: string; target: string; blockedReason: string | null };
  };
  assert.equal(result.ok, true);
  assert.equal(result.phase, 'diagnostic_recovery_analyze');
  assert.equal(result.status, 'running');
  assert.equal(result.diagnosticRecovery.question, 'What is structurally different about this scope?');
  assert.equal(result.diagnosticRecovery.target, 'src/neal/orchestrator.ts');
  assert.equal(result.diagnosticRecovery.blockedReason, 'Need a cleaner baseline');
  assert.match(stdout, /neal --resume/);
});

test('neal --diagnose preserves an explicit baseline reference in diagnostic recovery state', async () => {
  const root = await mkdtemp(join(tmpdir(), 'neal-diagnose-cli-baseline-'));
  const cwd = join(root, 'repo');
  await runGit(root, 'init', 'repo');
  await runGit(cwd, 'config', 'user.name', 'Neal Test');
  await runGit(cwd, 'config', 'user.email', 'neal@example.com');
  await runGit(cwd, 'config', 'commit.gpgsign', 'false');
  await writeFile(join(cwd, 'README.md'), 'bootstrap\n', 'utf8');
  await runGit(cwd, 'add', 'README.md');
  await runGit(cwd, 'commit', '-m', 'base commit');
  const baselineRef = (await runGit(cwd, 'rev-parse', 'HEAD')).trim();
  await writeFile(join(cwd, 'PLAN.md'), '# Plan\n', 'utf8');

  const loaded = await loadOrInitialize(join(cwd, 'PLAN.md'), cwd, getDefaultAgentConfig(), undefined, 'execute', {
    ignoreLocalChanges: true,
  });
  const blockedState = {
    ...loaded.state,
    phase: 'blocked' as const,
    status: 'blocked' as const,
    blockedFromPhase: 'reviewer_scope' as const,
  };
  await writeFile(loaded.statePath, JSON.stringify(blockedState, null, 2) + '\n', 'utf8');

  const { stdout } = await runNealCliResultInCwd(
    cwd,
    '--diagnose',
    loaded.statePath,
    '--question',
    'What changed relative to the clean baseline?',
    '--target',
    'src/neal/orchestrator.ts',
    '--baseline',
    baselineRef,
  );

  const result = JSON.parse(stdout) as {
    ok: boolean;
    diagnosticRecovery: {
      requestedBaselineRef: string | null;
      effectiveBaselineRef: string | null;
      effectiveBaselineSource: string;
    };
  };
  assert.equal(result.ok, true);
  assert.equal(result.diagnosticRecovery.requestedBaselineRef, baselineRef);
  assert.equal(result.diagnosticRecovery.effectiveBaselineRef, baselineRef);
  assert.equal(result.diagnosticRecovery.effectiveBaselineSource, 'explicit');
  assert.match(stdout, /neal --resume/);
});

test('neal --diagnostic-decision records a reference-only recovery outcome for a reviewed recovery plan', async () => {
  const root = await mkdtemp(join(tmpdir(), 'neal-diagnostic-decision-cli-'));
  const cwd = join(root, 'repo');
  await runGit(root, 'init', 'repo');
  await runGit(cwd, 'config', 'user.name', 'Neal Test');
  await runGit(cwd, 'config', 'user.email', 'neal@example.com');
  await runGit(cwd, 'config', 'commit.gpgsign', 'false');
  await writeFile(join(cwd, 'README.md'), 'bootstrap\n', 'utf8');
  await runGit(cwd, 'add', 'README.md');
  await runGit(cwd, 'commit', '-m', 'base commit');
  await writeFile(join(cwd, 'PLAN.md'), '# Plan\n', 'utf8');

  const loaded = await loadOrInitialize(join(cwd, 'PLAN.md'), cwd, getDefaultAgentConfig(), undefined, 'execute', {
    ignoreLocalChanges: true,
  });
  const recoveryPlanPath = join(loaded.state.runDir, 'DIAGNOSTIC_RECOVERY_1_PLAN.md');
  const adoptState = {
    ...loaded.state,
    phase: 'diagnostic_recovery_adopt' as const,
    status: 'running' as const,
    blockedFromPhase: 'reviewer_scope' as const,
    diagnosticRecovery: {
      sequence: 1,
      startedAt: '2026-04-17T00:00:00.000Z',
      sourcePhase: 'blocked' as const,
      resumePhase: 'reviewer_scope' as const,
      parentScopeLabel: '1',
      blockedReason: 'Need a cleaner baseline',
      question: 'What is structurally different about this scope?',
      target: 'src/neal/orchestrator.ts',
      requestedBaselineRef: null,
      effectiveBaselineRef: loaded.state.baseCommit,
      effectiveBaselineSource: 'active_parent_base_commit' as const,
      analysisArtifactPath: join(loaded.state.runDir, 'DIAGNOSTIC_RECOVERY_1_ANALYSIS.md'),
      recoveryPlanPath,
    },
    rounds: [
      {
        round: 1,
        reviewerSessionHandle: 'reviewer-session-recovery-1',
        reviewedPlanPath: recoveryPlanPath,
        normalizationApplied: false,
        normalizationOperations: [],
        normalizationScopeLabelMappings: [],
        commitRange: { base: loaded.state.baseCommit ?? '', head: loaded.state.baseCommit ?? '' },
        openBlockingCanonicalCount: 0,
        findings: [],
      },
    ],
  };
  await writeFile(loaded.statePath, JSON.stringify(adoptState, null, 2) + '\n', 'utf8');

  const { stdout } = await runNealCliResultInCwd(
    cwd,
    '--diagnostic-decision',
    loaded.statePath,
    '--action',
    'reference',
    '--rationale',
    'Keep the recovery artifacts, but do not replace the current scope yet.',
  );

  const result = JSON.parse(stdout) as {
    ok: boolean;
    phase: string;
    status: string;
    diagnosticRecoveryHistory: { decision: string; resultPhase: string; adoptedPlanPath: string | null };
  };
  assert.equal(result.ok, true);
  assert.equal(result.phase, 'blocked');
  assert.equal(result.status, 'blocked');
  assert.equal(result.diagnosticRecoveryHistory.decision, 'keep_as_reference');
  assert.equal(result.diagnosticRecoveryHistory.resultPhase, 'blocked');
  assert.equal(result.diagnosticRecoveryHistory.adoptedPlanPath, null);
});

test('neal --diagnostic-decision adopts a reviewed recovery plan into derived-plan execution', async () => {
  const root = await mkdtemp(join(tmpdir(), 'neal-diagnostic-decision-cli-adopt-'));
  const cwd = join(root, 'repo');
  await runGit(root, 'init', 'repo');
  await runGit(cwd, 'config', 'user.name', 'Neal Test');
  await runGit(cwd, 'config', 'user.email', 'neal@example.com');
  await runGit(cwd, 'config', 'commit.gpgsign', 'false');
  await writeFile(join(cwd, 'README.md'), 'bootstrap\n', 'utf8');
  await runGit(cwd, 'add', 'README.md');
  await runGit(cwd, 'commit', '-m', 'base commit');
  await writeFile(join(cwd, 'PLAN.md'), '# Plan\n', 'utf8');

  const loaded = await loadOrInitialize(join(cwd, 'PLAN.md'), cwd, getDefaultAgentConfig(), undefined, 'execute', {
    ignoreLocalChanges: true,
  });
  const recoveryPlanPath = join(loaded.state.runDir, 'DIAGNOSTIC_RECOVERY_1_PLAN.md');
  await writeFile(
    recoveryPlanPath,
    [
      '## Goal',
      '',
      'Adopt a narrower recovery path.',
      '',
      '## Execution Shape',
      '',
      'executionShape: one_shot',
      '',
    ].join('\n'),
    'utf8',
  );
  const adoptState = {
    ...loaded.state,
    phase: 'diagnostic_recovery_adopt' as const,
    status: 'running' as const,
    blockedFromPhase: 'reviewer_scope' as const,
    currentScopeNumber: 4,
    rounds: [
      {
        round: 1,
        reviewerSessionHandle: 'reviewer-session-recovery-1',
        reviewedPlanPath: recoveryPlanPath,
        normalizationApplied: false,
        normalizationOperations: [],
        normalizationScopeLabelMappings: [],
        commitRange: { base: loaded.state.baseCommit ?? '', head: loaded.state.baseCommit ?? '' },
        openBlockingCanonicalCount: 0,
        findings: [],
      },
    ],
    diagnosticRecovery: {
      sequence: 1,
      startedAt: '2026-04-17T00:00:00.000Z',
      sourcePhase: 'blocked' as const,
      resumePhase: 'reviewer_scope' as const,
      parentScopeLabel: '4',
      blockedReason: 'Need a narrower recovery plan',
      question: 'What should replace the current execution shape?',
      target: 'src/neal/orchestrator.ts',
      requestedBaselineRef: null,
      effectiveBaselineRef: loaded.state.baseCommit,
      effectiveBaselineSource: 'active_parent_base_commit' as const,
      analysisArtifactPath: join(loaded.state.runDir, 'DIAGNOSTIC_RECOVERY_1_ANALYSIS.md'),
      recoveryPlanPath,
    },
  };
  await writeFile(loaded.statePath, JSON.stringify(adoptState, null, 2) + '\n', 'utf8');

  const { stdout } = await runNealCliResultInCwd(
    cwd,
    '--diagnostic-decision',
    loaded.statePath,
    '--action',
    'adopt',
    '--rationale',
    'The reviewed recovery plan is safe to execute next.',
  );

  const result = JSON.parse(stdout) as {
    ok: boolean;
    phase: string;
    status: string;
    diagnosticRecoveryHistory: { decision: string; resultPhase: string; adoptedPlanPath: string | null };
    nextStep: string;
  };
  assert.equal(result.ok, true);
  assert.equal(result.phase, 'awaiting_derived_plan_execution');
  assert.equal(result.status, 'running');
  assert.equal(result.diagnosticRecoveryHistory.decision, 'adopt_recovery_plan');
  assert.equal(result.diagnosticRecoveryHistory.resultPhase, 'awaiting_derived_plan_execution');
  assert.equal(result.diagnosticRecoveryHistory.adoptedPlanPath, recoveryPlanPath);
  assert.match(result.nextStep, /start executing the adopted recovery plan/);
  assert.match(stdout, /neal --resume/);
});

test('neal --diagnostic-decision rejects adoption when the recovery plan review still has blocking findings', async () => {
  const root = await mkdtemp(join(tmpdir(), 'neal-diagnostic-decision-cli-blocked-'));
  const cwd = join(root, 'repo');
  await runGit(root, 'init', 'repo');
  await runGit(cwd, 'config', 'user.name', 'Neal Test');
  await runGit(cwd, 'config', 'user.email', 'neal@example.com');
  await runGit(cwd, 'config', 'commit.gpgsign', 'false');
  await writeFile(join(cwd, 'README.md'), 'bootstrap\n', 'utf8');
  await runGit(cwd, 'add', 'README.md');
  await runGit(cwd, 'commit', '-m', 'base commit');
  await writeFile(join(cwd, 'PLAN.md'), '# Plan\n', 'utf8');

  const loaded = await loadOrInitialize(join(cwd, 'PLAN.md'), cwd, getDefaultAgentConfig(), undefined, 'execute', {
    ignoreLocalChanges: true,
  });
  const recoveryPlanPath = join(loaded.state.runDir, 'DIAGNOSTIC_RECOVERY_1_PLAN.md');
  const adoptState = {
    ...loaded.state,
    phase: 'diagnostic_recovery_adopt' as const,
    status: 'running' as const,
    blockedFromPhase: 'reviewer_scope' as const,
    rounds: [
      {
        round: 1,
        reviewerSessionHandle: 'reviewer-session-recovery-1',
        reviewedPlanPath: recoveryPlanPath,
        normalizationApplied: false,
        normalizationOperations: [],
        normalizationScopeLabelMappings: [],
        commitRange: { base: loaded.state.baseCommit ?? '', head: loaded.state.baseCommit ?? '' },
        openBlockingCanonicalCount: 1,
        findings: ['R1-F1'],
      },
    ],
    findings: [
      {
        id: 'R1-F1',
        canonicalId: 'recovery-scope-too-broad',
        round: 1,
        source: 'reviewer' as const,
        severity: 'blocking' as const,
        files: [recoveryPlanPath],
        claim: 'The recovery plan remains too broad.',
        requiredAction: 'Narrow the plan before adoption.',
        status: 'open' as const,
        roundSummary: 'Recovery plan still needs revision.',
        coderDisposition: null,
        coderCommit: null,
      },
    ],
    diagnosticRecovery: {
      sequence: 1,
      startedAt: '2026-04-17T00:00:00.000Z',
      sourcePhase: 'blocked' as const,
      resumePhase: 'reviewer_scope' as const,
      parentScopeLabel: '1',
      blockedReason: 'Need a cleaner baseline',
      question: 'What is structurally different about this scope?',
      target: 'src/neal/orchestrator.ts',
      requestedBaselineRef: null,
      effectiveBaselineRef: loaded.state.baseCommit,
      effectiveBaselineSource: 'active_parent_base_commit' as const,
      analysisArtifactPath: join(loaded.state.runDir, 'DIAGNOSTIC_RECOVERY_1_ANALYSIS.md'),
      recoveryPlanPath,
    },
  };
  await writeFile(loaded.statePath, JSON.stringify(adoptState, null, 2) + '\n', 'utf8');

  const result = await runNealCliFailureInCwd(
    cwd,
    '--diagnostic-decision',
    loaded.statePath,
    '--action',
    'adopt',
  );

  assert.equal(result.code, 1);
  assert.match(result.stderr, /Cannot adopt diagnostic recovery while recovery-plan review still has open blocking findings/);
});

test('neal rejects an empty execute-text argument clearly', async () => {
  const result = await runNealCliFailure('--execute-text', '');
  assert.equal(result.code, 1);
  assert.match(result.stderr, /--execute-text requires a non-empty inline plan string argument/);
});

test('neal rejects a missing execute-file argument clearly', async () => {
  const result = await runNealCliFailure('--execute-file', '--coder-model', 'gpt-5.4');
  assert.equal(result.code, 1);
  assert.match(result.stderr, /--execute-file requires a plan file path argument/);
});

test('neal rejects conflicting execute-input source flags clearly', async () => {
  const result = await runNealCliFailure('--execute', 'PLAN.md', '--execute-text', '# Plan');
  assert.equal(result.code, 1);
  assert.match(result.stderr, /Choose exactly one execute input source: --execute, --execute-file, or --execute-text/);
});

test('neal rejects mixed top-level plan and execute modes clearly regardless of ordering', async () => {
  const result = await runNealCliFailure('--execute-text', '# Plan', '--plan', 'PLAN.md');
  assert.equal(result.code, 1);
  assert.match(result.stderr, /Choose exactly one execute input source: --execute, --execute-file, or --execute-text/);
});

test('neal points file-mode misses at execute-text explicitly', async () => {
  const result = await runNealCliFailure('--execute-file', 'missing-plan.md');
  assert.equal(result.code, 1);
  assert.match(result.stderr, /File mode requires an existing plan file path: missing-plan\.md/);
  assert.match(result.stderr, /Did you mean --execute-text\?/);
});
