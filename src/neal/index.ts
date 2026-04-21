#!/usr/bin/env node

import 'dotenv/config';

import { spawn } from 'node:child_process';
import { access, rm } from 'node:fs/promises';
import { resolve } from 'node:path';
import process from 'node:process';
import readline from 'node:readline';

import {
  InteractiveBlockedRecoveryPendingTurnError,
  loadOrInitialize,
  recordInteractiveBlockedRecoveryGuidance,
  resolveDiagnosticRecovery,
  startDiagnosticRecovery,
  runOnePass,
} from './orchestrator.js';
import { buildUsageLines, parseNewRunArgs, parseSquashArgs } from './cli.js';
import { clearDiagnosticFooter, configureDiagnosticFooter, writeDiagnostic } from './diagnostic.js';
import { resolveExecuteInput } from './input-source.js';
import type { RunLogger } from './logger.js';
import { assertSupportedAgentConfig } from './providers/registry.js';
import {
  countOpenNonBlockingFindings,
  determinePlanRefinementConvergence,
  formatPlanRefinementSummary,
  isPlanRefinementState,
  planRefinementExitCode,
} from './plan-refinement.js';
import { buildSquashCommitMessage, executeSquashForRun, selectSquashRunForPlan, validateSelectedRunForSquash } from './squash.js';
import { StatusFooter } from './status-footer.js';
import { getDefaultAgentConfig, loadState } from './state.js';
import { showSummaries } from './summaries.js';
import { CoderRoundError, ReviewerRoundError } from './agents.js';
import type { AgentProvider, OrchestrationState } from './types.js';

type SessionLaunchCommand = {
  command: string;
  args: string[];
};

type SessionLaunchTarget = {
  role: 'coder' | 'reviewer';
  provider: AgentProvider;
  sessionHandle: string;
};

type SquashPreviewArgs = {
  selection: Awaited<ReturnType<typeof selectSquashRunForPlan>>;
  validation: Awaited<ReturnType<typeof validateSelectedRunForSquash>>;
  commitMessage: Awaited<ReturnType<typeof buildSquashCommitMessage>>;
};

function usage(): never {
  for (const line of buildUsageLines()) {
    console.error(line);
  }
  process.exit(1);
}

function writeSquashPreview({ selection, validation, commitMessage }: SquashPreviewArgs) {
  const lines = [
    `[neal] selected squash run: ${selection.selected.runId}`,
    `[neal] run dir: ${selection.selected.runDir}`,
    `[neal] plan doc: ${selection.normalizedPlanDoc}`,
    `[neal] base commit: ${validation.baseCommit}`,
    `[neal] final commit: ${validation.finalCommit}`,
    '[neal] commits to replace:',
    ...validation.createdCommits.map((commit) => `  - ${commit}`),
    `[neal] commit message source: ${commitMessage.source}`,
    '[neal] generated commit message:',
    commitMessage.message,
  ];

  if (selection.selectionWarning) {
    lines.splice(2, 0, `[neal] ${selection.selectionWarning}`);
  }

  process.stderr.write(lines.join('\n') + '\n');
}

async function confirmSquashRewrite() {
  if (!process.stdin.isTTY || !process.stderr.isTTY) {
    process.stderr.write('[neal] Proceed with squash rewrite? [y/N] ');
    process.stdin.setEncoding('utf8');
    let buffer = '';
    for await (const chunk of process.stdin) {
      buffer += chunk;
      if (buffer.includes('\n')) {
        break;
      }
    }

    const normalized = buffer.trim().toLowerCase();
    if (normalized !== 'y' && normalized !== 'yes') {
      throw new Error('neal --squash aborted; no history was rewritten');
    }
    return;
  }

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stderr,
    terminal: true,
  });

  try {
    const answer = await new Promise<string>((resolve) => {
      rl.question('[neal] Proceed with squash rewrite? [y/N] ', resolve);
    });
    const normalized = answer.trim().toLowerCase();
    if (normalized !== 'y' && normalized !== 'yes') {
      throw new Error('neal --squash aborted; no history was rewritten');
    }
  } finally {
    rl.close();
  }
}

