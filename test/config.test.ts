import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import {
  assertWriterProvidersConfigured,
  clearConfigCache,
  formatWriterProviderSetupRequiredLines,
  getAgentTurnRetryLimit,
  getAgentTurnStartupTimeoutMs,
  getConfigSourceInfo,
  getExplicitAgentConfig,
  getNotifyBin,
  getOpenAICompatibleSettings,
  getPlanReviewDebtRoundThreshold,
  getRawMergedConfig,
  getConsultantMaxAttempts,
  getReviewStuckWindow,
  isWriterProvidersNotConfiguredError,
} from '../src/neal/config.js';
import { getDefaultAgentConfig } from '../src/neal/state.js';

// This file exercises notify behavior through its own fixture scripts; the
// suite-wide NEAL_NOTIFY_BIN= kill switch (pnpm test script) must not shadow
// them. Fixture repo configs pin notify_bin, so this stays hermetic.
delete process.env.NEAL_NOTIFY_BIN;


async function withIsolatedHome<T>(action: (home: string) => Promise<T>): Promise<T> {
  const previousHome = process.env.HOME;
  const home = await mkdtemp(join(tmpdir(), 'neal-config-home-'));
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

async function writeUserConfig(home: string, content: string) {
  const configDir = join(home, '.neal');
  await mkdir(configDir, { recursive: true });
  await writeFile(join(configDir, 'config.yml'), content, 'utf8');
}

test('getConfigSourceInfo reports repo and user config paths and existence', async () => {
  await withIsolatedHome(async (home) => {
    const cwd = await mkdtemp(join(tmpdir(), 'neal-config-sources-'));

    assert.deepEqual(getConfigSourceInfo(cwd), {
      repo: {
        path: resolve(cwd, 'neal.yml'),
        exists: false,
      },
      user: {
        path: join(home, '.neal', 'config.yml'),
        exists: false,
      },
    });

    await writeFile(join(cwd, 'neal.yml'), 'neal:\n  notify_bin: /bin/true\n', 'utf8');
    await writeUserConfig(home, 'neal:\n  max_review_rounds: 4\n');

    assert.deepEqual(getConfigSourceInfo(cwd), {
      repo: {
        path: resolve(cwd, 'neal.yml'),
        exists: true,
      },
      user: {
        path: join(home, '.neal', 'config.yml'),
        exists: true,
      },
    });
  });
});

test('repo config does not fall back to config.yml', async () => {
  await withIsolatedHome(async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'neal-config-no-legacy-fallback-'));
    await writeFile(join(cwd, 'config.yml'), 'neal:\n  review_stuck_window: 99\n', 'utf8');

    assert.equal(getConfigSourceInfo(cwd).repo.exists, false);
    assert.equal(getReviewStuckWindow(cwd), 5);
  });
});

test('getReviewStuckWindow defaults to 5 and honors config overrides', async () => {
  await withIsolatedHome(async (home) => {
    const cwd = await mkdtemp(join(tmpdir(), 'neal-config-stuck-window-'));

    assert.equal(getReviewStuckWindow(cwd), 5);

    await writeUserConfig(home, 'neal:\n  review_stuck_window: 4\n');
    clearConfigCache(cwd);
    assert.equal(getReviewStuckWindow(cwd), 4);

    await writeFile(join(cwd, 'neal.yml'), 'neal:\n  review_stuck_window: 7\n', 'utf8');
    clearConfigCache(cwd);
    assert.equal(getReviewStuckWindow(cwd), 7);
  });
});

test('getPlanReviewDebtRoundThreshold defaults to 3 and honors config overrides', async () => {
  await withIsolatedHome(async (home) => {
    const cwd = await mkdtemp(join(tmpdir(), 'neal-config-debt-threshold-'));

    assert.equal(getPlanReviewDebtRoundThreshold(cwd), 3);

    await writeUserConfig(home, 'neal:\n  plan_review_debt_round_threshold: 2\n');
    clearConfigCache(cwd);
    assert.equal(getPlanReviewDebtRoundThreshold(cwd), 2);

    await writeFile(join(cwd, 'neal.yml'), 'neal:\n  plan_review_debt_round_threshold: 5\n', 'utf8');
    clearConfigCache(cwd);
    assert.equal(getPlanReviewDebtRoundThreshold(cwd), 5);
  });
});

