import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type {
  HookInput,
  HookJSONOutput,
  SDKMessage,
  SDKResultMessage,
  SyncHookJSONOutput,
} from '@anthropic-ai/claude-agent-sdk';

import {
  configureDiagnosticFooter,
  resetDiagnosticStateForTests,
  setDiagnosticDetailVisibility,
} from '../src/neal/diagnostic.js';
import { buildReviewerSchema, validateReviewerPayload, type ReviewerPayload } from '../src/neal/agents/schemas.js';
import type { RunLogger } from '../src/neal/logger.js';
import {
  disableAgentSettingsIsolation,
  enableAgentSettingsIsolation,
} from '../src/neal/providers/agent-settings-isolation.js';
import { anthropicClaudeProviderTestHooks } from '../src/neal/providers/anthropic-claude.js';
import { createProviderTelemetrySink } from '../src/neal/providers/telemetry.js';
import {
  NealProviderError,
  type CoderRunPromptArgs,
  type CoderStructuredPromptArgs,
  type ProviderRuntimeEvent,
  type StructuredAdvisorRoundArgs,
} from '../src/neal/providers/types.js';

class FakeFooter {
  readonly writes: string[] = [];

  write(message: string) {
    this.writes.push(message);
  }

  dispose() {}
}

class FakeLogger {
  readonly stderrMessages: string[] = [];
  readonly events: Array<{ type: string; data?: Record<string, unknown> }> = [];

  async stderr(message: string) {
    this.stderrMessages.push(message);
  }

  async event(type: string, data?: Record<string, unknown>) {
    this.events.push({ type, data });
  }

  asRunLogger() {
    return this as unknown as RunLogger;
  }
}

function resultMessage(args: {
  sessionId?: string;
  result: string;
  structuredOutput?: unknown;
  subtype?: string;
  isError?: boolean;
  totalCostUsd?: number;
}): SDKResultMessage {
  return {
    type: 'result',
    subtype: args.subtype ?? 'success',
    duration_ms: 1,
    duration_api_ms: 1,
    is_error: args.isError ?? false,
    num_turns: 1,
    result: args.result,
    stop_reason: null,
    total_cost_usd: args.totalCostUsd ?? 0,
    usage: {
      input_tokens: 0,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 0,
      output_tokens: 0,
      server_tool_use: {
        web_search_requests: 0,
      },
      service_tier: null,
    },
    modelUsage: {},
    permission_denials: [],
    uuid: '00000000-0000-4000-8000-000000000000',
    session_id: args.sessionId ?? 'claude-session-1',
    ...(args.structuredOutput === undefined ? {} : { structured_output: args.structuredOutput }),
  } as unknown as SDKResultMessage;
}

function assistantTextMessage(text: string, sessionId = 'claude-session-1'): SDKMessage {
  return {
    type: 'assistant',
    session_id: sessionId,
    message: {
      id: 'msg_1',
      type: 'message',
      role: 'assistant',
      model: 'claude-test',
      content: [{ type: 'text', text }],
      stop_reason: 'end_turn',
      stop_sequence: null,
      usage: {
        input_tokens: 0,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 0,
        output_tokens: 0,
        server_tool_use: {
          web_search_requests: 0,
        },
        service_tier: null,
      },
    },
  } as unknown as SDKMessage;
}

function textDeltaMessage(text: string, sessionId = 'claude-session-1'): SDKMessage {
  return {
    type: 'stream_event',
    session_id: sessionId,
    event: {
      type: 'content_block_delta',
      delta: { type: 'text_delta', text },
    },
  } as unknown as SDKMessage;
}

function contentBlockStopMessage(sessionId = 'claude-session-1'): SDKMessage {
  return {
    type: 'stream_event',
    session_id: sessionId,
    event: { type: 'content_block_stop' },
  } as unknown as SDKMessage;
}

function systemMessage(subtype: string, data: Record<string, unknown>): SDKMessage {
  return {
    type: 'system',
    session_id: 'claude-session-1',
    subtype,
    ...data,
  } as unknown as SDKMessage;
}

function toolUseSummaryMessage(summary: string): SDKMessage {
  return {
    type: 'tool_use_summary',
    session_id: 'claude-session-1',
    summary,
  } as unknown as SDKMessage;
}

function assistantToolUseMessage(
  args: { id: string; name: string; input: Record<string, unknown> },
  sessionId = 'claude-session-1',
): SDKMessage {
  return {
    type: 'assistant',
    session_id: sessionId,
    message: {
      id: 'msg_tool_use',
      type: 'message',
      role: 'assistant',
      model: 'claude-test',
      content: [{ type: 'tool_use', id: args.id, name: args.name, input: args.input }],
      stop_reason: 'tool_use',
      stop_sequence: null,
      usage: {
        input_tokens: 0,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 0,
        output_tokens: 0,
        server_tool_use: {
          web_search_requests: 0,
        },
        service_tier: null,
      },
    },
  } as unknown as SDKMessage;
}

function toolResultMessage(
  args: { toolUseId: string; content?: string; isError?: boolean },
  sessionId = 'claude-session-1',
): SDKMessage {
  return {
    type: 'user',
    session_id: sessionId,
    parent_tool_use_id: null,
    message: {
      role: 'user',
      content: [
        {
          type: 'tool_result',
          tool_use_id: args.toolUseId,
          ...(args.content === undefined ? {} : { content: args.content }),
          ...(args.isError === undefined ? {} : { is_error: args.isError }),
        },
      ],
    },
  } as unknown as SDKMessage;
}

async function* messageStream(messages: SDKMessage[]) {
  for (const message of messages) {
    yield message;
  }
}

async function* stalledMessageStream(): AsyncGenerator<SDKMessage, void> {
  await new Promise(() => {});
}

async function* streamThenThrow(messages: SDKMessage[], error: Error): AsyncGenerator<SDKMessage, void> {
  for (const message of messages) {
    yield message;
  }
  throw error;
}

function structuredAdvisorArgs(overrides: Partial<StructuredAdvisorRoundArgs> = {}): StructuredAdvisorRoundArgs {
  return {
    label: 'review',
    cwd: process.cwd(),
    prompt: 'review the current work',
    schema: {
      type: 'object',
      additionalProperties: true,
    },
    inactivityTimeoutMs: 600_000,
    apiRetryLimit: 0,
    ...overrides,
  };
}

function validReviewerPayload(overrides: Partial<ReviewerPayload> = {}): ReviewerPayload {
  return {
    summary: 'Build succeeds and all tests pass.',
    findings: [],
    meaningfulProgressAction: 'accept',
    meaningfulProgressRationale: 'The implementation materially advances the active objective.',
    ...overrides,
  };
}

function reviewerJson(payload: unknown = validReviewerPayload()) {
  return JSON.stringify(payload, null, 2);
}

function reviewerJsonBlock(payload: unknown = validReviewerPayload(), prose = 'Review complete.') {
  return `${prose}\n\n\`\`\`neal-json\n${reviewerJson(payload)}\n\`\`\``;
}

type ReviewerJsonBlockStructuredAdvisorArgs = StructuredAdvisorRoundArgs<ReviewerPayload> & {
  structuredJsonProtocol: NonNullable<StructuredAdvisorRoundArgs<ReviewerPayload>['structuredJsonProtocol']>;
};

function reviewerStructuredAdvisorArgs(
  overrides: Partial<StructuredAdvisorRoundArgs<ReviewerPayload>> = {},
): ReviewerJsonBlockStructuredAdvisorArgs {
  return {
    ...structuredAdvisorArgs({
      schema: buildReviewerSchema(),
    }),
    label: 'review',
    structuredJsonProtocol: {
      protocol: 'neal-json-block-v1',
      schemaLabel: 'reviewer_payload',
      schema: buildReviewerSchema(),
      validator: validateReviewerPayload,
      repairAttemptLimit: 2,
    },
    ...overrides,
  } as ReviewerJsonBlockStructuredAdvisorArgs;
}

function coderStructuredArgs(overrides: Partial<CoderStructuredPromptArgs> = {}): CoderStructuredPromptArgs {
  const schema = {
    type: 'object',
    additionalProperties: true,
  };
  return {
    label: 'Coder response round',
    cwd: process.cwd(),
    prompt: 'respond to findings',
    schema,
    structuredJsonProtocol: {
      protocol: 'neal-json-block-v1',
      schemaLabel: 'coder_response_payload',
      schema,
      validator: (payload: unknown) => payload,
      repairAttemptLimit: 2,
    },
    inactivityTimeoutMs: 600_000,
    ...overrides,
  };
}

function coderRunArgs(overrides: Partial<CoderRunPromptArgs> = {}): CoderRunPromptArgs {
  return {
    cwd: process.cwd(),
    prompt: 'implement the requested change',
    inactivityTimeoutMs: 600_000,
    ...overrides,
  };
}

test('Claude executable resolver selects the SDK glibc Linux binary when resolvable', () => {
  const calls: string[] = [];
  const resolve = (specifier: string) => {
    calls.push(specifier);
    return `/sdk/${specifier}`;
  };

  assert.equal(
    anthropicClaudeProviderTestHooks.getClaudeCodeExecutablePath({
      platform: 'linux',
      arch: 'x64',
      glibcVersionRuntime: '2.41',
      resolve,
    }),
    '/sdk/@anthropic-ai/claude-agent-sdk-linux-x64/claude',
  );
  assert.deepEqual(calls, ['@anthropic-ai/claude-agent-sdk-linux-x64/claude']);
});

test('Claude executable resolver selects the SDK glibc Linux arm64 binary when resolvable', () => {
  const calls: string[] = [];
  const resolve = (specifier: string) => {
    calls.push(specifier);
    return `/sdk/${specifier}`;
  };

  assert.equal(
    anthropicClaudeProviderTestHooks.getClaudeCodeExecutablePath({
      platform: 'linux',
      arch: 'arm64',
      glibcVersionRuntime: '2.41',
      resolve,
    }),
    '/sdk/@anthropic-ai/claude-agent-sdk-linux-arm64/claude',
  );
  assert.deepEqual(calls, ['@anthropic-ai/claude-agent-sdk-linux-arm64/claude']);
});

