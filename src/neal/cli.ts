import { parseProviderId } from './providers/registry.js';
import type { AgentConfig, AgentProvider } from './types.js';

export type ParsedNewRunArgs = {
  topLevelMode: 'plan' | 'execute';
  planDoc: string;
  agentConfig: AgentConfig;
  squashOnCompletion: boolean;
  unattended: boolean;
};

export type ParsedPlanAndExecuteArgs = {
  planDocs: string[];
  agentConfig: AgentConfig;
  squashOnCompletion: boolean;
  unattended: boolean;
};

export type ParsedReviewSelector =
  | { kind: 'last'; count: number }
  | { kind: 'since'; baseRef: string };

export type ReviewInstructionSource = 'default' | 'positional';

export type ParsedReviewArgs = {
  instruction: string;
  instructionSource: ReviewInstructionSource;
  selector: ParsedReviewSelector;
};

export type ParsedSquashArgs = {
  planDoc: string | null;
};

export type ParsedStatusArgs = {
  runId: string | null;
  json: boolean;
  all: boolean;
};

export type ParsedResumeArgs = {
  runId: string | null;
  message: string | null;
};

export type ParsedCheckArgs = Record<string, never>;

export type ParsedSetupArgs = {
  force: boolean;
  allRoles: boolean;
  provider: AgentProvider | null;
  model: string | null;
  coderProvider: AgentProvider | null;
  coderModel: string | null;
  plannerProvider: AgentProvider | null;
  plannerModel: string | null;
  reviewerProvider: AgentProvider | null;
  reviewerModel: string | null;
};

export const DEFAULT_REVIEW_INSTRUCTION =
  'Use neal\'s built-in read-only review posture for the selected externally authored commits: look for correctness bugs, regressions, missing verification, unsafe assumptions, and integration risks, then produce findings without applying fixes or rewriting history.';

export function buildUsageLines(version: string) {
  return [
    `neal ${version}`,
    '',
    'Usage: neal setup',
    '   or: neal plan <plan.md> [--unattended]',
    '   or: neal execute <plan.md> [--no-squash] [--unattended]',
    '   or: neal run [--no-squash] [--unattended] <plan.md> [more-plans...]',
    '   or: neal resume [--run <run-id>] [--message "..."]',
    '   or: neal review [message] (--last <n> | --since <base>)',
    '   or: neal squash [plan.md]',
    '   or: neal check',
    '   or: neal compat [--model <slug>] [--role coder|reviewer|planner|all] [--reference openai-codex|anthropic-claude|openai-compatible:<model>] [--json]',
    '   or: neal status [--json] [--run <run-id>]',
    '   or: neal status [--json] --all',
    '   or: neal version',
    '   or: neal --version',
    '   or: neal -V',
    '   or: neal help',
    '   or: neal --help',
    '   or: neal -h',
    '',
    'Common examples:',
    '  neal plan tmp/PLAN.md',
    '  neal execute tmp/PLAN.md',
    '  neal execute tmp/PLAN.md --no-squash',
    '  neal execute tmp/PLAN.md --unattended',
    '  neal run tmp/PLAN.md',
    '  neal run --no-squash tmp/PLAN.md',
    '  neal run --unattended tmp/PLAN.md',
    '  neal resume',
    '  neal resume --run <run-id>',
    '  neal resume --run <run-id> --message "Use the narrower helper approach."',
    '  neal review --last 3',
    '  neal squash',
    '  neal status',
    '  neal status --all',
    '  neal check',
    '  neal compat --model deepseek/deepseek-chat --role all --reference openai-codex --json  # --model runs the slug on openai-compatible; reference roles run on the native adapter',
    '  neal setup',
    '  neal setup --provider anthropic-claude --all-roles',
    '  neal version',
    '',
    'See README.md for full details.',
  ];
}

function requireSubcommandPlanPath(command: 'plan' | 'execute' | 'squash', value: string | undefined) {
  if (value !== undefined && !value.startsWith('--')) {
    return value;
  }
  throw new Error(`neal ${command} requires a plan file path argument`);
}

function requireReviewValue(flag: '--last' | '--since', value: string | undefined) {
  if (value !== undefined && !value.startsWith('--')) {
    return value;
  }

  switch (flag) {
    case '--last':
      throw new Error('neal review --last requires a positive integer count');
    case '--since':
      throw new Error('neal review --since requires a base ref value');
  }
}