test('getConsultantMaxAttempts defaults to 1, honors overrides, and 0 disables', async () => {
  await withIsolatedHome(async (home) => {
    const cwd = await mkdtemp(join(tmpdir(), 'neal-config-consultant-attempts-'));

    assert.equal(getConsultantMaxAttempts(cwd), 1);

    await writeUserConfig(home, 'neal:\n  consultant_max_attempts: 3\n');
    clearConfigCache(cwd);
    assert.equal(getConsultantMaxAttempts(cwd), 3);

    await writeFile(join(cwd, 'neal.yml'), 'neal:\n  consultant_max_attempts: 0\n', 'utf8');
    clearConfigCache(cwd);
    assert.equal(getConsultantMaxAttempts(cwd), 0);
  });
});

test('getExplicitAgentConfig reads repo-only explicit writer providers', async () => {
  await withIsolatedHome(async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'neal-config-repo-agent-'));
    await writeFile(
      join(cwd, 'neal.yml'),
      [
        'agent:',
        '  coder:',
        '    provider: openai-codex',
        '    model: gpt-test-coder',
        '  reviewer:',
        '    provider: anthropic-claude',
        '    model: null',
        '',
      ].join('\n'),
      'utf8',
    );
    clearConfigCache(cwd);

    assert.deepEqual(getExplicitAgentConfig(cwd), {
      planner: {
        provider: 'openai-codex',
        model: 'gpt-test-coder',
        effort: null,
      },
      coder: {
        provider: 'openai-codex',
        model: 'gpt-test-coder',
        effort: null,
      },
      reviewer: {
        provider: 'anthropic-claude',
        model: null,
        effort: null,
      },
    });
  });
});

test('raw merged config keeps user values and lets repo config override matching keys', async () => {
  await withIsolatedHome(async (home) => {
    const cwd = await mkdtemp(join(tmpdir(), 'neal-config-user-override-'));
    await writeFile(
      join(cwd, 'neal.yml'),
      [
        'neal:',
        '  notify_bin: /repo/notify',
        'agent:',
        '  coder:',
        '    provider: openai-codex',
        '    model: repo-coder-model',
        '  reviewer:',
        '    provider: anthropic-claude',
        '    model: repo-reviewer-model',
        '',
      ].join('\n'),
      'utf8',
    );
    await writeUserConfig(
      home,
      [
        'neal:',
        '  max_review_rounds: 7',
        'agent:',
        '  coder:',
        '    provider: anthropic-claude',
        '    model: user-coder-model',
        '',
      ].join('\n'),
    );
    clearConfigCache(cwd);

    const raw = getRawMergedConfig(cwd);
    assert.equal(raw.neal?.notify_bin, '/repo/notify');
    assert.equal(raw.neal?.max_review_rounds, 7);
    assert.equal(raw.agent?.coder?.provider, 'openai-codex');
    assert.equal(raw.agent?.coder?.model, 'repo-coder-model');
    assert.equal(raw.agent?.reviewer?.provider, 'anthropic-claude');
    assert.equal(raw.agent?.reviewer?.model, 'repo-reviewer-model');
    assert.deepEqual(getExplicitAgentConfig(cwd), {
      planner: {
        provider: 'openai-codex',
        model: 'repo-coder-model',
        effort: null,
      },
      coder: {
        provider: 'openai-codex',
        model: 'repo-coder-model',
        effort: null,
      },
      reviewer: {
        provider: 'anthropic-claude',
        model: 'repo-reviewer-model',
        effort: null,
      },
    });
  });
});

test('repo config can disable a user notification helper', async () => {
  await withIsolatedHome(async (home) => {
    const cwd = await mkdtemp(join(tmpdir(), 'neal-config-repo-notify-null-'));
    await writeUserConfig(home, 'neal:\n  notify_bin: /usr/local/bin/notify\n');
    await writeFile(join(cwd, 'neal.yml'), 'neal:\n  notify_bin: null\n', 'utf8');
    clearConfigCache(cwd);

    assert.equal(getRawMergedConfig(cwd).neal?.notify_bin, null);
    assert.equal(getNotifyBin(cwd), null);
  });
});

