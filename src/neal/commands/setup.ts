import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import process from 'node:process';
import { createInterface } from 'node:readline/promises';
import type { Readable, Writable } from 'node:stream';
import YAML, { isMap } from 'yaml';

import { writeTextAtomic } from '../atomic-write.js';
import { parseSetupArgs, type ParsedSetupArgs } from '../cli.js';
import {
  clearConfigCache,
  getConfigSourceInfo,
  getOpenAICompatibleSettings,
  getRawMergedConfig,
  type NealConfigFile,
} from '../config.js';
import { getNealDirGitIgnoreStatus } from '../git.js';
import { assertAgentConfigSupportsWriterRun, getProviderDefinition } from '../providers/registry.js';
import { detectBuiltInProviders, type ProviderDetection } from '../providers/detection.js';
import type { AgentConfig, AgentProvider, AgentRoleConfig } from '../types.js';

type InputStream = Readable & { isTTY?: boolean };
type OutputStream = Writable & { isTTY?: boolean };
type QuestionFn = (prompt: string) => Promise<string>;

export type NealSetupCliOptions = {
  args?: string[];
  cwd?: string;
  stdin?: InputStream;
  stdout?: OutputStream;
  detections?: ProviderDetection[];
  detectProviders?: () => ProviderDetection[] | Promise<ProviderDetection[]>;
  question?: QuestionFn;
  confirmOverwrite?: () => boolean | Promise<boolean>;
  interactive?: boolean;
  configPath?: string;
};

type SetupSelection = {
  agentConfig: AgentConfig;
  notifyBin?: string | null;
  plannerExplicit: boolean;
  prompted: boolean;
};

type SetupRole = 'planner' | 'coder' | 'reviewer';

function writeLine(stdout: Writable, message: string) {
  stdout.write(`${message}\n`);
}

function supportsProviderRole(provider: AgentProvider, role: SetupRole) {
  const definition = getProviderDefinition(provider);
  const capabilities = role === 'coder' || role === 'planner'
    ? definition.capabilities.coder
    : definition.capabilities['structured-advisor'];
  return capabilities.supported;
}

function getConfiguredProviderDefault(args: {
  parsedProvider: AgentProvider | null;
  existingProvider: unknown;
  detections: ProviderDetection[];
  role: SetupRole;
}) {
  if (args.parsedProvider !== null) {
    return args.parsedProvider;
  }

  if (typeof args.existingProvider === 'string') {
    const matching = args.detections.find((detection) => detection.provider === args.existingProvider);
    if (matching && supportsProviderRole(matching.provider, args.role)) {
      return matching.provider;
    }
  }

  return null;
}

function formatProviderChoice(detection: ProviderDetection) {
  const runtimeNote = detection.runtimeAvailable ? '' : ' - runtime not found';
  return `${detection.displayName} (${detection.provider})${runtimeNote}`;
}

function getExistingProviderValues(config: NealConfigFile) {
  const planner = config.agent?.planner?.provider;
  const coder = config.agent?.coder?.provider;
  const reviewer = config.agent?.reviewer?.provider;
  const plannerModel = config.agent?.planner?.model;
  const coderModel = config.agent?.coder?.model;
  const reviewerModel = config.agent?.reviewer?.model;
  const notifyBin = config.neal?.notify_bin;
  return {
    planner,
    coder,
    reviewer,
    plannerModel,
    coderModel,
    reviewerModel,
    notifyBin,
    hasAny:
      (planner !== undefined && planner !== null && (typeof planner !== 'string' || planner.trim() !== '')) ||
      (coder !== undefined && coder !== null && (typeof coder !== 'string' || coder.trim() !== '')) ||
      (reviewer !== undefined && reviewer !== null && (typeof reviewer !== 'string' || reviewer.trim() !== '')),
  };
}

function isCompleteFlagSelection(parsed: ParsedSetupArgs) {
  return (
    (parsed.provider !== null && parsed.allRoles) ||
    (parsed.coderProvider !== null && parsed.reviewerProvider !== null)
  );
}

function assertNonInteractiveSelectionIsComplete(parsed: ParsedSetupArgs) {
  if (isCompleteFlagSelection(parsed)) {
    return;
  }

  throw new Error(
    'neal setup requires --provider <provider-id> --all-roles or both --coder-provider and --reviewer-provider when run non-interactively',
  );
}

