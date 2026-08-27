import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable, Writable } from 'node:stream';

import { runNealCheckCli } from '../src/neal/commands/check.js';
import { clearConfigCache } from '../src/neal/config.js';
import { clearUserGuidanceCache, USER_GUIDANCE_MAX_CHARS } from '../src/neal/prompts/guidance.js';
import {
  clearProviderDefinitionRegistrationsForTesting,
  registerProviderDefinitionForTesting,
} from '../src/neal/providers/registry.js';
import { MockLanguageModelV3 } from 'ai/test';

import { createFakeProviderDefinition, fakeProviderDefaultCapabilities } from './helpers/fake-provider.js';
import {
  openAICompatibleProviderDefinition,
  openAICompatibleProviderTestHooks,
} from '../src/neal/providers/openai-compatible.js';
import type { OpenAICompatibleSettings } from '../src/neal/config.js';
import { runGit } from './helpers/git.js';

// This file exercises notify behavior through its own fixture scripts; the
// suite-wide NEAL_NOTIFY_BIN= kill switch (pnpm test script) must not shadow
// them. Fixture repo configs pin notify_bin, so this stays hermetic.
delete process.env.NEAL_NOTIFY_BIN;


process.env.HOME = join(tmpdir(), 'neal-test-home-check');

class CaptureStream extends Writable {
  readonly chunks: string[] = [];

  override _write(chunk: unknown, _encoding: BufferEncoding, callback: (error?: Error | null) => void) {
    this.chunks.push(Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk));
    callback();
  }
}

function createClosedInput(isTTY = false) {
  const input = new Readable({
    read() {
      this.push(null);
    },
  }) as Readable & { isTTY?: boolean };
  input.isTTY = isTTY;
  return input;
}

function createInput(text: string, isTTY = true) {
  const input = Readable.from([text]) as Readable & { isTTY?: boolean };
  input.isTTY = isTTY;
  return input;
}

async function initGitRepo(prefix: string) {
  const cwd = await mkdtemp(join(tmpdir(), prefix));
  await runGit(cwd, 'init');
  return cwd;
}

// LanguageModelV3 finish reasons are { unified, raw } objects; the SDK resolves
// Output.object structured output only on a cleanly-stopped turn.
const CHECK_STOP_FINISH_REASON = { unified: 'stop', raw: 'stop' };
const CHECK_MOCK_USAGE = {
  inputTokens: { total: 10, noCache: undefined, cacheRead: undefined, cacheWrite: undefined },
  outputTokens: { total: 5, text: undefined, reasoning: undefined },
};

function checkTextResponse(text: string) {
  return {
    content: [{ type: 'text', text }],
    finishReason: CHECK_STOP_FINISH_REASON,
    usage: CHECK_MOCK_USAGE,
    warnings: [],
  };
}

// Builds a mock whose Nth doGenerate runs the Nth producer; the last producer
// repeats for any further calls. A producer may throw to simulate a transport
// error (e.g. an HTTP-400-shaped json_schema rejection).
function checkScriptedModel(producers: Array<() => unknown>): MockLanguageModelV3 {
  let calls = 0;
  return new MockLanguageModelV3({
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    doGenerate: (async () => {
      const producer = producers[Math.min(calls, producers.length - 1)];
      calls += 1;
      return producer();
    }) as any,
  });
}

function checkOpenAICompatibleSettings(): OpenAICompatibleSettings {
  return {
    baseUrl: 'https://example.test/v1',
    apiKeyEnv: 'TEST_NEAL_CHECK_OPENAI_COMPATIBLE_KEY',
    apiKey: 'test-key',
    defaultModel: 'test-model',
    headers: {},
    pricing: null,
  };
}

// Registers a provider whose coder/reviewer adapters are the REAL openai-compatible
// adapters (via the provider's injection seam) driven by an injected mock model.
// This routes `neal check` through the actual openai-compatible structured-output
// runtime and its error classification, not a pre-classified fake error.
function registerOpenAICompatibleMockProvider(createModel: () => MockLanguageModelV3) {
  return registerProviderDefinitionForTesting({
    id: 'openai-compatible-check-mock',
    displayName: openAICompatibleProviderDefinition.displayName,
    capabilities: openAICompatibleProviderDefinition.capabilities,
    createCoderAdapter: (options) =>
      openAICompatibleProviderTestHooks.createCoderAdapterWithInjection(
        { resolveSettings: () => checkOpenAICompatibleSettings(), createModel },
        options,
      ),
    createStructuredAdvisorAdapter: (options) =>
      openAICompatibleProviderTestHooks.createStructuredAdvisorAdapterWithInjection(
        { resolveSettings: () => checkOpenAICompatibleSettings(), createModel },
        options,
      ),
  });
}

