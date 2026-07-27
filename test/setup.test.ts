import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';
import { Writable } from 'node:stream';
import { promisify } from 'node:util';
import YAML from 'yaml';

import { runNealSetupCli } from '../src/neal/commands/setup.js';
import { clearConfigCache, getRawMergedConfig } from '../src/neal/config.js';
import { detectBuiltInProviders, type ProviderDetection } from '../src/neal/providers/detection.js';

// This file exercises notify behavior through its own fixture scripts; the
// suite-wide NEAL_NOTIFY_BIN= kill switch (pnpm test script) must not shadow
// them. Fixture repo configs pin notify_bin, so this stays hermetic.
delete process.env.NEAL_NOTIFY_BIN;


const execFileAsync = promisify(execFile);

class CaptureStream extends Writable {
  readonly chunks: string[] = [];

  override _write(chunk: unknown, _encoding: BufferEncoding, callback: (error?: Error | null) => void) {
    this.chunks.push(Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk));
    callback();
  }

  text() {
    return this.chunks.join('');
  }
}

async function runGit(cwd: string, ...args: string[]) {
  const { stdout } = await execFileAsync('git', args, { cwd });
  return stdout.trim();
}

async function initGitRepo(prefix: string) {
  const cwd = await mkdtemp(join(tmpdir(), prefix));
  await runGit(cwd, 'init');
  return cwd;
}

function resolveGitPath(cwd: string, path: string) {
  return isAbsolute(path) ? path : resolve(cwd, path);
}

function countNealIgnoreLines(content: string) {
  return content
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line !== '' && !line.startsWith('#') && line === '.neal/')
    .length;
}