function parsePositiveInteger(value: string) {
  if (!/^[1-9]\d*$/.test(value)) {
    throw new Error('neal review --last requires a positive integer count');
  }

  const count = Number(value);
  if (!Number.isSafeInteger(count)) {
    throw new Error('neal review --last requires a safe positive integer count');
  }

  return count;
}

function parseReviewSince(value: string) {
  const baseRef = value.trim();
  if (baseRef === '') {
    throw new Error('neal review --since requires a non-empty base ref value');
  }
  if (baseRef.includes('..')) {
    throw new Error('neal review --since accepts only a base ref; HEAD is implicit');
  }

  return {
    baseRef,
  };
}

export function parseNewRunArgs(args: string[], defaults: AgentConfig) {
  if (args.length === 0) {
    throw new Error('Missing command');
  }

  const agentConfig: AgentConfig = {
    planner: { ...defaults.planner },
    coder: { ...defaults.coder },
    reviewer: { ...defaults.reviewer },
  };

  const command = args[0];
  if (command !== 'plan' && command !== 'execute') {
    throw new Error(`Unknown argument: ${command ?? ''}`);
  }

  const planDoc = requireSubcommandPlanPath(command, args[1]);
  let squashOnCompletion = command === 'execute';
  let unattended = false;
  let index = 2;
  while (index < args.length) {
    const extra = args[index];
    if (extra === '--no-squash' && command === 'execute') {
      squashOnCompletion = false;
      index += 1;
      continue;
    }
    if (extra === '--unattended') {
      unattended = true;
      index += 1;
      continue;
    }
    if (extra?.startsWith('--')) {
      throw new Error(`neal ${command} accepts exactly one plan file path argument; unsupported flag: ${extra}`);
    }
    throw new Error(`neal ${command} accepts exactly one plan file path argument`);
  }

  return {
    topLevelMode: command,
    planDoc,
    agentConfig,
    squashOnCompletion,
    unattended,
  } satisfies ParsedNewRunArgs;
}

export function parsePlanAndExecuteArgs(args: string[], defaults: AgentConfig): ParsedPlanAndExecuteArgs {
  if (args[0] !== 'run') {
    throw new Error(`Unknown argument: ${args[0] ?? ''}`);
  }

  const planDocs: string[] = [];
  const agentConfig: AgentConfig = {
    planner: { ...defaults.planner },
    coder: { ...defaults.coder },
    reviewer: { ...defaults.reviewer },
  };
  let index = 1;
  let squashOnCompletion = true;
  let unattended = false;

  while (index < args.length) {
    const value = args[index];
    if (value === '--no-squash') {
      squashOnCompletion = false;
      index += 1;
      continue;
    }
    if (value === '--unattended') {
      unattended = true;
      index += 1;
      continue;
    }
    if (value.startsWith('--')) {
      throw new Error(`neal run accepts only plan file path operands; unsupported flag: ${value}`);
    }

    planDocs.push(value);
    index += 1;
  }

  if (planDocs.length === 0) {
    throw new Error('neal run requires at least one plan file path argument');
  }

  return {
    planDocs,
    agentConfig,
    squashOnCompletion,
    unattended,
  };
}

export function parseReviewArgs(args: string[]): ParsedReviewArgs {
  const command = args[0];
  if (command !== 'review') {
    throw new Error(`Unknown argument: ${args[0] ?? ''}`);
  }

  let positionalInstruction: string | null = null;
  let lastCount: number | null = null;
  let sinceSelector: { baseRef: string } | null = null;
  let index = 1;

  while (index < args.length) {
    const flag = args[index];

    if (!flag.startsWith('--')) {
      if (positionalInstruction !== null) {
        throw new Error('neal review accepts at most one positional message');
      }
      if (flag.trim() === '') {
        throw new Error('neal review requires a non-empty positional message');
      }
      positionalInstruction = flag.trim();
      index += 1;
      continue;
    }

    switch (flag) {
      case '--last':
        if (lastCount !== null) {
          throw new Error('neal review accepts --last only once');
        }
        lastCount = parsePositiveInteger(requireReviewValue('--last', args[index + 1]));
        index += 2;
        break;
      case '--since':
        if (sinceSelector !== null) {
          throw new Error('neal review accepts --since only once');
        }
        sinceSelector = parseReviewSince(requireReviewValue('--since', args[index + 1]));
        index += 2;
        break;
      default:
        throw new Error(`Unknown argument: ${flag}`);
    }
  }

  const selectorCount = (lastCount === null ? 0 : 1) + (sinceSelector === null ? 0 : 1);
  if (selectorCount === 0) {
    throw new Error('neal review requires exactly one selector: --last <count> or --since <base>');
  }
  if (selectorCount > 1) {
    throw new Error('Choose exactly one review selector: --last <count> or --since <base>');
  }

  let selector: ParsedReviewSelector;
  if (lastCount !== null) {
    selector = { kind: 'last', count: lastCount };
  } else {
    selector = { kind: 'since', ...sinceSelector! };
  }

  const instructionSource: ReviewInstructionSource =
    positionalInstruction !== null ? 'positional' : 'default';

  return {
    instruction: positionalInstruction ?? DEFAULT_REVIEW_INSTRUCTION,
    instructionSource,
    selector,
  };
}