async function writeExplicitWriterConfig(cwd: string, provider = 'anthropic-claude') {
  await writeFile(
    join(cwd, 'neal.yml'),
    [
      'agent:',
      '  coder:',
      `    provider: ${provider}`,
      '  reviewer:',
      `    provider: ${provider}`,
      '',
    ].join('\n'),
    'utf8',
  );
  clearConfigCache(cwd);
}

async function writeExplicitWriterConfigWithNotification(cwd: string, notifyBin: string, provider = 'anthropic-claude') {
  await writeFile(
    join(cwd, 'neal.yml'),
    [
      'neal:',
      `  notify_bin: ${notifyBin}`,
      'agent:',
      '  coder:',
      `    provider: ${provider}`,
      '  reviewer:',
      `    provider: ${provider}`,
      '',
    ].join('\n'),
    'utf8',
  );
  clearConfigCache(cwd);
}

async function withIsolatedHome<T>(action: (home: string) => Promise<T>): Promise<T> {
  const previousHome = process.env.HOME;
  const home = await mkdtemp(join(tmpdir(), 'neal-check-home-'));
  process.env.HOME = home;
  clearConfigCache();
  try {
    return await action(home);
  } finally {
    if (previousHome === undefined) {
      delete process.env.HOME;
    } else {
      process.env.HOME = previousHome;
    }
    clearConfigCache();
  }
}

test('neal check validates config and skips provider verification in non-interactive shells', async () => {
  await withIsolatedHome(async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'neal-check-defaults-'));
    await writeExplicitWriterConfig(cwd);
    const stdout = new CaptureStream();

    await runNealCheckCli({
      cwd,
      stdin: createClosedInput(false),
      stdout,
    });

    assert.equal(stdout.chunks.length > 0, true);
    const output = stdout.chunks.join('');
    assert.match(output, /planner: Anthropic Claude \(anthropic-claude\), model: provider default, effort: provider default \(inherits coder\)/);
    assert.match(output, /coder: Anthropic Claude \(anthropic-claude\), model: provider default/);
    assert.match(output, /reviewer: Anthropic Claude \(anthropic-claude\), model: provider default/);
  });
});

test('neal check fails on an invalid review_level before provider verification', async () => {
  await withIsolatedHome(async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'neal-check-review-level-'));
    await writeFile(
      join(cwd, 'neal.yml'),
      [
        'neal:',
        '  review_level: paranoid',
        'agent:',
        '  coder:',
        '    provider: anthropic-claude',
        '  reviewer:',
        '    provider: anthropic-claude',
        '',
      ].join('\n'),
      'utf8',
    );
    clearConfigCache(cwd);

    await assert.rejects(
      runNealCheckCli({
        cwd,
        stdin: createClosedInput(false),
        stdout: new CaptureStream(),
      }),
      /Invalid review level for neal\.review_level: "paranoid"\. Valid values: strict, moderate, lenient/,
    );
  });
});

test('neal check does not print the compat pointer for a native writer provider', async () => {
  await withIsolatedHome(async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'neal-check-native-pointer-'));
    await writeExplicitWriterConfig(cwd, 'anthropic-claude');
    const stdout = new CaptureStream();

    await runNealCheckCli({ cwd, stdin: createClosedInput(false), stdout });

    assert.doesNotMatch(stdout.chunks.join(''), /run `neal compat`/);
  });
});

test('neal check prints the compat pointer for an openai-compatible writer provider', async () => {
  await withIsolatedHome(async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'neal-check-generic-pointer-'));
    await writeExplicitWriterConfig(cwd, 'openai-compatible');
    const stdout = new CaptureStream();

    await runNealCheckCli({ cwd, stdin: createClosedInput(false), stdout });

    assert.match(
      stdout.chunks.join(''),
      /This is an openai-compatible model - run `neal compat` to confirm it can drive the full loop\./,
    );
  });
});