async function withIsolatedHome<T>(action: (home: string) => Promise<T>): Promise<T> {
  const previousHome = process.env.HOME;
  const home = await mkdtemp(join(tmpdir(), 'neal-setup-home-'));
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

async function readUserConfig(home: string) {
  const content = await readFile(join(home, '.neal', 'config.yml'), 'utf8');
  return YAML.parse(content) as Record<string, unknown>;
}

function anthropicDetected(): ProviderDetection {
  return {
    provider: 'anthropic-claude',
    displayName: 'Anthropic Claude',
    runtimeAvailable: true,
    details: ['test detector'],
  };
}

function openAIDetected(runtimeAvailable = true): ProviderDetection {
  return {
    provider: 'openai-codex',
    displayName: 'OpenAI Codex',
    runtimeAvailable,
    details: ['test detector'],
  };
}

function openAICompatibleDetected(runtimeAvailable = false): ProviderDetection {
  return {
    provider: 'openai-compatible',
    displayName: 'OpenAI-compatible',
    runtimeAvailable,
    details: ['test detector'],
  };
}

const OPENAI_COMPATIBLE_ENV_KEYS = [
  'OPENAI_COMPATIBLE_BASE_URL',
  'OPENAI_COMPATIBLE_API_KEY',
  'OPENAI_COMPATIBLE_MODEL',
] as const;

async function withScrubbedOpenAICompatibleEnv<T>(action: () => Promise<T>): Promise<T> {
  const saved = OPENAI_COMPATIBLE_ENV_KEYS.map((key) => [key, process.env[key]] as const);
  for (const key of OPENAI_COMPATIBLE_ENV_KEYS) {
    delete process.env[key];
  }
  try {
    return await action();
  } finally {
    for (const [key, value] of saved) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  }
}

test('provider detection uses injected local probes deterministically', () => {
  const detections = detectBuiltInProviders({
    resolvePackage: (specifier) => {
      assert.equal(specifier, '@openai/codex-sdk');
      return '/deps/@openai/codex-sdk/index.js';
    },
    resolveClaudeExecutable: () => '/deps/claude',
    fileExists: (path) => path === '/usr/local/bin/claude',
    env: {
      PATH: '/opt/bin:/usr/local/bin',
    },
    pathDelimiter: ':',
  });

  const codex = detections.find((detection) => detection.provider === 'openai-codex');
  const claude = detections.find((detection) => detection.provider === 'anthropic-claude');
  assert.equal(codex?.runtimeAvailable, true);
  assert.match(codex?.details.join('\n') ?? '', /SDK runtime resolved at \/deps\/@openai\/codex-sdk\/index\.js/);
  assert.equal(claude?.runtimeAvailable, true);
  assert.match(claude?.details.join('\n') ?? '', /SDK-bundled Claude executable resolved/);
  assert.match(claude?.details.join('\n') ?? '', /\/usr\/local\/bin\/claude/);
});

test('provider detection resolves OpenAI Codex SDK with default ESM resolver', () => {
  const detections = detectBuiltInProviders({
    resolveClaudeExecutable: () => undefined,
    fileExists: () => false,
    env: {
      PATH: '',
    },
    pathDelimiter: ':',
  });

  const codex = detections.find((detection) => detection.provider === 'openai-codex');
  assert.equal(codex?.runtimeAvailable, true);
  assert.match(codex?.details.join('\n') ?? '', /SDK runtime resolved at file:.*@openai\/codex-sdk\/dist\/index\.js/);
});

test('provider detection treats either Claude runtime surface as available', () => {
  const bundledOnly = detectBuiltInProviders({
    resolvePackage: () => {
      throw new Error('not available');
    },
    resolveClaudeExecutable: () => '/deps/claude',
    fileExists: () => false,
    env: {
      PATH: '/usr/local/bin',
    },
    pathDelimiter: ':',
  }).find((detection) => detection.provider === 'anthropic-claude');

  const pathOnly = detectBuiltInProviders({
    resolvePackage: () => {
      throw new Error('not available');
    },
    resolveClaudeExecutable: () => undefined,
    fileExists: (path) => path === '/usr/local/bin/claude',
    env: {
      PATH: '/usr/local/bin',
    },
    pathDelimiter: ':',
  }).find((detection) => detection.provider === 'anthropic-claude');

  assert.equal(bundledOnly?.runtimeAvailable, true);
  assert.match(bundledOnly?.details.join('\n') ?? '', /standalone claude executable was not found on PATH/);
  assert.equal(pathOnly?.runtimeAvailable, true);
  assert.match(pathOnly?.details.join('\n') ?? '', /SDK-bundled Claude executable was not resolved/);
});

test('provider detection reports openai-compatible ready from fully resolved settings', () => {
  const seenCwds: string[] = [];
  const detections = detectBuiltInProviders({
    resolvePackage: () => {
      throw new Error('not available');
    },
    resolveClaudeExecutable: () => undefined,
    fileExists: () => false,
    env: { PATH: '' },
    pathDelimiter: ':',
    cwd: '/repo/checkout',
    resolveOpenAICompatibleSettings: (cwd) => {
      seenCwds.push(cwd);
      return {
        baseUrl: 'https://api.example.test/v1',
        apiKeyEnv: 'EXAMPLE_API_KEY',
        apiKey: 'secret',
        defaultModel: 'example-model',
        headers: {},
        pricing: null,
      };
    },
  });

  const compatible = detections.find((detection) => detection.provider === 'openai-compatible');
  assert.deepEqual(seenCwds, ['/repo/checkout']);
  assert.equal(compatible?.displayName, 'OpenAI-compatible');
  assert.equal(compatible?.runtimeAvailable, true);
  const details = compatible?.details.join('\n') ?? '';
  // Guard the forgotten-switch-case failure mode: a registered definition
  // without a detector case would still yield a row, but with the default
  // "No local detector is available for this provider" detail instead of
  // settings-derived lines.
  assert.doesNotMatch(details, /No local detector is available/);
  assert.match(details, /base URL configured: https:\/\/api\.example\.test\/v1/);
  assert.match(details, /API key resolved from env EXAMPLE_API_KEY/);
  assert.match(details, /default model configured: example-model/);
});

test('provider detection names each missing openai-compatible config key and env var', () => {
  const detections = detectBuiltInProviders({
    resolvePackage: () => {
      throw new Error('not available');
    },
    resolveClaudeExecutable: () => undefined,
    fileExists: () => false,
    env: { PATH: '' },
    pathDelimiter: ':',
    cwd: '/repo/checkout',
    resolveOpenAICompatibleSettings: () => ({
      baseUrl: null,
      apiKeyEnv: 'OPENAI_COMPATIBLE_API_KEY',
      apiKey: null,
      defaultModel: null,
      headers: {},
      pricing: null,
    }),
  });

  const compatible = detections.find((detection) => detection.provider === 'openai-compatible');
  assert.equal(compatible?.runtimeAvailable, false);
  const details = compatible?.details.join('\n') ?? '';
  assert.match(details, /set providers\.openai_compatible\.base_url or env OPENAI_COMPATIBLE_BASE_URL/);
  assert.match(details, /set env OPENAI_COMPATIBLE_API_KEY \(named by providers\.openai_compatible\.api_key_env\)/);
  assert.match(details, /set providers\.openai_compatible\.default_model or env OPENAI_COMPATIBLE_MODEL/);
  assert.match(details, /role-level model/);
});

test('provider detection reports openai-compatible unavailable when only the model is missing', () => {
  const detections = detectBuiltInProviders({
    resolvePackage: () => {
      throw new Error('not available');
    },
    resolveClaudeExecutable: () => undefined,
    fileExists: () => false,
    env: { PATH: '' },
    pathDelimiter: ':',
    cwd: '/repo/checkout',
    resolveOpenAICompatibleSettings: () => ({
      baseUrl: 'https://api.example.test/v1',
      apiKeyEnv: 'EXAMPLE_API_KEY',
      apiKey: 'secret',
      defaultModel: null,
      headers: {},
      pricing: null,
    }),
  });

  const compatible = detections.find((detection) => detection.provider === 'openai-compatible');
  assert.equal(compatible?.runtimeAvailable, false);
  assert.match(
    compatible?.details.join('\n') ?? '',
    /default model is missing: .*or configure a role-level model/,
  );
});

test('provider detection resolves openai-compatible settings through the default resolver from env', async () => {
  await withIsolatedHome(async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'neal-detect-compat-env-'));
    const detections = detectBuiltInProviders({
      resolvePackage: () => {
        throw new Error('not available');
      },
      resolveClaudeExecutable: () => undefined,
      fileExists: () => false,
      env: {
        PATH: '',
        OPENAI_COMPATIBLE_BASE_URL: 'https://env.example.test/v1',
        OPENAI_COMPATIBLE_API_KEY: 'env-secret',
        OPENAI_COMPATIBLE_MODEL: 'env-model',
      },
      pathDelimiter: ':',
      cwd,
    });

    const compatible = detections.find((detection) => detection.provider === 'openai-compatible');
    assert.equal(compatible?.runtimeAvailable, true);
    const details = compatible?.details.join('\n') ?? '';
    assert.match(details, /base URL configured: https:\/\/env\.example\.test\/v1/);
    assert.match(details, /API key resolved from env OPENAI_COMPATIBLE_API_KEY/);
    assert.match(details, /default model configured: env-model/);
  });
});

test('neal setup non-interactively writes all roles with provider-default models for shared setup', async () => {
  await withIsolatedHome(async (home) => {
    const cwd = await mkdtemp(join(tmpdir(), 'neal-setup-noninteractive-'));
    const stdout = new CaptureStream();

    await runNealSetupCli({
      cwd,
      stdout,
      args: ['setup', '--provider', 'anthropic-claude', '--all-roles'],
      detections: [anthropicDetected()],
    });

    assert.deepEqual(await readUserConfig(home), {
      agent: {
        planner: {
          provider: 'anthropic-claude',
          model: null,
        },
        coder: {
          provider: 'anthropic-claude',
          model: null,
        },
        reviewer: {
          provider: 'anthropic-claude',
          model: null,
        },
      },
    });
    const rawConfig = await readFile(join(home, '.neal', 'config.yml'), 'utf8');
    assert.match(rawConfig, /^agent:\n/m);
    assert.doesNotMatch(rawConfig, /[{}]/);
    assert.match(stdout.text(), /\.neal\/config\.yml/);
  });
});

test('neal setup shared provider can write an explicit planner model override', async () => {
  await withIsolatedHome(async (home) => {
    const cwd = await mkdtemp(join(tmpdir(), 'neal-setup-shared-planner-model-'));

    await runNealSetupCli({
      cwd,
      stdout: new CaptureStream(),
      args: ['setup', '--provider', 'anthropic-claude', '--all-roles', '--planner-model', 'gpt-plan'],
      detections: [anthropicDetected()],
    });

    assert.deepEqual(await readUserConfig(home), {
      agent: {
        planner: {
          provider: 'anthropic-claude',
          model: 'gpt-plan',
        },
        coder: {
          provider: 'anthropic-claude',
          model: null,
        },
        reviewer: {
          provider: 'anthropic-claude',
          model: null,
        },
      },
    });
  });
});