test('getExplicitAgentConfig returns null when either writer provider is missing, null, or blank', async () => {
  await withIsolatedHome(async () => {
    const missingReviewerCwd = await mkdtemp(join(tmpdir(), 'neal-config-missing-reviewer-'));
    await writeFile(
      join(missingReviewerCwd, 'neal.yml'),
      [
        'agent:',
        '  coder:',
        '    provider: openai-codex',
        '',
      ].join('\n'),
      'utf8',
    );
    clearConfigCache(missingReviewerCwd);
    assert.equal(getExplicitAgentConfig(missingReviewerCwd), null);

    const nullCoderCwd = await mkdtemp(join(tmpdir(), 'neal-config-null-coder-'));
    await writeFile(
      join(nullCoderCwd, 'neal.yml'),
      [
        'agent:',
        '  coder:',
        '    provider: null',
        '  reviewer:',
        '    provider: anthropic-claude',
        '',
      ].join('\n'),
      'utf8',
    );
    clearConfigCache(nullCoderCwd);
    assert.equal(getExplicitAgentConfig(nullCoderCwd), null);

    const blankCoderCwd = await mkdtemp(join(tmpdir(), 'neal-config-blank-coder-'));
    await writeFile(
      join(blankCoderCwd, 'neal.yml'),
      [
        'agent:',
        '  coder:',
        '    provider: "   "',
        '  reviewer:',
        '    provider: anthropic-claude',
        '',
      ].join('\n'),
      'utf8',
    );
    clearConfigCache(blankCoderCwd);
    assert.equal(getExplicitAgentConfig(blankCoderCwd), null);
  });
});

test('getExplicitAgentConfig treats missing and blank models as provider defaults', async () => {
  await withIsolatedHome(async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'neal-config-model-defaults-'));
    await writeFile(
      join(cwd, 'neal.yml'),
      [
        'agent:',
        '  coder:',
        '    provider: openai-codex',
        '    model: ""',
        '  reviewer:',
        '    provider: anthropic-claude',
        '',
      ].join('\n'),
      'utf8',
    );
    clearConfigCache(cwd);

    assert.deepEqual(getExplicitAgentConfig(cwd), {
      planner: {
        provider: 'openai-codex',
        model: null,
        effort: null,
      },
      coder: {
        provider: 'openai-codex',
        model: null,
        effort: null,
      },
      reviewer: {
        provider: 'anthropic-claude',
        model: null,
        effort: null,
      },
    });
  });
});

test('invalid explicit provider ids still throw registry-context errors', async () => {
  await withIsolatedHome(async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'neal-config-invalid-provider-'));
    await writeFile(
      join(cwd, 'neal.yml'),
      [
        'agent:',
        '  coder:',
        '    provider: missing-provider',
        '  reviewer:',
        '    provider: anthropic-claude',
        '',
      ].join('\n'),
      'utf8',
    );
    clearConfigCache(cwd);

    assert.throws(
      () => getExplicitAgentConfig(cwd),
      /Invalid provider for agent\.coder\.provider: "missing-provider"\. Registered providers:/,
    );
  });
});

test('assertWriterProvidersConfigured returns explicit config or throws setup guidance', async () => {
  await withIsolatedHome(async () => {
    const configuredCwd = await mkdtemp(join(tmpdir(), 'neal-config-assert-configured-'));
    await writeFile(
      join(configuredCwd, 'neal.yml'),
      [
        'agent:',
        '  coder:',
        '    provider: openai-codex',
        '  reviewer:',
        '    provider: anthropic-claude',
        '',
      ].join('\n'),
      'utf8',
    );
    clearConfigCache(configuredCwd);
    assert.deepEqual(assertWriterProvidersConfigured(configuredCwd, { context: 'test writer run' }), {
      planner: {
        provider: 'openai-codex',
        model: null,
        effort: null,
      },
      coder: {
        provider: 'openai-codex',
        model: null,
        effort: null,
      },
      reviewer: {
        provider: 'anthropic-claude',
        model: null,
        effort: null,
      },
    });

    const missingCwd = await mkdtemp(join(tmpdir(), 'neal-config-assert-missing-'));
    clearConfigCache(missingCwd);
    assert.throws(
      () => assertWriterProvidersConfigured(missingCwd),
      (error: unknown) => {
        assert.equal(isWriterProvidersNotConfiguredError(error), true);
        if (!isWriterProvidersNotConfiguredError(error)) {
          return false;
        }
        assert.deepEqual(error.missingProviderKeys, ['agent.coder.provider', 'agent.reviewer.provider']);
        assert.deepEqual(formatWriterProviderSetupRequiredLines(error), [
          'Neal is not set up yet.',
          'Run `neal setup` to choose providers, or set agent.coder.provider and agent.reviewer.provider in neal.yml.',
        ]);
        return true;
      },
    );

    assert.throws(
      () => assertWriterProvidersConfigured(missingCwd, { guidance: 'check' }),
      (error: unknown) => {
        assert.equal(isWriterProvidersNotConfiguredError(error), true);
        if (!isWriterProvidersNotConfiguredError(error)) {
          return false;
        }
        assert.deepEqual(error.missingProviderKeys, ['agent.coder.provider', 'agent.reviewer.provider']);
        assert.deepEqual(formatWriterProviderSetupRequiredLines(error), [
          'Neal is not set up yet.',
          'Run `neal setup` to choose providers, then run `neal check` again.',
        ]);
        return true;
      },
    );
  });
});