test('neal check warns about guidance files that exceed the prompt inline cap', async () => {
  await withIsolatedHome(async () => {
    const previousGuidanceDir = process.env.NEAL_GUIDANCE_DIR;
    const guidanceDir = await mkdtemp(join(tmpdir(), 'neal-check-guidance-'));
    process.env.NEAL_GUIDANCE_DIR = guidanceDir;
    clearUserGuidanceCache();
    try {
      const cwd = await mkdtemp(join(tmpdir(), 'neal-check-guidance-cwd-'));
      await writeExplicitWriterConfig(cwd);
      await writeFile(join(guidanceDir, 'reviewer.md'), 'g'.repeat(USER_GUIDANCE_MAX_CHARS + 1), 'utf8');
      await writeFile(join(guidanceDir, 'coder.md'), 'Short guidance.', 'utf8');
      const stdout = new CaptureStream();

      await runNealCheckCli({ cwd, stdin: createClosedInput(false), stdout });

      const output = stdout.chunks.join('');
      assert.match(
        output,
        new RegExp(
          `warning: reviewer guidance at .* is ${USER_GUIDANCE_MAX_CHARS + 1} characters; prompts inline the first ${USER_GUIDANCE_MAX_CHARS} and truncate the rest`,
        ),
      );
      assert.doesNotMatch(output, /warning: coder guidance/);
    } finally {
      if (previousGuidanceDir === undefined) {
        delete process.env.NEAL_GUIDANCE_DIR;
      } else {
        process.env.NEAL_GUIDANCE_DIR = previousGuidanceDir;
      }
      clearUserGuidanceCache();
    }
  });
});

test('neal check describes configured notifications without testing them in non-interactive shells', async () => {
  await withIsolatedHome(async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'neal-check-noninteractive-notification-'));
    await writeExplicitWriterConfigWithNotification(cwd, '/path/that/must/not-run');
    const stdout = new CaptureStream();
    let providerVerifierCalled = false;
    let notificationVerifierCalled = false;

    await runNealCheckCli({
      cwd,
      stdin: createClosedInput(false),
      stdout,
      verifyProviderConnectivity: async () => {
        providerVerifierCalled = true;
      },
      verifyNotificationScript: async () => {
        notificationVerifierCalled = true;
      },
    });

    const output = stdout.chunks.join('');
    assert.equal(providerVerifierCalled, false);
    assert.equal(notificationVerifierCalled, false);
    assert.match(output, /notification script: \/path\/that\/must\/not-run/);
    assert.match(output, /Provider verification skipped: non-interactive input/);
    assert.doesNotMatch(output, /Test notification script now\?/);
  });
});

test('neal check prompts after valid config and honors a declined provider verification', async () => {
  await withIsolatedHome(async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'neal-check-decline-'));
    await writeExplicitWriterConfig(cwd);
    const stdout = new CaptureStream();
    let verifierCalled = false;

    await runNealCheckCli({
      cwd,
      stdin: createClosedInput(true),
      stdout,
      confirmProviderVerification: () => false,
      verifyProviderConnectivity: async () => {
        verifierCalled = true;
      },
    });

    assert.equal(verifierCalled, false);
  });
});

test('neal check defaults provider verification to yes for empty interactive input', async () => {
  await withIsolatedHome(async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'neal-check-default-yes-'));
    await writeExplicitWriterConfig(cwd);
    const stdout = new CaptureStream();
    let verifierCalled = false;

    await runNealCheckCli({
      cwd,
      stdin: createInput('\n'),
      stdout,
      verifyProviderConnectivity: async () => {
        verifierCalled = true;
      },
    });

    assert.equal(verifierCalled, true);
  });
});

test('neal check can test a configured notification script after confirmation', async () => {
  await withIsolatedHome(async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'neal-check-notification-'));
    await writeExplicitWriterConfigWithNotification(cwd, '/usr/local/bin/notify');
    const stdout = new CaptureStream();
    let verifierCalled = false;

    await runNealCheckCli({
      cwd,
      stdin: createClosedInput(true),
      stdout,
      confirmProviderVerification: () => false,
      confirmNotificationTest: () => true,
      verifyNotificationScript: async (args) => {
        verifierCalled = true;
        assert.equal(args.cwd, cwd);
      },
    });

    assert.equal(verifierCalled, true);
  });
});