export function parseSquashArgs(args: string[]): ParsedSquashArgs {
  if (args[0] !== 'squash') {
    throw new Error(`Unknown argument: ${args[0] ?? ''}`);
  }

  if (args.length === 1) {
    return {
      planDoc: null,
    };
  }

  const planDocArg = args[1];
  if (planDocArg?.startsWith('--')) {
    throw new Error(`neal squash accepts an optional plan file path argument; unsupported flag: ${planDocArg}`);
  }

  const planDoc = requireSubcommandPlanPath('squash', planDocArg);
  if (args.length > 2) {
    const extra = args[2];
    if (extra?.startsWith('--')) {
      throw new Error(`neal squash accepts at most one plan file path argument; unsupported flag: ${extra}`);
    }
    throw new Error('neal squash accepts at most one plan file path argument');
  }

  return {
    planDoc,
  };
}

export function parseStatusArgs(args: string[]): ParsedStatusArgs {
  if (args[0] !== 'status') {
    throw new Error(`Unknown argument: ${args[0] ?? ''}`);
  }

  let sawJson = false;
  let all = false;
  let runId: string | null = null;
  let index = 1;

  while (index < args.length) {
    const flag = args[index];
    switch (flag) {
      case '--json':
        if (sawJson) {
          throw new Error('neal status accepts --json only once');
        }
        sawJson = true;
        index += 1;
        break;
      case '--all':
        if (all) {
          throw new Error('neal status accepts --all only once');
        }
        all = true;
        index += 1;
        break;
      case '--run': {
        if (runId !== null) {
          throw new Error('neal status accepts --run only once');
        }
        const value = args[index + 1];
        if (!value || value.startsWith('--')) {
          throw new Error('neal status --run requires a run id argument');
        }
        runId = value;
        index += 2;
        break;
      }
      default:
        throw new Error(`Unknown argument: ${flag}`);
    }
  }

  if (all && runId) {
    throw new Error('neal status --all and --run are mutually exclusive');
  }

  return { runId, json: sawJson, all };
}

export function parseResumeArgs(args: string[]): ParsedResumeArgs {
  if (args[0] !== 'resume') {
    throw new Error(`Unknown argument: ${args[0] ?? ''}`);
  }

  const commandLabel = 'neal resume';
  let runId: string | null = null;
  let message: string | null = null;
  let index = 1;

  while (index < args.length) {
    const flag = args[index];
    const value = args[index + 1];
    switch (flag) {
      case '--run':
        if (runId !== null) {
          throw new Error(`${commandLabel} accepts --run only once`);
        }
        if (!value || value.startsWith('--')) {
          throw new Error(`${commandLabel} --run requires a run id argument`);
        }
        runId = value;
        index += 2;
        break;
      case '--message':
        if (message !== null) {
          throw new Error(`${commandLabel} accepts --message only once`);
        }
        if (value === undefined || value.trim() === '') {
          throw new Error(`${commandLabel} --message requires a non-empty guidance value`);
        }
        message = value;
        index += 2;
        break;
      default:
        throw new Error(`${commandLabel} accepts only --run <run-id> and optional --message <guidance>`);
    }
  }

  return {
    runId,
    message,
  };
}

export function parseCheckArgs(args: string[]): ParsedCheckArgs {
  if (args[0] !== 'check') {
    throw new Error(`Unknown argument: ${args[0] ?? ''}`);
  }
  if (args.length > 1) {
    throw new Error('neal check accepts no arguments');
  }

  return {};
}