test('assertWriterProvidersConfigured identifies the missing writer role key', async () => {
  await withIsolatedHome(async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'neal-config-partial-writer-'));
    await writeFile(
      join(cwd, 'neal.yml'),
      [
        'agent:',
        '  coder:',
        '    provider: openai-codex',
        '',
      ].join('\n'),
      'utf8',
    );
    clearConfigCache(cwd);

    assert.throws(
      () => assertWriterProvidersConfigured(cwd),
      (error: unknown) => {
        assert.equal(isWriterProvidersNotConfiguredError(error), true);
        if (!isWriterProvidersNotConfiguredError(error)) {
          return false;
        }
        assert.deepEqual(error.missingProviderKeys, ['agent.reviewer.provider']);
        assert.deepEqual(formatWriterProviderSetupRequiredLines(error), [
          'Neal is not set up yet.',
          'Run `neal setup` to choose providers, or set agent.reviewer.provider in neal.yml.',
        ]);
        return true;
      },
    );
  });
});

test('agent turn liveness getters return documented defaults with no config', async () => {
  await withIsolatedHome(async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'neal-config-liveness-defaults-'));
    clearConfigCache(cwd);

    assert.equal(getAgentTurnStartupTimeoutMs(cwd), 300_000);
    assert.equal(getAgentTurnRetryLimit(cwd), 1);
  });
});

test('agent turn liveness getters honor repo config overrides', async () => {
  await withIsolatedHome(async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'neal-config-liveness-repo-'));
    await writeFile(
      join(cwd, 'neal.yml'),
      [
        'neal:',
        '  agent_turn_startup_timeout_ms: 120000',
        '  agent_turn_retry_limit: 2',
        '',
      ].join('\n'),
      'utf8',
    );
    clearConfigCache(cwd);

    assert.equal(getAgentTurnStartupTimeoutMs(cwd), 120_000);
    assert.equal(getAgentTurnRetryLimit(cwd), 2);
  });
});

test('agent turn liveness getters honor user config overrides', async () => {
  await withIsolatedHome(async (home) => {
    const cwd = await mkdtemp(join(tmpdir(), 'neal-config-liveness-user-'));
    await writeUserConfig(
      home,
      [
        'neal:',
        '  agent_turn_startup_timeout_ms: 45000',
        '  agent_turn_retry_limit: 0',
        '',
      ].join('\n'),
    );
    clearConfigCache(cwd);

    assert.equal(getAgentTurnStartupTimeoutMs(cwd), 45_000);
    assert.equal(getAgentTurnRetryLimit(cwd), 0);
  });
});

test('getDefaultAgentConfig keeps built-in fallback behavior when explicit config is absent', async () => {
  await withIsolatedHome(async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'neal-config-defaults-'));
    clearConfigCache(cwd);

    assert.deepEqual(getExplicitAgentConfig(cwd), null);
    assert.deepEqual(getDefaultAgentConfig(cwd), {
      planner: {
        provider: 'openai-codex',
        model: null,
        effort: null,
      },
      coder: {
        provider: 'openai-codex',
        model: null,
        effort: null,
      },
      reviewer: {
        provider: 'anthropic-claude',
        model: null,
        effort: null,
      },
    });
  });
});