test('Claude executable resolver leaves non-glibc and non-Linux runtimes to the SDK default', () => {
  const calls: string[] = [];
  const resolve = (specifier: string) => {
    calls.push(specifier);
    return `/sdk/${specifier}`;
  };

  assert.equal(
    anthropicClaudeProviderTestHooks.getClaudeCodeExecutablePath({
      platform: 'linux',
      arch: 'x64',
      glibcVersionRuntime: undefined,
      resolve,
    }),
    undefined,
  );
  assert.equal(
    anthropicClaudeProviderTestHooks.getClaudeCodeExecutablePath({
      platform: 'linux',
      arch: 'x64',
      glibcVersionRuntime: '',
      resolve,
    }),
    undefined,
  );
  assert.equal(
    anthropicClaudeProviderTestHooks.getClaudeCodeExecutablePath({
      platform: 'darwin',
      arch: 'x64',
      glibcVersionRuntime: '2.41',
      resolve,
    }),
    undefined,
  );
  assert.equal(
    anthropicClaudeProviderTestHooks.getClaudeCodeExecutablePath({
      platform: 'win32',
      arch: 'x64',
      glibcVersionRuntime: '2.41',
      resolve,
    }),
    undefined,
  );
  assert.deepEqual(calls, []);
});

test('Claude executable resolver leaves resolver failures to the SDK default', () => {
  const calls: string[] = [];
  const resolve = (specifier: string) => {
    calls.push(specifier);
    throw new Error(`cannot resolve ${specifier}`);
  };

  assert.equal(
    anthropicClaudeProviderTestHooks.getClaudeCodeExecutablePath({
      platform: 'linux',
      arch: 'x64',
      glibcVersionRuntime: '2.41',
      resolve,
    }),
    undefined,
  );
  assert.deepEqual(calls, ['@anthropic-ai/claude-agent-sdk-linux-x64/claude']);
});

test('Claude executable resolver lets unsupported Linux architectures fail through resolution', () => {
  const calls: string[] = [];
  const resolve = (specifier: string) => {
    calls.push(specifier);
    throw new Error(`cannot resolve ${specifier}`);
  };

  assert.equal(
    anthropicClaudeProviderTestHooks.getClaudeCodeExecutablePath({
      platform: 'linux',
      arch: 'ia32',
      glibcVersionRuntime: '2.41',
      resolve,
    }),
    undefined,
  );
  assert.deepEqual(calls, ['@anthropic-ai/claude-agent-sdk-linux-ia32/claude']);
});

test('Claude glibc runtime detection requires a non-empty string', () => {
  assert.equal(anthropicClaudeProviderTestHooks.isGlibcRuntime('2.41'), true);
  assert.equal(anthropicClaudeProviderTestHooks.isGlibcRuntime(undefined), false);
  assert.equal(anthropicClaudeProviderTestHooks.isGlibcRuntime(''), false);
});

test('Claude advisor query options preserve behavior and include an injected executable path', () => {
  const events: Array<Record<string, unknown>> = [];
  const args = structuredAdvisorArgs({
    cwd: '/tmp/neal-advisor',
    events: (event) => {
      events.push(event);
    },
  });
  const options = anthropicClaudeProviderTestHooks.buildClaudeQueryOptions(args, null, '/sdk/claude');

  assert.equal(options.cwd, '/tmp/neal-advisor');
  assert.equal(options.pathToClaudeCodeExecutable, '/sdk/claude');
  assert.deepEqual(options.tools, ['Read', 'Grep', 'Glob']);
  assert.equal(options.permissionMode, 'bypassPermissions');
  // Default (no compat isolation): settingSources unset, so the SDK loads the
  // operator's config. Isolation is asserted separately below.
  assert.equal(options.settingSources, undefined);
  assert.equal(options.allowDangerouslySkipPermissions, true);
  assert.deepEqual(options.outputFormat, { type: 'json_schema', schema: args.schema });
  options.stderr?.('advisor stderr');
  assert.deepEqual(events, [
    {
      type: 'tool_progress',
      provider: 'anthropic-claude',
      role: 'structured-advisor',
      label: 'review',
      sessionHandle: null,
      toolName: 'stderr',
      message: 'advisor stderr',
      isError: true,
      providerData: { stream: 'stderr' },
    },
  ]);
});

test('Claude query options isolate settings only under compat isolation', () => {
  const args = structuredAdvisorArgs({ cwd: '/tmp/neal-advisor' });

  // Default: no compat isolation, so settingSources is unset and the SDK loads
  // the operator's config (CLAUDE.md, hooks, permissions).
  assert.equal(
    anthropicClaudeProviderTestHooks.buildClaudeQueryOptions(args, null, '/sdk/claude').settingSources,
    undefined,
  );

  // Under compat isolation, settingSources is [] (SDK isolation mode): none of
  // the operator's filesystem settings load, so no per-turn notifier hook fires.
  try {
    enableAgentSettingsIsolation();
    assert.deepEqual(
      anthropicClaudeProviderTestHooks.buildClaudeQueryOptions(args, null, '/sdk/claude').settingSources,
      [],
    );
  } finally {
    disableAgentSettingsIsolation();
  }
});

test('Claude advisor query options preserve resume and model behavior', () => {
  const events: Array<Record<string, unknown>> = [];
  const resumedOptions = anthropicClaudeProviderTestHooks.buildClaudeQueryOptions(
    structuredAdvisorArgs({
      resumeHandle: 'session-1',
      events: (event) => {
        events.push(event);
      },
    }),
    null,
    '',
  );
  assert.equal(resumedOptions.resume, 'session-1');
  assert.equal('pathToClaudeCodeExecutable' in resumedOptions, false);
  resumedOptions.stderr?.('advisor resumed stderr');
  assert.deepEqual(events, [
    {
      type: 'tool_progress',
      provider: 'anthropic-claude',
      role: 'structured-advisor',
      label: 'review',
      sessionHandle: 'session-1',
      toolName: 'stderr',
      message: 'advisor resumed stderr',
      isError: true,
      providerData: { stream: 'stderr' },
    },
  ]);
  assert.equal(
    'pathToClaudeCodeExecutable' in
      anthropicClaudeProviderTestHooks.buildClaudeQueryOptions(structuredAdvisorArgs(), null, ''),
    false,
  );

  assert.equal(
    anthropicClaudeProviderTestHooks.buildClaudeQueryOptions(
      structuredAdvisorArgs({ model: 'advisor-model' }),
      'default-model',
      '',
    ).model,
    'advisor-model',
  );
  assert.equal(
    anthropicClaudeProviderTestHooks.buildClaudeQueryOptions(structuredAdvisorArgs(), 'default-model', '').model,
    'default-model',
  );
});