test('neal check defaults notification testing to yes for empty interactive input', async () => {
  await withIsolatedHome(async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'neal-check-notification-default-yes-'));
    await writeExplicitWriterConfigWithNotification(cwd, '/path/that/must/not-run');
    const stdout = new CaptureStream();
    let verifierCalled = false;

    await runNealCheckCli({
      cwd,
      stdin: createInput('\n'),
      stdout,
      confirmProviderVerification: () => false,
      verifyNotificationScript: async (args) => {
        verifierCalled = true;
        assert.equal(args.cwd, cwd);
      },
    });

    assert.equal(verifierCalled, true);
    assert.match(stdout.chunks.join(''), /Test notification script now\? \[Y\/n\] /);
  });
});

test('neal check skips notification testing for explicit no input', async () => {
  await withIsolatedHome(async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'neal-check-notification-explicit-no-'));
    await writeExplicitWriterConfigWithNotification(cwd, '/path/that/must/not-run');
    const stdout = new CaptureStream();
    let verifierCalled = false;

    await runNealCheckCli({
      cwd,
      stdin: createInput('n\n'),
      stdout,
      confirmProviderVerification: () => false,
      verifyNotificationScript: async () => {
        verifierCalled = true;
      },
    });

    const output = stdout.chunks.join('');
    assert.equal(verifierCalled, false);
    assert.match(output, /Test notification script now\? \[Y\/n\] /);
    assert.match(output, /Notification test skipped\./);
  });
});

test('neal check skips notification testing when no notification script is configured', async () => {
  await withIsolatedHome(async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'neal-check-no-notification-'));
    await writeExplicitWriterConfig(cwd);
    const stdout = new CaptureStream();
    let confirmationCalled = false;
    let verifierCalled = false;

    await runNealCheckCli({
      cwd,
      stdin: createClosedInput(true),
      stdout,
      confirmProviderVerification: () => false,
      confirmNotificationTest: () => {
        confirmationCalled = true;
        return true;
      },
      verifyNotificationScript: async () => {
        verifierCalled = true;
      },
    });

    assert.equal(confirmationCalled, false);
    assert.equal(verifierCalled, false);
    assert.doesNotMatch(stdout.chunks.join(''), /Test notification script now\?/);
  });
});

test('neal check warns when .neal/ is not ignored by Git', async () => {
  await withIsolatedHome(async () => {
    const cwd = await initGitRepo('neal-check-neal-not-ignored-');
    await writeExplicitWriterConfig(cwd);
    const stdout = new CaptureStream();

    await runNealCheckCli({
      cwd,
      stdin: createClosedInput(false),
      stdout,
      confirmProviderVerification: () => false,
    });

    const warning = '.neal/ is not ignored by Git. Run `neal setup` to add `.neal/` to `.git/info/exclude`, or add `.neal/` to your repository `.gitignore`.';
    const output = stdout.chunks.join('');
    assert.equal((output.match(new RegExp(warning.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g')) ?? []).length, 1);
  });
});

test('neal check does not warn when .neal/ is ignored by .gitignore', async () => {
  await withIsolatedHome(async () => {
    const cwd = await initGitRepo('neal-check-neal-gitignore-');
    await writeExplicitWriterConfig(cwd);
    await writeFile(join(cwd, '.gitignore'), '.neal/\n', 'utf8');
    const stdout = new CaptureStream();

    await runNealCheckCli({
      cwd,
      stdin: createClosedInput(false),
      stdout,
      confirmProviderVerification: () => false,
    });

    assert.doesNotMatch(stdout.chunks.join(''), /\.neal\/ is not ignored by Git/);
  });
});

test('neal check does not warn when .neal/ is ignored by .git/info/exclude', async () => {
  await withIsolatedHome(async () => {
    const cwd = await initGitRepo('neal-check-neal-exclude-');
    await writeExplicitWriterConfig(cwd);
    await writeFile(join(cwd, '.git', 'info', 'exclude'), '.neal/\n', 'utf8');
    const stdout = new CaptureStream();

    await runNealCheckCli({
      cwd,
      stdin: createClosedInput(false),
      stdout,
      confirmProviderVerification: () => false,
    });

    assert.doesNotMatch(stdout.chunks.join(''), /\.neal\/ is not ignored by Git/);
  });
});

test('neal check does not warn outside a Git worktree', async () => {
  await withIsolatedHome(async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'neal-check-neal-not-git-'));
    await writeExplicitWriterConfig(cwd);
    const stdout = new CaptureStream();

    await runNealCheckCli({
      cwd,
      stdin: createClosedInput(false),
      stdout,
      confirmProviderVerification: () => false,
    });

    assert.doesNotMatch(stdout.chunks.join(''), /\.neal\/ is not ignored by Git/);
  });
});

test('neal check can verify configured provider adapters after confirmation', async () => {
  await withIsolatedHome(async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'neal-check-fake-provider-'));
    await writeFile(
      join(cwd, 'neal.yml'),
      [
        'agent:',
        '  coder:',
        '    provider: fake-check-provider',
        '    model: fake-coder-model',
        '  reviewer:',
        '    provider: fake-check-provider',
        '    model: fake-reviewer-model',
        '',
      ].join('\n'),
      'utf8',
    );
    registerProviderDefinitionForTesting(createFakeProviderDefinition({
      id: 'fake-check-provider',
      displayName: 'Fake Check Provider',
      coderStructuredResponses: [
        { ok: true, message: 'NEAL_CHECK_PROVIDER_OK' },
      ],
      structuredAdvisorResponses: [{ ok: true, message: 'NEAL_CHECK_PROVIDER_OK' }],
      onCoderStructuredRun: (args) => {
        assert.equal(args.skipGitRepoCheck, true);
        assert.equal(args.structuredJsonProtocol.protocol, 'neal-json-block-v1');
        assert.equal(args.structuredJsonProtocol.schemaLabel, 'provider_check_payload');
        assert.deepEqual(args.schema, {
          type: 'object',
          properties: {
            ok: { type: 'boolean' },
            message: { type: 'string' },
          },
          required: ['ok', 'message'],
          additionalProperties: false,
        });
      },
    }));

    try {
      clearConfigCache(cwd);
      const stdout = new CaptureStream();
      await runNealCheckCli({
        cwd,
        stdin: createClosedInput(true),
        stdout,
        confirmProviderVerification: () => true,
      });
      const output = stdout.chunks.join('');
      assert.match(output, /Verifying Fake Check Provider \(fake-check-provider\), fake-coder-model, provider default effort \[planner, coder\]\.\.\.ok/);
      assert.match(output, /Verifying Fake Check Provider \(fake-check-provider\), fake-reviewer-model, provider default effort \[reviewer\]\.\.\.ok/);
    } finally {
      clearProviderDefinitionRegistrationsForTesting();
      clearConfigCache(cwd);
    }
  });
});