test('neal setup writes role-specific providers and explicit models', async () => {
  await withIsolatedHome(async (home) => {
    const cwd = await mkdtemp(join(tmpdir(), 'neal-setup-role-specific-'));

    await runNealSetupCli({
      cwd,
      stdout: new CaptureStream(),
      args: [
        'setup',
        '--coder-provider',
        'openai-codex',
        '--coder-model',
        'gpt-test',
        '--reviewer-provider',
        'anthropic-claude',
        '--reviewer-model',
        'claude-test',
      ],
      detections: [openAIDetected(), anthropicDetected()],
    });

    assert.deepEqual(await readUserConfig(home), {
      agent: {
        coder: {
          provider: 'openai-codex',
          model: 'gpt-test',
        },
        reviewer: {
          provider: 'anthropic-claude',
          model: 'claude-test',
        },
      },
    });
  });
});

test('neal setup writes explicit planner flags without requiring them for completeness', async () => {
  await withIsolatedHome(async (home) => {
    const cwd = await mkdtemp(join(tmpdir(), 'neal-setup-planner-flags-'));

    await runNealSetupCli({
      cwd,
      stdout: new CaptureStream(),
      args: [
        'setup',
        '--coder-provider',
        'openai-codex',
        '--coder-model',
        'gpt-code',
        '--planner-model',
        'gpt-plan',
        '--reviewer-provider',
        'anthropic-claude',
        '--reviewer-model',
        'claude-test',
      ],
      detections: [openAIDetected(), anthropicDetected()],
    });

    assert.deepEqual(await readUserConfig(home), {
      agent: {
        planner: {
          provider: 'openai-codex',
          model: 'gpt-plan',
        },
        coder: {
          provider: 'openai-codex',
          model: 'gpt-code',
        },
        reviewer: {
          provider: 'anthropic-claude',
          model: 'claude-test',
        },
      },
    });
  });
});

test('neal setup interactive can prompt for an explicit planner override', async () => {
  await withIsolatedHome(async (home) => {
    const cwd = await mkdtemp(join(tmpdir(), 'neal-setup-interactive-planner-'));
    const prompts: string[] = [];
    const answers = ['1', '2', 'gpt-code', '2', '', 'n', '1', '3', 'gpt-plan', ''];

    await runNealSetupCli({
      cwd,
      stdout: new CaptureStream(),
      args: ['setup'],
      detections: [openAIDetected(), anthropicDetected()],
      question: async (prompt) => {
        prompts.push(prompt);
        return answers.shift() ?? '';
      },
    });

    // Assert each positional prompt by its structural default token (the
    // bracketed provider id / model / [Y/n]), not the verbatim English lead-in.
    assert.match(prompts[5] ?? '', /planner\? \[Y\/n\]/);
    assert.match(prompts[6] ?? '', /planner provider \[1\. .*\(openai-codex\)\]/);
    assert.match(prompts[7] ?? '', /\[2\. gpt-code\]/);
    assert.deepEqual(await readUserConfig(home), {
      agent: {
        planner: {
          provider: 'openai-codex',
          model: 'gpt-plan',
        },
        coder: {
          provider: 'openai-codex',
          model: 'gpt-code',
        },
        reviewer: {
          provider: 'anthropic-claude',
          model: null,
        },
      },
    });
    assert.equal(prompts.length, 10);
  });
});

test('neal setup interactive prompts each role without provider defaults when unconfigured', async () => {
  await withIsolatedHome(async (home) => {
    const cwd = await mkdtemp(join(tmpdir(), 'neal-setup-interactive-default-'));
    const prompts: string[] = [];
    const answers = ['2', '', '2', '', '', ''];
    const stdout = new CaptureStream();

    await runNealSetupCli({
      cwd,
      stdout,
      args: ['setup'],
      detections: [openAIDetected(false), anthropicDetected()],
      question: async (prompt) => {
        prompts.push(prompt);
        return answers.shift() ?? '';
      },
    });

    // Assert each positional prompt by role + structural default token; an
    // unconfigured role provider prompt carries no bracketed default.
    assert.match(prompts[0] ?? '', /coder provider: /);
    assert.match(prompts[1] ?? '', /\[1\. provider default\]/);
    assert.match(prompts[2] ?? '', /reviewer provider: /);
    assert.match(prompts[3] ?? '', /\[1\. provider default\]/);
    assert.match(prompts[4] ?? '', /planner\? \[Y\/n\]/);
    assert.match(prompts[5] ?? '', /Notification script \[none\]/);
    assert.deepEqual(await readUserConfig(home), {
      agent: {
        coder: {
          provider: 'anthropic-claude',
          model: null,
        },
        reviewer: {
          provider: 'anthropic-claude',
          model: null,
        },
      },
    });
    assert.equal(prompts.length, 6);
  });
});

test('neal setup uses existing configured providers as role defaults', async () => {
  await withIsolatedHome(async (home) => {
    const cwd = await mkdtemp(join(tmpdir(), 'neal-setup-existing-defaults-'));
    await mkdir(join(home, '.neal'), { recursive: true });
    await writeFile(
      join(home, '.neal', 'config.yml'),
      [
        'neal:',
        '  notify_bin: /usr/local/bin/notify',
        'agent:',
        '  coder:',
        '    provider: openai-codex',
        '    model: gpt-existing',
        '  reviewer:',
        '    provider: anthropic-claude',
        '    model: claude-existing',
        '',
      ].join('\n'),
      'utf8',
    );
    clearConfigCache(cwd);
    const prompts: string[] = [];

    await runNealSetupCli({
      cwd,
      stdout: new CaptureStream(),
      args: ['setup', '--force'],
      detections: [openAIDetected(), anthropicDetected()],
      question: async (prompt) => {
        prompts.push(prompt);
        return '';
      },
    });

    // Assert each positional prompt by role + the bracketed default (provider
    // id / existing model / notify path), not the verbatim English lead-in.
    assert.match(prompts[0] ?? '', /coder provider \[1\. .*\(openai-codex\)\]/);
    assert.match(prompts[1] ?? '', /\[2\. gpt-existing\]/);
    assert.match(prompts[2] ?? '', /reviewer provider \[2\. .*\(anthropic-claude\)\]/);
    assert.match(prompts[3] ?? '', /\[2\. claude-existing\]/);
    assert.match(prompts[4] ?? '', /planner\? \[Y\/n\]/);
    assert.match(prompts[5] ?? '', /Notification script \[\/usr\/local\/bin\/notify\]/);
    assert.deepEqual(await readUserConfig(home), {
      neal: {
        notify_bin: '/usr/local/bin/notify',
      },
      agent: {
        coder: {
          provider: 'openai-codex',
          model: 'gpt-existing',
        },
        reviewer: {
          provider: 'anthropic-claude',
          model: 'claude-existing',
        },
      },
    });
    assert.equal(prompts.length, 6);
  });
});

