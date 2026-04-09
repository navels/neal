#!/usr/bin/env node

import { spawn } from 'node:child_process';
import { access, readFile } from 'node:fs/promises';
import { basename, resolve } from 'node:path';
import process from 'node:process';
import readline from 'node:readline';

import { Codex, type AgentMessageItem, type ThreadItem } from '@openai/codex-sdk';
import { notify, type NotificationKind } from './notifier.js';

const AUTONOMY_CHUNK_DONE = 'AUTONOMY_CHUNK_DONE';
const AUTONOMY_DONE = 'AUTONOMY_DONE';
const AUTONOMY_BLOCKED = 'AUTONOMY_BLOCKED';

type Marker = typeof AUTONOMY_CHUNK_DONE | typeof AUTONOMY_DONE | typeof AUTONOMY_BLOCKED;

type ChunkResult = {
  finalResponse: string;
  marker: Marker | null;
  threadId: string | null;
};

type ChunkAttemptResult = ChunkResult & {
  fatalError: string | null;
};

function usage(): never {
  console.error('Usage: codex-chunked <plan-doc>');
  process.exit(1);
}

function buildPrompt(planDoc: string): string {
  return [
    `Continue autonomously on the task described in ${planDoc}.`,
    '',
    'Before doing anything else:',
    `1. Read ${planDoc}.`,
    '2. Read any companion docs or required-context files explicitly referenced by that plan before starting work.',
    '3. Reset your instructions for this turn from the current contents of that plan and its required context.',
    '',
    'Then execute exactly one meaningful chunk.',
    'Do not start a second chunk in this turn.',
    'Treat AUTONOMY_BLOCKED as a last resort, not an early exit.',
    'Before declaring yourself blocked, first exhaust reasonable in-repo recovery attempts such as reading more code, checking adjacent implementations, tracing call sites, inspecting tests, running targeted commands, and trying the most plausible fix.',
    'Do not stop just because the task is messy, broad, unfamiliar, or requires deeper investigation.',
    'Only declare AUTONOMY_BLOCKED when progress on this chunk truly requires missing external information, a user decision, unavailable credentials/access, or a risky unresolved ambiguity that cannot be safely resolved from the repository and available tools.',
    'If you are blocked, stop and report the exact blocker, the recovery attempts you made, and the smallest concrete input needed to continue.',
    '',
    "Follow the plan doc's verification steps exactly.",
    '',
    'Final line must be exactly one of:',
    `- ${AUTONOMY_CHUNK_DONE}`,
    `- ${AUTONOMY_DONE}`,
    `- ${AUTONOMY_BLOCKED}`,
    '- Do not use AUTONOMY_* markers for any other reason.',
  ].join('\n');
}

function buildRetryPrompt(planDoc: string): string {
  return [
    `The previous turn for ${planDoc} was interrupted by a transient transport or service error.`,
    '',
    'Recover carefully before doing anything else:',
    `1. Read ${planDoc} again.`,
    '2. Read any companion docs or required-context files explicitly referenced by that plan before starting work.',
    '3. Inspect the current repository state and determine whether the previous turn already completed its one chunk.',
    '4. If that chunk already completed, do not perform additional work. Summarize the completed chunk and emit the correct final marker only.',
    '5. If the chunk did not complete, continue and finish exactly one meaningful chunk.',
    '6. Treat AUTONOMY_BLOCKED as a last resort, not an early exit.',
    '7. Before declaring yourself blocked, first exhaust reasonable in-repo recovery attempts such as reading more code, checking adjacent implementations, tracing call sites, inspecting tests, running targeted commands, and trying the most plausible fix.',
    '8. Do not stop just because the task is messy, broad, unfamiliar, or requires deeper investigation.',
    '9. Only declare AUTONOMY_BLOCKED when progress on this chunk truly requires missing external information, a user decision, unavailable credentials/access, or a risky unresolved ambiguity that cannot be safely resolved from the repository and available tools.',
    '10. If you are blocked, stop and report the exact blocker, the recovery attempts you made, and the smallest concrete input needed to continue.',
    '',
    "Follow the plan doc's verification steps exactly.",
    '',
    'Final line must be exactly one of:',
    `- ${AUTONOMY_CHUNK_DONE}`,
    `- ${AUTONOMY_DONE}`,
    `- ${AUTONOMY_BLOCKED}`,
    '- Do not use AUTONOMY_* markers for any other reason.',
  ].join('\n');
}

function sleep(ms: number) {
  return new Promise<void>((resolvePromise) => {
    setTimeout(resolvePromise, ms);
  });
}

function isRetryableChunkError(message: string): boolean {
  const normalized = message.toLowerCase();

  const nonRetryableSnippets = [
    'no prompt provided via stdin',
    'no prompt provided. either specify one as an argument or pipe the prompt into stdin',
    'failed to read prompt from stdin',
    'not inside a trusted directory',
    'skip-git-repo-check was not specified',
    'missing optional dependency',
    'outputschema must be a plain json object',
  ];

  if (nonRetryableSnippets.some((snippet) => normalized.includes(snippet))) {
    return false;
  }

  return [
    'stream disconnected before completion',
    'transport error',
    'error decoding response body',
    'econnreset',
    'socket hang up',
    'timed out',
    'timeout',
    'rate limit',
    'temporarily unavailable',
    'service unavailable',
    'internal server error',
    'connection reset',
    'codex exec exited with code 1',
  ].some((snippet) => normalized.includes(snippet));
}