test('neal check reports a FAIL with an attributable structured-output detail when an openai-compatible model rejects schema enforcement', async () => {
  await withIsolatedHome(async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'neal-check-structured-reject-'));
    await writeFile(
      join(cwd, 'neal.yml'),
      [
        'agent:',
        '  coder:',
        '    provider: openai-compatible-check-mock',
        '    model: fake-coder-model',
        '  reviewer:',
        '    provider: openai-compatible-check-mock',
        '    model: fake-reviewer-model',
        '',
      ].join('\n'),
      'utf8',
    );
    // Real openai-compatible provider path: the structured provider-check turn is
    // the SDK's schema-enforced (json_schema) finalization. The injected mock
    // completes the tool loop, then rejects the finalization with an
    // HTTP-400-shaped error (a gateway/model that cannot honor structured
    // outputs). Scope 1's runtime classification must turn that into a
    // non-retryable structured_output_invalid, and `neal check` must surface a
    // FAIL with the attributable detail rather than a misleading pass.
    registerOpenAICompatibleMockProvider(() => checkScriptedModel([
      () => checkTextResponse('Provider check complete.'),
      () => {
        throw {
          name: 'AI_APICallError',
          message: 'response_format json_schema is not supported',
          statusCode: 400,
        };
      },
    ]));

    try {
      clearConfigCache(cwd);
      const stdout = new CaptureStream();
      await assert.rejects(
        runNealCheckCli({
          cwd,
          stdin: createClosedInput(true),
          stdout,
          confirmProviderVerification: () => true,
        }),
        /HTTP 400.*provider_check_payload/s,
      );
      const output = stdout.chunks.join('');
      assert.match(
        output,
        /Verifying OpenAI-compatible \(openai-compatible-check-mock\), fake-coder-model, provider default effort \[planner, coder\]\.\.\.failed/,
      );
    } finally {
      clearProviderDefinitionRegistrationsForTesting();
      clearConfigCache(cwd);
    }
  });
});