test('Claude review JSON-block query options omit SDK outputFormat while preserving review tools', () => {
  const events: Array<Record<string, unknown>> = [];
  const args = reviewerStructuredAdvisorArgs({
    cwd: '/tmp/neal-json-review',
    resumeHandle: 'review-session-1',
    events: (event) => {
      events.push(event);
    },
  });
  const options = anthropicClaudeProviderTestHooks.buildClaudeJsonBlockQueryOptions(args, 'default-model', '/sdk/claude');
  const prompt = anthropicClaudeProviderTestHooks.buildClaudeJsonBlockReviewPrompt(args);

  assert.equal(options.cwd, '/tmp/neal-json-review');
  assert.equal(options.model, 'default-model');
  assert.equal(options.resume, 'review-session-1');
  assert.equal(options.pathToClaudeCodeExecutable, '/sdk/claude');
  assert.deepEqual(options.tools, ['Read', 'Grep', 'Glob']);
  assert.equal(options.permissionMode, 'bypassPermissions');
  // Default (no compat isolation): settingSources unset, so the SDK loads the
  // operator's config. Isolation is asserted separately below.
  assert.equal(options.settingSources, undefined);
  assert.equal(options.allowDangerouslySkipPermissions, true);
  assert.equal('outputFormat' in options, false);
  assert.match(prompt, /exactly one final fenced ```neal-json JSON block/);
  assert.match(prompt, /"meaningfulProgressAction"/);
  options.stderr?.('json review stderr');
  assert.deepEqual(events, [
    {
      type: 'tool_progress',
      provider: 'anthropic-claude',
      role: 'structured-advisor',
      label: 'review',
      sessionHandle: 'review-session-1',
      toolName: 'stderr',
      message: 'json review stderr',
      isError: true,
      providerData: { stream: 'stderr' },
    },
  ]);
});

test('Claude JSON-block repair query options omit SDK outputFormat, repo tools, and resume', () => {
  const events: Array<Record<string, unknown>> = [];
  const options = anthropicClaudeProviderTestHooks.buildClaudeJsonBlockRepairQueryOptions(
    reviewerStructuredAdvisorArgs({
      cwd: '/tmp/neal-json-repair',
      model: 'repair-model',
      resumeHandle: 'must-not-resume',
      events: (event) => {
        events.push(event);
      },
    }),
    'default-model',
    '/sdk/claude',
  );

  assert.equal(options.cwd, '/tmp/neal-json-repair');
  assert.equal(options.model, 'repair-model');
  assert.deepEqual(options.tools, []);
  assert.equal('resume' in options, false);
  assert.equal('outputFormat' in options, false);
  assert.equal(options.pathToClaudeCodeExecutable, '/sdk/claude');
  options.stderr?.('json repair stderr');
  assert.deepEqual(events, [
    {
      type: 'tool_progress',
      provider: 'anthropic-claude',
      role: 'structured-advisor',
      label: 'review:structured-json-repair',
      sessionHandle: null,
      toolName: 'stderr',
      message: 'json repair stderr',
      isError: true,
      providerData: { stream: 'stderr' },
    },
  ]);
});

test('Claude reviewer query option builders never expose write or shell tools, while the coder builder does', () => {
  const writeOrShellTools = ['Bash', 'Edit', 'Write'];

  const advisorTools = anthropicClaudeProviderTestHooks.buildClaudeQueryOptions(
    structuredAdvisorArgs(),
    null,
    '',
  ).tools as string[];
  const jsonBlockTools = anthropicClaudeProviderTestHooks.buildClaudeJsonBlockQueryOptions(
    reviewerStructuredAdvisorArgs(),
    null,
    '',
  ).tools as string[];
  const repairTools = anthropicClaudeProviderTestHooks.buildClaudeJsonBlockRepairQueryOptions(
    reviewerStructuredAdvisorArgs(),
    null,
    '',
  ).tools as string[];
  const coderTools = anthropicClaudeProviderTestHooks.buildClaudeCoderQueryOptions(
    coderRunArgs(),
    null,
    '',
  ).tools as string[];

  for (const reviewerTools of [advisorTools, jsonBlockTools, repairTools]) {
    for (const forbidden of writeOrShellTools) {
      assert.equal(reviewerTools.includes(forbidden), false, `reviewer must not expose ${forbidden}`);
    }
  }

  for (const required of writeOrShellTools) {
    assert.equal(coderTools.includes(required), true, `coder must expose ${required}`);
  }
});

test('Claude SDK compatibility advisor query options still use SDK outputFormat', () => {
  const args = structuredAdvisorArgs({
    label: 'plan-review',
    schema: {
      type: 'object',
      additionalProperties: false,
    },
  });
  const options = anthropicClaudeProviderTestHooks.buildClaudeQueryOptions(args, null, '');

  assert.deepEqual(options.outputFormat, { type: 'json_schema', schema: args.schema });
});

test('Claude coder query options preserve behavior and include an injected executable path', () => {
  const events: Array<Record<string, unknown>> = [];
  const outputSchema = {
    type: 'object',
    additionalProperties: false,
  };
  const options = anthropicClaudeProviderTestHooks.buildClaudeCoderQueryOptions(
    coderRunArgs({
      cwd: '/tmp/neal-coder',
      outputSchema,
      events: (event) => {
        events.push(event);
      },
    }),
    null,
    '/sdk/claude',
  );

  assert.equal(options.cwd, '/tmp/neal-coder');
  assert.equal(options.pathToClaudeCodeExecutable, '/sdk/claude');
  assert.deepEqual(options.tools, ['Read', 'Grep', 'Glob', 'Bash', 'Edit', 'Write']);
  assert.equal(options.permissionMode, 'bypassPermissions');
  // Default (no compat isolation): settingSources unset, so the SDK loads the
  // operator's config. Isolation is asserted separately below.
  assert.equal(options.settingSources, undefined);
  assert.equal(options.allowDangerouslySkipPermissions, true);
  assert.deepEqual(options.outputFormat, { type: 'json_schema', schema: outputSchema });
  options.stderr?.('coder stderr');
  assert.deepEqual(events, [
    {
      type: 'tool_progress',
      provider: 'anthropic-claude',
      role: 'coder',
      label: 'coder',
      sessionHandle: null,
      toolName: 'stderr',
      message: 'coder stderr',
      isError: true,
      providerData: { stream: 'stderr' },
    },
  ]);
});

test('Claude coder query options preserve resume, model, and unstructured behavior', () => {
  const events: Array<Record<string, unknown>> = [];
  const resumedOptions = anthropicClaudeProviderTestHooks.buildClaudeCoderQueryOptions(
    coderRunArgs({
      resumeHandle: 'session-2',
      events: (event) => {
        events.push(event);
      },
    }),
    null,
    '',
  );
  assert.equal(resumedOptions.resume, 'session-2');
  assert.equal('pathToClaudeCodeExecutable' in resumedOptions, false);
  resumedOptions.stderr?.('coder resumed stderr');
  assert.deepEqual(events, [
    {
      type: 'tool_progress',
      provider: 'anthropic-claude',
      role: 'coder',
      label: 'coder',
      sessionHandle: 'session-2',
      toolName: 'stderr',
      message: 'coder resumed stderr',
      isError: true,
      providerData: { stream: 'stderr' },
    },
  ]);
  assert.equal(
    'pathToClaudeCodeExecutable' in
      anthropicClaudeProviderTestHooks.buildClaudeCoderQueryOptions(coderRunArgs(), null, ''),
    false,
  );

  assert.equal(
    anthropicClaudeProviderTestHooks.buildClaudeCoderQueryOptions(coderRunArgs(), 'default-model', '').model,
    'default-model',
  );
  assert.equal(
    'outputFormat' in anthropicClaudeProviderTestHooks.buildClaudeCoderQueryOptions(coderRunArgs(), null, ''),
    false,
  );
});

function preToolUseHookInput(toolName: string, toolInput: unknown, cwd: string): HookInput {
  return {
    hook_event_name: 'PreToolUse',
    tool_name: toolName,
    tool_input: toolInput,
    tool_use_id: 'tool-use-1',
    session_id: 'claude-session-1',
    transcript_path: '/tmp/transcript.jsonl',
    cwd,
  };
}

function assertPreToolUseDeny(output: HookJSONOutput, messageFragment: string) {
  const specific = (output as SyncHookJSONOutput).hookSpecificOutput;
  assert.equal(specific?.hookEventName, 'PreToolUse');
  if (specific?.hookEventName !== 'PreToolUse') {
    throw new Error('expected a PreToolUse hook output');
  }
  assert.equal(specific.permissionDecision, 'deny');
  assert.equal((specific.permissionDecisionReason ?? '').includes(messageFragment), true);
}

test('Claude coder toolPolicy excludes Bash and installs the write-path guard hook', () => {
  const jailedOptions = anthropicClaudeProviderTestHooks.buildClaudeCoderQueryOptions(
    coderRunArgs({
      cwd: '/tmp/neal-plan-jail',
      toolPolicy: { allowedWritePaths: ['/tmp/neal-plan-jail/plan.md'], allowRun: false },
    }),
    null,
    '',
  );
  assert.deepEqual(jailedOptions.tools, ['Read', 'Grep', 'Glob', 'Edit', 'Write']);
  assert.equal(jailedOptions.hooks?.PreToolUse?.length, 1);
  assert.equal(jailedOptions.hooks?.PreToolUse?.[0]?.hooks.length, 1);
  assert.equal(jailedOptions.permissionMode, 'bypassPermissions');
  // Default (no compat isolation): settingSources unset even on jailed coder
  // turns; the write-path guard hooks are passed programmatically, not loaded.
  assert.equal(jailedOptions.settingSources, undefined);

  // Policy-free coder turns keep the full toolset and gain no hooks.
  const openOptions = anthropicClaudeProviderTestHooks.buildClaudeCoderQueryOptions(coderRunArgs(), null, '');
  assert.deepEqual(openOptions.tools, ['Read', 'Grep', 'Glob', 'Bash', 'Edit', 'Write']);
  assert.equal('hooks' in openOptions, false);
});

test('Claude coder write-path guard allows only the allowlisted paths and fails closed', async () => {
  const cwd = '/tmp/neal-plan-jail';
  const options = anthropicClaudeProviderTestHooks.buildClaudeCoderQueryOptions(
    coderRunArgs({
      cwd,
      toolPolicy: { allowedWritePaths: [`${cwd}/plan.md`], allowRun: false },
    }),
    null,
    '',
  );
  const guard = options.hooks?.PreToolUse?.[0]?.hooks[0];
  assert.notEqual(guard, undefined);
  const invoke = (toolName: string, toolInput: unknown) =>
    guard!(preToolUseHookInput(toolName, toolInput, cwd), 'tool-use-1', { signal: new AbortController().signal });

  // Absolute and cwd-relative spellings of the allowlisted path both pass.
  assert.deepEqual(await invoke('Write', { file_path: `${cwd}/plan.md`, content: 'plan body' }), { continue: true });
  assert.deepEqual(await invoke('Edit', { file_path: 'plan.md', old_string: 'a', new_string: 'b' }), {
    continue: true,
  });
  // Read-class tools are untouched by the write jail.
  assert.deepEqual(await invoke('Read', { file_path: `${cwd}/src/index.ts` }), { continue: true });

  // Any other write target is denied, as is a write without a recognizable path.
  assertPreToolUseDeny(await invoke('Write', { file_path: `${cwd}/src/index.ts`, content: 'nope' }), '/src/index.ts');
  assertPreToolUseDeny(await invoke('Edit', { file_path: '../outside.md', old_string: 'a', new_string: 'b' }), '../outside.md');
  assertPreToolUseDeny(await invoke('Write', { content: 'no path at all' }), 'an unrecognized path');
});

test('Claude option builders emit Options.effort when a default effort is supplied', () => {
  assert.equal(
    anthropicClaudeProviderTestHooks.buildClaudeQueryOptions(structuredAdvisorArgs(), null, '', 'high').effort,
    'high',
  );
  assert.equal(
    anthropicClaudeProviderTestHooks.buildClaudeJsonBlockQueryOptions(
      reviewerStructuredAdvisorArgs(),
      null,
      '',
      'high',
    ).effort,
    'high',
  );
  assert.equal(
    anthropicClaudeProviderTestHooks.buildClaudeJsonBlockRepairQueryOptions(
      reviewerStructuredAdvisorArgs(),
      null,
      '',
      'high',
    ).effort,
    'high',
  );
  assert.equal(
    anthropicClaudeProviderTestHooks.buildClaudeCoderQueryOptions(coderRunArgs(), null, '', 'high').effort,
    'high',
  );
  assert.equal(
    anthropicClaudeProviderTestHooks.buildClaudeCoderRepairQueryOptions(coderStructuredArgs(), null, '', 'high').effort,
    'high',
  );
});

test('Claude option builders omit Options.effort when effort is null or omitted', () => {
  assert.equal(
    'effort' in anthropicClaudeProviderTestHooks.buildClaudeQueryOptions(structuredAdvisorArgs(), null, ''),
    false,
  );
  assert.equal(
    'effort' in
      anthropicClaudeProviderTestHooks.buildClaudeJsonBlockQueryOptions(reviewerStructuredAdvisorArgs(), null, '', null),
    false,
  );
  assert.equal(
    'effort' in
      anthropicClaudeProviderTestHooks.buildClaudeJsonBlockRepairQueryOptions(
        reviewerStructuredAdvisorArgs(),
        null,
        '',
        null,
      ),
    false,
  );
  assert.equal(
    'effort' in anthropicClaudeProviderTestHooks.buildClaudeCoderQueryOptions(coderRunArgs(), null, '', null),
    false,
  );
  assert.equal(
    'effort' in anthropicClaudeProviderTestHooks.buildClaudeCoderRepairQueryOptions(coderStructuredArgs(), null, ''),
    false,
  );
});

test('Claude structured result selection ignores late unstructured background result messages', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'neal-claude-provider-'));
  const structuredOutput = {
    summary: 'Scope 1 accepted.',
    findings: [],
    meaningfulProgressAction: 'accept',
    meaningfulProgressRationale: 'The implementation satisfies the requested scope.',
  };
  const lateBackgroundText =
    'Background task completed - that grep finished after the review was already submitted. No action needed.';

  const collected = await anthropicClaudeProviderTestHooks.collectClaudeResult(
    messageStream([
      resultMessage({
        result: 'Review complete. No findings. Scope 1 accepted.',
        structuredOutput,
      }),
      assistantTextMessage(lateBackgroundText),
      resultMessage({
        result: lateBackgroundText,
      }),
    ]),
    cwd,
    'review',
    600_000,
  );

  assert.equal(collected.sessionHandle, 'claude-session-1');
  assert.equal((collected.lastResult as { result?: string } | null)?.result, lateBackgroundText);
  assert.deepEqual(
    anthropicClaudeProviderTestHooks.getPreferredStructuredOutput(collected),
    structuredOutput,
  );
  assert.equal(collected.assistantText, lateBackgroundText);
});

test('Claude result collection captures streamed assistant text for local validation', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'neal-claude-provider-stream-text-'));

  const collected = await anthropicClaudeProviderTestHooks.collectClaudeResult(
    messageStream([
      textDeltaMessage('First reviewer paragraph.\nSecond reviewer paragraph', 'stream-text-session'),
      contentBlockStopMessage('stream-text-session'),
      resultMessage({
        sessionId: 'stream-text-session',
        subtype: 'error_max_structured_output_retries',
        isError: true,
        result: 'Failed to provide valid structured output after 5 attempts',
      }),
    ]),
    cwd,
    'review',
    600_000,
  );

  assert.equal(collected.sessionHandle, 'stream-text-session');
  assert.equal(collected.assistantText, 'First reviewer paragraph.\n\nSecond reviewer paragraph');
});

test('Claude assistant text mirror accepts only matching Claude assistant text events', () => {
  const matching = anthropicClaudeProviderTestHooks.getMirroredAssistantText(
    {
      type: 'assistant_text',
      provider: 'anthropic-claude',
      role: 'structured-advisor',
      label: 'review',
      sessionHandle: 'review-session',
      text: '  Reviewer prose.  ',
    },
    'structured-advisor',
    'review',
  );
  assert.equal(matching, 'Reviewer prose.');
  assert.equal(
    anthropicClaudeProviderTestHooks.getMirroredAssistantText(
      {
        type: 'assistant_text',
        provider: 'anthropic-claude',
        role: 'structured-advisor',
        label: 'plan-review',
        sessionHandle: 'review-session',
        text: 'Wrong label.',
      },
      'structured-advisor',
      'review',
    ),
    null,
  );
  assert.equal(
    anthropicClaudeProviderTestHooks.getMirroredAssistantText(
      {
        type: 'tool_progress',
        provider: 'anthropic-claude',
        role: 'structured-advisor',
        label: 'review',
        sessionHandle: 'review-session',
      },
      'structured-advisor',
      'review',
    ),
    null,
  );
});

test('Claude structured result selection treats null structured output as absent', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'neal-claude-provider-null-'));

  const collected = await anthropicClaudeProviderTestHooks.collectClaudeResult(
    messageStream([
      resultMessage({
        result: 'No structured payload was produced.',
        structuredOutput: null,
      }),
    ]),
    cwd,
    'review',
    600_000,
  );

  assert.equal(anthropicClaudeProviderTestHooks.getPreferredStructuredOutput(collected), undefined);
});

test('Claude diagnostics keep provider telemetry out of the default terminal but persist it to artifacts', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'neal-claude-provider-diagnostics-'));
  const footer = new FakeFooter();
  const logger = new FakeLogger();
  resetDiagnosticStateForTests();
  configureDiagnosticFooter(footer);

  try {
    await anthropicClaudeProviderTestHooks.collectClaudeResult(
      messageStream([
        assistantTextMessage('This is a long assistant explanation that belongs in artifacts.'),
        systemMessage('local_command_output', { content: 'local shell output\nsecret detail' }),
        systemMessage('task_started', { description: 'review current diff' }),
        toolUseSummaryMessage('Read 2 files.'),
        resultMessage({
          result: 'Review complete.',
          structuredOutput: { summary: 'ok' },
        }),
      ]),
      cwd,
      'review',
      600_000,
      createProviderTelemetrySink({
        logger: logger.asRunLogger(),
        provider: 'anthropic-claude',
        role: 'structured-advisor',
        label: 'review',
        cwd,
      }),
    );

    const terminal = footer.writes.join('');
    const artifactLog = logger.stderrMessages.join('');
    assert.doesNotMatch(terminal, /\[claude:review\] task started: review current diff/);
    assert.doesNotMatch(terminal, /\[claude:review\] Read 2 files\./);
    assert.doesNotMatch(terminal, /\[claude:review\] result: success/);
    assert.doesNotMatch(terminal, /long assistant explanation/);
    assert.doesNotMatch(terminal, /secret detail/);
    assert.match(artifactLog, /\[claude:review\] task started: review current diff/);
    assert.match(artifactLog, /\[claude:review\] Read 2 files\./);
    assert.match(artifactLog, /\[claude:review\] result: success/);
    assert.match(artifactLog, /long assistant explanation/);
    assert.match(artifactLog, /secret detail/);
    assert.deepEqual(
      logger.events.map((event) => event.type),
      [
        'provider.session_started',
        'provider.assistant_text',
        'provider.tool_progress',
        'provider.tool_started',
        'provider.tool_progress',
        'provider.tool_progress',
        'provider.turn_completed',
        'provider.usage_reported',
      ],
    );
  } finally {
    resetDiagnosticStateForTests();
  }
});

test('Claude detail visibility surfaces assistant text and local command output', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'neal-claude-provider-verbose-'));
  const footer = new FakeFooter();
  const logger = new FakeLogger();
  resetDiagnosticStateForTests();
  setDiagnosticDetailVisibility(true);
  configureDiagnosticFooter(footer);

  try {
    await anthropicClaudeProviderTestHooks.collectClaudeResult(
      messageStream([
        assistantTextMessage('Verbose assistant detail.'),
        systemMessage('local_command_output', { content: 'verbose command output' }),
        resultMessage({
          result: 'Review complete.',
          structuredOutput: { summary: 'ok' },
        }),
      ]),
      cwd,
      'review',
      600_000,
      createProviderTelemetrySink({
        logger: logger.asRunLogger(),
        provider: 'anthropic-claude',
        role: 'structured-advisor',
        label: 'review',
        cwd,
      }),
    );

    const terminal = footer.writes.join('');
    assert.match(terminal, /Verbose assistant detail/);
    assert.match(terminal, /verbose command output/);
    assert.match(terminal, /result: success/);
  } finally {
    resetDiagnosticStateForTests();
  }
});

function isCommandCompleted(
  event: ProviderRuntimeEvent,
): event is Extract<ProviderRuntimeEvent, { type: 'command_completed' }> {
  return event.type === 'command_completed';
}

function isFileChanged(event: ProviderRuntimeEvent): event is Extract<ProviderRuntimeEvent, { type: 'file_changed' }> {
  return event.type === 'file_changed';
}

async function collectToolMappingEvents(messages: SDKMessage[], cwd: string) {
  const events: ProviderRuntimeEvent[] = [];
  await anthropicClaudeProviderTestHooks.collectClaudeResult(
    messageStream(messages),
    cwd,
    'coder',
    600_000,
    (event) => {
      events.push(event);
    },
    'coder',
  );
  return events;
}

test('Claude coder Bash tool results emit exactly one command_completed with the command and status', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'neal-claude-provider-bash-'));

  const events = await collectToolMappingEvents(
    [
      assistantTextMessage('Running the verification suite.'),
      assistantToolUseMessage({ id: 'tool-bash-1', name: 'Bash', input: { command: 'pnpm typecheck && pnpm test' } }),
      toolResultMessage({ toolUseId: 'tool-bash-1', content: 'all checks passed' }),
      assistantTextMessage('Verification passed.'),
      resultMessage({ result: 'Done.' }),
    ],
    cwd,
  );

  // Assistant text around the tool call is unchanged by the tool mapping.
  assert.deepEqual(
    events.map((event) => event.type),
    ['session_started', 'assistant_text', 'command_completed', 'assistant_text', 'turn_completed', 'usage_reported'],
  );
  assert.deepEqual(
    events
      .filter((event): event is Extract<ProviderRuntimeEvent, { type: 'assistant_text' }> => event.type === 'assistant_text')
      .map((event) => event.text),
    ['Running the verification suite.', 'Verification passed.'],
  );

  const commandEvents = events.filter(isCommandCompleted);
  assert.equal(commandEvents.length, 1);
  const commandEvent = commandEvents[0];
  assert.equal(commandEvent?.command, 'pnpm typecheck && pnpm test');
  assert.equal(commandEvent?.status, 'completed');
  assert.equal(commandEvent?.exitCode, undefined, 'the Claude SDK exposes no exit code, so exitCode is omitted');
  assert.equal(commandEvent?.output, 'all checks passed');
  assert.equal(commandEvent?.cwd, cwd);
  assert.equal(commandEvent?.itemId, 'tool-bash-1');
  assert.equal(commandEvent?.provider, 'anthropic-claude');
  assert.equal(commandEvent?.role, 'coder');
  assert.equal(commandEvent?.sessionHandle, 'claude-session-1');
});

test('Claude result total_cost_usd flows into turn_completed and usage_reported as provider cost', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'neal-claude-provider-cost-'));

  const events = await collectToolMappingEvents(
    [
      assistantTextMessage('All set.'),
      resultMessage({ result: 'Done.', totalCostUsd: 0.0421 }),
    ],
    cwd,
  );

  const turnCompleted = events.find(
    (event): event is Extract<ProviderRuntimeEvent, { type: 'turn_completed' }> => event.type === 'turn_completed',
  );
  const usageReported = events.find(
    (event): event is Extract<ProviderRuntimeEvent, { type: 'usage_reported' }> => event.type === 'usage_reported',
  );

  assert.ok(turnCompleted);
  assert.equal(turnCompleted.costUsd, 0.0421);
  assert.equal(turnCompleted.costSource, 'provider');
  assert.ok(usageReported);
  assert.equal(usageReported.costUsd, 0.0421);
  assert.equal(usageReported.costSource, 'provider');
});

test('Claude coder Edit tool results emit file_changed with the edited path', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'neal-claude-provider-edit-'));

  const events = await collectToolMappingEvents(
    [
      assistantToolUseMessage({
        id: 'tool-edit-1',
        name: 'Edit',
        input: { file_path: '/repo/src/example.ts', old_string: 'before', new_string: 'after' },
      }),
      toolResultMessage({ toolUseId: 'tool-edit-1', content: 'The file /repo/src/example.ts has been updated.' }),
      resultMessage({ result: 'Done.' }),
    ],
    cwd,
  );

  const fileEvents = events.filter(isFileChanged);
  assert.equal(fileEvents.length, 1);
  assert.deepEqual(fileEvents[0]?.files, ['/repo/src/example.ts']);
  assert.equal(fileEvents[0]?.role, 'coder');
  assert.equal(events.filter(isCommandCompleted).length, 0);
});

test('Claude coder failed Bash tool results emit command_completed with failed status', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'neal-claude-provider-bash-failed-'));

  const events = await collectToolMappingEvents(
    [
      assistantToolUseMessage({ id: 'tool-bash-2', name: 'Bash', input: { command: 'pnpm test' } }),
      toolResultMessage({ toolUseId: 'tool-bash-2', content: '1 failing test', isError: true }),
      resultMessage({ result: 'Tests failed.' }),
    ],
    cwd,
  );

  const commandEvents = events.filter(isCommandCompleted);
  assert.equal(commandEvents.length, 1);
  assert.equal(commandEvents[0]?.command, 'pnpm test');
  assert.equal(commandEvents[0]?.status, 'failed');
  assert.equal(commandEvents[0]?.output, '1 failing test');
});

test('Claude coder read-class tool results emit no command_completed or file_changed', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'neal-claude-provider-read-'));

  const events = await collectToolMappingEvents(
    [
      assistantToolUseMessage({ id: 'tool-read-1', name: 'Read', input: { file_path: '/repo/src/example.ts' } }),
      toolResultMessage({ toolUseId: 'tool-read-1', content: 'file contents' }),
      resultMessage({ result: 'Done.' }),
    ],
    cwd,
  );

  assert.equal(events.filter(isCommandCompleted).length, 0);
  assert.equal(events.filter(isFileChanged).length, 0);
  assert.deepEqual(
    events.map((event) => event.type),
    ['session_started', 'turn_completed', 'usage_reported'],
  );
});

test('Claude coder failed write tool results never claim a file change', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'neal-claude-provider-edit-failed-'));

  const events = await collectToolMappingEvents(
    [
      assistantToolUseMessage({
        id: 'tool-edit-2',
        name: 'Edit',
        input: { file_path: '/repo/src/example.ts', old_string: 'before', new_string: 'after' },
      }),
      toolResultMessage({ toolUseId: 'tool-edit-2', content: 'This turn may only write to: /repo/other.ts.', isError: true }),
      resultMessage({ result: 'Denied.' }),
    ],
    cwd,
  );

  assert.equal(events.filter(isFileChanged).length, 0);
});

test('Claude Bash tool results reach the telemetry sink as provider.command_completed verification evidence', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'neal-claude-provider-verification-evidence-'));
  const logger = new FakeLogger();

  await anthropicClaudeProviderTestHooks.collectClaudeResult(
    messageStream([
      assistantToolUseMessage({ id: 'tool-bash-4', name: 'Bash', input: { command: 'pnpm test' } }),
      toolResultMessage({ toolUseId: 'tool-bash-4', content: 'all tests passed' }),
      resultMessage({ result: 'Done.' }),
    ]),
    cwd,
    'coder',
    600_000,
    createProviderTelemetrySink({
      logger: logger.asRunLogger(),
      provider: 'anthropic-claude',
      role: 'coder',
      label: 'coder',
      cwd,
    }),
    'coder',
  );

  // verification-events.ts extracts evidence from provider.command_completed
  // records with a command string; this is the record the completion reviewer
  // was blind to before Claude tool executions were mapped.
  const commandRecords = logger.events.filter((event) => event.type === 'provider.command_completed');
  assert.equal(commandRecords.length, 1);
  assert.equal(commandRecords[0]?.data?.command, 'pnpm test');
  assert.equal(commandRecords[0]?.data?.status, 'completed');
  assert.equal(commandRecords[0]?.data?.cwd, cwd);
});

test('Claude pending tool_use blocks do not leak across turn boundaries within a stream', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'neal-claude-provider-turn-boundary-'));

  const events = await collectToolMappingEvents(
    [
      assistantToolUseMessage({ id: 'tool-bash-3', name: 'Bash', input: { command: 'pnpm test' } }),
      resultMessage({ result: 'First turn ended with the tool call dangling.' }),
      toolResultMessage({ toolUseId: 'tool-bash-3', content: 'stale result from a later turn' }),
      resultMessage({ result: 'Done.' }),
    ],
    cwd,
  );

  assert.equal(events.filter(isCommandCompleted).length, 0);
});

test('Claude missing structured output maps to a normalized structured output error', async () => {
  await assert.rejects(
    () =>
      anthropicClaudeProviderTestHooks.runClaudeStructuredAdvisorRound(
        structuredAdvisorArgs(),
        null,
        () =>
          messageStream([
            resultMessage({
              sessionId: 'claude-missing-structured-session',
              result: 'Review complete without a structured payload.',
            }),
          ]),
      ),
    (error) => {
      assert.equal(error instanceof NealProviderError, true);
      const providerError = error as NealProviderError;
      assert.equal(providerError.provider, 'anthropic-claude');
      assert.equal(providerError.role, 'structured-advisor');
      assert.equal(providerError.kind, 'structured_output_missing');
      assert.equal(providerError.sessionHandle, 'claude-missing-structured-session');
      assert.equal(providerError.retryable, false);
      assert.match(providerError.message, /did not return a successful result/);
      return true;
    },
  );
});

test('Claude review JSON-block path validates prose plus final neal-json block locally', async () => {
  const payload = validReviewerPayload();
  const events: Array<{
    type: string;
    toolName?: string;
    sessionHandle?: string | null;
    providerData?: Record<string, unknown>;
  }> = [];
  const fullProse = 'FULL SECRET REVIEW PROSE. Build succeeds and all tests pass.';

  const result = await anthropicClaudeProviderTestHooks.runClaudeJsonBlockStructuredAdvisorRound(
    reviewerStructuredAdvisorArgs({
      events: (event) => {
        events.push({
          type: event.type,
          toolName: event.type === 'tool_progress' ? event.toolName : undefined,
          sessionHandle: event.sessionHandle,
          providerData: event.providerData,
        });
      },
    }),
    null,
    () =>
      messageStream([
        assistantTextMessage(reviewerJsonBlock(payload, fullProse), 'json-review-session'),
        resultMessage({
          sessionId: 'json-review-session',
          result: 'review complete',
        }),
      ]),
  );

  assert.deepEqual(result, {
    sessionHandle: 'json-review-session',
    structured: payload,
  });
  assert.equal(
    events.some((event) => event.type === 'tool_progress' && event.toolName === 'structured_json_extraction_started'),
    true,
  );
  const structuredEvent = events.find((event) => event.type === 'structured_output_received');
  assert.equal(structuredEvent?.sessionHandle, 'json-review-session');
  assert.equal(structuredEvent?.providerData?.protocol, 'neal-json-block-v1');
  assert.equal(structuredEvent?.providerData?.schemaLabel, 'reviewer_payload');
  assert.equal(structuredEvent?.providerData?.source, 'neal-json-block');
  assert.equal(structuredEvent?.providerData?.attemptNumber, 0);
  assert.equal(
    events.some((event) => JSON.stringify(event.providerData ?? {}).includes(fullProse)),
    false,
  );
});

test('Claude plan-review JSON-block path validates prose plus final neal-json block locally', async () => {
  const payload = validReviewerPayload();

  const result = await anthropicClaudeProviderTestHooks.runClaudeJsonBlockStructuredAdvisorRound(
    reviewerStructuredAdvisorArgs({
      label: 'plan-review',
      structuredJsonProtocol: {
        protocol: 'neal-json-block-v1',
        schemaLabel: 'plan_reviewer_payload',
        schema: buildReviewerSchema(),
        validator: validateReviewerPayload,
        repairAttemptLimit: 2,
      },
    }),
    null,
    () =>
      messageStream([
        assistantTextMessage(reviewerJsonBlock(payload, 'Plan review complete.'), 'json-plan-review-session'),
        resultMessage({
          sessionId: 'json-plan-review-session',
          result: 'plan review complete',
        }),
      ]),
  );

  assert.deepEqual(result, {
    sessionHandle: 'json-plan-review-session',
    structured: payload,
  });
});

test('Claude final-completion JSON-block path validates prose plus final neal-json block locally', async () => {
  const payload = validReviewerPayload();

  const result = await anthropicClaudeProviderTestHooks.runClaudeJsonBlockStructuredAdvisorRound(
    reviewerStructuredAdvisorArgs({
      label: 'final-completion',
      structuredJsonProtocol: {
        protocol: 'neal-json-block-v1',
        schemaLabel: 'final_completion_reviewer_payload',
        schema: buildReviewerSchema(),
        validator: validateReviewerPayload,
        repairAttemptLimit: 2,
      },
    }),
    null,
    () =>
      messageStream([
        assistantTextMessage(reviewerJsonBlock(payload, 'Final completion review complete.'), 'json-final-completion-session'),
        resultMessage({
          sessionId: 'json-final-completion-session',
          result: 'final completion review complete',
        }),
      ]),
  );

  assert.deepEqual(result, {
    sessionHandle: 'json-final-completion-session',
    structured: payload,
  });
});

test('Claude review JSON-block malformed JSON repairs successfully without SDK structured output', async () => {
  const events: Array<{
    type: string;
    label?: string;
    toolName?: string;
    sessionHandle?: string | null;
    providerData?: Record<string, unknown>;
  }> = [];
  const calls: string[] = [];
  let repairPrompt = '';

  const result = await anthropicClaudeProviderTestHooks.runClaudeJsonBlockStructuredAdvisorRound(
    reviewerStructuredAdvisorArgs({
      events: (event) => {
        events.push({
          type: event.type,
          label: event.label,
          toolName: event.type === 'tool_progress' ? event.toolName : undefined,
          sessionHandle: event.sessionHandle,
          providerData: event.providerData,
        });
      },
    }),
    null,
    () => {
      calls.push('primary');
      return messageStream([
        assistantTextMessage('Review prose.\n\n```neal-json\n{"summary":\n```', 'malformed-json-primary'),
        resultMessage({
          sessionId: 'malformed-json-primary',
          result: 'review complete',
        }),
      ]);
    },
    (_args, prompt) => {
      calls.push('repair');
      repairPrompt = prompt;
      return messageStream([
        resultMessage({
          sessionId: 'malformed-json-repair',
          result: reviewerJson(),
        }),
      ]);
    },
  );

  assert.deepEqual(result, {
    sessionHandle: 'malformed-json-primary',
    structured: validReviewerPayload(),
  });
  assert.deepEqual(calls, ['primary', 'repair']);
  assert.match(repairPrompt, /malformed JSON/);
  assert.equal(
    events.some((event) => event.type === 'tool_progress' && event.toolName === 'structured_json_extraction_failed'),
    true,
  );
  assert.equal(
    events.some((event) => event.type === 'tool_progress' && event.toolName === 'structured_json_repair_started'),
    true,
  );
  assert.equal(
    events.some(
      (event) =>
        event.type === 'tool_progress' &&
        event.toolName === 'structured_json_repair_succeeded' &&
        event.providerData?.repairSessionHandle === 'malformed-json-repair',
    ),
    true,
  );
  assert.equal(
    events.some(
      (event) =>
        event.type === 'structured_output_received' &&
        event.label === 'review' &&
        event.sessionHandle === 'malformed-json-primary' &&
        event.providerData?.repairSessionHandle === 'malformed-json-repair',
    ),
    true,
  );
});

test('Claude review JSON-block schema-invalid JSON repairs after local validation failure', async () => {
  const events: Array<{ type: string; toolName?: string; providerData?: Record<string, unknown> }> = [];
  const invalidPayload = {
    ...validReviewerPayload(),
    meaningfulProgressAction: 'maybe',
  };

  const result = await anthropicClaudeProviderTestHooks.runClaudeJsonBlockStructuredAdvisorRound(
    reviewerStructuredAdvisorArgs({
      events: (event) => {
        events.push({
          type: event.type,
          toolName: event.type === 'tool_progress' ? event.toolName : undefined,
          providerData: event.providerData,
        });
      },
    }),
    null,
    () =>
      messageStream([
        assistantTextMessage(reviewerJsonBlock(invalidPayload), 'schema-invalid-primary'),
        resultMessage({
          sessionId: 'schema-invalid-primary',
          result: 'review complete',
        }),
      ]),
    () =>
      messageStream([
        assistantTextMessage(reviewerJsonBlock(validReviewerPayload()), 'schema-invalid-repair'),
        resultMessage({
          sessionId: 'schema-invalid-repair',
          result: 'repair complete',
        }),
      ]),
  );

  assert.deepEqual(result, {
    sessionHandle: 'schema-invalid-primary',
    structured: validReviewerPayload(),
  });
  const validationFailureIndex = events.findIndex(
    (event) => event.type === 'tool_progress' && event.toolName === 'structured_json_validation_failed',
  );
  const structuredReceivedIndex = events.findIndex((event) => event.type === 'structured_output_received');
  assert.notEqual(validationFailureIndex, -1);
  assert.notEqual(structuredReceivedIndex, -1);
  assert.equal(structuredReceivedIndex > validationFailureIndex, true);
  assert.equal(
    events.some(
      (event) =>
        event.type === 'tool_progress' &&
        event.toolName === 'structured_json_validation_failed' &&
        String(event.providerData?.validationErrorSummary ?? '').includes('meaningfulProgressAction'),
    ),
    true,
  );
});

test('Claude review JSON-block repair exhaustion normalizes to structured_output_invalid', async () => {
  const events: Array<{ type: string; toolName?: string; providerData?: Record<string, unknown>; errorKind?: string }> = [];

  await assert.rejects(
    () =>
      anthropicClaudeProviderTestHooks.runClaudeJsonBlockStructuredAdvisorRound(
        reviewerStructuredAdvisorArgs({
          events: (event) => {
            events.push({
              type: event.type,
              toolName: event.type === 'tool_progress' ? event.toolName : undefined,
              providerData: event.providerData,
              errorKind: event.type === 'provider_error' ? event.errorKind : undefined,
            });
          },
        }),
        null,
        () =>
          messageStream([
            assistantTextMessage('Review prose without a JSON control block.', 'repair-exhausted-primary'),
            resultMessage({
              sessionId: 'repair-exhausted-primary',
              result: 'review complete',
            }),
          ]),
        (_args, _prompt, _defaultModel) =>
          messageStream([
            resultMessage({
              sessionId: 'repair-exhausted-repair',
              result: 'Still no JSON control block.',
            }),
          ]),
      ),
    (error) => {
      assert.equal(error instanceof NealProviderError, true);
      const providerError = error as NealProviderError;
      assert.equal(providerError.provider, 'anthropic-claude');
      assert.equal(providerError.role, 'structured-advisor');
      assert.equal(providerError.kind, 'structured_output_invalid');
      assert.equal(providerError.sessionHandle, 'repair-exhausted-primary');
      assert.match(providerError.message, /remained invalid after 2 repair attempt/);
      return true;
    },
  );

  assert.equal(events.filter((event) => event.type === 'provider_error').length, 1);
  assert.equal(
    events.some((event) => event.type === 'tool_progress' && event.toolName === 'structured_json_repair_failed'),
    true,
  );
  assert.equal(
    events.some((event) => event.type === 'structured_output_received'),
    false,
  );
});

test('Claude advisor SDK structured output retry exhaustion fails without fallback conversion', async () => {
  const events: Array<{ type: string; toolName?: string; providerData?: Record<string, unknown> }> = [];

  await assert.rejects(
    () =>
      anthropicClaudeProviderTestHooks.runClaudeStructuredAdvisorRound(
        structuredAdvisorArgs({
          label: 'final-completion',
          events: (event) => {
            events.push({
              type: event.type,
              toolName: event.type === 'tool_progress' ? event.toolName : undefined,
              providerData: event.providerData,
            });
          },
        }),
        null,
        () =>
          messageStream([
            resultMessage({
              sessionId: 'primary-no-prose-session',
              subtype: 'error_max_structured_output_retries',
              isError: true,
              result: 'Failed to provide valid structured output after 5 attempts',
            }),
          ]),
      ),
    (error) => {
      assert.equal(error instanceof NealProviderError, true);
      const providerError = error as NealProviderError;
      assert.equal(providerError.kind, 'structured_output_invalid');
      assert.equal(providerError.sessionHandle, 'primary-no-prose-session');
      assert.match(providerError.message, /error_max_structured_output_retries/);
      return true;
    },
  );

  assert.equal(
    events.some(
      (event) =>
        event.type === 'tool_progress' &&
        event.toolName === 'structured_output_retry_exhausted' &&
        event.providerData?.subtype === 'error_max_structured_output_retries',
    ),
    true,
  );
  assert.equal(
    events.some((event) => event.type === 'tool_progress' && event.toolName === 'structured_output_fallback_skipped'),
    false,
  );
});

test('Claude coder structured prompt returns typed structured output without stringifying it', async () => {
  const structuredOutput = { outcome: 'responded', summary: 'fixed' };
  const events: Array<{ type: string; role?: string; label?: string }> = [];

  const result = await anthropicClaudeProviderTestHooks.runClaudeStructuredCoderPrompt(
    coderStructuredArgs({
      events: (event) => {
        events.push({ type: event.type, role: event.role, label: event.label });
      },
    }),
      null,
      () =>
        messageStream([
          assistantTextMessage(
            [
              'Structured coder lifecycle text.',
              '',
              '```neal-json',
              JSON.stringify(structuredOutput, null, 2),
              '```',
            ].join('\n'),
          ),
          resultMessage({
            sessionId: 'claude-coder-structured-session',
            result: 'structured complete',
          }),
        ]),
  );

  assert.deepEqual(result, {
    sessionHandle: 'claude-session-1',
    structured: structuredOutput,
  });
  assert.deepEqual(
    events.find((event) => event.type === 'session_started'),
    { type: 'session_started', role: 'coder', label: 'Coder response round' },
  );
  assert.deepEqual(
    events.find((event) => event.type === 'assistant_text'),
    { type: 'assistant_text', role: 'coder', label: 'Coder response round' },
  );
  assert.equal(events.some((event) => event.type === 'structured_output_received' && event.role === 'coder'), true);
});