function requireFlagValue(commandLabel: string, flag: string, value: string | undefined) {
  if (value === undefined || value.startsWith('--') || value.trim() === '') {
    throw new Error(`${commandLabel} ${flag} requires a non-empty value`);
  }
  return value;
}

export function parseSetupArgs(args: string[]): ParsedSetupArgs {
  if (args[0] !== 'setup') {
    throw new Error(`Unknown argument: ${args[0] ?? ''}`);
  }

  const commandLabel = 'neal setup';
  const parsed: ParsedSetupArgs = {
    force: false,
    allRoles: false,
    provider: null,
    model: null,
    coderProvider: null,
    coderModel: null,
    plannerProvider: null,
    plannerModel: null,
    reviewerProvider: null,
    reviewerModel: null,
  };
  const seen = new Set<string>();
  let index = 1;

  function markOnce(flag: string) {
    if (seen.has(flag)) {
      throw new Error(`${commandLabel} accepts ${flag} only once`);
    }
    seen.add(flag);
  }

  while (index < args.length) {
    const flag = args[index];
    switch (flag) {
      case '--force':
        markOnce(flag);
        parsed.force = true;
        index += 1;
        break;
      case '--all-roles':
        markOnce(flag);
        parsed.allRoles = true;
        index += 1;
        break;
      case '--provider':
        markOnce(flag);
        parsed.provider = parseProviderId(requireFlagValue(commandLabel, flag, args[index + 1]), flag);
        index += 2;
        break;
      case '--model':
        markOnce(flag);
        parsed.model = requireFlagValue(commandLabel, flag, args[index + 1]).trim();
        index += 2;
        break;
      case '--coder-provider':
        markOnce(flag);
        parsed.coderProvider = parseProviderId(requireFlagValue(commandLabel, flag, args[index + 1]), flag);
        index += 2;
        break;
      case '--planner-provider':
        markOnce(flag);
        parsed.plannerProvider = parseProviderId(requireFlagValue(commandLabel, flag, args[index + 1]), flag);
        index += 2;
        break;
      case '--reviewer-provider':
        markOnce(flag);
        parsed.reviewerProvider = parseProviderId(requireFlagValue(commandLabel, flag, args[index + 1]), flag);
        index += 2;
        break;
      case '--coder-model':
        markOnce(flag);
        parsed.coderModel = requireFlagValue(commandLabel, flag, args[index + 1]).trim();
        index += 2;
        break;
      case '--planner-model':
        markOnce(flag);
        parsed.plannerModel = requireFlagValue(commandLabel, flag, args[index + 1]).trim();
        index += 2;
        break;
      case '--reviewer-model':
        markOnce(flag);
        parsed.reviewerModel = requireFlagValue(commandLabel, flag, args[index + 1]).trim();
        index += 2;
        break;
      default:
        throw new Error(`Unknown argument: ${flag}`);
    }
  }

  const hasSharedProvider = parsed.provider !== null;
  const hasRoleProvider =
    parsed.coderProvider !== null ||
    parsed.plannerProvider !== null ||
    parsed.reviewerProvider !== null;
  if (hasSharedProvider && hasRoleProvider) {
    throw new Error(`${commandLabel} cannot mix --provider with role-specific provider flags`);
  }
  if (hasRoleProvider && parsed.allRoles) {
    throw new Error(`${commandLabel} cannot use --all-roles with role-specific provider flags`);
  }
  if (hasSharedProvider && !parsed.allRoles) {
    throw new Error(`${commandLabel} --provider requires --all-roles`);
  }
  if (parsed.allRoles && !hasSharedProvider) {
    throw new Error(`${commandLabel} --all-roles requires --provider <provider-id>`);
  }
  if (parsed.model !== null && !hasSharedProvider) {
    throw new Error(`${commandLabel} --model requires --provider <provider-id>`);
  }
  if (parsed.coderModel !== null && parsed.coderProvider === null) {
    throw new Error(`${commandLabel} --coder-model requires --coder-provider in the same invocation`);
  }
  if (parsed.plannerModel !== null && parsed.plannerProvider === null && parsed.coderProvider === null && parsed.provider === null) {
    throw new Error(`${commandLabel} --planner-model requires --planner-provider, --coder-provider, or --provider in the same invocation`);
  }
  if (parsed.reviewerModel !== null && parsed.reviewerProvider === null) {
    throw new Error(`${commandLabel} --reviewer-model requires --reviewer-provider in the same invocation`);
  }

  return parsed;
}