test('neal check reports ok when an openai-compatible model honors schema-enforced structured output', async () => {
  await withIsolatedHome(async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'neal-check-structured-ok-'));
    await writeFile(
      join(cwd, 'neal.yml'),
      [
        'agent:',
        '  coder:',
        '    provider: openai-compatible-check-mock',
        '    model: fake-coder-model',
        '  reviewer:',
        '    provider: openai-compatible-check-mock',
        '    model: fake-reviewer-model',
        '',
      ].join('\n'),
      'utf8',
    );
    // The same real openai-compatible path, but the model honors the schema-enforced
    // finalization by returning the expected check payload as JSON. The SDK's
    // Output.object parses it on both the coder (runStructuredPrompt) and reviewer
    // (runStructuredRound) paths, so both must report `ok`.
    registerOpenAICompatibleMockProvider(() => checkScriptedModel([
      () => checkTextResponse('{ "ok": true, "message": "NEAL_CHECK_PROVIDER_OK" }'),
    ]));

    try {
      clearConfigCache(cwd);
      const stdout = new CaptureStream();
      await runNealCheckCli({
        cwd,
        stdin: createClosedInput(true),
        stdout,
        confirmProviderVerification: () => true,
      });
      const output = stdout.chunks.join('');
      assert.match(
        output,
        /Verifying OpenAI-compatible \(openai-compatible-check-mock\), fake-coder-model, provider default effort \[planner, coder\]\.\.\.ok/,
      );
      assert.match(
        output,
        /Verifying OpenAI-compatible \(openai-compatible-check-mock\), fake-reviewer-model, provider default effort \[reviewer\]\.\.\.ok/,
      );
    } finally {
      clearProviderDefinitionRegistrationsForTesting();
      clearConfigCache(cwd);
    }
  });
});

test('neal check includes provider stderr when verification exits with a generic provider error', async () => {
  await withIsolatedHome(async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'neal-check-provider-stderr-'));
    await writeFile(
      join(cwd, 'neal.yml'),
      [
        'agent:',
        '  coder:',
        '    provider: fake-stderr-provider',
        '  reviewer:',
        '    provider: fake-stderr-provider',
        '    model: fake-reviewer-model',
        '',
      ].join('\n'),
      'utf8',
    );
    registerProviderDefinitionForTesting(createFakeProviderDefinition({
      id: 'fake-stderr-provider',
      displayName: 'Fake Stderr Provider',
      coderStructuredResponses: [
        { ok: true, message: 'NEAL_CHECK_PROVIDER_OK' },
      ],
      emittedProviderEvents: [{
        type: 'tool_progress',
        provider: 'fake-stderr-provider',
        role: 'structured-advisor',
        label: 'support',
        sessionHandle: null,
        toolName: 'stderr',
        message: '--dangerously-skip-permissions cannot be used with root/sudo privileges for security reasons',
        isError: true,
      }],
      structuredAdvisorError: new Error('Claude Code process exited with code 1'),
    }));

    try {
      clearConfigCache(cwd);
      const stdout = new CaptureStream();
      await assert.rejects(
        runNealCheckCli({
          cwd,
          stdin: createClosedInput(true),
          stdout,
          confirmProviderVerification: () => true,
        }),
        /Run Neal from a non-root user/,
      );
    } finally {
      clearProviderDefinitionRegistrationsForTesting();
      clearConfigCache(cwd);
    }
  });
});

test('neal check redacts secret-shaped provider verification failures', async () => {
  await withIsolatedHome(async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'neal-check-provider-secret-redaction-'));
    const fakeOpenAiKey = `sk-${'testCredentialValue123'}`;
    const fakeGithubToken = `ghp_${'testCredentialValue123'}`;
    const openAiApiKeyName = ['OPENAI', 'API', 'KEY'].join('_');
    const githubTokenName = ['GITHUB', 'TOKEN'].join('_');
    const fakePassword = 'provider-password-value';
    await writeFile(
      join(cwd, 'neal.yml'),
      [
        'agent:',
        '  coder:',
        '    provider: fake-secret-provider',
        '  reviewer:',
        '    provider: fake-secret-provider',
        '',
      ].join('\n'),
      'utf8',
    );
    registerProviderDefinitionForTesting(createFakeProviderDefinition({
      id: 'fake-secret-provider',
      displayName: 'Fake Secret Provider',
      emittedProviderEvents: [{
        type: 'tool_progress',
        provider: 'fake-secret-provider',
        role: 'coder',
        sessionHandle: null,
        toolName: 'stderr',
        message: `provider stderr ${openAiApiKeyName}=${fakeOpenAiKey} password: ${fakePassword}`,
        isError: true,
      }],
      coderError: new Error(`provider failed with ${githubTokenName}=${fakeGithubToken}`),
    }));

    try {
      clearConfigCache(cwd);
      const stdout = new CaptureStream();
      await assert.rejects(
        runNealCheckCli({
          cwd,
          stdin: createClosedInput(true),
          stdout,
          confirmProviderVerification: () => true,
        }),
        (error) => {
          assert.equal(error instanceof Error, true);
          const message = error instanceof Error ? error.message : String(error);
          assert.match(message, new RegExp(`${openAiApiKeyName}=\\[redacted\\]`));
          assert.match(message, /password=\[redacted\]/);
          assert.match(message, new RegExp(`${githubTokenName}=\\[redacted\\]`));
          assert.equal(message.includes(fakeOpenAiKey), false);
          assert.equal(message.includes(fakeGithubToken), false);
          assert.equal(message.includes(fakePassword), false);
          return true;
        },
      );
    } finally {
      clearProviderDefinitionRegistrationsForTesting();
      clearConfigCache(cwd);
    }
  });
});