test('Claude coder missing structured output repairs through the coder JSON-block path before failing', async () => {
  await assert.rejects(
    () =>
      anthropicClaudeProviderTestHooks.runClaudeStructuredCoderPrompt(
        coderStructuredArgs(),
        null,
        () =>
          messageStream([
            resultMessage({
              sessionId: 'claude-coder-missing-structured-session',
              result: 'Coder completed without a structured payload.',
            }),
          ]),
        () =>
          messageStream([
            assistantTextMessage('Repair still omitted the control payload.', 'claude-coder-repair-session'),
            resultMessage({
              sessionId: 'claude-coder-repair-session',
              result: 'repair failed',
            }),
          ]),
      ),
    (error) => {
      assert.equal(error instanceof NealProviderError, true);
      const providerError = error as NealProviderError;
      assert.equal(providerError.provider, 'anthropic-claude');
      assert.equal(providerError.role, 'coder');
      assert.equal(providerError.kind, 'structured_output_invalid');
      assert.equal(providerError.sessionHandle, 'claude-coder-missing-structured-session');
      assert.equal(providerError.retryable, false);
      assert.match(providerError.message, /Neal structured control payload remained invalid/);
      return true;
    },
  );
});

test('Claude coder structured prompt timeout maps to a normalized coder timeout error', async () => {
  const events: Array<{ type: string; role?: string; label?: string; errorKind?: string }> = [];
  let turnAbortController: AbortController | undefined;

  await assert.rejects(
    () =>
      anthropicClaudeProviderTestHooks.runClaudeStructuredCoderPrompt(
        coderStructuredArgs({
          inactivityTimeoutMs: 1,
          events: (event) => {
            events.push({
              type: event.type,
              role: event.role,
              label: event.label,
              errorKind: event.type === 'provider_error' ? event.errorKind : undefined,
            });
          },
        }),
        null,
        (_args, _defaultModel, _defaultEffort, abortController) => {
          turnAbortController = abortController;
          return stalledMessageStream();
        },
      ),
    (error) => {
      assert.equal(error instanceof NealProviderError, true);
      const providerError = error as NealProviderError;
      assert.equal(providerError.provider, 'anthropic-claude');
      assert.equal(providerError.role, 'coder');
      assert.equal(providerError.kind, 'timeout');
      assert.equal(providerError.sessionHandle, null);
      assert.equal(providerError.retryable, true);
      assert.match(providerError.message, /timed out/);
      return true;
    },
  );

  // The inactivity timeout must cancel the SDK turn: the per-turn controller
  // aborts (killing the query's child process and token spend) while the
  // surfaced error stays the retryable timeout kind, not a caller abort.
  assert.equal(turnAbortController instanceof AbortController, true);
  assert.equal(turnAbortController?.signal.aborted, true);
  assert.deepEqual(events, [
    {
      type: 'provider_error',
      role: 'coder',
      label: 'Coder response round',
      errorKind: 'timeout',
    },
  ]);
});