async function askYesNo(question: QuestionFn, prompt: string, defaultYes: boolean) {
  const answer = (await question(prompt)).trim();
  if (!answer) {
    return defaultYes;
  }
  return defaultYes ? !/^n(?:o)?$/i.test(answer) : /^y(?:es)?$/i.test(answer);
}

function parseChoice(answer: string, max: number) {
  if (!/^[1-9]\d*$/.test(answer)) {
    return null;
  }
  const choice = Number(answer);
  if (!Number.isSafeInteger(choice) || choice < 1 || choice > max) {
    return null;
  }
  return choice - 1;
}

async function promptForProvider(args: {
  role: SetupRole;
  detections: ProviderDetection[];
  defaultProvider: AgentProvider | null;
  stdout: Writable;
  question: QuestionFn;
}) {
  const detections = args.detections.filter((detection) => supportsProviderRole(detection.provider, args.role));
  if (detections.length === 0) {
    throw new Error(`neal setup found no registered providers supporting the ${args.role} role`);
  }

  writeLine(args.stdout, `${formatRoleLabel(args.role)} provider:`);
  detections.forEach((detection, index) => {
    writeLine(args.stdout, `  ${index + 1}. ${formatProviderChoice(detection)}`);
  });

  const defaultIndex = detections.findIndex((detection) => detection.provider === args.defaultProvider);

  while (true) {
    const prompt = defaultIndex >= 0
      ? `Select ${args.role} provider [${defaultIndex + 1}. ${formatProviderChoice(detections[defaultIndex])}]: `
      : `Select ${args.role} provider: `;
    const answer = (await args.question(prompt)).trim();
    if (!answer) {
      if (defaultIndex < 0) {
        writeLine(args.stdout, `Choose a number from 1-${detections.length} or a provider id.`);
        continue;
      }
      return detections[defaultIndex].provider;
    }

    const choice = parseChoice(answer, detections.length);
    if (choice !== null) {
      return detections[choice].provider;
    }

    const matching = detections.find((detection) => detection.provider === answer);
    if (matching) {
      return matching.provider;
    }

    writeLine(args.stdout, `Choose a number from 1-${detections.length} or a provider id.`);
  }
}

async function promptForModel(args: {
  role: SetupRole;
  provider: AgentProvider;
  detections: ProviderDetection[];
  defaultModel: string | null;
  stdout: Writable;
  question: QuestionFn;
}) {
  const modelChoices: Array<{ label: string; model: string | null }> = [
    { label: 'provider default', model: null },
  ];
  if (args.defaultModel !== null) {
    modelChoices.push({ label: args.defaultModel, model: args.defaultModel });
  }
  const defaultIndex = args.defaultModel !== null ? 1 : 0;
  const customChoice = modelChoices.length + 1;

  writeLine(args.stdout, `${formatRoleLabel(args.role)} model for ${args.provider}:`);
  modelChoices.forEach((choice, index) => {
    writeLine(args.stdout, `  ${index + 1}. ${choice.label}`);
  });
  writeLine(args.stdout, `  ${customChoice}. specify model`);

  while (true) {
    const answer = (await args.question(`Select model [${defaultIndex + 1}. ${modelChoices[defaultIndex].label}]: `)).trim();
    if (!answer) {
      return modelChoices[defaultIndex].model;
    }

    const choice = parseChoice(answer, customChoice);
    if (choice !== null) {
      if (choice === customChoice - 1) {
        const custom = (await args.question('Model ID: ')).trim();
        if (custom) {
          return custom;
        }
        writeLine(args.stdout, 'Model ID must be non-empty.');
        continue;
      }

      return modelChoices[choice].model;
    }

    return answer;
  }
}

function formatRoleLabel(role: SetupRole) {
  switch (role) {
    case 'planner':
      return 'Planner';
    case 'coder':
      return 'Coder';
    case 'reviewer':
      return 'Reviewer';
  }
}

