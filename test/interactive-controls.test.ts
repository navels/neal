import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type readline from 'node:readline';

import {
  configureDiagnosticFooter,
  isDiagnosticDetailVisible,
  resetDiagnosticStateForTests,
  writeDetail,
  writeNarrative,
} from '../src/neal/diagnostic.js';
import { createInteractiveKeyController, renderInteractiveKeyHint } from '../src/neal/interactive-controls.js';
import type { RunLogger } from '../src/neal/logger.js';
import { createInitialState, getDefaultAgentConfig } from '../src/neal/state.js';
import { StatusFooter } from '../src/neal/status-footer.js';

class FakeInput extends EventEmitter {
  isTTY: boolean;
  rawModes: boolean[] = [];
  resumed = false;
  paused = false;

  constructor(isTTY: boolean) {
    super();
    this.isTTY = isTTY;
  }

  setRawMode(mode: boolean) {
    this.rawModes.push(mode);
  }

  resume() {
    this.resumed = true;
    return this;
  }

  pause() {
    this.paused = true;
    return this;
  }

  press(key: readline.Key) {
    this.emit('keypress', '', key);
  }
}

class FakeFooter {
  readonly writes: string[] = [];
  disposed = false;

  write(message: string) {
    this.writes.push(message);
  }

  dispose() {
    this.disposed = true;
  }
}

class FakeStream {
  isTTY = true;
  columns = 120;
  writes: string[] = [];

  write(chunk: string) {
    this.writes.push(chunk);
    return true;
  }
}

class FakeLogger {
  readonly stderrMessages: string[] = [];

  async stderr(message: string) {
    this.stderrMessages.push(message);
  }

  async event() {}

  asRunLogger() {
    return this as unknown as RunLogger;
  }
}

function getLatestManagedView(writes: string[]) {
  const output = writes.join('');
  const clearScreen = '\x1b[H\x1b[2J';
  const lastClearScreen = output.lastIndexOf(clearScreen);
  return lastClearScreen === -1 ? output : output.slice(lastClearScreen + clearScreen.length);
}

async function createState() {
  const root = await mkdtemp(join(tmpdir(), 'neal-interactive-controls-'));
  const cwd = join(root, 'repo');
  const stateDir = join(cwd, '.neal');
  const runDir = join(stateDir, 'runs', 'interactive-test-run');
  const planDoc = join(cwd, 'PLAN.md');

  await mkdir(runDir, { recursive: true });
  await writeFile(
    planDoc,
    `# Example Plan

## Execution Shape

executionShape: one_shot
`,
    'utf8',
  );

  const state = await createInitialState(
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
    'abc123',
  );

  return state;
}

test('interactive key hint advertises stop requests only when they are enabled', () => {
  assert.equal(renderInteractiveKeyHint(false), '[neal] keys: v show/hide details\n');
  assert.equal(
    renderInteractiveKeyHint(true),
    '[neal] keys: q stop after current scope, v show/hide details\n',
  );
});

test('interactive q key preserves stop-after-current-scope behavior', () => {
  const input = new FakeInput(true);
  const footer = new FakeFooter();
  resetDiagnosticStateForTests();
  configureDiagnosticFooter(footer);

  try {
    const controller = createInteractiveKeyController({
      input,
      emitKeypressEvents() {},
    });

    assert.deepEqual(input.rawModes, [true]);
    assert.equal(input.resumed, true);
    assert.equal(controller.isStopRequested(), false);

    input.press({ name: 'q' });
    assert.equal(controller.isStopRequested(), true);
    assert.deepEqual(footer.writes, ['\n[neal] stop requested after the current scope\n']);

    input.press({ name: 'q' });
    assert.equal(controller.isStopRequested(), false);
    assert.deepEqual(footer.writes, [
      '\n[neal] stop requested after the current scope\n',
      '\n[neal] stop request cleared; continuing after the current scope\n',
    ]);

    controller.cleanup();
    assert.deepEqual(input.rawModes, [true, false]);
    assert.equal(input.paused, true);
  } finally {
    resetDiagnosticStateForTests();
  }
});

test('interactive q key is ignored when stop-after-current-scope is disabled', () => {
  const input = new FakeInput(true);
  const footer = new FakeFooter();
  resetDiagnosticStateForTests();
  configureDiagnosticFooter(footer);

  try {
    const controller = createInteractiveKeyController({
      input,
      allowStopRequest: false,
      emitKeypressEvents() {},
    });

    input.press({ name: 'q' });

    assert.equal(controller.isStopRequested(), false);
    assert.deepEqual(footer.writes, []);

    controller.cleanup();
  } finally {
    resetDiagnosticStateForTests();
  }
});

