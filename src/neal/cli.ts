import type { AgentConfig } from './types.js';

export type FileOrTextInputSource =
  | { mode: 'file_default'; value: string }
  | { mode: 'file_explicit'; value: string }
  | { mode: 'text_explicit'; value: string; targetPath?: string };

export type ParsedNewRunArgs = {
  topLevelMode: 'plan' | 'execute';
  planDoc: string | null;
  inputSource: FileOrTextInputSource | null;
  agentConfig: AgentConfig;
  ignoreLocalChanges: boolean;
};

export type ParsedSquashArgs = {
  planDoc: string;
  dryRun: boolean;
  yes: boolean;
};

const EXECUTE_SOURCE_FLAGS = new Set(['--execute', '--execute-file', '--execute-text']);
const PLAN_SOURCE_FLAGS = new Set(['--plan', '--plan-file', '--plan-text']);
const TOP_LEVEL_MODE_FLAGS = new Set([...EXECUTE_SOURCE_FLAGS, ...PLAN_SOURCE_FLAGS]);

export function buildUsageLines() {
  return [
    'Usage: neal --execute <plan-doc>              # default file mode',
    '   or: neal --execute-file <plan-doc>         # explicit file mode',
    '   or: neal --execute-text "<plan markdown>"  # explicit inline text mode',
    '   or: neal --plan <plan-doc>                 # refine plan in place via coder+reviewer loop; backs up original, overwrites input, does not implement',
    '   or: neal --plan-file <plan-doc>            # explicit file mode for planning',
    '   or: neal --plan-text "<plan markdown>" <plan-doc>  # write inline draft to plan file, then refine it',
    '   or: neal --resume [state-file]             # resume a crashed/paused run from persisted state (default: .neal/session.json)',
    '   or: neal --recover [state-file] --message <guidance>  # record operator guidance, then run neal --resume',
    '   or: neal --diagnose [state-file] --question "<diagnostic question>" --target "<files-or-component>" [--baseline <ref>]',
    '   or: neal --diagnostic-decision [state-file] --action <adopt|reference|cancel> [--rationale "<note>"]',
    '   or: neal --resume-coder [state-file]       # open persisted coder session in its provider CLI',
    '   or: neal --resume-reviewer [state-file]    # open persisted reviewer session in its provider CLI',
    '   or: neal --squash <plan-doc> [--dry-run] [--yes]      # squash run-owned commits for a completed plan',
    '   or: neal --summaries [runs-dir]            # page past-run retrospective summaries',
    '',
    'Optional new-run flags (--plan / --execute*):',
    '  --ignore-local-changes                                 start a fresh execute run on a dirty worktree',
    '',
    'Config precedence: ~/.config/neal/config.yml > repo config.yml > built-in defaults.',
    'Optional prompt guidance (injected into built-in prompts if present):',
    '  ~/.config/neal/guidance/{coder,reviewer,planner}.md',
    'Notifications: runs neal.notify_bin (default ~/bin/notify) for blocked/complete/done/retry events.',
    'See README.md for full details.',
  ];
}

function requireFilePathValue(flag: '--plan' | '--plan-file' | '--execute' | '--execute-file', value: string | undefined) {
  if (value !== undefined && !value.startsWith('--')) {
    return value;
  }

  switch (flag) {
    case '--plan':
      throw new Error('--plan requires a plan file path argument');
    case '--plan-file':
      throw new Error('--plan-file requires a plan file path argument');
    case '--execute':
      throw new Error('--execute requires a plan file path argument');
    case '--execute-file':
      throw new Error('--execute-file requires a plan file path argument');
  }
}

function requirePlanTextTargetPath(value: string | undefined) {
  if (value !== undefined && !value.startsWith('--')) {
    return value;
  }

  throw new Error('--plan-text requires an inline plan string followed by a target plan file path argument');
}

function requireTextValue(flag: '--plan-text' | '--execute-text', value: string | undefined) {
  if (value === undefined || value === '') {
    throw new Error(`${flag} requires a non-empty inline plan string argument`);
  }

  return value;
}

function rejectConflictingTopLevelMode(flag: string) {
  if (TOP_LEVEL_MODE_FLAGS.has(flag)) {
    throw new Error(
      'Choose exactly one top-level input source: --plan, --plan-file, --plan-text, --execute, --execute-file, or --execute-text',
    );
  }
}

function rejectConflictingExecuteSource(flag: string) {
  if (EXECUTE_SOURCE_FLAGS.has(flag)) {
    throw new Error('Choose exactly one execute input source: --execute, --execute-file, or --execute-text');
  }
}

function rejectConflictingPlanSource(flag: string) {
  if (PLAN_SOURCE_FLAGS.has(flag)) {
    throw new Error('Choose exactly one plan input source: --plan, --plan-file, or --plan-text');
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
  let inputSource: FileOrTextInputSource | null = null;
  const agentConfig: AgentConfig = {
    coder: { ...defaults.coder },
    reviewer: { ...defaults.reviewer },
  };
  let ignoreLocalChanges = false;

  switch (firstArg) {
    case '--plan':
      topLevelMode = 'plan';
      inputSource = {
        mode: 'file_default',
        value: requireFilePathValue('--plan', args[index + 1]),
      };
      planDoc = inputSource.value;
      index += 2;
      break;
    case '--plan-file':
      topLevelMode = 'plan';
      inputSource = {
        mode: 'file_explicit',
        value: requireFilePathValue('--plan-file', args[index + 1]),
      };
      planDoc = inputSource.value;
      index += 2;
      break;
    case '--plan-text':
      topLevelMode = 'plan';
      inputSource = {
        mode: 'text_explicit',
        value: requireTextValue('--plan-text', args[index + 1]),
        targetPath: requirePlanTextTargetPath(args[index + 2]),
      };
      index += 3;
      break;
    case '--execute':
      topLevelMode = 'execute';
      inputSource = {
        mode: 'file_default',
        value: requireFilePathValue('--execute', args[index + 1]),
      };
      index += 2;
      break;
    case '--execute-file':
      topLevelMode = 'execute';
      inputSource = {
        mode: 'file_explicit',
        value: requireFilePathValue('--execute-file', args[index + 1]),
      };
      index += 2;
      break;
    case '--execute-text':
      topLevelMode = 'execute';
      inputSource = {
        mode: 'text_explicit',
        value: requireTextValue('--execute-text', args[index + 1]),
      };
      index += 2;
      break;
    default:
      throw new Error(`Unknown argument: ${firstArg}`);
  }

  while (index < args.length) {
    const flag = args[index];
    if (topLevelMode === 'execute') {
      rejectConflictingExecuteSource(flag);
      if (PLAN_SOURCE_FLAGS.has(flag)) {
        rejectConflictingTopLevelMode(flag);
      }
    } else {
      rejectConflictingPlanSource(flag);
      if (EXECUTE_SOURCE_FLAGS.has(flag)) {
        rejectConflictingTopLevelMode(flag);
      }
    }
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
    inputSource,
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