test('neal setup defaults planner model prompt to existing model when provider still matches', async () => {
  await withIsolatedHome(async (home) => {
    const cwd = await mkdtemp(join(tmpdir(), 'neal-setup-existing-planner-model-'));
    await mkdir(join(home, '.neal'), { recursive: true });
    await writeFile(
      join(home, '.neal', 'config.yml'),
      [
        'agent:',
        '  planner:',
        '    provider: openai-codex',
        '    model: gpt-plan-existing',
        '  coder:',
        '    provider: openai-codex',
        '    model: gpt-code-existing',
        '  reviewer:',
        '    provider: anthropic-claude',
        '    model: claude-existing',
        '',
      ].join('\n'),
      'utf8',
    );
    clearConfigCache(cwd);
    const prompts: string[] = [];
    const answers = ['', '', '', '', 'n', '', '', ''];

    await runNealSetupCli({
      cwd,
      stdout: new CaptureStream(),
      args: ['setup', '--force'],
      detections: [openAIDetected(), anthropicDetected()],
      question: async (prompt) => {
        prompts.push(prompt);
        return answers.shift() ?? '';
      },
    });

    assert.match(prompts[1] ?? '', /Select model \[2\. gpt-code-existing\]/);
    assert.match(prompts[3] ?? '', /Select model \[2\. claude-existing\]/);
    assert.match(prompts[6] ?? '', /Select model \[2\. gpt-plan-existing\]/);
    assert.deepEqual(await readUserConfig(home), {
      agent: {
        planner: {
          provider: 'openai-codex',
          model: 'gpt-plan-existing',
        },
        coder: {
          provider: 'openai-codex',
          model: 'gpt-code-existing',
        },
        reviewer: {
          provider: 'anthropic-claude',
          model: 'claude-existing',
        },
      },
    });
    assert.equal(prompts.length, 8);
  });
});

test('neal setup provider choices use runtime wording', async () => {
  await withIsolatedHome(async (home) => {
    const cwd = await mkdtemp(join(tmpdir(), 'neal-setup-provider-choices-'));
    const stdout = new CaptureStream();
    const prompts: string[] = [];
    const answers = ['2', '1', '2', '1', '', ''];

    await runNealSetupCli({
      cwd,
      stdout,
      args: ['setup'],
      detections: [openAIDetected(false), anthropicDetected()],
      question: async (prompt) => {
        prompts.push(prompt);
        return answers.shift() ?? '';
      },
    });

    assert.deepEqual(await readUserConfig(home), {
      agent: {
        coder: {
          provider: 'anthropic-claude',
          model: null,
        },
        reviewer: {
          provider: 'anthropic-claude',
          model: null,
        },
      },
    });
    assert.equal(prompts.length, 6);
  });
});

test('neal setup can clear an existing notification script', async () => {
  await withIsolatedHome(async (home) => {
    const cwd = await mkdtemp(join(tmpdir(), 'neal-setup-notify-clear-'));
    await mkdir(join(home, '.neal'), { recursive: true });
    await writeFile(
      join(home, '.neal', 'config.yml'),
      [
        'neal:',
        '  notify_bin: /usr/local/bin/notify',
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
    const answers = ['', '', '', '', '', 'none'];

    await runNealSetupCli({
      cwd,
      stdout: new CaptureStream(),
      args: ['setup', '--force'],
      detections: [openAIDetected(), anthropicDetected()],
      question: async () => answers.shift() ?? '',
    });

    assert.deepEqual(await readUserConfig(home), {
      neal: {
        notify_bin: null,
      },
      agent: {
        coder: {
          provider: 'openai-codex',
          model: null,
        },
        reviewer: {
          provider: 'anthropic-claude',
          model: null,
        },
      },
    });
  });
});

test('neal setup preserves unrelated user config keys while replacing writer roles', async () => {
  await withIsolatedHome(async (home) => {
    const cwd = await mkdtemp(join(tmpdir(), 'neal-setup-preserve-config-'));
    await mkdir(join(home, '.neal'), { recursive: true });
    await writeFile(
      join(home, '.neal', 'config.yml'),
      [
        'neal:',
        '  notify_bin: /usr/local/bin/notify',
        'custom:',
        '  keep: true',
        'agent:',
        '  other: keep-me',
        '  coder:',
        '    provider: openai-codex',
        '    model: old-coder',
        '  reviewer:',
        '    provider: openai-codex',
        '    model: old-reviewer',
        '',
      ].join('\n'),
      'utf8',
    );
    clearConfigCache(cwd);

    await runNealSetupCli({
      cwd,
      stdout: new CaptureStream(),
      args: ['setup', '--force', '--provider', 'anthropic-claude', '--all-roles'],
      detections: [anthropicDetected()],
    });

    assert.deepEqual(await readUserConfig(home), {
      neal: {
        notify_bin: '/usr/local/bin/notify',
      },
      custom: {
        keep: true,
      },
      agent: {
        other: 'keep-me',
        planner: {
          provider: 'anthropic-claude',
          model: null,
        },
        coder: {
          provider: 'anthropic-claude',
          model: null,
        },
        reviewer: {
          provider: 'anthropic-claude',
          model: null,
        },
      },
    });
  });
});

test('neal setup refuses to overwrite existing effective provider config without confirmation or force', async () => {
  await withIsolatedHome(async (home) => {
    const cwd = await mkdtemp(join(tmpdir(), 'neal-setup-overwrite-refusal-'));
    await mkdir(join(home, '.neal'), { recursive: true });
    await writeFile(
      join(home, '.neal', 'config.yml'),
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
    await assert.rejects(
      () => runNealSetupCli({
        cwd,
        stdout: new CaptureStream(),
        args: ['setup', '--provider', 'anthropic-claude', '--all-roles'],
        detections: [anthropicDetected()],
      }),
      /will not overwrite existing provider config non-interactively/,
    );
    assert.deepEqual(await readUserConfig(home), {
      agent: {
        coder: {
          provider: 'openai-codex',
        },
        reviewer: {
          provider: 'anthropic-claude',
        },
      },
    });
  });
});

test('neal setup clears config cache after writing user config', async () => {
  await withIsolatedHome(async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'neal-setup-cache-clear-'));
    assert.equal(getRawMergedConfig(cwd).agent, undefined);

    await runNealSetupCli({
      cwd,
      stdout: new CaptureStream(),
      args: ['setup', '--provider', 'anthropic-claude', '--all-roles'],
      detections: [anthropicDetected()],
    });

    assert.equal(getRawMergedConfig(cwd).agent?.coder?.provider, 'anthropic-claude');
    assert.equal(getRawMergedConfig(cwd).agent?.reviewer?.provider, 'anthropic-claude');
  });
});