function getActiveHandleSummary() {
  const getActiveHandles = (process as typeof process & { _getActiveHandles?: () => unknown[] })._getActiveHandles;
  const getActiveRequests = (process as typeof process & { _getActiveRequests?: () => unknown[] })._getActiveRequests;
  const activeResourcesInfo = 'getActiveResourcesInfo' in process ? process.getActiveResourcesInfo?.() ?? [] : [];
  const handles = getActiveHandles ? getActiveHandles.call(process) : [];
  const requests = getActiveRequests ? getActiveRequests.call(process) : [];

  return {
    resourceTypes: Array.from(new Set(activeResourcesInfo)).sort(),
    handles: handles.map(summarizeActiveEntry),
    requests: requests.map(summarizeActiveEntry),
  };
}

function summarizeActiveEntry(entry: unknown) {
  if (!entry || typeof entry !== 'object') {
    return { type: typeof entry };
  }

  const candidate = entry as {
    constructor?: { name?: string };
    fd?: unknown;
    path?: unknown;
    bytesRead?: unknown;
    bytesWritten?: unknown;
    pending?: unknown;
    readable?: unknown;
    writable?: unknown;
    connecting?: unknown;
    destroyed?: unknown;
    localAddress?: unknown;
    localPort?: unknown;
    remoteAddress?: unknown;
    remotePort?: unknown;
  };

  return {
    type: candidate.constructor?.name ?? 'unknown',
    fd: typeof candidate.fd === 'number' ? candidate.fd : undefined,
    path: typeof candidate.path === 'string' ? candidate.path : undefined,
    pending: typeof candidate.pending === 'boolean' ? candidate.pending : undefined,
    readable: typeof candidate.readable === 'boolean' ? candidate.readable : undefined,
    writable: typeof candidate.writable === 'boolean' ? candidate.writable : undefined,
    connecting: typeof candidate.connecting === 'boolean' ? candidate.connecting : undefined,
    destroyed: typeof candidate.destroyed === 'boolean' ? candidate.destroyed : undefined,
    bytesRead: typeof candidate.bytesRead === 'number' ? candidate.bytesRead : undefined,
    bytesWritten: typeof candidate.bytesWritten === 'number' ? candidate.bytesWritten : undefined,
    localAddress: typeof candidate.localAddress === 'string' ? candidate.localAddress : undefined,
    localPort: typeof candidate.localPort === 'number' ? candidate.localPort : undefined,
    remoteAddress: typeof candidate.remoteAddress === 'string' ? candidate.remoteAddress : undefined,
    remotePort: typeof candidate.remotePort === 'number' ? candidate.remotePort : undefined,
  };
}

function armShutdownWatchdog(finalState: OrchestrationState, logger: RunLogger) {
  const armedAt = Date.now();
  const timeout = setTimeout(() => {
    const elapsedMs = Date.now() - armedAt;
    const active = getActiveHandleSummary();
    const resourceSummary = active.resourceTypes.length > 0 ? active.resourceTypes.join(', ') : '(none reported)';
    writeDiagnostic(
      `[neal:debug] process still alive ${elapsedMs}ms after final output; active resources: ${resourceSummary}\n`,
      logger,
    );
    void logger.event('shutdown.hang_detected', {
      elapsedMs,
      phase: finalState.phase,
      status: finalState.status,
      topLevelMode: finalState.topLevelMode,
      runDir: finalState.runDir,
      activeResources: active,
    });
  }, 5000);
  timeout.unref();

  return async () => {
    clearTimeout(timeout);
    await logger.event('shutdown.watchdog_cleared', {
      phase: finalState.phase,
      status: finalState.status,
      runDir: finalState.runDir,
    });
  };
}