async function promptForNotifyBin(args: {
  existingNotifyBin: unknown;
  question: QuestionFn;
}) {
  const existing = typeof args.existingNotifyBin === 'string' && args.existingNotifyBin.trim()
    ? args.existingNotifyBin.trim()
    : null;
  const defaultLabel = existing ?? 'none';
  const answer = (await args.question(`Notification script [${defaultLabel}]: `)).trim();
  if (!answer) {
    return existing ?? undefined;
  }
  if (/^(?:none|no|off|disable|disabled)$/i.test(answer)) {
    return null;
  }
  return answer;
}

function buildFlagSelection(parsed: ParsedSetupArgs): AgentConfig | null {
  if (parsed.provider !== null && parsed.allRoles) {
    return {
      planner: {
        provider: parsed.provider,
        model: parsed.plannerModel ?? parsed.model,
      },
      coder: {
        provider: parsed.provider,
        model: parsed.model,
      },
      reviewer: {
        provider: parsed.provider,
        model: parsed.model,
      },
    };
  }

  if (parsed.coderProvider !== null && parsed.reviewerProvider !== null) {
    const plannerProvider = parsed.plannerProvider ?? parsed.coderProvider;
    const plannerModel = parsed.plannerModel ?? (
      parsed.plannerProvider === null ? parsed.coderModel : null
    );
    return {
      planner: {
        provider: plannerProvider,
        model: plannerModel,
      },
      coder: {
        provider: parsed.coderProvider,
        model: parsed.coderModel,
      },
      reviewer: {
        provider: parsed.reviewerProvider,
        model: parsed.reviewerModel,
      },
    };
  }

  return null;
}

async function resolveSetupSelection(args: {
  parsed: ParsedSetupArgs;
  detections: ProviderDetection[];
  cwd: string;
  stdout: Writable;
  question: QuestionFn;
  canPrompt: boolean;
}): Promise<SetupSelection> {
  const flagSelection = buildFlagSelection(args.parsed);
  if (flagSelection) {
    return {
      agentConfig: flagSelection,
      notifyBin: undefined,
      plannerExplicit: args.parsed.provider !== null || args.parsed.plannerProvider !== null || args.parsed.plannerModel !== null,
      prompted: false,
    };
  }

  if (!args.canPrompt) {
    assertNonInteractiveSelectionIsComplete(args.parsed);
  }

  let prompted = false;
  let coderProvider = args.parsed.coderProvider;
  let plannerProvider = args.parsed.plannerProvider;
  let reviewerProvider = args.parsed.reviewerProvider;
  const existing = getExistingProviderValues(getRawMergedConfig(args.cwd));
  let coderModel = args.parsed.coderModel;
  let plannerModel = args.parsed.plannerModel;
  let reviewerModel = args.parsed.reviewerModel;

  if (coderProvider === null) {
    prompted = true;
    const defaultProvider = getConfiguredProviderDefault({
      parsedProvider: args.parsed.coderProvider,
      existingProvider: existing.coder,
      detections: args.detections,
      role: 'coder',
    });
    coderProvider = await promptForProvider({
      role: 'coder',
      detections: args.detections,
      defaultProvider,
      stdout: args.stdout,
      question: args.question,
    });
  }

  if (coderModel === null) {
    prompted = true;
    coderModel = await promptForModel({
      role: 'coder',
      provider: coderProvider,
      detections: args.detections,
      defaultModel:
        existing.coder === coderProvider && typeof existing.coderModel === 'string'
          ? existing.coderModel
          : null,
      stdout: args.stdout,
      question: args.question,
    });
  }

  if (reviewerProvider === null) {
    prompted = true;
    const defaultProvider = getConfiguredProviderDefault({
      parsedProvider: args.parsed.reviewerProvider,
      existingProvider: existing.reviewer,
      detections: args.detections,
      role: 'reviewer',
    });
    reviewerProvider = await promptForProvider({
      role: 'reviewer',
      detections: args.detections,
      defaultProvider,
      stdout: args.stdout,
      question: args.question,
    });
  }

  if (reviewerModel === null) {
    prompted = true;
    reviewerModel = await promptForModel({
      role: 'reviewer',
      provider: reviewerProvider,
      detections: args.detections,
      defaultModel:
        existing.reviewer === reviewerProvider && typeof existing.reviewerModel === 'string'
          ? existing.reviewerModel
          : null,
      stdout: args.stdout,
      question: args.question,
    });
  }

  let plannerExplicit = plannerProvider !== null || plannerModel !== null;
  if (!plannerExplicit && args.canPrompt) {
    prompted = true;
    const useCoderForPlanner = await askYesNo(args.question, 'Use coder provider/model for planner? [Y/n] ', true);
    plannerExplicit = !useCoderForPlanner;
  }

  if (plannerExplicit) {
    if (plannerProvider === null) {
      prompted = true;
      const defaultProvider = getConfiguredProviderDefault({
        parsedProvider: args.parsed.plannerProvider,
        existingProvider: existing.planner ?? coderProvider,
        detections: args.detections,
        role: 'planner',
      }) ?? coderProvider;
      plannerProvider = await promptForProvider({
        role: 'planner',
        detections: args.detections,
        defaultProvider,
        stdout: args.stdout,
        question: args.question,
      });
    }

    if (plannerModel === null) {
      prompted = true;
      plannerModel = await promptForModel({
        role: 'planner',
        provider: plannerProvider,
        detections: args.detections,
        defaultModel:
          existing.planner === plannerProvider && typeof existing.plannerModel === 'string'
            ? existing.plannerModel
            : plannerProvider === coderProvider
              ? coderModel
              : null,
        stdout: args.stdout,
        question: args.question,
      });
    }
  } else {
    plannerProvider = coderProvider;
    plannerModel = coderModel;
  }

  const notifyBin = args.canPrompt
    ? await promptForNotifyBin({
      existingNotifyBin: existing.notifyBin,
      question: args.question,
    })
    : undefined;
  if (notifyBin !== undefined) {
    prompted = true;
  }

  return {
    agentConfig: {
      planner: {
        provider: plannerProvider,
        model: plannerModel,
      },
      coder: {
        provider: coderProvider,
        model: coderModel,
      },
      reviewer: {
        provider: reviewerProvider,
        model: reviewerModel,
      },
    },
    notifyBin,
    plannerExplicit,
    prompted,
  };
}