test('Claude structured-advisor inactivity timeout aborts the in-flight query turn', async () => {
  let turnAbortController: AbortController | undefined;

  await assert.rejects(
    () =>
      anthropicClaudeProviderTestHooks.runClaudeStructuredAdvisorRound(
        structuredAdvisorArgs({ inactivityTimeoutMs: 1 }),
        null,
        (_args, _defaultModel, _defaultEffort, abortController) => {
          turnAbortController = abortController;
          return stalledMessageStream();
        },
      ),
    (error) => {
      assert.equal(error instanceof NealProviderError, true);
      const providerError = error as NealProviderError;
      assert.equal(providerError.role, 'structured-advisor');
      assert.equal(providerError.kind, 'timeout');
      assert.equal(providerError.retryable, true);
      assert.match(providerError.message, /timed out/);
      return true;
    },
  );

  assert.equal(turnAbortController instanceof AbortController, true);
  assert.equal(turnAbortController?.signal.aborted, true);
});

test('Claude review JSON-block inactivity timeout aborts the in-flight query turn', async () => {
  let turnAbortController: AbortController | undefined;

  await assert.rejects(
    () =>
      anthropicClaudeProviderTestHooks.runClaudeJsonBlockStructuredAdvisorRound(
        reviewerStructuredAdvisorArgs({ inactivityTimeoutMs: 1 }),
        null,
        (_args, _defaultModel, _defaultEffort, abortController) => {
          turnAbortController = abortController;
          return stalledMessageStream();
        },
      ),
    (error) => {
      assert.equal(error instanceof NealProviderError, true);
      const providerError = error as NealProviderError;
      assert.equal(providerError.role, 'structured-advisor');
      assert.equal(providerError.kind, 'timeout');
      assert.equal(providerError.retryable, true);
      return true;
    },
  );

  assert.equal(turnAbortController instanceof AbortController, true);
  assert.equal(turnAbortController?.signal.aborted, true);
});