test('planner config inherits coder defaults and supports field-level overrides', async () => {
  await withIsolatedHome(async () => {
    const modelOnlyCwd = await mkdtemp(join(tmpdir(), 'neal-config-planner-model-'));
    await writeFile(
      join(modelOnlyCwd, 'neal.yml'),
      [
        'agent:',
        '  planner:',
        '    model: planner-model',
        '  coder:',
        '    provider: openai-codex',
        '    model: coder-model',
        '  reviewer:',
        '    provider: anthropic-claude',
        '',
      ].join('\n'),
      'utf8',
    );
    clearConfigCache(modelOnlyCwd);
    assert.deepEqual(getExplicitAgentConfig(modelOnlyCwd), {
      planner: {
        provider: 'openai-codex',
        model: 'planner-model',
        effort: null,
      },
      coder: {
        provider: 'openai-codex',
        model: 'coder-model',
        effort: null,
      },
      reviewer: {
        provider: 'anthropic-claude',
        model: null,
        effort: null,
      },
    });

    const providerOnlyCwd = await mkdtemp(join(tmpdir(), 'neal-config-planner-provider-'));
    await writeFile(
      join(providerOnlyCwd, 'neal.yml'),
      [
        'agent:',
        '  planner:',
        '    provider: anthropic-claude',
        '  coder:',
        '    provider: openai-codex',
        '    model: coder-model',
        '  reviewer:',
        '    provider: anthropic-claude',
        '',
      ].join('\n'),
      'utf8',
    );
    clearConfigCache(providerOnlyCwd);
    assert.deepEqual(getDefaultAgentConfig(providerOnlyCwd).planner, {
      provider: 'anthropic-claude',
      model: null,
      effort: null,
    });
    assert.deepEqual(getExplicitAgentConfig(providerOnlyCwd)?.planner, {
      provider: 'anthropic-claude',
      model: null,
      effort: null,
    });

    const nullModelCwd = await mkdtemp(join(tmpdir(), 'neal-config-planner-null-model-'));
    await writeFile(
      join(nullModelCwd, 'neal.yml'),
      [
        'agent:',
        '  planner:',
        '    provider: anthropic-claude',
        '    model: null',
        '  coder:',
        '    provider: openai-codex',
        '    model: coder-model',
        '  reviewer:',
        '    provider: anthropic-claude',
        '',
      ].join('\n'),
      'utf8',
    );
    clearConfigCache(nullModelCwd);
    assert.deepEqual(getDefaultAgentConfig(nullModelCwd).planner, {
      provider: 'anthropic-claude',
      model: null,
      effort: null,
    });

    const blankProviderCwd = await mkdtemp(join(tmpdir(), 'neal-config-planner-blank-provider-'));
    await writeFile(
      join(blankProviderCwd, 'neal.yml'),
      [
        'agent:',
        '  planner:',
        '    provider: "   "',
        '  coder:',
        '    provider: openai-codex',
        '    model: coder-model',
        '  reviewer:',
        '    provider: anthropic-claude',
        '',
      ].join('\n'),
      'utf8',
    );
    clearConfigCache(blankProviderCwd);
    assert.deepEqual(getDefaultAgentConfig(blankProviderCwd).planner, {
      provider: 'openai-codex',
      model: 'coder-model',
      effort: null,
    });
  });
});

test('explicit agent config reads per-role effort from user config', async () => {
  await withIsolatedHome(async (home) => {
    const cwd = await mkdtemp(join(tmpdir(), 'neal-config-effort-user-'));
    await writeUserConfig(
      home,
      [
        'agent:',
        '  coder:',
        '    provider: openai-codex',
        '    effort: high',
        '  reviewer:',
        '    provider: anthropic-claude',
        '    effort: xhigh',
        '',
      ].join('\n'),
    );
    clearConfigCache(cwd);

    const config = getExplicitAgentConfig(cwd);
    assert.equal(config?.coder.effort, 'high');
    assert.equal(config?.reviewer.effort, 'xhigh');
    // Planner inherits the coder effort when planner is not explicitly configured.
    assert.equal(config?.planner.effort, 'high');
    assert.equal(getDefaultAgentConfig(cwd).coder.effort, 'high');
    assert.equal(getDefaultAgentConfig(cwd).reviewer.effort, 'xhigh');
    assert.equal(getDefaultAgentConfig(cwd).planner.effort, 'high');
  });
});

test('repo effort overrides user effort and explicit null clears it', async () => {
  await withIsolatedHome(async (home) => {
    const cwd = await mkdtemp(join(tmpdir(), 'neal-config-effort-override-'));
    await writeUserConfig(
      home,
      [
        'agent:',
        '  coder:',
        '    provider: openai-codex',
        '    effort: low',
        '  reviewer:',
        '    provider: anthropic-claude',
        '    effort: medium',
        '',
      ].join('\n'),
    );
    await writeFile(
      join(cwd, 'neal.yml'),
      [
        'agent:',
        '  coder:',
        '    effort: high',
        '  reviewer:',
        '    effort: null',
        '',
      ].join('\n'),
      'utf8',
    );
    clearConfigCache(cwd);

    const config = getExplicitAgentConfig(cwd);
    assert.equal(config?.coder.effort, 'high');
    assert.equal(config?.reviewer.effort, null);
  });
});