const fakeEffortCapabilities = {
  coder: {
    ...fakeProviderDefaultCapabilities.coder,
    supportedEfforts: ['low', 'medium', 'high', 'xhigh'] as const,
  },
  'structured-advisor': {
    ...fakeProviderDefaultCapabilities['structured-advisor'],
    supportedEfforts: ['low', 'medium', 'high', 'xhigh'] as const,
  },
};

test('neal check renders the configured effort per role', async () => {
  await withIsolatedHome(async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'neal-check-effort-render-'));
    await writeFile(
      join(cwd, 'neal.yml'),
      [
        'agent:',
        '  coder:',
        '    provider: fake-effort-provider',
        '    effort: high',
        '  reviewer:',
        '    provider: fake-effort-provider',
        '    effort: low',
        '',
      ].join('\n'),
      'utf8',
    );
    registerProviderDefinitionForTesting(createFakeProviderDefinition({
      id: 'fake-effort-provider',
      displayName: 'Fake Effort Provider',
      capabilities: fakeEffortCapabilities,
    }));

    try {
      clearConfigCache(cwd);
      const stdout = new CaptureStream();
      await runNealCheckCli({
        cwd,
        stdin: createClosedInput(false),
        stdout,
      });
      const output = stdout.chunks.join('');
      assert.match(output, /planner: Fake Effort Provider \(fake-effort-provider\), model: provider default, effort: high \(inherits coder\)/);
      assert.match(output, /coder: Fake Effort Provider \(fake-effort-provider\), model: provider default, effort: high/);
      assert.match(output, /reviewer: Fake Effort Provider \(fake-effort-provider\), model: provider default, effort: low/);
    } finally {
      clearProviderDefinitionRegistrationsForTesting();
      clearConfigCache(cwd);
    }
  });
});

test('neal check verifies roles separately when they differ only by effort', async () => {
  await withIsolatedHome(async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'neal-check-effort-verify-'));
    await writeFile(
      join(cwd, 'neal.yml'),
      [
        'agent:',
        '  coder:',
        '    provider: fake-effort-provider',
        '    model: shared-model',
        '    effort: high',
        '  reviewer:',
        '    provider: fake-effort-provider',
        '    model: shared-model',
        '    effort: low',
        '',
      ].join('\n'),
      'utf8',
    );
    registerProviderDefinitionForTesting(createFakeProviderDefinition({
      id: 'fake-effort-provider',
      displayName: 'Fake Effort Provider',
      capabilities: fakeEffortCapabilities,
      coderStructuredResponses: [{ ok: true, message: 'NEAL_CHECK_PROVIDER_OK' }],
      structuredAdvisorResponses: [{ ok: true, message: 'NEAL_CHECK_PROVIDER_OK' }],
    }));

    try {
      clearConfigCache(cwd);
      const stdout = new CaptureStream();
      await runNealCheckCli({
        cwd,
        stdin: createClosedInput(true),
        stdout,
        confirmProviderVerification: () => true,
      });
      const output = stdout.chunks.join('');
      assert.match(output, /Verifying Fake Effort Provider \(fake-effort-provider\), shared-model, high \[planner, coder\]\.\.\.ok/);
      assert.match(output, /Verifying Fake Effort Provider \(fake-effort-provider\), shared-model, low \[reviewer\]\.\.\.ok/);
    } finally {
      clearProviderDefinitionRegistrationsForTesting();
      clearConfigCache(cwd);
    }
  });
});