test('neal setup does not prompt when .neal/ is already ignored by tracked .gitignore', async () => {
  await withIsolatedHome(async () => {
    const cwd = await initGitRepo('neal-setup-gitignore-ignored-');
    const gitignorePath = join(cwd, '.gitignore');
    const gitignoreContent = ['# tracked ignore rules', '.neal/', ''].join('\n');
    await writeFile(gitignorePath, gitignoreContent, 'utf8');
    await runGit(cwd, 'add', '.gitignore');
    const prompts: string[] = [];

    await runNealSetupCli({
      cwd,
      stdout: new CaptureStream(),
      args: ['setup', '--provider', 'anthropic-claude', '--all-roles'],
      detections: [anthropicDetected()],
      question: async (prompt) => {
        prompts.push(prompt);
        return '';
      },
    });

    assert.equal(prompts.length, 0);
    assert.equal(await readFile(gitignorePath, 'utf8'), gitignoreContent);
    assert.equal(countNealIgnoreLines(await readFile(join(cwd, '.git', 'info', 'exclude'), 'utf8')), 0);
  });
});

test('neal setup does not prompt when .neal/ is already ignored by .git/info/exclude', async () => {
  await withIsolatedHome(async () => {
    const cwd = await initGitRepo('neal-setup-exclude-ignored-');
    const excludePath = join(cwd, '.git', 'info', 'exclude');
    await writeFile(excludePath, ['# existing local excludes', '.neal/', ''].join('\n'), 'utf8');
    const prompts: string[] = [];

    await runNealSetupCli({
      cwd,
      stdout: new CaptureStream(),
      args: ['setup', '--provider', 'anthropic-claude', '--all-roles'],
      detections: [anthropicDetected()],
      question: async (prompt) => {
        prompts.push(prompt);
        return '';
      },
    });

    assert.equal(prompts.length, 0);
    assert.equal(countNealIgnoreLines(await readFile(excludePath, 'utf8')), 1);
  });
});

test('neal setup adds .neal/ to .git/info/exclude on interactive default acceptance without mutating .gitignore', async () => {
  await withIsolatedHome(async () => {
    const cwd = await initGitRepo('neal-setup-exclude-accept-');
    const gitignorePath = join(cwd, '.gitignore');
    const gitignoreContent = ['node_modules/', ''].join('\n');
    await writeFile(gitignorePath, gitignoreContent, 'utf8');
    await runGit(cwd, 'add', '.gitignore');
    const prompts: string[] = [];

    await runNealSetupCli({
      cwd,
      stdout: new CaptureStream(),
      args: ['setup', '--provider', 'anthropic-claude', '--all-roles'],
      detections: [anthropicDetected()],
      question: async (prompt) => {
        prompts.push(prompt);
        return '';
      },
    });

    // One prompt, for the .git/info/exclude [Y/n] decision; assert the
    // structural target + control tokens, not the verbatim sentence.
    assert.equal(prompts.length, 1);
    assert.match(prompts[0] ?? '', /\.git\/info\/exclude\? \[Y\/n\]/);
    assert.equal(countNealIgnoreLines(await readFile(join(cwd, '.git', 'info', 'exclude'), 'utf8')), 1);
    assert.equal(await readFile(gitignorePath, 'utf8'), gitignoreContent);
  });
});

test('neal setup honors explicit decline for adding .neal/ to .git/info/exclude', async () => {
  await withIsolatedHome(async () => {
    const cwd = await initGitRepo('neal-setup-exclude-decline-');
    const stdout = new CaptureStream();
    const prompts: string[] = [];

    await runNealSetupCli({
      cwd,
      stdout,
      args: ['setup', '--provider', 'anthropic-claude', '--all-roles'],
      detections: [anthropicDetected()],
      question: async (prompt) => {
        prompts.push(prompt);
        return 'n';
      },
    });

    assert.equal(prompts.length, 1);
    assert.match(prompts[0] ?? '', /\.git\/info\/exclude\? \[Y\/n\]/);
    assert.equal(countNealIgnoreLines(await readFile(join(cwd, '.git', 'info', 'exclude'), 'utf8')), 0);
    assert.match(stdout.text(), /Skipped Git ignore update for \.neal\/\./);
  });
});