function getRetryDelayMs(attempt: number): number {
  const cappedAttempt = Math.min(attempt, 6);
  const baseDelay = 1000 * 2 ** (cappedAttempt - 1);
  const jitter = Math.floor(Math.random() * 250);
  return Math.min(baseDelay + jitter, 30000);
}

function extractMarker(message: string): Marker | null {
  for (const rawLine of message.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line === AUTONOMY_CHUNK_DONE || line === AUTONOMY_DONE || line === AUTONOMY_BLOCKED) {
      return line;
    }
  }

  return null;
}

function appendUnprintedText(id: string, text: string, printedLengths: Map<string, number>) {
  const alreadyPrinted = printedLengths.get(id) ?? 0;
  const nextText = text.slice(alreadyPrinted);

  if (nextText) {
    process.stdout.write(nextText);
    printedLengths.set(id, text.length);
  }
}

function streamItemOutput(item: ThreadItem, printedLengths: Map<string, number>, seenCommands: Set<string>) {
  switch (item.type) {
    case 'agent_message':
      appendUnprintedText(item.id, item.text, printedLengths);
      return;
    case 'command_execution':
      if (!seenCommands.has(item.id)) {
        seenCommands.add(item.id);
        process.stderr.write(`\n$ ${item.command}\n`);
      }
      appendUnprintedText(item.id, item.aggregated_output, printedLengths);
      return;
    case 'error':
      process.stderr.write(`\n[error] ${item.message}\n`);
      return;
    case 'web_search':
      process.stderr.write(`\n[web] ${item.query}\n`);
      return;
    case 'mcp_tool_call':
      if (item.status === 'in_progress') {
        process.stderr.write(`\n[mcp] ${item.server}.${item.tool}\n`);
      } else if (item.status === 'failed' && item.error?.message) {
        process.stderr.write(`\n[mcp:error] ${item.error.message}\n`);
      }
      return;
    case 'file_change':
      if (item.status === 'completed' && item.changes.length > 0) {
        const changedPaths = item.changes.map((change) => change.path).join(', ');
        process.stderr.write(`\n[files] ${changedPaths}\n`);
      }
      return;
    case 'reasoning':
    case 'todo_list':
      return;
    default:
      return;
  }
}

function ensureFinalResponsePrinted(
  finalResponse: string,
  items: ThreadItem[],
  printedLengths: Map<string, number>,
) {
  const finalAgentMessage = [...items]
    .reverse()
    .find((item): item is AgentMessageItem => item.type === 'agent_message');

  if (!finalAgentMessage) {
    if (finalResponse) {
      process.stdout.write(finalResponse);
    }
  } else {
    const alreadyPrinted = printedLengths.get(finalAgentMessage.id) ?? 0;
    if (alreadyPrinted < finalAgentMessage.text.length) {
      process.stdout.write(finalAgentMessage.text.slice(alreadyPrinted));
    }
  }

  if (finalResponse && !finalResponse.endsWith('\n')) {
    process.stdout.write('\n');
  }
}

async function notifyChunk(kind: NotificationKind, message: string) {
  await notify(kind, message);
}