async function executeRun(state: Awaited<ReturnType<typeof loadOrInitialize>>['state'], statePath: string, logger: RunLogger) {
  runLogger = logger;
  const footer = new StatusFooter();
  configureDiagnosticFooter(footer);
  let displayedPhaseStartedAt = Date.now();
  await footer.setState(state, displayedPhaseStartedAt);
  const stopController = createStopController();
  let lastCoderSessionHandle: string | null = state.coderSessionHandle;
  let shouldResumeLastThread = false;

  if (process.stdin.isTTY) {
    writeDiagnostic('[neal] press q to stop after the current scope\n');
  }

  let finalState;
  try {
    finalState = await runOnePass(state, statePath, logger, {
      shouldStopAfterCurrentScope() {
        return stopController.isStopRequested();
      },
      onCoderSessionHandle(sessionHandle) {
        if (sessionHandle) {
          lastCoderSessionHandle = sessionHandle;
        }
      },
      onDisplayState(nextState, phaseStartedAt) {
        displayedPhaseStartedAt = phaseStartedAt;
        return footer.setState(nextState, phaseStartedAt);
      },
    });
    shouldResumeLastThread =
      stopController.isStopRequested() &&
      finalState.phase === 'coder_scope' &&
      finalState.status === 'running' &&
      Boolean(lastCoderSessionHandle);
  } finally {
    stopController.cleanup();
  }

  const interactiveBlockedRecovery = finalState.interactiveBlockedRecovery;
  const waitingForOperatorGuidance =
    finalState.phase === 'interactive_blocked_recovery' && interactiveBlockedRecovery
      ? interactiveBlockedRecovery.turns.length === interactiveBlockedRecovery.lastHandledTurn &&
        !interactiveBlockedRecovery.pendingDirective
      : false;

  if (waitingForOperatorGuidance) {
    await footer.setState(finalState, displayedPhaseStartedAt);
    writeDiagnostic(`[neal] waiting for operator guidance; use: neal --recover ${statePath} --message \"...\"\n`);
  }

  await logger.event('shutdown.final_output_begin', {
    phase: finalState.phase,
    status: finalState.status,
    waitingForOperatorGuidance,
    shouldResumeLastThread,
    lastCoderSessionHandle,
    runDir: finalState.runDir,
  });

  process.stdout.write(
    JSON.stringify(
      {
        ok: true,
        waitingForOperatorGuidance,
        phase: finalState.phase,
        status: finalState.status,
        topLevelMode: finalState.topLevelMode,
        agentConfig: finalState.agentConfig,
        planDoc: finalState.planDoc,
        planDocBackupPath: finalState.planDocBackupPath,
        statePath,
        runDir: finalState.runDir,
        progressJsonPath: finalState.progressJsonPath,
        progressMarkdownPath: finalState.progressMarkdownPath,
        reviewMarkdownPath: finalState.reviewMarkdownPath,
        archivedReviewPath: finalState.archivedReviewPath,
        baseCommit: finalState.baseCommit,
        finalCommit: finalState.finalCommit,
        coderSessionHandle: finalState.coderSessionHandle,
        reviewerSessionHandle: finalState.reviewerSessionHandle,
        rounds: finalState.rounds.length,
        findings: finalState.findings.length,
      },
      null,
      2,
    ) + '\n',
  );

  await logger.event('shutdown.final_output_written', {
    phase: finalState.phase,
    status: finalState.status,
    waitingForOperatorGuidance,
    runDir: finalState.runDir,
  });

  if (isPlanRefinementState(finalState)) {
    const convergenceReason = determinePlanRefinementConvergence(finalState);
    if (convergenceReason !== null) {
      const summary = formatPlanRefinementSummary({
        rounds: finalState.rounds.length,
        backupPath: finalState.planDocBackupPath,
        convergenceReason,
        residualNonBlocking: countOpenNonBlockingFindings(finalState),
      });
      writeDiagnostic(`${summary}\n`);
      await logger.event('plan_refinement.summary', {
        rounds: finalState.rounds.length,
        backupPath: finalState.planDocBackupPath,
        convergenceReason,
        residualNonBlocking: countOpenNonBlockingFindings(finalState),
      });
      const exitCode = planRefinementExitCode(convergenceReason);
      if (exitCode !== 0) {
        process.exitCode = exitCode;
      }
    }
  }

  const clearShutdownWatchdog = armShutdownWatchdog(finalState, logger);

  if (shouldResumeLastThread && lastCoderSessionHandle) {
    writeDiagnostic(`[neal] resuming ${lastCoderSessionHandle}\n`);
    await logger.event('shutdown.resuming_last_coder_thread', {
      sessionHandle: lastCoderSessionHandle,
      provider: finalState.agentConfig.coder.provider,
      runDir: finalState.runDir,
    });
    clearDiagnosticFooter();
    await resumeLastCoderSession(finalState.agentConfig.coder.provider, lastCoderSessionHandle);
  }

  clearDiagnosticFooter();
  await logger.event('shutdown.footer_cleared', {
    phase: finalState.phase,
    status: finalState.status,
    runDir: finalState.runDir,
  });
  await clearShutdownWatchdog();
}