async function confirmOverwriteIfNeeded(args: {
  cwd: string;
  force: boolean;
  selectionPrompted: boolean;
  canPrompt: boolean;
  stdout: Writable;
  question: QuestionFn;
  confirmOverwrite?: () => boolean | Promise<boolean>;
}) {
  const existing = getExistingProviderValues(getRawMergedConfig(args.cwd));
  if (!existing.hasAny) {
    return;
  }

  if (args.selectionPrompted || args.force) {
    return;
  }

  if (args.confirmOverwrite) {
    if (await args.confirmOverwrite()) {
      return;
    }
    throw new Error('neal setup canceled without writing config');
  }

  if (!args.canPrompt) {
    throw new Error('neal setup will not overwrite existing provider config non-interactively; rerun with --force to overwrite');
  }

  const confirmed = await askYesNo(args.question, 'Save changes to existing writer-run config? [y/N] ', false);
  if (!confirmed) {
    throw new Error('neal setup canceled without writing config');
  }
}

function roleConfigToYaml(config: AgentRoleConfig, preservedEffort?: unknown) {
  const mapping: Record<string, unknown> = {
    provider: config.provider,
    model: config.model,
  };
  if (preservedEffort !== undefined) {
    mapping.effort = preservedEffort;
  }
  return mapping;
}

function readExistingRoleEffort(document: YAML.Document.Parsed, role: SetupRole) {
  if (!document.hasIn(['agent', role, 'effort'])) {
    return undefined;
  }
  return document.getIn(['agent', role, 'effort']);
}