test('Claude coder repair inactivity timeout aborts the repair turn with a retryable timeout', async () => {
  let repairAbortController: AbortController | undefined;

  await assert.rejects(
    () =>
      anthropicClaudeProviderTestHooks.runClaudeStructuredCoderPrompt(
        coderStructuredArgs({ inactivityTimeoutMs: 1 }),
        null,
        () =>
          messageStream([
            assistantTextMessage('Coder prose without a control payload.', 'claude-coder-repair-timeout-session'),
            resultMessage({
              sessionId: 'claude-coder-repair-timeout-session',
              result: 'coder complete',
            }),
          ]),
        (_args, _prompt, _defaultModel, _defaultEffort, abortController) => {
          repairAbortController = abortController;
          return stalledMessageStream();
        },
      ),
    (error) => {
      assert.equal(error instanceof NealProviderError, true);
      const providerError = error as NealProviderError;
      assert.equal(providerError.role, 'coder');
      assert.equal(providerError.kind, 'timeout');
      assert.equal(providerError.retryable, true);
      assert.match(providerError.message, /timed out/);
      return true;
    },
  );

  assert.equal(repairAbortController instanceof AbortController, true);
  assert.equal(repairAbortController?.signal.aborted, true);
});

test('Claude coder transient error results retry the coder round before succeeding', async () => {
  let attempts = 0;
  const events: Array<{ type: string; role?: string; toolName?: string; providerData?: Record<string, unknown> }> = [];
  const sleepDelays: number[] = [];
  const structuredOutput = { outcome: 'responded', summary: 'fixed' };

  const result = await anthropicClaudeProviderTestHooks.runClaudeStructuredCoderPrompt(
    coderStructuredArgs({
      apiRetryLimit: 1,
      events: (event) => {
        events.push({
          type: event.type,
          role: event.role,
          toolName: event.type === 'tool_progress' ? event.toolName : undefined,
          providerData: event.providerData,
        });
      },
    }),
    null,
    () => {
      attempts += 1;
      if (attempts === 1) {
        return messageStream([
          resultMessage({
            sessionId: 'claude-coder-transient-failure',
            isError: true,
            result: 'Claude Code returned an error result: API Error: Stream idle timeout - partial response received',
          }),
        ]);
      }
      return messageStream([
        assistantTextMessage(
          ['```neal-json', JSON.stringify(structuredOutput), '```'].join('\n'),
          'claude-coder-transient-retry-success',
        ),
        resultMessage({
          sessionId: 'claude-coder-transient-retry-success',
          result: 'structured complete',
        }),
      ]);
    },
    undefined,
    undefined,
    async (ms) => {
      sleepDelays.push(ms);
    },
  );

  assert.equal(attempts, 2);
  assert.deepEqual(result.structured, structuredOutput);
  assert.deepEqual(sleepDelays, [500]);
  assert.equal(
    events.some(
      (event) =>
        event.type === 'tool_progress' &&
        event.role === 'coder' &&
        event.toolName === 'api_retry' &&
        String(event.providerData?.message ?? '').includes('Stream idle timeout'),
    ),
    true,
  );
});