test('planner effort defaults to null when planner provider is explicit', async () => {
  await withIsolatedHome(async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'neal-config-effort-planner-provider-'));
    await writeFile(
      join(cwd, 'neal.yml'),
      [
        'agent:',
        '  planner:',
        '    provider: anthropic-claude',
        '  coder:',
        '    provider: openai-codex',
        '    effort: high',
        '  reviewer:',
        '    provider: anthropic-claude',
        '',
      ].join('\n'),
      'utf8',
    );
    clearConfigCache(cwd);

    const config = getExplicitAgentConfig(cwd);
    assert.equal(config?.planner.effort, null);
    assert.equal(config?.coder.effort, 'high');
    assert.equal(getDefaultAgentConfig(cwd).planner.effort, null);
  });
});

test('getOpenAICompatibleSettings parses the repo config providers section', async () => {
  await withIsolatedHome(async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'neal-config-openai-compat-repo-'));
    await writeFile(
      join(cwd, 'neal.yml'),
      [
        'providers:',
        '  openai_compatible:',
        '    base_url: https://openrouter.ai/api/v1',
        '    api_key_env: OPENROUTER_API_KEY',
        '    default_model: deepseek/deepseek-r1',
        '    headers:',
        '      HTTP-Referer: https://example.invalid',
        '      X-Title: Neal',
        '',
      ].join('\n'),
      'utf8',
    );
    clearConfigCache(cwd);

    assert.deepEqual(getOpenAICompatibleSettings(cwd, { OPENROUTER_API_KEY: 'router-secret' }), {
      baseUrl: 'https://openrouter.ai/api/v1',
      apiKeyEnv: 'OPENROUTER_API_KEY',
      apiKey: 'router-secret',
      defaultModel: 'deepseek/deepseek-r1',
      headers: {
        'HTTP-Referer': 'https://example.invalid',
        'X-Title': 'Neal',
      },
      pricing: null,
    });
  });
});

test('getOpenAICompatibleSettings parses the user config providers section', async () => {
  await withIsolatedHome(async (home) => {
    const cwd = await mkdtemp(join(tmpdir(), 'neal-config-openai-compat-user-'));
    await writeUserConfig(
      home,
      [
        'providers:',
        '  openai_compatible:',
        '    base_url: https://api.deepseek.com',
        '    api_key_env: DEEPSEEK_API_KEY',
        '    default_model: deepseek-chat',
        '',
      ].join('\n'),
    );
    clearConfigCache(cwd);

    assert.deepEqual(getOpenAICompatibleSettings(cwd, { DEEPSEEK_API_KEY: 'deepseek-secret' }), {
      baseUrl: 'https://api.deepseek.com',
      apiKeyEnv: 'DEEPSEEK_API_KEY',
      apiKey: 'deepseek-secret',
      defaultModel: 'deepseek-chat',
      headers: {},
      pricing: null,
    });
  });
});

test('repo openai_compatible config overrides matching user config keys', async () => {
  await withIsolatedHome(async (home) => {
    const cwd = await mkdtemp(join(tmpdir(), 'neal-config-openai-compat-override-'));
    await writeUserConfig(
      home,
      [
        'providers:',
        '  openai_compatible:',
        '    base_url: https://user.example/v1',
        '    api_key_env: USER_KEY_ENV',
        '    default_model: user-model',
        '',
      ].join('\n'),
    );
    await writeFile(
      join(cwd, 'neal.yml'),
      [
        'providers:',
        '  openai_compatible:',
        '    base_url: https://repo.example/v1',
        '',
      ].join('\n'),
      'utf8',
    );
    clearConfigCache(cwd);

    assert.deepEqual(getOpenAICompatibleSettings(cwd, { USER_KEY_ENV: 'user-secret' }), {
      baseUrl: 'https://repo.example/v1',
      apiKeyEnv: 'USER_KEY_ENV',
      apiKey: 'user-secret',
      defaultModel: 'user-model',
      headers: {},
      pricing: null,
    });
  });
});

