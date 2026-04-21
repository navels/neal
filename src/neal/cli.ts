import type { AgentConfig } from './types.js';

export type ExecuteInputSource =
  | { mode: 'file_default'; value: string }
  | { mode: 'file_explicit'; value: string }
  | { mode: 'text_explicit'; value: string };

export type ParsedNewRunArgs = {
  topLevelMode: 'plan' | 'execute';
  planDoc: string | null;
  executeInputSource: ExecuteInputSource | null;
  agentConfig: AgentConfig;
  ignoreLocalChanges: boolean;
};

export type ParsedSquashArgs = {
  planDoc: string;
  dryRun: boolean;
  yes: boolean;
};

const EXECUTE_SOURCE_FLAGS = new Set(['--execute', '--execute-file', '--execute-text']);
const TOP_LEVEL_MODE_FLAGS = new Set(['--plan', '--execute', '--execute-file', '--execute-text']);

export function buildUsageLines() {
  return [
    'Usage: neal --execute <plan-doc>              # default file mode',
    '   or: neal --execute-file <plan-doc>         # explicit file mode',
    '   or: neal --execute-text "<plan markdown>"  # explicit inline text mode',
    '   or: neal --plan <plan-doc>                 # refine plan in place via coder+reviewer loop; backs up original, overwrites input, does not implement',
    '   or: neal --resume [state-file]             # resume a crashed/paused run from persisted state (default: .neal/session.json)',
    '   or: neal --recover [state-file] --message <guidance>  # record operator guidance, then run neal --resume',
    '   or: neal --diagnose [state-file] --question "<diagnostic question>" --target "<files-or-component>" [--baseline <ref>]',
    '   or: neal --diagnostic-decision [state-file] --action <adopt|reference|cancel> [--rationale "<note>"]',
<<<<<<< Updated upstream
    '   or: neal --resume-coder [state-file]       # open persisted coder session in its provider CLI',
    '   or: neal --resume-reviewer [state-file]    # open persisted reviewer session in its provider CLI',
    '   or: neal --squash <plan-doc> [--dry-run] [--yes]      # squash run-owned commits for a completed plan',
    '   or: neal --summaries [runs-dir]            # page past-run retrospective summaries',
    '',
    'Optional new-run flags (--plan / --execute*):',
    '  --coder-provider <openai-codex|anthropic-claude>       (default: openai-codex)',
    '  --coder-model <model>',
    '  --reviewer-provider <openai-codex|anthropic-claude>    (default: anthropic-claude)',
    '  --reviewer-model <model>',
    '  --ignore-local-changes                                 start a fresh execute run on a dirty worktree',
    '',
    'Config precedence: CLI flags > ~/.config/neal/config.yml > repo config.yml > built-in defaults.',
    'Optional prompt guidance (injected into built-in prompts if present):',
    '  ~/.config/neal/guidance/{coder,reviewer,planner}.md',
    'Notifications: runs neal.notify_bin (default ~/bin/notify) for blocked/complete/done/retry events.',
    'See README.md for full details.',
=======
    '   or: neal --resume-coder [state-file]',
    '   or: neal --resume-reviewer [state-file]',
    '   or: neal --summaries [runs-dir]',
    'Optional new-run flags: --ignore-local-changes',
>>>>>>> Stashed changes
  ];
}

function requireFilePathValue(flag: '--plan' | '--execute' | '--execute-file', value: string | undefined) {
  if (value !== undefined && !value.startsWith('--')) {
    return value;
  }

  switch (flag) {
    case '--plan':
      throw new Error('--plan requires a plan file path argument');
    case '--execute':
      throw new Error('--execute requires a plan file path argument');
    case '--execute-file':
      throw new Error('--execute-file requires a plan file path argument');
  }
}

function requireTextValue(value: string | undefined) {
  if (value === undefined || value === '') {
    throw new Error('--execute-text requires a non-empty inline plan string argument');
  }

  return value;
}

function rejectConflictingTopLevelMode(flag: string) {
  if (TOP_LEVEL_MODE_FLAGS.has(flag)) {
    throw new Error('Choose exactly one execute input source: --execute, --execute-file, or --execute-text');
  }
}

function rejectConflictingExecuteSource(flag: string) {
  if (EXECUTE_SOURCE_FLAGS.has(flag)) {
    throw new Error('Choose exactly one execute input source: --execute, --execute-file, or --execute-text');
  }
}

export function parseNewRunArgs(args: string[], defaults: AgentConfig) {
  if (args.length === 0) {
    throw new Error('Missing command');
  }

  let index = 0;
  const firstArg = args[index];
  let topLevelMode: 'plan' | 'execute';
  let planDoc: string | null = null;
  let executeInputSource: ExecuteInputSource | null = null;
  const agentConfig: AgentConfig = {
    coder: { ...defaults.coder },
    reviewer: { ...defaults.reviewer },
  };
  let ignoreLocalChanges = false;

  switch (firstArg) {
    case '--plan':
      topLevelMode = 'plan';
      planDoc = requireFilePathValue('--plan', args[index + 1]);
      index += 2;
      break;
    case '--execute':
      topLevelMode = 'execute';
      executeInputSource = {
        mode: 'file_default',
        value: requireFilePathValue('--execute', args[index + 1]),
      };
      index += 2;
      break;
    case '--execute-file':
      topLevelMode = 'execute';
      executeInputSource = {
        mode: 'file_explicit',
        value: requireFilePathValue('--execute-file', args[index + 1]),
      };
      index += 2;
      break;
    case '--execute-text':
      topLevelMode = 'execute';
      executeInputSource = {
        mode: 'text_explicit',
        value: requireTextValue(args[index + 1]),
      };
      index += 2;
      break;
    default:
      throw new Error(`Unknown argument: ${firstArg}`);
  }

  while (index < args.length) {
    const flag = args[index];
    const value = args[index + 1];
    rejectConflictingTopLevelMode(flag);
    rejectConflictingExecuteSource(flag);
    switch (flag) {
      case '--ignore-local-changes':
        ignoreLocalChanges = true;
        index += 1;
        break;
      default:
        throw new Error(`Unknown argument: ${flag}`);
    }
  }

  return {
    topLevelMode,
    planDoc,
    executeInputSource,
    agentConfig,
    ignoreLocalChanges,
  } satisfies ParsedNewRunArgs;
}

export function parseSquashArgs(args: string[]): ParsedSquashArgs {
  if (args[0] !== '--squash') {
    throw new Error(`Unknown argument: ${args[0] ?? ''}`);
  }

  const planDoc = args[1];
  if (!planDoc || planDoc.startsWith('--')) {
    throw new Error('--squash requires a plan file path argument');
  }

  let dryRun = false;
  let yes = false;
  let index = 2;

  while (index < args.length) {
    const flag = args[index];
    switch (flag) {
      case '--dry-run':
        dryRun = true;
        index += 1;
        break;
      case '--yes':
        yes = true;
        index += 1;
        break;
      default:
        throw new Error(`Unknown argument: ${flag}`);
    }
  }

  return {
    planDoc,
    dryRun,
    yes,
  };
}