async function resumeLastCoderSession(provider: AgentProvider, sessionHandle: string) {
  await openSession({
    role: 'coder',
    provider,
    sessionHandle,
  });
}

async function spawnLaunchCommand({ command, args }: SessionLaunchCommand) {
  await new Promise<void>((resolvePromise, rejectPromise) => {
    const child = spawn(command, args, {
      stdio: 'inherit',
    });

    child.on('error', rejectPromise);
    child.on('exit', (code, signal) => {
      if (signal) {
        rejectPromise(new Error(`${command} ${args.join(' ')} terminated by signal ${signal}`));
        return;
      }

      if (code === 0) {
        resolvePromise();
      } else {
        rejectPromise(new Error(`${command} ${args.join(' ')} exited with status ${code}`));
      }
    });
  });
}

function getSessionLaunchCommand(provider: AgentProvider, sessionHandle: string): SessionLaunchCommand {
  switch (provider) {
    case 'openai-codex':
      return {
        command: 'codex',
        args: ['resume', sessionHandle],
      };
    case 'anthropic-claude':
      return {
        command: 'claude',
        args: ['--resume', sessionHandle],
      };
  }
}

async function openSession(target: SessionLaunchTarget) {
  clearDiagnosticFooter();
  const launch = getSessionLaunchCommand(target.provider, target.sessionHandle);
  writeDiagnostic(`[neal] opening ${target.role} session via ${launch.command} ${launch.args.join(' ')}\n`);
  await spawnLaunchCommand(launch);
}

async function openPersistedSession(role: 'coder' | 'reviewer', statePath: string) {
  const state = await loadState(statePath);
  const roleConfig = role === 'coder' ? state.agentConfig.coder : state.agentConfig.reviewer;
  const sessionHandle = role === 'coder' ? state.coderSessionHandle : state.reviewerSessionHandle;

  if (!sessionHandle) {
    throw new Error(`No persisted ${role} session handle found in ${statePath}`);
  }

  await openSession({
    role,
    provider: roleConfig.provider,
    sessionHandle,
  });
}

function createStopController() {
  let stopRequested = false;

  if (!process.stdin.isTTY) {
    return {
      cleanup() {},
      isStopRequested() {
        return stopRequested;
      },
    };
  }

  readline.emitKeypressEvents(process.stdin);
  process.stdin.setRawMode(true);
  process.stdin.resume();

  const onKeypress = (_input: string, key: readline.Key) => {
    if (key.ctrl && key.name === 'c') {
      cleanup();
      clearDiagnosticFooter();
      process.exit(130);
    }

    if (key.name === 'q') {
      stopRequested = !stopRequested;
      writeDiagnostic(
        stopRequested
          ? '\n[neal] stop requested after the current scope\n'
          : '\n[neal] stop request cleared; continuing after the current scope\n',
      );
    }
  };

  process.stdin.on('keypress', onKeypress);

  function cleanup() {
    process.stdin.off('keypress', onKeypress);
    if (process.stdin.isTTY) {
      process.stdin.setRawMode(false);
    }
    process.stdin.pause();
  }

  return {
    cleanup,
    isStopRequested() {
      return stopRequested;
    },
  };
}