test('getOpenAICompatibleSettings falls back to environment variables and default api_key_env', async () => {
  await withIsolatedHome(async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'neal-config-openai-compat-env-'));
    clearConfigCache(cwd);

    assert.deepEqual(getOpenAICompatibleSettings(cwd, {}), {
      baseUrl: null,
      apiKeyEnv: 'OPENAI_COMPATIBLE_API_KEY',
      apiKey: null,
      defaultModel: null,
      headers: {},
      pricing: null,
    });

    assert.deepEqual(
      getOpenAICompatibleSettings(cwd, {
        OPENAI_COMPATIBLE_BASE_URL: 'https://env.example/v1',
        OPENAI_COMPATIBLE_MODEL: 'env-model',
        OPENAI_COMPATIBLE_API_KEY: 'env-secret',
      }),
      {
        baseUrl: 'https://env.example/v1',
        apiKeyEnv: 'OPENAI_COMPATIBLE_API_KEY',
        apiKey: 'env-secret',
        defaultModel: 'env-model',
        headers: {},
        pricing: null,
      },
    );
  });
});

test('openai_compatible config values take precedence over environment fallbacks', async () => {
  await withIsolatedHome(async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'neal-config-openai-compat-precedence-'));
    await writeFile(
      join(cwd, 'neal.yml'),
      [
        'providers:',
        '  openai_compatible:',
        '    base_url: https://config.example/v1',
        '    api_key_env: CONFIG_KEY_ENV',
        '    default_model: config-model',
        '',
      ].join('\n'),
      'utf8',
    );
    clearConfigCache(cwd);

    assert.deepEqual(
      getOpenAICompatibleSettings(cwd, {
        OPENAI_COMPATIBLE_BASE_URL: 'https://env.example/v1',
        OPENAI_COMPATIBLE_MODEL: 'env-model',
        OPENAI_COMPATIBLE_API_KEY: 'default-env-secret',
        CONFIG_KEY_ENV: 'config-env-secret',
      }),
      {
        baseUrl: 'https://config.example/v1',
        apiKeyEnv: 'CONFIG_KEY_ENV',
        apiKey: 'config-env-secret',
        defaultModel: 'config-model',
        headers: {},
        pricing: null,
      },
    );
  });
});

test('invalid openai_compatible headers produce a clear config error', async () => {
  await withIsolatedHome(async () => {
    const nonStringValueCwd = await mkdtemp(join(tmpdir(), 'neal-config-openai-compat-bad-header-'));
    await writeFile(
      join(nonStringValueCwd, 'neal.yml'),
      [
        'providers:',
        '  openai_compatible:',
        '    headers:',
        '      X-Retry-Count: 3',
        '',
      ].join('\n'),
      'utf8',
    );
    clearConfigCache(nonStringValueCwd);
    assert.throws(
      () => getOpenAICompatibleSettings(nonStringValueCwd, {}),
      /Invalid providers\.openai_compatible\.headers: value for "X-Retry-Count" must be a string\./,
    );

    const nonMapCwd = await mkdtemp(join(tmpdir(), 'neal-config-openai-compat-headers-list-'));
    await writeFile(
      join(nonMapCwd, 'neal.yml'),
      [
        'providers:',
        '  openai_compatible:',
        '    headers:',
        '      - X-Title',
        '',
      ].join('\n'),
      'utf8',
    );
    clearConfigCache(nonMapCwd);
    assert.throws(
      () => getOpenAICompatibleSettings(nonMapCwd, {}),
      /Invalid providers\.openai_compatible\.headers: expected a map of string header names to string values\./,
    );
  });
});

test('getOpenAICompatibleSettings parses a valid pricing block', async () => {
  await withIsolatedHome(async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'neal-config-openai-compat-pricing-'));
    await writeFile(
      join(cwd, 'neal.yml'),
      [
        'providers:',
        '  openai_compatible:',
        '    base_url: https://api.deepseek.com',
        '    default_model: deepseek-chat',
        '    pricing:',
        '      input_per_million: 0.27',
        '      cached_input_per_million: 0.07',
        '      output_per_million: 1.1',
        '',
      ].join('\n'),
      'utf8',
    );
    clearConfigCache(cwd);

    assert.deepEqual(getOpenAICompatibleSettings(cwd, {}).pricing, {
      inputPerMillion: 0.27,
      cachedInputPerMillion: 0.07,
      outputPerMillion: 1.1,
    });
  });
});