test('Claude coder transient error results stop retrying once the budget is exhausted', async () => {
  let attempts = 0;
  let repairs = 0;
  const sleepDelays: number[] = [];

  await assert.rejects(
    () =>
      anthropicClaudeProviderTestHooks.runClaudeStructuredCoderPrompt(
        coderStructuredArgs({ apiRetryLimit: 2 }),
        null,
        () => {
          attempts += 1;
          return messageStream([
            resultMessage({
              sessionId: `claude-coder-transient-${attempts}`,
              isError: true,
              result: 'API Error: Stream idle timeout - partial response received',
            }),
          ]);
        },
        () => {
          repairs += 1;
          return messageStream([
            resultMessage({
              sessionId: 'claude-coder-transient-repair',
              result: 'repair produced no payload',
            }),
          ]);
        },
        undefined,
        async (ms) => {
          sleepDelays.push(ms);
        },
      ),
    (error) => {
      // 1 initial + 2 retries, then the exhausted round degrades to the
      // pre-existing repair-then-fail behavior instead of a new error path.
      assert.equal(attempts, 3);
      assert.equal(repairs > 0, true);
      assert.equal(error instanceof NealProviderError, true);
      const providerError = error as NealProviderError;
      assert.equal(providerError.role, 'coder');
      assert.equal(providerError.kind, 'structured_output_invalid');
      assert.equal(providerError.retryable, false);
      return true;
    },
  );

  assert.deepEqual(sleepDelays, [500, 1000]);
});

test('Claude SDK structured output retry exhaustion maps to a normalized structured output error', async () => {
  await assert.rejects(
    () =>
      anthropicClaudeProviderTestHooks.runClaudeStructuredAdvisorRound(
        structuredAdvisorArgs(),
        null,
        () => {
          throw new Error('Failed to provide valid structured output after 5 attempts');
        },
      ),
    (error) => {
      assert.equal(error instanceof NealProviderError, true);
      const providerError = error as NealProviderError;
      assert.equal(providerError.provider, 'anthropic-claude');
      assert.equal(providerError.role, 'structured-advisor');
      assert.equal(providerError.kind, 'structured_output_invalid');
      assert.equal(providerError.sessionHandle, null);
      assert.equal(providerError.retryable, false);
      assert.match(providerError.message, /Failed to provide valid structured output after 5 attempts/);
      return true;
    },
  );
});

test('Claude SDK structured output stream errors do not fallback', async () => {
  const events: Array<{ type: string; toolName?: string; providerData?: Record<string, unknown> }> = [];

  await assert.rejects(
    () =>
      anthropicClaudeProviderTestHooks.runClaudeStructuredAdvisorRound(
        structuredAdvisorArgs({
          events: (event) => {
            events.push({
              type: event.type,
              toolName: event.type === 'tool_progress' ? event.toolName : undefined,
              providerData: event.providerData,
            });
          },
        }),
        null,
        () =>
          streamThenThrow(
            [
              resultMessage({
                sessionId: 'stream-error-no-prose',
                subtype: 'error_max_structured_output_retries',
                isError: true,
                result: 'Failed to provide valid structured output after 5 attempts',
              }),
            ],
            new Error('Claude Code returned an error result: Failed to provide valid structured output after 5 attempts'),
          ),
      ),
    (error) => {
      assert.equal(error instanceof NealProviderError, true);
      const providerError = error as NealProviderError;
      assert.equal(providerError.kind, 'structured_output_invalid');
      assert.equal(providerError.sessionHandle, 'stream-error-no-prose');
      return true;
    },
  );

  assert.equal(
    events.some(
      (event) =>
        event.type === 'tool_progress' &&
        event.toolName === 'structured_output_stream_error' &&
        event.providerData?.collectedAssistantTextLength === 0,
    ),
    true,
  );
});

test('Claude transient API failures retry to the configured limit with backoff before returning a normalized failure', async () => {
  let attempts = 0;
  const sleepDelays: number[] = [];
  await assert.rejects(
    () =>
      anthropicClaudeProviderTestHooks.runClaudeStructuredAdvisorRound(
        structuredAdvisorArgs({ apiRetryLimit: 2 }),
        null,
        () => {
          attempts += 1;
          return messageStream([
            resultMessage({
              sessionId: `claude-api-retry-${attempts}`,
              subtype: 'api_error',
              isError: true,
              result: 'Internal server error. Please try again.',
            }),
          ]);
        },
        undefined,
        async (ms) => {
          sleepDelays.push(ms);
        },
      ),
    (error) => {
      assert.equal(attempts, 3);
      assert.equal(error instanceof NealProviderError, true);
      const providerError = error as NealProviderError;
      assert.equal(providerError.provider, 'anthropic-claude');
      assert.equal(providerError.role, 'structured-advisor');
      assert.equal(providerError.kind, 'api_error');
      assert.equal(providerError.retryable, true);
      assert.equal(providerError.sessionHandle, 'claude-api-retry-3');
      assert.match(providerError.message, /Internal server error/);
      return true;
    },
  );

  // Exponential in-round backoff: 500 ms base, doubling per retry.
  assert.deepEqual(sleepDelays, [500, 1000]);
});

test('Claude empty-assistant execution diagnostics retry as transient provider failures', async () => {
  let attempts = 0;
  const events: Array<{ type: string; toolName?: string; providerData?: Record<string, unknown> }> = [];
  const sleepDelays: number[] = [];
  const structuredOutput = { verdict: 'accepted' };

  const result = await anthropicClaudeProviderTestHooks.runClaudeStructuredAdvisorRound(
    structuredAdvisorArgs({
      apiRetryLimit: 1,
      events: (event) => {
        events.push({
          type: event.type,
          toolName: event.type === 'tool_progress' ? event.toolName : undefined,
          providerData: event.providerData,
        });
      },
    }),
    null,
    () => {
      attempts += 1;
      if (attempts === 1) {
        return messageStream([
          resultMessage({
            sessionId: 'claude-empty-assistant-diagnostic',
            subtype: 'error_during_execution',
            isError: true,
            result: 'Claude Code returned an error result: [ede_diagnostic] result_type=assistant last_content_type=none stop_reason=end_turn',
          }),
        ]);
      }

      return messageStream([
        resultMessage({
          sessionId: 'claude-empty-assistant-retry-success',
          result: '',
          structuredOutput,
        }),
      ]);
    },
    undefined,
    async (ms) => {
      sleepDelays.push(ms);
    },
  );

  assert.equal(attempts, 2);
  assert.deepEqual(result, {
    sessionHandle: 'claude-empty-assistant-retry-success',
    structured: structuredOutput,
  });
  assert.deepEqual(sleepDelays, [500]);
  assert.equal(
    events.some(
      (event) =>
        event.type === 'tool_progress' &&
        event.toolName === 'api_retry' &&
        event.providerData?.subtype === 'error_during_execution' &&
        String(event.providerData?.message ?? '').includes('[ede_diagnostic]'),
    ),
    true,
  );
});