test('neal setup does not duplicate .neal/ in .git/info/exclude across repeated runs', async () => {
  await withIsolatedHome(async () => {
    const cwd = await initGitRepo('neal-setup-exclude-no-duplicate-');
    const firstPrompts: string[] = [];

    await runNealSetupCli({
      cwd,
      stdout: new CaptureStream(),
      args: ['setup', '--provider', 'anthropic-claude', '--all-roles'],
      detections: [anthropicDetected()],
      question: async (prompt) => {
        firstPrompts.push(prompt);
        return '';
      },
    });

    const secondPrompts: string[] = [];
    await runNealSetupCli({
      cwd,
      stdout: new CaptureStream(),
      args: ['setup', '--force', '--provider', 'anthropic-claude', '--all-roles'],
      detections: [anthropicDetected()],
      question: async (prompt) => {
        secondPrompts.push(prompt);
        return '';
      },
    });

    assert.equal(firstPrompts.length, 1);
    assert.match(firstPrompts[0] ?? '', /\.git\/info\/exclude\? \[Y\/n\]/);
    assert.equal(secondPrompts.length, 0);
    assert.equal(countNealIgnoreLines(await readFile(join(cwd, '.git', 'info', 'exclude'), 'utf8')), 1);
  });
});

test('neal setup non-interactively warns without mutating Git ignore files', async () => {
  await withIsolatedHome(async () => {
    const cwd = await initGitRepo('neal-setup-exclude-noninteractive-');
    const gitignorePath = join(cwd, '.gitignore');
    const gitignoreContent = ['dist/', ''].join('\n');
    await writeFile(gitignorePath, gitignoreContent, 'utf8');
    const stdout = new CaptureStream();

    await runNealSetupCli({
      cwd,
      stdout,
      args: ['setup', '--provider', 'anthropic-claude', '--all-roles'],
      detections: [anthropicDetected()],
    });

    assert.match(stdout.text(), /Add `\.neal\/` to `\.git\/info\/exclude` or your repository `\.gitignore`/);
    assert.equal(countNealIgnoreLines(await readFile(join(cwd, '.git', 'info', 'exclude'), 'utf8')), 0);
    assert.equal(await readFile(gitignorePath, 'utf8'), gitignoreContent);
  });
});

test('neal setup writes linked worktree excludes to git rev-parse --git-path info/exclude', async (t) => {
  await withIsolatedHome(async () => {
    const root = await mkdtemp(join(tmpdir(), 'neal-setup-linked-worktree-'));
    const main = join(root, 'main');
    const linked = join(root, 'linked');
    await mkdir(main, { recursive: true });
    await runGit(main, 'init');
    await runGit(main, 'config', 'user.email', 'neal@example.test');
    await runGit(main, 'config', 'user.name', 'Neal Test');
    await writeFile(join(main, 'README.md'), 'linked worktree fixture\n', 'utf8');
    await runGit(main, 'add', 'README.md');
    await runGit(main, 'commit', '-m', 'initial commit');

    try {
      await runGit(main, 'worktree', 'add', '-b', 'linked-test', linked);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      t.skip(`git worktree add failed: ${message}`);
      return;
    }

    const gitPath = resolveGitPath(linked, await runGit(linked, 'rev-parse', '--git-path', 'info/exclude'));
    await runNealSetupCli({
      cwd: linked,
      stdout: new CaptureStream(),
      args: ['setup', '--provider', 'anthropic-claude', '--all-roles'],
      detections: [anthropicDetected()],
      question: async () => '',
    });

    assert.equal(countNealIgnoreLines(await readFile(gitPath, 'utf8')), 1);
  });
});

test('neal setup preserves configured effort when rewriting coder and reviewer roles', async () => {
  await withIsolatedHome(async (home) => {
    const cwd = await mkdtemp(join(tmpdir(), 'neal-setup-preserve-effort-'));
    await mkdir(join(home, '.neal'), { recursive: true });
    await writeFile(
      join(home, '.neal', 'config.yml'),
      [
        'agent:',
        '  coder:',
        '    provider: openai-codex',
        '    model: old-coder',
        '    effort: high',
        '  reviewer:',
        '    provider: openai-codex',
        '    model: old-reviewer',
        '    effort: low',
        '',
      ].join('\n'),
      'utf8',
    );
    clearConfigCache(cwd);

    await runNealSetupCli({
      cwd,
      stdout: new CaptureStream(),
      args: ['setup', '--force', '--provider', 'anthropic-claude', '--all-roles'],
      detections: [anthropicDetected()],
    });

    assert.deepEqual(await readUserConfig(home), {
      agent: {
        planner: {
          provider: 'anthropic-claude',
          model: null,
        },
        coder: {
          provider: 'anthropic-claude',
          model: null,
          effort: 'high',
        },
        reviewer: {
          provider: 'anthropic-claude',
          model: null,
          effort: 'low',
        },
      },
    });
  });
});

test('neal setup preserves explicit planner effort when rewriting the planner role', async () => {
  await withIsolatedHome(async (home) => {
    const cwd = await mkdtemp(join(tmpdir(), 'neal-setup-preserve-planner-effort-'));
    await mkdir(join(home, '.neal'), { recursive: true });
    await writeFile(
      join(home, '.neal', 'config.yml'),
      [
        'agent:',
        '  planner:',
        '    provider: openai-codex',
        '    effort: xhigh',
        '  coder:',
        '    provider: openai-codex',
        '  reviewer:',
        '    provider: openai-codex',
        '',
      ].join('\n'),
      'utf8',
    );
    clearConfigCache(cwd);

    await runNealSetupCli({
      cwd,
      stdout: new CaptureStream(),
      args: ['setup', '--force', '--provider', 'anthropic-claude', '--all-roles'],
      detections: [anthropicDetected()],
    });

    assert.deepEqual(await readUserConfig(home), {
      agent: {
        planner: {
          provider: 'anthropic-claude',
          model: null,
          effort: 'xhigh',
        },
        coder: {
          provider: 'anthropic-claude',
          model: null,
        },
        reviewer: {
          provider: 'anthropic-claude',
          model: null,
        },
      },
    });
  });
});

test('neal setup keeps a planner-only effort override when planner is not explicit', async () => {
  await withIsolatedHome(async (home) => {
    const cwd = await mkdtemp(join(tmpdir(), 'neal-setup-planner-effort-only-'));
    await mkdir(join(home, '.neal'), { recursive: true });
    await writeFile(
      join(home, '.neal', 'config.yml'),
      [
        'agent:',
        '  planner:',
        '    effort: xhigh',
        '  coder:',
        '    provider: openai-codex',
        '  reviewer:',
        '    provider: openai-codex',
        '',
      ].join('\n'),
      'utf8',
    );
    clearConfigCache(cwd);

    await runNealSetupCli({
      cwd,
      stdout: new CaptureStream(),
      args: [
        'setup',
        '--force',
        '--coder-provider',
        'anthropic-claude',
        '--reviewer-provider',
        'anthropic-claude',
      ],
      detections: [anthropicDetected()],
    });

    assert.deepEqual(await readUserConfig(home), {
      agent: {
        planner: {
          effort: 'xhigh',
        },
        coder: {
          provider: 'anthropic-claude',
          model: null,
        },
        reviewer: {
          provider: 'anthropic-claude',
          model: null,
        },
      },
    });

    clearConfigCache(cwd);
    const resolved = getRawMergedConfig(cwd);
    assert.equal(resolved.agent?.planner?.effort, 'xhigh');
    assert.equal(resolved.agent?.coder?.provider, 'anthropic-claude');
  });
});