async function main() {
  const args = process.argv.slice(2);
  if (args.length === 0) {
    usage();
  }

  if (args[0] === '--summaries') {
    await showSummaries(args[1]);
    return;
  }

  if (args[0] === '--squash') {
    const parsed = parseSquashArgs(args);
    const selection = await selectSquashRunForPlan({
      cwd: process.cwd(),
      planDocArg: parsed.planDoc,
    });
    const validation = await validateSelectedRunForSquash({
      cwd: process.cwd(),
      selected: selection.selected,
    });
    const commitMessage = await buildSquashCommitMessage({
      cwd: process.cwd(),
      selected: selection.selected,
    });
    writeSquashPreview({
      selection,
      validation,
      commitMessage,
    });
    if (parsed.dryRun) {
      process.stderr.write('[neal] dry run only; no history was rewritten\n');
      process.stdout.write(
        JSON.stringify(
          {
            ok: true,
            mode: 'squash_selection',
            dryRun: true,
            yes: parsed.yes,
            rewriteReady: true,
            planDoc: selection.normalizedPlanDoc,
            selectedRunDir: selection.selected.runDir,
            selectedRunId: selection.selected.runId,
            completedMatchCount: selection.completedMatchCount,
            selectionWarning: selection.selectionWarning,
            baseCommit: validation.baseCommit,
            finalCommit: validation.finalCommit,
            createdCommits: validation.createdCommits,
            commitMessageSource: commitMessage.source,
            commitMessage: commitMessage.message,
            nextStep: 'Re-run with --yes to rewrite the selected run-owned commit range.',
          },
          null,
          2,
        ) + '\n',
      );
      return;
    }

    if (!parsed.yes) {
      await confirmSquashRewrite();
    }

    const execution = await executeSquashForRun({
      cwd: process.cwd(),
      selected: selection.selected,
      validation,
      commitMessage,
    });
    process.stdout.write(
      JSON.stringify(
        {
          ok: true,
          mode: 'squash_result',
          dryRun: false,
          yes: true,
          rewriteReady: true,
          planDoc: selection.normalizedPlanDoc,
          selectedRunDir: selection.selected.runDir,
          selectedRunId: selection.selected.runId,
          completedMatchCount: selection.completedMatchCount,
          selectionWarning: selection.selectionWarning,
          baseCommit: validation.baseCommit,
          finalCommit: validation.finalCommit,
          createdCommits: validation.createdCommits,
          commitMessageSource: commitMessage.source,
          commitMessage: commitMessage.message,
          replacementCommit: execution.replacementCommit,
          squashArtifactPath: execution.artifactPath,
        },
        null,
        2,
      ) + '\n',
    );
    return;
  }

  if (args[0] === '--recover') {
    let statePath = resolve('.neal/session.json');
    let message: string | null = null;
    let index = 1;

    if (args[index] && !args[index].startsWith('--')) {
      statePath = resolve(args[index]);
      index += 1;
    }

    while (index < args.length) {
      const flag = args[index];
      const value = args[index + 1];
      switch (flag) {
        case '--message':
          if (!value) {
            throw new Error('--recover requires a value for --message');
          }
          message = value;
          index += 2;
          break;
        default:
          throw new Error(`Unknown argument: ${flag}`);
      }
    }

    if (!message) {
      throw new Error('neal --recover requires --message <guidance>');
    }

    await access(statePath);
    const loaded = await loadOrInitialize(null, process.cwd(), getDefaultAgentConfig(), statePath, 'execute');
    assertSupportedAgentConfig(loaded.state.agentConfig);
    if (loaded.state.topLevelMode !== 'execute') {
      throw new Error('--recover is only supported for execute-mode runs');
    }
    let nextState;
    try {
      nextState = await recordInteractiveBlockedRecoveryGuidance(loaded.statePath, message, loaded.logger);
    } catch (error) {
      if (error instanceof InteractiveBlockedRecoveryPendingTurnError) {
        process.stdout.write(
          JSON.stringify(
            {
              ok: false,
              code: 'interactive_blocked_recovery_pending_turn',
              message: error.message,
              statePath: loaded.statePath,
              runDir: loaded.state.runDir,
              pendingTurn: error.pendingTurn,
              recoveryTurns: loaded.state.interactiveBlockedRecovery?.turns.length ?? 0,
              nextStep: 'Run `neal --resume` to let the coder handle the pending recovery turn before recording more guidance.',
            },
            null,
            2,
          ) + '\n',
        );
        return;
      }
      throw error;
    }
    writeDiagnostic(`[neal] recovery guidance recorded; run: neal --resume ${loaded.statePath}\n`);
    process.stdout.write(
      JSON.stringify(
        {
          ok: true,
          phase: nextState.phase,
          status: nextState.status,
          statePath: loaded.statePath,
          runDir: nextState.runDir,
          recoveryTurns: nextState.interactiveBlockedRecovery?.turns.length ?? 0,
          terminalDirectivePending: nextState.interactiveBlockedRecovery?.pendingDirective?.terminalOnly ?? false,
          nextStep: `Run \`neal --resume ${loaded.statePath}\` to process the recovery guidance.`,
        },
        null,
        2,
      ) + '\n',
    );
    return;
  }

  if (args[0] === '--diagnose') {
    let statePath = resolve('.neal/session.json');
    let question: string | null = null;
    let target: string | null = null;
    let baseline: string | null = null;
    let index = 1;

    if (args[index] && !args[index].startsWith('--')) {
      statePath = resolve(args[index]);
      index += 1;
    }

    while (index < args.length) {
      const flag = args[index];
      const value = args[index + 1];
      switch (flag) {
        case '--question':
          if (!value) {
            throw new Error('--diagnose requires a value for --question');
          }
          question = value;
          index += 2;
          break;
        case '--target':
          if (!value) {
            throw new Error('--diagnose requires a value for --target');
          }
          target = value;
          index += 2;
          break;
        case '--baseline':
          if (!value) {
            throw new Error('--diagnose requires a value for --baseline');
          }
          baseline = value;
          index += 2;
          break;
        default:
          throw new Error(`Unknown argument: ${flag}`);
      }
    }

    if (!question) {
      throw new Error('neal --diagnose requires --question "<diagnostic question>"');
    }
    if (!target) {
      throw new Error('neal --diagnose requires --target "<files-or-component>"');
    }

    await access(statePath);
    const loaded = await loadOrInitialize(null, process.cwd(), getDefaultAgentConfig(), statePath, 'execute');
    assertSupportedAgentConfig(loaded.state.agentConfig);
    const nextState = await startDiagnosticRecovery(
      loaded.statePath,
      {
        question,
        target,
        baselineRef: baseline,
      },
      loaded.logger,
    );
    writeDiagnostic(`[neal] diagnostic recovery initialized; inspect with: neal --resume ${loaded.statePath}\n`);
    process.stdout.write(
      JSON.stringify(
        {
          ok: true,
          phase: nextState.phase,
          status: nextState.status,
          statePath: loaded.statePath,
          runDir: nextState.runDir,
          diagnosticRecovery: nextState.diagnosticRecovery,
          nextStep: `Run \`neal --resume ${loaded.statePath}\` to inspect the diagnostic-recovery session.`,
        },
        null,
        2,
      ) + '\n',
    );
    return;
  }

  if (args[0] === '--diagnostic-decision') {
    let statePath = resolve('.neal/session.json');
    let action: 'adopt_recovery_plan' | 'keep_as_reference' | 'cancel' | null = null;
    let rationale: string | null = null;
    let index = 1;

    if (args[index] && !args[index].startsWith('--')) {
      statePath = resolve(args[index]);
      index += 1;
    }

    while (index < args.length) {
      const flag = args[index];
      const value = args[index + 1];
      switch (flag) {
        case '--action':
          if (!value) {
            throw new Error('--diagnostic-decision requires a value for --action');
          }
          if (value === 'adopt') {
            action = 'adopt_recovery_plan';
          } else if (value === 'reference') {
            action = 'keep_as_reference';
          } else if (value === 'cancel') {
            action = 'cancel';
          } else {
            throw new Error('--diagnostic-decision --action must be one of: adopt, reference, cancel');
          }
          index += 2;
          break;
        case '--rationale':
          if (!value) {
            throw new Error('--diagnostic-decision requires a value for --rationale');
          }
          rationale = value;
          index += 2;
          break;
        default:
          throw new Error(`Unknown argument: ${flag}`);
      }
    }

    if (!action) {
      throw new Error('neal --diagnostic-decision requires --action <adopt|reference|cancel>');
    }

    await access(statePath);
    const loaded = await loadOrInitialize(null, process.cwd(), getDefaultAgentConfig(), statePath, 'execute');
    assertSupportedAgentConfig(loaded.state.agentConfig);
    const nextState = await resolveDiagnosticRecovery(
      loaded.statePath,
      {
        decision: action,
        rationale,
      },
      loaded.logger,
    );
    const nextStep =
      action === 'adopt_recovery_plan'
        ? `Run \`neal --resume ${loaded.statePath}\` to start executing the adopted recovery plan.`
        : `The original run remains paused; inspect with \`neal --resume ${loaded.statePath}\` or start another diagnostic recovery later with \`neal --diagnose ${loaded.statePath} ...\`.`;
    writeDiagnostic(`[neal] diagnostic recovery decision recorded: ${action}\n`);
    process.stdout.write(
      JSON.stringify(
        {
          ok: true,
          phase: nextState.phase,
          status: nextState.status,
          statePath: loaded.statePath,
          runDir: nextState.runDir,
          diagnosticRecoveryHistory: nextState.diagnosticRecoveryHistory.at(-1) ?? null,
          nextStep,
        },
        null,
        2,
      ) + '\n',
    );
    return;
  }

  const firstArg = args[0];
  if (!firstArg) {
    usage();
  }

  if (firstArg === '--resume-coder' || firstArg === '--resume-reviewer') {
    if (args.length > 2) {
      throw new Error(`${firstArg} accepts only an optional state-file path`);
    }
    const statePath = resolve(args[1] ?? '.neal/session.json');
    await access(statePath);
    await openPersistedSession(firstArg === '--resume-coder' ? 'coder' : 'reviewer', statePath);
    return;
  }

  if (firstArg === '--resume') {
    if (args.length > 2) {
      throw new Error('neal --resume accepts only an optional state-file path and does not accept agent config flags');
    }
    const resumeStatePath = resolve(args[1] ?? '.neal/session.json');
    await access(resumeStatePath);
    const loaded = await loadOrInitialize(null, process.cwd(), getDefaultAgentConfig(), resumeStatePath, 'execute');
    assertSupportedAgentConfig(loaded.state.agentConfig);
    await executeRun(loaded.state, loaded.statePath, loaded.logger);
    return;
  }
  const parsed = parseNewRunArgs(args, getDefaultAgentConfig());
  assertSupportedAgentConfig(parsed.agentConfig);

  let planDoc = parsed.planDoc;
  let runDir: string | undefined;
  if (parsed.topLevelMode === 'plan') {
    try {
      planDoc = resolve(process.cwd(), parsed.planDoc ?? '');
      await access(planDoc);
    } catch {
      throw new Error(`Plan file not found: ${parsed.planDoc}`);
    }
  } else if (parsed.executeInputSource) {
    const resolvedInput = await resolveExecuteInput(parsed.executeInputSource, process.cwd());
    planDoc = resolvedInput.planDoc;
    runDir = resolvedInput.runDir;
  }

  let loaded;
  try {
    loaded = await loadOrInitialize(planDoc, process.cwd(), parsed.agentConfig, undefined, parsed.topLevelMode, {
      ignoreLocalChanges: parsed.ignoreLocalChanges,
      runDir,
    });
  } catch (error) {
    if (parsed.topLevelMode === 'execute' && runDir) {
      await rm(runDir, { recursive: true, force: true });
    }
    throw error;
  }
  assertSupportedAgentConfig(loaded.state.agentConfig);
  await executeRun(loaded.state, loaded.statePath, loaded.logger);
}

let runLogger: RunLogger | undefined;

void main().catch((error: unknown) => {
  clearDiagnosticFooter();
  const message = error instanceof Error ? error.message : String(error);
  void runLogger?.event('run.failed', {
    message,
    coderSessionHandle: error instanceof CoderRoundError ? error.sessionHandle : null,
    reviewerSessionHandle: error instanceof ReviewerRoundError ? error.sessionHandle : null,
    reviewerSubtype: error instanceof ReviewerRoundError ? error.subtype : null,
  });
  if (error instanceof Error && error.stack) {
    void runLogger?.stderr(`[fatal] ${error.stack}\n`);
  } else {
    void runLogger?.stderr(`[fatal] ${message}\n`);
  }
  if (error instanceof CoderRoundError && error.sessionHandle) {
    writeDiagnostic(`[neal] ${message} (coder session: ${error.sessionHandle})\n`);
  } else if (error instanceof ReviewerRoundError && error.sessionHandle) {
    writeDiagnostic(`[neal] ${message} (reviewer session: ${error.sessionHandle})\n`);
  } else {
    writeDiagnostic(`[neal] ${message}\n`);
  }
  process.exit(1);
});