async function resumeLastThread(threadId: string) {
  await new Promise<void>((resolvePromise, rejectPromise) => {
    const child = spawn('codex', ['resume', threadId], {
      stdio: 'inherit',
    });

    child.on('error', rejectPromise);
    child.on('exit', (code, signal) => {
      if (signal) {
        rejectPromise(new Error(`codex resume terminated by signal ${signal}`));
        return;
      }

      if (code === 0) {
        resolvePromise();
      } else {
        rejectPromise(new Error(`codex resume exited with status ${code}`));
      }
    });
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
      process.exit(130);
    }

    if (key.name === 'q') {
      stopRequested = true;
      process.stderr.write('\n[autonomy] stop requested after current chunk\n');
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

async function runChunkAttempt(thread: ReturnType<Codex['startThread']>, prompt: string): Promise<ChunkAttemptResult> {
  const printedLengths = new Map<string, number>();
  const seenCommands = new Set<string>();
  const items = new Map<string, ThreadItem>();
  const itemOrder: string[] = [];

  let threadId: string | null = null;
  let fatalError: string | null = null;

  try {
    const streamedTurn = await thread.runStreamed(prompt);
    for await (const event of streamedTurn.events) {
      switch (event.type) {
        case 'thread.started':
          threadId = event.thread_id;
          process.stderr.write(`[autonomy] thread ${threadId}\n`);
          break;
        case 'turn.failed':
          fatalError = event.error.message;
          break;
        case 'error':
          fatalError = event.message;
          break;
        case 'item.started':
        case 'item.updated':
        case 'item.completed':
          if (!items.has(event.item.id)) {
            itemOrder.push(event.item.id);
          }
          items.set(event.item.id, event.item);
          streamItemOutput(event.item, printedLengths, seenCommands);
          break;
        case 'turn.started':
        case 'turn.completed':
          break;
        default:
          break;
      }
    }
  } catch (error: unknown) {
    fatalError = error instanceof Error ? error.message : String(error);
  }

  const orderedItems = itemOrder
    .map((id) => items.get(id))
    .filter((item): item is ThreadItem => Boolean(item));

  const finalAgentMessage = [...orderedItems]
    .reverse()
    .find((item): item is AgentMessageItem => item.type === 'agent_message');
  const finalResponse = finalAgentMessage?.text ?? '';
  const marker = extractMarker(finalResponse);

  ensureFinalResponsePrinted(finalResponse, orderedItems, printedLengths);

  if (fatalError && !marker) {
    throw new Error(fatalError);
  }

  if (fatalError && marker) {
    process.stderr.write(`\n[autonomy] stream error ignored after completed response: ${fatalError}\n`);
  }

  return {
    finalResponse,
    fatalError,
    marker,
    threadId: threadId ?? thread.id,
  };
}

async function runChunk(codex: Codex, planDoc: string): Promise<ChunkResult> {
  const maxAttempts = Number(process.env.AUTONOMY_MAX_RETRIES ?? '4') + 1;
  const thread = codex.startThread({
    approvalPolicy: 'never',
    sandboxMode: 'danger-full-access',
    workingDirectory: process.cwd(),
  });

  process.stderr.write(`\n[autonomy] starting chunk in ${basename(planDoc)}\n`);

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    if (attempt > 1) {
      process.stderr.write(`[autonomy] retry attempt ${attempt}/${maxAttempts}\n`);
    }

    const prompt = attempt === 1 ? buildPrompt(planDoc) : buildRetryPrompt(planDoc);
    const chunk = await runChunkAttempt(thread, prompt);

    if (chunk.marker) {
      return chunk;
    }

    if (!chunk.fatalError) {
      return chunk;
    }

    if (!isRetryableChunkError(chunk.fatalError) || attempt === maxAttempts) {
      throw new Error(chunk.fatalError);
    }

    const delayMs = getRetryDelayMs(attempt);
    const retryMessage = `${basename(planDoc)} retry ${attempt}/${maxAttempts} in ${delayMs}ms thread=${
      chunk.threadId ?? 'unknown'
    } error=${chunk.fatalError}`;
    process.stderr.write(`[autonomy] transient chunk failure, retrying in ${delayMs}ms: ${chunk.fatalError}\n`);
    await notifyChunk('retry', retryMessage).catch((error: unknown) => {
      process.stderr.write(`[autonomy] notify failed: ${String(error)}\n`);
    });
    await sleep(delayMs);
  }

  throw new Error('chunk retry loop exited unexpectedly');
}

async function main() {
  const planArg = process.argv[2];
  if (!planArg) {
    usage();
  }

  const planDoc = resolve(planArg);
  await access(planDoc);
  await readFile(planDoc, 'utf8');

  const codex = new Codex();
  const stopController = createStopController();
  let lastThreadId: string | null = null;
  let shouldResumeLastThread = false;

  process.stderr.write(`[autonomy] cwd ${process.cwd()}\n`);
  process.stderr.write(`[autonomy] plan ${planDoc}\n`);
  process.stderr.write('[autonomy] press q to stop after the current chunk\n');

  try {
    while (true) {
      const chunk = await runChunk(codex, planDoc);
      lastThreadId = chunk.threadId;
      const marker = chunk.marker;

      if (!marker) {
        process.stderr.write('\n[autonomy] missing AUTONOMY_* marker in final response\n');
        if (chunk.threadId) {
          process.stdout.write(`\nLast thread id: ${chunk.threadId}\n`);
        }
        process.exitCode = 1;
        shouldResumeLastThread = Boolean(chunk.threadId);
        break;
      }

      const notificationMessage = `${basename(planDoc)} ${marker} thread=${chunk.threadId ?? 'unknown'}`;

      if (marker === AUTONOMY_CHUNK_DONE) {
        await notifyChunk('done', notificationMessage).catch((error: unknown) => {
          process.stderr.write(`[autonomy] notify failed: ${String(error)}\n`);
        });

        if (stopController.isStopRequested()) {
          shouldResumeLastThread = true;
          break;
        }

        continue;
      }

      const notificationKind = marker === AUTONOMY_DONE ? 'complete' : 'blocked';
      await notifyChunk(notificationKind, notificationMessage).catch((error: unknown) => {
        process.stderr.write(`[autonomy] notify failed: ${String(error)}\n`);
      });

      if (chunk.threadId) {
        process.stdout.write(`\nLast thread id: ${chunk.threadId}\n`);
      }
      shouldResumeLastThread = Boolean(chunk.threadId);
      break;
    }
  } finally {
    stopController.cleanup();
  }

  if (shouldResumeLastThread && lastThreadId) {
    process.stderr.write(`[autonomy] resuming ${lastThreadId}\n`);
    await resumeLastThread(lastThreadId);
  }
}

void main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`\n[autonomy] ${message}\n`);
  process.exit(1);
});