test('neal setup deletes the planner mapping when no planner effort is configured', async () => {
  await withIsolatedHome(async (home) => {
    const cwd = await mkdtemp(join(tmpdir(), 'neal-setup-planner-delete-'));
    await mkdir(join(home, '.neal'), { recursive: true });
    await writeFile(
      join(home, '.neal', 'config.yml'),
      [
        'agent:',
        '  planner:',
        '    provider: openai-codex',
        '  coder:',
        '    provider: openai-codex',
        '  reviewer:',
        '    provider: openai-codex',
        '',
      ].join('\n'),
      'utf8',
    );
    clearConfigCache(cwd);

    await runNealSetupCli({
      cwd,
      stdout: new CaptureStream(),
      args: [
        'setup',
        '--force',
        '--coder-provider',
        'anthropic-claude',
        '--reviewer-provider',
        'anthropic-claude',
      ],
      detections: [anthropicDetected()],
    });

    assert.deepEqual(await readUserConfig(home), {
      agent: {
        coder: {
          provider: 'anthropic-claude',
          model: null,
        },
        reviewer: {
          provider: 'anthropic-claude',
          model: null,
        },
      },
    });
  });
});

test('neal setup rejects rather than writing a preserved effort the new provider does not support', async () => {
  await withIsolatedHome(async (home) => {
    const cwd = await mkdtemp(join(tmpdir(), 'neal-setup-effort-provider-mismatch-'));
    await mkdir(join(home, '.neal'), { recursive: true });
    const original = [
      'agent:',
      '  coder:',
      '    provider: openai-codex',
      '    effort: minimal',
      '  reviewer:',
      '    provider: openai-codex',
      '',
    ].join('\n');
    await writeFile(join(home, '.neal', 'config.yml'), original, 'utf8');
    clearConfigCache(cwd);

    await assert.rejects(
      () => runNealSetupCli({
        cwd,
        stdout: new CaptureStream(),
        args: ['setup', '--force', '--provider', 'anthropic-claude', '--all-roles'],
        detections: [anthropicDetected()],
      }),
      // Assert the structured rejection: the offending role + effort enum and
      // the supported-effort enum list, not the verbatim error sentence.
      /coder role.*anthropic-claude.*effort "minimal".*low, medium, high, xhigh, max/,
    );

    // Nothing should have been written: the on-disk config is unchanged.
    assert.equal(await readFile(join(home, '.neal', 'config.yml'), 'utf8'), original);
  });
});

test('neal setup offers openai-compatible for coder, reviewer, and planner', async () => {
  await withScrubbedOpenAICompatibleEnv(() => withIsolatedHome(async (home) => {
    const cwd = await mkdtemp(join(tmpdir(), 'neal-setup-compat-roles-'));
    const stdout = new CaptureStream();
    const prompts: string[] = [];
    // coder provider, coder model, reviewer provider, reviewer model,
    // use-coder-for-planner? -> no, planner provider, planner model, notify
    const answers = ['1', '', '3', 'compat-model', 'n', '1', '', ''];

    await runNealSetupCli({
      cwd,
      stdout,
      args: ['setup'],
      detections: [openAIDetected(), anthropicDetected(), openAICompatibleDetected()],
      question: async (prompt) => {
        prompts.push(prompt);
        return answers.shift() ?? '';
      },
    });

    const output = stdout.text();
    const coderSection = output.slice(output.indexOf('Coder provider:'), output.indexOf('Reviewer provider:'));
    assert.match(coderSection, /3\. OpenAI-compatible \(openai-compatible\)/);
    const reviewerSection = output.slice(output.indexOf('Reviewer provider:'), output.indexOf('Planner provider:'));
    assert.match(reviewerSection, /3\. OpenAI-compatible \(openai-compatible\)/);
    const plannerSection = output.slice(output.indexOf('Planner provider:'), output.indexOf('Wrote '));
    assert.match(plannerSection, /3\. OpenAI-compatible \(openai-compatible\)/);

    assert.deepEqual(await readUserConfig(home), {
      agent: {
        planner: {
          provider: 'openai-codex',
          model: null,
        },
        coder: {
          provider: 'openai-codex',
          model: null,
        },
        reviewer: {
          provider: 'openai-compatible',
          model: 'compat-model',
        },
      },
    });
    assert.equal(prompts.length, 8);
  }));
});

test('neal setup --provider openai-compatible --all-roles writes an all-roles config', async () => {
  await withScrubbedOpenAICompatibleEnv(() => withIsolatedHome(async (home) => {
    const cwd = await mkdtemp(join(tmpdir(), 'neal-setup-compat-all-roles-'));

    await runNealSetupCli({
      cwd,
      stdout: new CaptureStream(),
      args: ['setup', '--provider', 'openai-compatible', '--all-roles'],
      detections: [openAICompatibleDetected()],
    });

    assert.deepEqual(await readUserConfig(home), {
      agent: {
        planner: {
          provider: 'openai-compatible',
          model: null,
        },
        coder: {
          provider: 'openai-compatible',
          model: null,
        },
        reviewer: {
          provider: 'openai-compatible',
          model: null,
        },
      },
    });
  }));
});

