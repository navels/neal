/**
 * Registry-driven reviewer read-only conformance test.
 *
 * This file is the executable form of the README's claim that neal's reviewer
 * role is "read-only by construction". That guarantee is layered:
 *
 *   1. Declared metadata — every registered provider's structured-advisor
 *      capability must declare write:false and shell:false. The registry
 *      enforces this on every enumeration (assertStructuredAdvisorReadOnly in
 *      src/neal/providers/registry.ts); this file re-asserts it directly as an
 *      executable statement of the contract.
 *   2. Adapter wiring — metadata alone proves nothing about what an adapter
 *      actually hands its SDK. Each registered provider therefore has a
 *      WIRING VERIFIER below that pins the mechanical enforcement in that
 *      adapter (SDK tool allowlist, OS sandbox mode, jailed toolset, or a
 *      tool-less wire protocol).
 *
 * The two layers are joined registry-first: the test enumerates the PRODUCTION
 * registry (listRegisteredProviderDefinitions — never a hand-maintained id
 * list) and fails if any registered provider id has no entry in
 * REVIEWER_WIRING_VERIFIERS. Registering a provider obligates wiring
 * verification.
 *
 * To add a provider:
 *   - Register its definition (its structured-advisor toolAccess must already
 *     be read-only or the registry itself throws).
 *   - Add a `[yourProviderId]: async () => { ... }` entry to
 *     REVIEWER_WIRING_VERIFIERS that proves, hermetically (no network, no real
 *     provider processes), that the adapter's reviewer path cannot write or
 *     run shell: build its advisor options/toolset through the adapter's
 *     exported *TestHooks and assert the enforced surface (tool allowlist,
 *     sandbox mode, toolset contents + a no-mutation invocation sweep, or the
 *     absence of any tool surface).
 *   - A provider whose structured-advisor capability is unsupported still
 *     needs an entry; its verifier should assert `supported === false`.
 */
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test, { afterEach } from 'node:test';
import { promisify } from 'node:util';

import type { ToolExecutionOptions } from 'ai';

import { anthropicClaudeProviderTestHooks } from '../src/neal/providers/anthropic-claude.js';
import {
  createReadOnlyToolset,
  isToolErrorResult,
} from '../src/neal/providers/openai-compatible-tools.js';
import { openAICodexProviderTestHooks } from '../src/neal/providers/openai-codex.js';
import {
  assertStructuredAdvisorReadOnly,
  clearProviderDefinitionRegistrationsForTesting,
  getProviderDefinition,
  isRegisteredProviderId,
  listRegisteredProviderDefinitions,
  registerProviderDefinitionForTesting,
} from '../src/neal/providers/registry.js';
import type { StructuredAdvisorRoundArgs } from '../src/neal/providers/types.js';
import {
  createFakeProviderDefinition,
  fakeProviderDefaultCapabilities,
} from './helpers/fake-provider.js';

const execFileAsync = promisify(execFile);

afterEach(() => {
  clearProviderDefinitionRegistrationsForTesting();
});

// ---------------------------------------------------------------------------
// Shared advisor-round fixtures
// ---------------------------------------------------------------------------

function verdictProtocol() {
  return {
    protocol: 'neal-json-block-v1' as const,
    schemaLabel: 'conformance_review_payload',
    schema: {
      type: 'object',
      properties: { verdict: { type: 'string' } },
      required: ['verdict'],
    },
    validator: (payload: unknown) => {
      const candidate = payload as { verdict?: unknown };
      if (typeof candidate.verdict !== 'string') {
        throw new Error('verdict must be a string');
      }
      return candidate as { verdict: string };
    },
    repairAttemptLimit: 1,
  };
}

function verdictJsonBlock(prose: string) {
  return `${prose}\n\n\`\`\`neal-json\n${JSON.stringify({ verdict: 'accepted' })}\n\`\`\``;
}

