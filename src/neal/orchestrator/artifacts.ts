import { writeFile } from 'node:fs/promises';
import { basename, join } from 'node:path';

import { writeRecoveryMarkdown } from '../support.js';
import { getFinalCompletionReviewArtifactPath, writeFinalCompletionReviewMarkdown } from '../final-completion-review.js';
import { writePlanProgressArtifacts } from '../progress.js';
import { writeReviewMarkdown } from '../review.js';
import { writeRunNarrativeArtifacts } from '../run-narrative.js';
import { hasFinalCompletionReviewState } from '../state-views.js';
import type { ManualGateResumeCheck, OrchestrationState } from '../types.js';

export async function writeExecutionArtifacts(state: OrchestrationState) {
  await writeReviewMarkdown(state.reviewMarkdownPath, state);
  await writeRecoveryMarkdown(state.recoveryMarkdownPath, state);
  await writePlanProgressArtifacts(state);
  if (hasFinalCompletionReviewState(state)) {
    await writeFinalCompletionReviewMarkdown(getFinalCompletionReviewArtifactPath(state.runDir), state);
  }
  await writeRunNarrativeArtifacts(state);
}

export function validateManualGateId(id: string) {
  const trimmed = id.trim();
  if (!trimmed) {
    throw new Error('Manual gate id must be non-empty.');
  }
  if (
    trimmed.includes('..') ||
    trimmed.includes('/') ||
    trimmed.includes('\\') ||
    !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(trimmed)
  ) {
    throw new Error(`Manual gate id ${JSON.stringify(id)} cannot safely form a gate artifact filename.`);
  }

  return trimmed;
}

export function getManualGateArtifactPath(runDir: string, gateId: string) {
  return join(runDir, `GATE-${validateManualGateId(gateId)}.md`);
}

export async function writeManualGateArtifact(args: {
  state: OrchestrationState;
  id: string;
  title: string;
  reason: string;
  instructionsMarkdown: string;
  resumeChecks: ManualGateResumeCheck[];
}) {
  const id = validateManualGateId(args.id);
  const artifactPath = getManualGateArtifactPath(args.state.runDir, id);
  const runId = basename(args.state.runDir);
  const lines = [
    `# ${args.title.trim()}`,
    '',
    '## Reason',
    '',
    args.reason.trim(),
    '',
    '## Instructions',
    '',
    args.instructionsMarkdown.trim(),
    '',
    '## Resume Checks',
    '',
    ...args.resumeChecks.flatMap((check) => renderResumeCheck(check)),
    '## Resume',
    '',
    `Run \`neal resume --run ${runId}\` after the manual work is complete.`,
    '',
    'Neal will resume the same `coder_scope` after these checks pass.',
    '',
  ];

  await writeFile(artifactPath, `${lines.join('\n').trimEnd()}\n`, 'utf8');
  return artifactPath;
}

function renderResumeCheck(check: ManualGateResumeCheck) {
  return [
    `- ${check.name}`,
    `  - argv: \`${JSON.stringify(check.command)}\``,
    `  - cwd: \`${check.cwd ?? 'repo'}\``,
    ...(check.timeoutMs === undefined ? [] : [`  - timeoutMs: \`${check.timeoutMs}\``]),
    '',
  ];
}