test('neal check verifies identical roles once including effort', async () => {
  await withIsolatedHome(async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'neal-check-effort-dedupe-'));
    await writeFile(
      join(cwd, 'neal.yml'),
      [
        'agent:',
        '  coder:',
        '    provider: fake-effort-provider',
        '    model: shared-model',
        '    effort: high',
        '  reviewer:',
        '    provider: fake-effort-provider',
        '    model: shared-model',
        '    effort: high',
        '',
      ].join('\n'),
      'utf8',
    );
    registerProviderDefinitionForTesting(createFakeProviderDefinition({
      id: 'fake-effort-provider',
      displayName: 'Fake Effort Provider',
      capabilities: fakeEffortCapabilities,
      coderStructuredResponses: [{ ok: true, message: 'NEAL_CHECK_PROVIDER_OK' }],
      structuredAdvisorResponses: [{ ok: true, message: 'NEAL_CHECK_PROVIDER_OK' }],
    }));

    try {
      clearConfigCache(cwd);
      const stdout = new CaptureStream();
      await runNealCheckCli({
        cwd,
        stdin: createClosedInput(true),
        stdout,
        confirmProviderVerification: () => true,
      });
      const output = stdout.chunks.join('');
      const verifications = output.match(/Verifying Fake Effort Provider/g) ?? [];
      assert.equal(verifications.length, 1);
      assert.match(output, /Verifying Fake Effort Provider \(fake-effort-provider\), shared-model, high \[planner, coder, reviewer\]\.\.\.ok/);
    } finally {
      clearProviderDefinitionRegistrationsForTesting();
      clearConfigCache(cwd);
    }
  });
});

test('neal check surfaces a hung provider turn as a failed check mentioning no observable progress', async () => {
  await withIsolatedHome(async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'neal-check-liveness-hang-'));
    await writeFile(
      join(cwd, 'neal.yml'),
      [
        'neal:',
        '  agent_turn_startup_timeout_ms: 40',
        '  agent_turn_retry_limit: 1',
        'agent:',
        '  coder:',
        '    provider: fake-liveness-check-provider',
        '    model: fake-coder-model',
        '  reviewer:',
        '    provider: fake-liveness-check-provider',
        '    model: fake-reviewer-model',
        '',
      ].join('\n'),
      'utf8',
    );
    let advisorRuns = 0;
    const advisorTrace: string[] = [];
    registerProviderDefinitionForTesting(createFakeProviderDefinition({
      id: 'fake-liveness-check-provider',
      displayName: 'Fake Liveness Check Provider',
      coderStructuredResponses: [
        { ok: true, message: 'NEAL_CHECK_PROVIDER_OK' },
      ],
      onStructuredAdvisorRun: async (args) => {
        advisorRuns += 1;
        advisorTrace.push(`run:${advisorRuns}`);
        const attempt = advisorRuns;
        args.signal?.addEventListener('abort', () => advisorTrace.push(`abort:${attempt}`), { once: true });
        await args.events?.({
          type: 'turn_started',
          provider: 'fake-liveness-check-provider',
          role: 'structured-advisor',
        });
        // Hang forever after turn start: startup silence on every attempt.
        await new Promise(() => {});
      },
    }));

    try {
      clearConfigCache(cwd);
      const stdout = new CaptureStream();
      await assert.rejects(
        runNealCheckCli({
          cwd,
          stdin: createClosedInput(true),
          stdout,
          confirmProviderVerification: () => true,
        }),
        /no observable progress/i,
      );
      const output = stdout.chunks.join('');
      assert.match(output, /Verifying Fake Liveness Check Provider \(fake-liveness-check-provider\), fake-coder-model, provider default effort \[planner, coder\]\.\.\.ok/);
      assert.match(output, /Verifying Fake Liveness Check Provider \(fake-liveness-check-provider\), fake-reviewer-model, provider default effort \[reviewer\]\.\.\.failed/);
      // The supervisor retried the hung check turn once and aborted each
      // abandoned attempt before moving on.
      assert.deepEqual(advisorTrace, ['run:1', 'abort:1', 'run:2', 'abort:2']);
    } finally {
      clearProviderDefinitionRegistrationsForTesting();
      clearConfigCache(cwd);
    }
  });
});