function advisorRoundArgs(
  overrides: Partial<StructuredAdvisorRoundArgs> = {},
): StructuredAdvisorRoundArgs {
  return {
    label: 'review',
    cwd: process.cwd(),
    prompt: 'review the current work',
    schema: { type: 'object', additionalProperties: true },
    inactivityTimeoutMs: 60_000,
    apiRetryLimit: 0,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Layer 1: declared structured-advisor metadata is read-only.
// Deliberately duplicates the registry's own assertStructuredAdvisorReadOnly
// gate so the contract is stated here as directly executable assertions, not
// only as a side effect of enumeration.
// ---------------------------------------------------------------------------

test('every registered provider declares a read-only structured-advisor capability', () => {
  const definitions = listRegisteredProviderDefinitions();
  assert.ok(definitions.length >= 3, 'the production registry lists the built-in providers');

  for (const definition of definitions) {
    const capability = definition.capabilities['structured-advisor'];
    if (!capability.supported) {
      continue; // Unsupported advisor roles have no reviewer surface to constrain.
    }
    assert.equal(
      capability.toolAccess.write,
      false,
      `provider ${JSON.stringify(definition.id)} declares a structured-advisor capability with write access; reviewers must declare write:false`,
    );
    assert.equal(
      capability.toolAccess.shell,
      false,
      `provider ${JSON.stringify(definition.id)} declares a structured-advisor capability with shell access; reviewers must declare shell:false`,
    );
    // The registry's own gate must agree with the direct assertions above.
    assert.doesNotThrow(() => assertStructuredAdvisorReadOnly(definition));
  }
});

// ---------------------------------------------------------------------------
// Layer 2: per-provider wiring verifiers.
// ---------------------------------------------------------------------------

// --- anthropic-claude -------------------------------------------------------
//
// Enforcement mechanism: the Claude Agent SDK `Options.tools` allowlist. The
// advisor query builders pin `tools` explicitly, so the SDK-side agent can
// only invoke the listed tools.
//
// Allowlist rationale (Claude Code SDK tool names):
//   - Read-class (allowed): Read (file reads), Grep (content search),
//     Glob (path listing). None mutates the checkout or executes commands.
//   - Write/shell-class (forbidden): Bash (shell execution), Edit / Write /
//     MultiEdit / NotebookEdit (file mutation). Network-read tools such as
//     WebFetch / WebSearch are not write/shell-class, but they are also not
//     in the allowlist, and the exact-equality assertions below exclude them
//     (and any future SDK tool) until deliberately added here.
//   - The JSON-block repair turn is prompt-only: its allowlist is exactly [].
//
// The allowlist governs built-in tools only. MCP servers from the operator's
// user settings, plugins, and project .mcp.json are added on top of it, and
// those routinely carry write-capable tools (issue trackers, drives, browsers).
// Every advisor variant therefore also sets `strictMcpConfig: true`, which
// makes the SDK ignore all MCP configuration not passed explicitly in options
// (neal passes none for reviewer turns).
const CLAUDE_REVIEWER_READ_TOOL_ALLOWLIST = ['Read', 'Grep', 'Glob'];
const CLAUDE_WRITE_OR_SHELL_TOOLS = ['Bash', 'Edit', 'Write', 'MultiEdit', 'NotebookEdit'];

function verifyAnthropicClaudeReviewerWiring() {
  const hooks = anthropicClaudeProviderTestHooks;
  const jsonBlockArgs = () =>
    advisorRoundArgs({ structuredJsonProtocol: verdictProtocol() }) as StructuredAdvisorRoundArgs<unknown>;

  // Every advisor query-option builder variant, including repair. The empty
  // executable-path argument skips SDK binary resolution (hermetic).
  const advisorOptionVariants: Record<string, { tools?: unknown; strictMcpConfig?: unknown }> = {
    'structured-output advisor query': hooks.buildClaudeQueryOptions(advisorRoundArgs(), null, ''),
    'JSON-block advisor query': hooks.buildClaudeJsonBlockQueryOptions(jsonBlockArgs(), null, ''),
    'JSON-block repair query': hooks.buildClaudeJsonBlockRepairQueryOptions(jsonBlockArgs(), null, ''),
  };

  for (const [variant, options] of Object.entries(advisorOptionVariants)) {
    // An absent `tools` key would inherit the SDK's full default toolset
    // (including Bash/Edit/Write), so the explicit allowlist must be present.
    assert.ok(
      Array.isArray(options.tools),
      `anthropic-claude ${variant} must pin an explicit tools allowlist; an absent tools option would inherit the SDK's full default toolset`,
    );
    const tools = options.tools as string[];

    for (const tool of tools) {
      assert.ok(
        CLAUDE_REVIEWER_READ_TOOL_ALLOWLIST.includes(tool),
        `anthropic-claude ${variant} exposes non-read-class tool ${JSON.stringify(tool)}; reviewer turns may only use ${CLAUDE_REVIEWER_READ_TOOL_ALLOWLIST.join(', ')}`,
      );
    }
    for (const forbidden of CLAUDE_WRITE_OR_SHELL_TOOLS) {
      assert.ok(
        !tools.includes(forbidden),
        `anthropic-claude ${variant} exposes write/shell tool ${JSON.stringify(forbidden)}`,
      );
    }
    assert.equal(
      options.strictMcpConfig,
      true,
      `anthropic-claude ${variant} must set strictMcpConfig so operator-configured MCP tools (which may write) do not reach the reviewer`,
    );
  }

  // Exact current values, pinned so drift is loud: primary advisor turns get
  // exactly the read-class trio; the prompt-only repair turn gets no tools.
  assert.deepEqual(advisorOptionVariants['structured-output advisor query'].tools, ['Read', 'Grep', 'Glob']);
  assert.deepEqual(advisorOptionVariants['JSON-block advisor query'].tools, ['Read', 'Grep', 'Glob']);
  assert.deepEqual(advisorOptionVariants['JSON-block repair query'].tools, []);
}

// --- openai-codex ------------------------------------------------------------
//
// Enforcement mechanism: the Codex SDK OS sandbox. Every structured-advisor
// thread must be created with sandboxMode 'read-only' — the primary advisor
// thread (the single thread-creation call site shared by the structured-output
// and JSON-block advisor paths) and the fresh repair thread.

type CodexAdvisorThreadFactory = Parameters<
  typeof openAICodexProviderTestHooks.createStructuredAdvisorAdapterWithThreadFactory
>[0];
type CodexThreadCreateArgs = Parameters<CodexAdvisorThreadFactory>[0];
type CodexFakeThread = ReturnType<CodexAdvisorThreadFactory>;

function fakeCodexAdvisorThreadFactory(responses: string[]) {
  const createdThreads: CodexThreadCreateArgs[] = [];
  const createThread: CodexAdvisorThreadFactory = (createArgs) => {
    const index = createdThreads.length;
    const responseText = responses[index];
    if (responseText === undefined) {
      throw new Error('unexpected Codex thread creation in conformance test');
    }
    createdThreads.push(createArgs);
    const threadId = `codex-conformance-thread-${index}`;
    return {
      id: threadId,
      runStreamed: () => ({
        events: (async function* () {
          yield { type: 'thread.started', thread_id: threadId };
          yield {
            type: 'item.completed',
            item: { type: 'agent_message', id: `msg-${index}`, text: responseText },
          };
          yield {
            type: 'turn.completed',
            usage: { input_tokens: 1, cached_input_tokens: 0, output_tokens: 1 },
          };
        })(),
      }),
    } as unknown as CodexFakeThread;
  };
  return { createdThreads, createThread };
}

async function verifyOpenAICodexReviewerWiring() {
  // A primary response without the neal-json control block forces the repair
  // turn, so one round exercises both advisor thread-creation call sites.
  const fakeThreads = fakeCodexAdvisorThreadFactory([
    'Review prose without a control block.',
    verdictJsonBlock('Repaired review control payload.'),
  ]);
  const adapter = openAICodexProviderTestHooks.createStructuredAdvisorAdapterWithThreadFactory(
    fakeThreads.createThread,
  );

  const result = await adapter.runStructuredRound<{ verdict: string }>(
    advisorRoundArgs({ structuredJsonProtocol: verdictProtocol() }) as StructuredAdvisorRoundArgs<{
      verdict: string;
    }>,
  );

  assert.deepEqual(result.structured, { verdict: 'accepted' });
  assert.equal(fakeThreads.createdThreads.length, 2, 'expected a primary and a repair advisor thread');
  assert.equal(
    fakeThreads.createdThreads[0].sandboxMode,
    'read-only',
    'openai-codex primary advisor thread must run under the read-only OS sandbox',
  );
  assert.equal(
    fakeThreads.createdThreads[1].sandboxMode,
    'read-only',
    'openai-codex repair advisor thread must run under the read-only OS sandbox',
  );
}

// --- openai-compatible -------------------------------------------------------
//
// Enforcement mechanism: neal's own jailed toolset. The reviewer role binds
// createReadOnlyToolset, which must contain exactly the read-class tools and
// must leave the worktree byte-identical when every tool is invoked.

async function verifyOpenAICompatibleReviewerWiring() {
  const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), 'neal-reviewer-conformance-'));
  try {
    const git = async (...gitArgs: string[]) =>
      (await execFileAsync('git', gitArgs, { cwd: rootDir })).stdout.trim();
    // Canary repo with one committed file; pin identity and signing locally so
    // the fixture commit succeeds regardless of operator git configuration.
    await git('init', '--quiet');
    await git('config', 'user.email', 'neal-conformance@example.invalid');
    await git('config', 'user.name', 'Neal Conformance');
    await git('config', 'commit.gpgsign', 'false');
    const canaryContent = 'reviewer read-only conformance canary\n';
    await fs.writeFile(path.join(rootDir, 'canary.txt'), canaryContent);
    await git('add', '-A');
    await git('commit', '--quiet', '-m', 'canary commit');
    const head = await git('rev-parse', 'HEAD');

    const tools = createReadOnlyToolset(rootDir);

    // (a) Exactly the expected read-only tool set — nothing more, nothing less.
    assert.deepEqual(
      Object.keys(tools).sort(),
      ['git_diff', 'grep', 'list_dir', 'read_file'],
      'openai-compatible reviewer toolset must be exactly read_file, list_dir, grep, git_diff',
    );

    // (b) No mutation- or execution-shaped tool under any plausible name.
    for (const forbidden of ['write_file', 'edit_file', 'run', 'shell', 'bash', 'exec', 'apply_patch']) {
      assert.ok(
        !(forbidden in tools),
        `openai-compatible reviewer toolset must not expose ${JSON.stringify(forbidden)}`,
      );
    }

    // (c) Invoking every available tool leaves the worktree byte-identical.
    assert.equal(await git('status', '--porcelain'), '', 'fixture repo must start clean');

    const trivialInputsByTool: Record<string, unknown> = {
      read_file: { path: 'canary.txt' },
      list_dir: { path: '.' },
      grep: { pattern: 'canary' },
      git_diff: { base: head, head },
    };
    const callOptions = { toolCallId: 'conformance-call', messages: [] } as unknown as ToolExecutionOptions<never>;

    for (const [toolName, toolDefinition] of Object.entries(tools)) {
      const input = trivialInputsByTool[toolName];
      assert.ok(
        input !== undefined,
        `read-only tool ${JSON.stringify(toolName)} has no conformance invocation — add trivially-valid args for it to trivialInputsByTool so the no-mutation sweep covers it`,
      );
      const execute = (toolDefinition as {
        execute?: (input: unknown, options: ToolExecutionOptions<never>) => unknown;
      }).execute;
      assert.ok(execute, `read-only tool ${JSON.stringify(toolName)} has no execute function`);
      const result = await execute(input, callOptions);
      assert.equal(typeof result, 'string', `tool ${toolName} result must be a string`);
      assert.ok(
        !isToolErrorResult(result as string),
        `tool ${toolName} invocation must exercise the real tool body, not fail validation: ${String(result).slice(0, 200)}`,
      );
    }

    assert.equal(
      await git('status', '--porcelain'),
      '',
      'invoking every read-only tool must leave the worktree byte-identical (git status --porcelain not empty)',
    );
    assert.equal(
      await fs.readFile(path.join(rootDir, 'canary.txt'), 'utf8'),
      canaryContent,
      'canary file content must be byte-identical after the read-only tool sweep',
    );
  } finally {
    await fs.rm(rootDir, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------
// The contract: registering a provider obligates wiring verification.
// ---------------------------------------------------------------------------

const REVIEWER_WIRING_VERIFIERS: Record<string, () => void | Promise<void>> = {
  'anthropic-claude': verifyAnthropicClaudeReviewerWiring,
  'openai-codex': verifyOpenAICodexReviewerWiring,
  'openai-compatible': verifyOpenAICompatibleReviewerWiring,
};

test('every registered provider has a reviewer read-only wiring conformance verifier', () => {
  for (const definition of listRegisteredProviderDefinitions()) {
    assert.ok(
      Object.hasOwn(REVIEWER_WIRING_VERIFIERS, definition.id),
      `provider ${JSON.stringify(definition.id)} is registered but has no read-only wiring conformance verifier — add one to test/reviewer-readonly-conformance.test.ts before shipping it`,
    );
  }
});

test('every reviewer wiring verifier targets a registered provider (no stale entries)', () => {
  for (const providerId of Object.keys(REVIEWER_WIRING_VERIFIERS)) {
    assert.ok(
      isRegisteredProviderId(providerId),
      `reviewer wiring verifier for ${JSON.stringify(providerId)} targets a provider id that is not registered — remove or rename the entry`,
    );
  }
});

for (const [providerId, verifier] of Object.entries(REVIEWER_WIRING_VERIFIERS)) {
  test(`reviewer read-only wiring conformance: ${providerId}`, verifier);
}

// ---------------------------------------------------------------------------
// The registry's own gate: a definition whose structured-advisor can write or
// shell cannot even be registered.
// ---------------------------------------------------------------------------

test('registering a provider whose structured-advisor can write or shell throws', () => {
  const violations = [
    { read: true, write: true, shell: false },
    { read: true, write: false, shell: true },
  ];

  for (const toolAccess of violations) {
    assert.throws(
      () =>
        registerProviderDefinitionForTesting(
          createFakeProviderDefinition({
            id: 'conformance-violating-reviewer',
            capabilities: {
              coder: fakeProviderDefaultCapabilities.coder,
              'structured-advisor': {
                ...fakeProviderDefaultCapabilities['structured-advisor'],
                toolAccess,
              },
            },
          }),
        ),
      /structured-advisor capability that is not read-only/,
      `registration must reject toolAccess ${JSON.stringify(toolAccess)}`,
    );
    // The violating id never entered the registry.
    assert.equal(isRegisteredProviderId('conformance-violating-reviewer'), false);
  }
});