function rejectWhenAborted(signal: AbortSignal, message: string): Promise<never> {
  return new Promise<never>((_resolve, reject) => {
    const fail = () => reject(new Error(message));
    if (signal.aborted) {
      fail();
      return;
    }
    signal.addEventListener('abort', fail, { once: true });
  });
}

async function* stalledUntilAborted(signal: AbortSignal, message: string): AsyncGenerator<SDKMessage, void> {
  await rejectWhenAborted(signal, message);
}

test('Claude primary query option builders derive an SDK abortController from the external signal', () => {
  const external = new AbortController();
  const advisorOptions = anthropicClaudeProviderTestHooks.buildClaudeQueryOptions(
    structuredAdvisorArgs({ signal: external.signal }),
    null,
    '',
  );
  const jsonBlockOptions = anthropicClaudeProviderTestHooks.buildClaudeJsonBlockQueryOptions(
    reviewerStructuredAdvisorArgs({ signal: external.signal }),
    null,
    '',
  );
  const coderOptions = anthropicClaudeProviderTestHooks.buildClaudeCoderQueryOptions(
    coderRunArgs({ signal: external.signal }),
    null,
    '',
  );

  assert.equal(advisorOptions.abortController instanceof AbortController, true);
  assert.equal(jsonBlockOptions.abortController instanceof AbortController, true);
  assert.equal(coderOptions.abortController instanceof AbortController, true);
  assert.equal(advisorOptions.abortController?.signal.aborted, false);
  assert.equal(jsonBlockOptions.abortController?.signal.aborted, false);
  assert.equal(coderOptions.abortController?.signal.aborted, false);

  external.abort();
  assert.equal(advisorOptions.abortController?.signal.aborted, true);
  assert.equal(jsonBlockOptions.abortController?.signal.aborted, true);
  assert.equal(coderOptions.abortController?.signal.aborted, true);

  const preAborted = new AbortController();
  preAborted.abort();
  assert.equal(
    anthropicClaudeProviderTestHooks
      .buildClaudeCoderQueryOptions(coderRunArgs({ signal: preAborted.signal }), null, '')
      .abortController?.signal.aborted,
    true,
  );
});

test('Claude query option builders omit abortController without an external signal and for repair turns', () => {
  assert.equal(
    'abortController' in anthropicClaudeProviderTestHooks.buildClaudeQueryOptions(structuredAdvisorArgs(), null, ''),
    false,
  );
  assert.equal(
    'abortController' in anthropicClaudeProviderTestHooks.buildClaudeCoderQueryOptions(coderRunArgs(), null, ''),
    false,
  );

  const external = new AbortController();
  assert.equal(
    'abortController' in
      anthropicClaudeProviderTestHooks.buildClaudeJsonBlockRepairQueryOptions(
        reviewerStructuredAdvisorArgs({ signal: external.signal }),
        null,
        '',
      ),
    false,
  );
  assert.equal(
    'abortController' in
      anthropicClaudeProviderTestHooks.buildClaudeCoderRepairQueryOptions(
        coderStructuredArgs({ signal: external.signal }),
        null,
        '',
      ),
    false,
  );
});

test('Claude option builders thread an explicit per-turn abortController into primary and repair queries', () => {
  const turnController = new AbortController();
  assert.equal(
    anthropicClaudeProviderTestHooks.buildClaudeQueryOptions(structuredAdvisorArgs(), null, '', null, turnController)
      .abortController,
    turnController,
  );
  assert.equal(
    anthropicClaudeProviderTestHooks.buildClaudeJsonBlockQueryOptions(
      reviewerStructuredAdvisorArgs(),
      null,
      '',
      null,
      turnController,
    ).abortController,
    turnController,
  );
  assert.equal(
    anthropicClaudeProviderTestHooks.buildClaudeCoderQueryOptions(coderRunArgs(), null, '', null, turnController)
      .abortController,
    turnController,
  );
  assert.equal(
    anthropicClaudeProviderTestHooks.buildClaudeJsonBlockRepairQueryOptions(
      reviewerStructuredAdvisorArgs(),
      null,
      '',
      null,
      turnController,
    ).abortController,
    turnController,
  );
  assert.equal(
    anthropicClaudeProviderTestHooks.buildClaudeCoderRepairQueryOptions(
      coderStructuredArgs(),
      null,
      '',
      null,
      turnController,
    ).abortController,
    turnController,
  );
});

test('Claude structured-advisor external abort terminates an in-flight query with a provider error', async () => {
  const external = new AbortController();

  await assert.rejects(
    () =>
      anthropicClaudeProviderTestHooks.runClaudeStructuredAdvisorRound(
        structuredAdvisorArgs({ signal: external.signal }),
        null,
        (args) => {
          // Simulate the SDK contract: query() receives Options.abortController
          // and the stream rejects once that derived controller aborts.
          const options = anthropicClaudeProviderTestHooks.buildClaudeQueryOptions(args, null, '');
          assert.equal(options.abortController instanceof AbortController, true);
          setTimeout(() => external.abort(), 10);
          return stalledUntilAborted(options.abortController!.signal, 'Claude query aborted by external signal');
        },
      ),
    (error) => {
      assert.equal(error instanceof NealProviderError, true);
      const providerError = error as NealProviderError;
      assert.equal(providerError.provider, 'anthropic-claude');
      assert.equal(providerError.role, 'structured-advisor');
      assert.match(providerError.message, /aborted/i);
      return true;
    },
  );
});

test('Claude coder external abort terminates an in-flight structured prompt with a provider error', async () => {
  const external = new AbortController();

  await assert.rejects(
    () =>
      anthropicClaudeProviderTestHooks.runClaudeStructuredCoderPrompt(
        coderStructuredArgs({ signal: external.signal }),
        null,
        (args) => {
          const options = anthropicClaudeProviderTestHooks.buildClaudeCoderQueryOptions(args, null, '');
          assert.equal(options.abortController instanceof AbortController, true);
          setTimeout(() => external.abort(), 10);
          return stalledUntilAborted(options.abortController!.signal, 'Claude query aborted by external signal');
        },
      ),
    (error) => {
      assert.equal(error instanceof NealProviderError, true);
      const providerError = error as NealProviderError;
      assert.equal(providerError.provider, 'anthropic-claude');
      assert.equal(providerError.role, 'coder');
      assert.match(providerError.message, /aborted/i);
      return true;
    },
  );
});

test('Claude thinking deltas emit a throttled assistant_thinking event for liveness', async () => {
  const { logClaudeMessage, THINKING_PROGRESS_EMIT_INTERVAL_MS } = anthropicClaudeProviderTestHooks;
  const events: Array<{ type: string; estimatedTokens?: number }> = [];
  const sink = async (event: { type: string; estimatedTokens?: number }) => {
    events.push(event);
  };
  const state = { textBuffer: '', sawTextDelta: false, lastThinkingEmitMs: 0, pendingToolUses: new Map() };
  const thinkingDelta = {
    type: 'stream_event',
    session_id: 'claude-session-1',
    event: { type: 'content_block_delta', delta: { type: 'thinking_delta', thinking: 'pondering' } },
  } as unknown as SDKMessage;

  // First thinking delta emits immediately (lastThinkingEmitMs starts at 0).
  await logClaudeMessage('review', thinkingDelta, sink as never, state, 'claude-session-1');
  assert.deepEqual(events.map((event) => event.type), ['assistant_thinking']);

  // Immediately following thinking signals are throttled.
  await logClaudeMessage('review', thinkingDelta, sink as never, state, 'claude-session-1');
  await logClaudeMessage(
    'review',
    systemMessage('thinking_tokens', { estimated_tokens: 512, estimated_tokens_delta: 16 }),
    sink as never,
    state,
    'claude-session-1',
  );
  assert.equal(events.length, 1);

  // Once the throttle interval has elapsed, the next signal emits again and
  // carries the thinking-token estimate when the SDK provides one.
  state.lastThinkingEmitMs = Date.now() - THINKING_PROGRESS_EMIT_INTERVAL_MS - 1;
  await logClaudeMessage(
    'review',
    systemMessage('thinking_tokens', { estimated_tokens: 1024, estimated_tokens_delta: 16 }),
    sink as never,
    state,
    'claude-session-1',
  );
  assert.equal(events.length, 2);
  assert.equal(events[1]?.type, 'assistant_thinking');
  assert.equal(events[1]?.estimatedTokens, 1024);

  // Thinking signals never produce assistant_text or disturb the text buffer.
  assert.equal(state.textBuffer, '');
  assert.equal(state.sawTextDelta, false);
});

test('Claude coder success results that mention failure vocabulary are never retried as transient', async () => {
  let attempts = 0;
  const events: Array<{ type: string; toolName?: string }> = [];
  const structuredOutput = { outcome: 'responded', summary: 'plan refined' };
  // Regression: a successful plan round whose final text documents error
  // handling (literal "api_error", "rate limit", "try again") was classified
  // as a transient failure by substring matching on the success result's
  // text, retrying the round until the budget exhausted.
  const planStyleText = [
    'Refined the plan. It documents retry semantics: 408/429/5xx map to',
    'api_error and stay retryable; rate limit responses back off; operators',
    'should try again after transient failures. Temporarily out of scope.',
    '```neal-json',
    JSON.stringify(structuredOutput),
    '```',
  ].join('\n');

  const result = await anthropicClaudeProviderTestHooks.runClaudeStructuredCoderPrompt(
    coderStructuredArgs({
      apiRetryLimit: 2,
      events: (event) => {
        events.push({
          type: event.type,
          toolName: event.type === 'tool_progress' ? event.toolName : undefined,
        });
      },
    }),
    null,
    () => {
      attempts += 1;
      return messageStream([
        assistantTextMessage(planStyleText, 'claude-coder-success-vocabulary'),
        resultMessage({
          sessionId: 'claude-coder-success-vocabulary',
          result: planStyleText,
        }),
      ]);
    },
  );

  assert.equal(attempts, 1, 'a successful result must never be retried as transient');
  assert.deepEqual(result.structured, structuredOutput);
  assert.equal(
    events.some((event) => event.type === 'tool_progress' && event.toolName === 'api_retry'),
    false,
    'no api_retry event for a successful result',
  );
});