function normalizeEffortForValidation(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

function assertPreservedEffortsAreSupported(args: {
  agentConfig: AgentConfig;
  plannerExplicit: boolean;
  plannerEffort: unknown;
  coderEffort: unknown;
  reviewerEffort: unknown;
}) {
  // The persisted config carries each role's preserved effort (planner inherits the
  // coder provider when it is not explicit). Validate the exact combination Neal will
  // re-read so setup never writes a provider/effort pairing it would immediately reject.
  assertAgentConfigSupportsWriterRun({
    planner: {
      ...args.agentConfig.planner,
      effort: normalizeEffortForValidation(args.plannerEffort),
    },
    coder: {
      ...args.agentConfig.coder,
      effort: normalizeEffortForValidation(args.coderEffort),
    },
    reviewer: {
      ...args.agentConfig.reviewer,
      effort: normalizeEffortForValidation(args.reviewerEffort),
    },
  }, { context: 'neal setup' });
}

async function writeUserSetupConfig(path: string, args: {
  agentConfig: AgentConfig;
  plannerExplicit: boolean;
  notifyBin?: string | null;
}) {
  const rawContent = existsSync(path) ? await readFile(path, 'utf8') : '{}\n';
  const source = rawContent
    .split('\n')
    .every((line) => line.trim() === '' || line.trim().startsWith('#'))
    ? '{}\n'
    : rawContent;
  const document = YAML.parseDocument(source);

  if (document.errors.length > 0) {
    throw new Error(`Could not parse existing user config ${path}: ${document.errors[0]?.message ?? 'invalid YAML'}`);
  }

  if (document.contents === null || !isMap(document.contents)) {
    throw new Error(`Cannot update user config ${path}: expected a YAML mapping at the document root`);
  }

  // Fresh and blank configs seed from '{}', which parses as a flow-style
  // mapping and would force the whole document into flow style; clear the
  // flag so the written config stringifies in block style.
  document.contents.flow = false;

  const plannerEffort = readExistingRoleEffort(document, 'planner');
  const coderEffort = readExistingRoleEffort(document, 'coder');
  const reviewerEffort = readExistingRoleEffort(document, 'reviewer');

  assertPreservedEffortsAreSupported({
    agentConfig: args.agentConfig,
    plannerExplicit: args.plannerExplicit,
    plannerEffort,
    coderEffort,
    reviewerEffort,
  });

  if (args.plannerExplicit) {
    document.setIn(['agent', 'planner'], roleConfigToYaml(args.agentConfig.planner, plannerEffort));
  } else if (plannerEffort !== undefined) {
    document.setIn(['agent', 'planner'], { effort: plannerEffort });
  } else if (document.hasIn(['agent', 'planner'])) {
    document.deleteIn(['agent', 'planner']);
  }
  document.setIn(['agent', 'coder'], roleConfigToYaml(args.agentConfig.coder, coderEffort));
  document.setIn(['agent', 'reviewer'], roleConfigToYaml(args.agentConfig.reviewer, reviewerEffort));
  if (args.notifyBin !== undefined) {
    document.setIn(['neal', 'notify_bin'], args.notifyBin);
  }

  await writeTextAtomic(path, document.toString());
  clearConfigCache();
}

function printOpenAICompatibleGuidanceIfUnresolved(args: {
  agentConfig: AgentConfig;
  cwd: string;
  stdout: Writable;
}) {
  const selectedRoles = (['planner', 'coder', 'reviewer'] as const)
    .filter((role) => args.agentConfig[role].provider === 'openai-compatible');
  if (selectedRoles.length === 0) {
    return;
  }

  // Setup intentionally does not prompt for base URL or API key; it only points at
  // the config keys/env vars the openai-compatible adapter resolves at round time.
  const settings = getOpenAICompatibleSettings(args.cwd);
  if (settings.baseUrl === null || settings.apiKey === null) {
    writeLine(
      args.stdout,
      'Set providers.openai_compatible.base_url (or OPENAI_COMPATIBLE_BASE_URL) and OPENAI_COMPATIBLE_API_KEY before running Neal.',
    );
  }

  // The adapter resolves the model as role model -> default_model -> OPENAI_COMPATIBLE_MODEL
  // and fails the round when none resolve, so warn when a selected role would hit that error.
  const rolesMissingModel = selectedRoles.filter((role) => args.agentConfig[role].model === null);
  if (settings.defaultModel === null && rolesMissingModel.length > 0) {
    const roleModelKeys = rolesMissingModel.map((role) => `agent.${role}.model`).join(', ');
    writeLine(
      args.stdout,
      `No model is resolvable for the openai-compatible ${rolesMissingModel.join('/')} role: set providers.openai_compatible.default_model (or OPENAI_COMPATIBLE_MODEL) or ${roleModelKeys} before running Neal.`,
    );
  }
}

async function ensureNealDirInGitExclude(excludePath: string) {
  let existing = '';
  try {
    existing = await readFile(excludePath, 'utf8');
  } catch (error) {
    const code = typeof error === 'object' && error !== null && 'code' in error ? (error as { code?: unknown }).code : null;
    if (code !== 'ENOENT') {
      throw error;
    }
  }

  const alreadyPresent = existing
    .split(/\r?\n/)
    .map((line) => line.trim())
    .some((line) => line !== '' && !line.startsWith('#') && line === '.neal/');
  if (alreadyPresent) {
    return false;
  }

  const prefix = existing.length === 0 || existing.endsWith('\n') ? existing : `${existing}\n`;
  await writeTextAtomic(excludePath, `${prefix}.neal/\n`);
  return true;
}

async function offerNealGitExcludeUpdate(args: {
  cwd: string;
  stdout: Writable;
  question: QuestionFn;
  canPrompt: boolean;
}) {
  const status = await getNealDirGitIgnoreStatus(args.cwd);
  if (status.kind !== 'not_ignored') {
    return;
  }

  if (!args.canPrompt) {
    writeLine(
      args.stdout,
      'Note: .neal/ is not ignored by Git. Add `.neal/` to `.git/info/exclude` or your repository `.gitignore`.',
    );
    return;
  }

  const confirmed = await askYesNo(args.question, 'Add .neal/ to this repository\'s .git/info/exclude? [Y/n] ', true);
  if (!confirmed) {
    writeLine(args.stdout, 'Skipped Git ignore update for .neal/.');
    return;
  }

  await ensureNealDirInGitExclude(status.excludePath);
  writeLine(args.stdout, `Added .neal/ to ${status.excludePath}`);
}

async function withQuestionFn<T>(args: {
  stdin: InputStream;
  stdout: OutputStream;
  question?: QuestionFn;
  action: (question: QuestionFn) => Promise<T>;
}) {
  if (args.question) {
    return await args.action(args.question);
  }

  const readline = createInterface({ input: args.stdin, output: args.stdout });
  try {
    return await args.action((prompt) => readline.question(prompt));
  } finally {
    readline.close();
  }
}

export async function runNealSetupCli(options: NealSetupCliOptions = {}) {
  const args = options.args ?? ['setup'];
  const parsed = parseSetupArgs(args);
  const cwd = options.cwd ?? process.cwd();
  const stdin = options.stdin ?? process.stdin;
  const stdout = options.stdout ?? process.stdout;
  const canPrompt = options.interactive ?? (
    options.question !== undefined || (stdin.isTTY === true && stdout.isTTY === true)
  );
  const detections = options.detections ?? await (options.detectProviders ?? detectBuiltInProviders)();

  await withQuestionFn({
    stdin,
    stdout,
    question: options.question,
    action: async (question) => {
      const selection = await resolveSetupSelection({
        parsed,
        detections,
        cwd,
        stdout,
        question,
        canPrompt,
      });
      assertAgentConfigSupportsWriterRun(selection.agentConfig, { context: 'neal setup' });

      await confirmOverwriteIfNeeded({
        cwd,
        force: parsed.force,
        selectionPrompted: selection.prompted,
        canPrompt,
        stdout,
        question,
        confirmOverwrite: options.confirmOverwrite,
      });

      const configPath = options.configPath ?? getConfigSourceInfo(cwd).user.path;
      await writeUserSetupConfig(configPath, {
        agentConfig: selection.agentConfig,
        plannerExplicit: selection.plannerExplicit,
        notifyBin: selection.notifyBin,
      });

      writeLine(stdout, `Wrote ${configPath}`);
      printOpenAICompatibleGuidanceIfUnresolved({
        agentConfig: selection.agentConfig,
        cwd,
        stdout,
      });
      await offerNealGitExcludeUpdate({
        cwd,
        stdout,
        question,
        canPrompt,
      });
      writeLine(stdout, 'Next: complete any provider-owned setup, then run `neal check`.');
    },
  });
}

export async function runSetupCommand(args: string[]) {
  await runNealSetupCli({ args });
}
