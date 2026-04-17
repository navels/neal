import type { AgentConfig, AgentProvider } from './types.js';

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

const EXECUTE_SOURCE_FLAGS = new Set(['--execute', '--execute-file', '--execute-text']);
const TOP_LEVEL_MODE_FLAGS = new Set(['--plan', '--execute', '--execute-file', '--execute-text']);

export function buildUsageLines() {
  return [
    'Usage: neal --execute <plan-doc>              # default file mode',
    '   or: neal --execute-file <plan-doc>         # explicit file mode',
    '   or: neal --execute-text "<plan markdown>"  # explicit inline text mode',
    '   or: neal --plan <plan-doc>',
    '   or: neal --resume [state-file]',
    '   or: neal --recover [state-file] --message <guidance>  # then run neal --resume',
    '   or: neal --resume-coder [state-file]',
    '   or: neal --resume-reviewer [state-file]',
    '   or: neal --summaries [runs-dir]',
    'Optional new-run flags: --coder-provider <provider> --coder-model <model> --reviewer-provider <provider> --reviewer-model <model> --ignore-local-changes',
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
      case '--coder-provider':
        if (!value || !isAgentProvider(value)) {
          throw new Error(`Invalid --coder-provider value: ${String(value)}`);
        }
        agentConfig.coder.provider = value;
        index += 2;
        break;
      case '--coder-model':
        if (!value) {
          throw new Error('--coder-model requires a value');
        }
        agentConfig.coder.model = value;
        index += 2;
        break;
      case '--reviewer-provider':
        if (!value || !isAgentProvider(value)) {
          throw new Error(`Invalid --reviewer-provider value: ${String(value)}`);
        }
        agentConfig.reviewer.provider = value;
        index += 2;
        break;
      case '--reviewer-model':
        if (!value) {
          throw new Error('--reviewer-model requires a value');
        }
        agentConfig.reviewer.model = value;
        index += 2;
        break;
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

function isAgentProvider(value: string): value is AgentProvider {
  return value === 'openai-codex' || value === 'anthropic-claude';
}