test('getOpenAICompatibleSettings returns null pricing when the block is absent', async () => {
  await withIsolatedHome(async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'neal-config-openai-compat-no-pricing-'));
    await writeFile(
      join(cwd, 'neal.yml'),
      [
        'providers:',
        '  openai_compatible:',
        '    base_url: https://api.deepseek.com',
        '    default_model: deepseek-chat',
        '',
      ].join('\n'),
      'utf8',
    );
    clearConfigCache(cwd);

    assert.equal(getOpenAICompatibleSettings(cwd, {}).pricing, null);
  });
});

test('invalid or partial openai_compatible pricing produces a clear config error', async () => {
  await withIsolatedHome(async () => {
    const partialCwd = await mkdtemp(join(tmpdir(), 'neal-config-openai-compat-partial-pricing-'));
    await writeFile(
      join(partialCwd, 'neal.yml'),
      [
        'providers:',
        '  openai_compatible:',
        '    pricing:',
        '      input_per_million: 0.27',
        '',
      ].join('\n'),
      'utf8',
    );
    clearConfigCache(partialCwd);
    assert.throws(
      () => getOpenAICompatibleSettings(partialCwd, {}),
      /Invalid providers\.openai_compatible\.pricing: "cached_input_per_million" must be a finite non-negative number\./,
    );

    const negativeCwd = await mkdtemp(join(tmpdir(), 'neal-config-openai-compat-negative-pricing-'));
    await writeFile(
      join(negativeCwd, 'neal.yml'),
      [
        'providers:',
        '  openai_compatible:',
        '    pricing:',
        '      input_per_million: -1',
        '      cached_input_per_million: 0.07',
        '      output_per_million: 1.1',
        '',
      ].join('\n'),
      'utf8',
    );
    clearConfigCache(negativeCwd);
    assert.throws(
      () => getOpenAICompatibleSettings(negativeCwd, {}),
      /Invalid providers\.openai_compatible\.pricing: "input_per_million" must be a finite non-negative number\./,
    );

    const nonMapCwd = await mkdtemp(join(tmpdir(), 'neal-config-openai-compat-pricing-list-'));
    await writeFile(
      join(nonMapCwd, 'neal.yml'),
      [
        'providers:',
        '  openai_compatible:',
        '    pricing:',
        '      - 1',
        '',
      ].join('\n'),
      'utf8',
    );
    clearConfigCache(nonMapCwd);
    assert.throws(
      () => getOpenAICompatibleSettings(nonMapCwd, {}),
      /Invalid providers\.openai_compatible\.pricing: expected a map/,
    );
  });
});

test('configs without a providers section keep resolving exactly as before', async () => {
  await withIsolatedHome(async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'neal-config-no-providers-'));
    await writeFile(
      join(cwd, 'neal.yml'),
      [
        'agent:',
        '  coder:',
        '    provider: openai-codex',
        '  reviewer:',
        '    provider: anthropic-claude',
        '',
      ].join('\n'),
      'utf8',
    );
    clearConfigCache(cwd);

    assert.deepEqual(getExplicitAgentConfig(cwd), {
      planner: {
        provider: 'openai-codex',
        model: null,
        effort: null,
      },
      coder: {
        provider: 'openai-codex',
        model: null,
        effort: null,
      },
      reviewer: {
        provider: 'anthropic-claude',
        model: null,
        effort: null,
      },
    });
    assert.deepEqual(getOpenAICompatibleSettings(cwd, {}), {
      baseUrl: null,
      apiKeyEnv: 'OPENAI_COMPATIBLE_API_KEY',
      apiKey: null,
      defaultModel: null,
      headers: {},
      pricing: null,
    });
  });
});

test('explicit planner effort overrides coder inheritance', async () => {
  await withIsolatedHome(async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'neal-config-effort-planner-explicit-'));
    await writeFile(
      join(cwd, 'neal.yml'),
      [
        'agent:',
        '  planner:',
        '    effort: medium',
        '  coder:',
        '    provider: openai-codex',
        '    effort: high',
        '  reviewer:',
        '    provider: anthropic-claude',
        '',
      ].join('\n'),
      'utf8',
    );
    clearConfigCache(cwd);

    const config = getExplicitAgentConfig(cwd);
    assert.equal(config?.planner.effort, 'medium');
    assert.equal(getDefaultAgentConfig(cwd).planner.effort, 'medium');
  });
});