test('interactive v key switches between detail and restored narrative terminal views', async () => {
  const input = new FakeInput(true);
  const stream = new FakeStream();
  const footer = new StatusFooter({
    stream,
    refreshIntervalMs: 0,
    minRedrawIntervalMs: 0,
    now: () => 10_000,
  });
  const logger = new FakeLogger();
  const state = await createState();
  resetDiagnosticStateForTests();
  configureDiagnosticFooter(footer);
  await footer.setState(state, 0);
  stream.writes = [];

  try {
    writeNarrative('Scope 1/1: Example Plan\n', logger.asRunLogger());
    writeNarrative('Coder is implementing.\n', logger.asRunLogger());
    writeDetail('hidden provider detail\n', logger.asRunLogger(), {
      runId: 'interactive-test-run',
      phase: 'coder_scope',
      scopeNumber: 1,
    });

    const controller = createInteractiveKeyController({
      input,
      emitKeypressEvents() {},
      getDetailFilter() {
        return {
          runId: 'interactive-test-run',
          phase: 'coder_scope',
          scopeNumber: 1,
        };
      },
    });

    input.press({ name: 'v' });
    assert.equal(isDiagnosticDetailVisible(), true);
    let visibleView = getLatestManagedView(stream.writes);
    assert.match(visibleView, /hidden provider detail\n/);
    assert.doesNotMatch(visibleView, /Scope 1\/1: Example Plan\n/);
    assert.doesNotMatch(visibleView, /Coder is implementing\.\n/);
    assert.doesNotMatch(visibleView, /\[neal\].*(details|detail).*(shown|hidden|enabled|disabled|toggled)/i);
    assert.ok(stream.writes.includes('\x1b[H\x1b[2J'));
    assert.match(stream.writes.at(-1) ?? '', /\r\x1b\[2K\[neal\] PLAN\.md/);

    writeDetail('visible provider detail\n', logger.asRunLogger(), {
      runId: 'interactive-test-run',
      phase: 'coder_scope',
      scopeNumber: 1,
    });
    visibleView = getLatestManagedView(stream.writes);
    assert.match(visibleView, /visible provider detail\n/);
    assert.doesNotMatch(visibleView, /\[neal\].*(details|detail).*(shown|hidden|enabled|disabled|toggled)/i);

    writeNarrative('narrative while detail is active\n', logger.asRunLogger());
    visibleView = getLatestManagedView(stream.writes);
    assert.doesNotMatch(visibleView, /narrative while detail is active\n/);

    input.press({ name: 'v' });
    assert.equal(isDiagnosticDetailVisible(), false);
    visibleView = getLatestManagedView(stream.writes);
    assert.match(visibleView, /Scope 1\/1: Example Plan\n/);
    assert.match(visibleView, /Coder is implementing\.\n/);
    assert.match(visibleView, /narrative while detail is active\n/);
    assert.doesNotMatch(visibleView, /hidden provider detail\n/);
    assert.doesNotMatch(visibleView, /visible provider detail\n/);
    assert.equal((visibleView.match(/^Scope 1\/1: Example Plan$/gm) ?? []).length, 1);

    const writesBeforeHiddenDetail = stream.writes.join('');
    writeDetail('detail after hide\n', logger.asRunLogger(), {
      runId: 'interactive-test-run',
      phase: 'coder_scope',
      scopeNumber: 1,
    });
    assert.equal(stream.writes.join(''), writesBeforeHiddenDetail);
    assert.deepEqual(logger.stderrMessages, [
      'Scope 1/1: Example Plan\n',
      'Coder is implementing.\n',
      'hidden provider detail\n',
      'visible provider detail\n',
      'narrative while detail is active\n',
      'detail after hide\n',
    ]);
    assert.doesNotMatch(
      logger.stderrMessages.join(''),
      /\[neal\].*(details|detail).*(shown|hidden|enabled|disabled|toggled)/i,
    );

    controller.cleanup();
  } finally {
    footer.dispose();
    resetDiagnosticStateForTests();
  }
});

test('interactive v replay falls back to the current run when the current phase has no detail', () => {
  const input = new FakeInput(true);
  const footer = new FakeFooter();
  resetDiagnosticStateForTests();
  configureDiagnosticFooter(footer);

  try {
    writeDetail('earlier phase detail\n', undefined, {
      runId: 'run-1',
      phase: 'coder_plan',
    });
    const controller = createInteractiveKeyController({
      input,
      emitKeypressEvents() {},
      getDetailFilter() {
        return {
          runId: 'run-1',
          phase: 'reviewer_plan',
        };
      },
    });

    input.press({ name: 'v' });

    assert.equal(isDiagnosticDetailVisible(), true);
    assert.match(footer.writes.join(''), /earlier phase detail\n/);

    controller.cleanup();
  } finally {
    resetDiagnosticStateForTests();
  }
});

test('non-TTY controller ignores keypress detail toggles', () => {
  const input = new FakeInput(false);
  const footer = new FakeFooter();
  resetDiagnosticStateForTests();
  configureDiagnosticFooter(footer);

  try {
    const controller = createInteractiveKeyController({
      input,
      stopRequestFile: '',
      emitKeypressEvents() {
        throw new Error('non-TTY input should not arm keypress handling');
      },
    });

    input.press({ name: 'v' });

    assert.equal(isDiagnosticDetailVisible(), false);
    assert.deepEqual(input.rawModes, []);
    assert.deepEqual(footer.writes, []);
    assert.equal(controller.isStopRequested(), false);
    controller.cleanup();
  } finally {
    resetDiagnosticStateForTests();
  }
});

test('Ctrl-C cleans up raw mode, clears the footer, and exits with code 130', () => {
  const input = new FakeInput(true);
  const footer = new FakeFooter();
  let exitCode: number | null = null;
  resetDiagnosticStateForTests();
  configureDiagnosticFooter(footer);

  try {
    createInteractiveKeyController({
      input,
      emitKeypressEvents() {},
      exit(code) {
        exitCode = code;
      },
    });

    input.press({ name: 'c', ctrl: true });
    input.press({ name: 'q' });

    assert.equal(exitCode, 130);
    assert.deepEqual(input.rawModes, [true, false]);
    assert.equal(input.paused, true);
    assert.equal(footer.disposed, true);
    assert.deepEqual(footer.writes, []);
  } finally {
    resetDiagnosticStateForTests();
  }
});