test('neal setup writes a codex coder with an openai-compatible reviewer non-interactively and prints guidance', async () => {
  await withScrubbedOpenAICompatibleEnv(() => withIsolatedHome(async (home) => {
    const cwd = await mkdtemp(join(tmpdir(), 'neal-setup-compat-split-'));
    const stdout = new CaptureStream();

    await runNealSetupCli({
      cwd,
      stdout,
      args: [
        'setup',
        '--coder-provider',
        'openai-codex',
        '--reviewer-provider',
        'openai-compatible',
        '--reviewer-model',
        'deepseek-chat',
      ],
      detections: [openAIDetected(), openAICompatibleDetected()],
    });

    assert.deepEqual(await readUserConfig(home), {
      agent: {
        coder: {
          provider: 'openai-codex',
          model: null,
        },
        reviewer: {
          provider: 'openai-compatible',
          model: 'deepseek-chat',
        },
      },
    });
    assert.match(
      stdout.text(),
      /Set providers\.openai_compatible\.base_url \(or OPENAI_COMPATIBLE_BASE_URL\) and OPENAI_COMPATIBLE_API_KEY before running Neal\./,
    );
  }));
});

test('neal setup omits the openai-compatible guidance line when settings are resolved', async () => {
  await withScrubbedOpenAICompatibleEnv(() => withIsolatedHome(async (home) => {
    const cwd = await mkdtemp(join(tmpdir(), 'neal-setup-compat-resolved-'));
    await mkdir(join(home, '.neal'), { recursive: true });
    await writeFile(
      join(home, '.neal', 'config.yml'),
      [
        'providers:',
        '  openai_compatible:',
        '    base_url: https://api.example.test/v1',
        '    api_key_env: NEAL_SETUP_TEST_COMPAT_KEY',
        '    default_model: example-model',
        '',
      ].join('\n'),
      'utf8',
    );
    clearConfigCache(cwd);
    process.env.NEAL_SETUP_TEST_COMPAT_KEY = 'secret';
    try {
      const stdout = new CaptureStream();

      await runNealSetupCli({
        cwd,
        stdout,
        args: [
          'setup',
          '--coder-provider',
          'openai-codex',
          '--reviewer-provider',
          'openai-compatible',
          '--reviewer-model',
          'example-model',
        ],
        detections: [openAIDetected(), openAICompatibleDetected(true)],
      });

      assert.equal(
        (await readUserConfig(home)).agent !== undefined,
        true,
      );
      assert.doesNotMatch(stdout.text(), /before running Neal/);
    } finally {
      delete process.env.NEAL_SETUP_TEST_COMPAT_KEY;
    }
  }));
});

test('neal setup warns when an openai-compatible reviewer has no resolvable model', async () => {
  await withScrubbedOpenAICompatibleEnv(() => withIsolatedHome(async (home) => {
    const cwd = await mkdtemp(join(tmpdir(), 'neal-setup-compat-no-model-'));
    await mkdir(join(home, '.neal'), { recursive: true });
    // Base URL and API key resolve, but no role model, no default_model, and no
    // OPENAI_COMPATIBLE_MODEL: the adapter would fail before making any request.
    await writeFile(
      join(home, '.neal', 'config.yml'),
      [
        'providers:',
        '  openai_compatible:',
        '    base_url: https://api.example.test/v1',
        '    api_key_env: NEAL_SETUP_TEST_COMPAT_KEY',
        '',
      ].join('\n'),
      'utf8',
    );
    clearConfigCache(cwd);
    process.env.NEAL_SETUP_TEST_COMPAT_KEY = 'secret';
    try {
      const stdout = new CaptureStream();

      await runNealSetupCli({
        cwd,
        stdout,
        args: [
          'setup',
          '--coder-provider',
          'openai-codex',
          '--reviewer-provider',
          'openai-compatible',
        ],
        detections: [openAIDetected(), openAICompatibleDetected()],
      });

      assert.equal((await readUserConfig(home)).agent !== undefined, true);
      const output = stdout.text();
      assert.match(
        output,
        /No model is resolvable for the openai-compatible reviewer role: set providers\.openai_compatible\.default_model \(or OPENAI_COMPATIBLE_MODEL\) or agent\.reviewer\.model before running Neal\./,
      );
      // Base URL and API key are resolved, so that guidance line must not appear.
      assert.doesNotMatch(output, /Set providers\.openai_compatible\.base_url/);
    } finally {
      delete process.env.NEAL_SETUP_TEST_COMPAT_KEY;
    }
  }));
});

test('neal setup prints both openai-compatible guidance lines when nothing is resolvable', async () => {
  await withScrubbedOpenAICompatibleEnv(() => withIsolatedHome(async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'neal-setup-compat-nothing-'));
    const stdout = new CaptureStream();

    await runNealSetupCli({
      cwd,
      stdout,
      args: [
        'setup',
        '--coder-provider',
        'openai-codex',
        '--reviewer-provider',
        'openai-compatible',
      ],
      detections: [openAIDetected(), openAICompatibleDetected()],
    });

    const output = stdout.text();
    assert.match(
      output,
      /Set providers\.openai_compatible\.base_url \(or OPENAI_COMPATIBLE_BASE_URL\) and OPENAI_COMPATIBLE_API_KEY before running Neal\./,
    );
    assert.match(
      output,
      /No model is resolvable for the openai-compatible reviewer role: set providers\.openai_compatible\.default_model \(or OPENAI_COMPATIBLE_MODEL\) or agent\.reviewer\.model before running Neal\./,
    );
  }));
});

test('neal setup omits the model guidance line when the reviewer role model is explicit', async () => {
  await withScrubbedOpenAICompatibleEnv(() => withIsolatedHome(async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'neal-setup-compat-role-model-'));
    const stdout = new CaptureStream();

    await runNealSetupCli({
      cwd,
      stdout,
      args: [
        'setup',
        '--coder-provider',
        'openai-codex',
        '--reviewer-provider',
        'openai-compatible',
        '--reviewer-model',
        'deepseek-chat',
      ],
      detections: [openAIDetected(), openAICompatibleDetected()],
    });

    assert.doesNotMatch(stdout.text(), /No model is resolvable/);
  }));
});

test('neal setup guidance line stays silent for read-capable provider selections', async () => {
  await withScrubbedOpenAICompatibleEnv(() => withIsolatedHome(async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'neal-setup-compat-uninvolved-'));
    const stdout = new CaptureStream();

    await runNealSetupCli({
      cwd,
      stdout,
      args: ['setup', '--provider', 'anthropic-claude', '--all-roles'],
      detections: [anthropicDetected()],
    });

    assert.doesNotMatch(stdout.text(), /before running Neal/);
  }));
});
