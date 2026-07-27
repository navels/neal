import test from 'node:test';
import assert from 'node:assert/strict';

import {
  buildUsageLines,
  DEFAULT_REVIEW_INSTRUCTION,
  parseCheckArgs,
  parseNewRunArgs,
  parsePlanAndExecuteArgs,
  parseResumeArgs,
  parseReviewArgs,
  parseSetupArgs,
  parseSquashArgs,
} from '../src/neal/cli.js';
import type { AgentConfig } from '../src/neal/types.js';

function testAgentConfig(): AgentConfig {
  return {
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
  };
}

test('parseNewRunArgs accepts only direct plan and execute subcommands', () => {
  const defaults = testAgentConfig();

  assert.deepEqual(parseNewRunArgs(['plan', 'plans/PLAN.md'], defaults), {
    topLevelMode: 'plan',
    planDoc: 'plans/PLAN.md',
    agentConfig: defaults,
    squashOnCompletion: false,
    unattended: false,
  });

  assert.deepEqual(parseNewRunArgs(['execute', 'plans/PLAN.md'], defaults), {
    topLevelMode: 'execute',
    planDoc: 'plans/PLAN.md',
    agentConfig: defaults,
    squashOnCompletion: true,
    unattended: false,
  });

  assert.deepEqual(parseNewRunArgs(['execute', 'plans/PLAN.md', '--no-squash'], defaults), {
    topLevelMode: 'execute',
    planDoc: 'plans/PLAN.md',
    agentConfig: defaults,
    squashOnCompletion: false,
    unattended: false,
  });

  assert.deepEqual(parseNewRunArgs(['execute', 'plans/PLAN.md', '--unattended'], defaults), {
    topLevelMode: 'execute',
    planDoc: 'plans/PLAN.md',
    agentConfig: defaults,
    squashOnCompletion: true,
    unattended: true,
  });

  assert.deepEqual(parseNewRunArgs(['plan', 'plans/PLAN.md', '--unattended'], defaults), {
    topLevelMode: 'plan',
    planDoc: 'plans/PLAN.md',
    agentConfig: defaults,
    squashOnCompletion: false,
    unattended: true,
  });
});

test('parseNewRunArgs rejects unsupported commands, extra operands, and flags', () => {
  assert.throws(() => parseNewRunArgs(['plan'], testAgentConfig()), /neal plan requires a plan file path argument/);
  assert.throws(() => parseNewRunArgs(['execute'], testAgentConfig()), /neal execute requires a plan file path argument/);
  assert.throws(
    () => parseNewRunArgs(['plan', 'plans/PLAN.md', '--unexpected'], testAgentConfig()),
    /unsupported flag: --unexpected/,
  );
  assert.throws(
    () => parseNewRunArgs(['plan', 'plans/PLAN.md', '--no-squash'], testAgentConfig()),
    /unsupported flag: --no-squash/,
  );
  assert.throws(
    () => parseNewRunArgs(['execute', 'plans/PLAN.md', '--unexpected'], testAgentConfig()),
    /unsupported flag: --unexpected/,
  );
  assert.throws(
    () => parseNewRunArgs(['execute', 'plans/PLAN.md', 'plans/OTHER.md'], testAgentConfig()),
    /neal execute accepts exactly one plan file path argument/,
  );
  assert.throws(() => parseNewRunArgs(['frobnicate', 'plans/PLAN.md'], testAgentConfig()), /Unknown argument: frobnicate/);
});

test('parsePlanAndExecuteArgs accepts one or more existing plan file operands', () => {
  const defaults = testAgentConfig();

  assert.deepEqual(parsePlanAndExecuteArgs(['run', 'plans/A.md'], defaults), {
    planDocs: ['plans/A.md'],
    agentConfig: defaults,
    squashOnCompletion: true,
    unattended: false,
  });

  assert.deepEqual(parsePlanAndExecuteArgs(['run', 'plans/A.md', 'plans/B.md'], defaults), {
    planDocs: ['plans/A.md', 'plans/B.md'],
    agentConfig: defaults,
    squashOnCompletion: true,
    unattended: false,
  });

  assert.deepEqual(parsePlanAndExecuteArgs(['run', '--no-squash', 'plans/A.md'], defaults), {
    planDocs: ['plans/A.md'],
    agentConfig: defaults,
    squashOnCompletion: false,
    unattended: false,
  });

  assert.deepEqual(parsePlanAndExecuteArgs(['run', '--unattended', 'plans/A.md'], defaults), {
    planDocs: ['plans/A.md'],
    agentConfig: defaults,
    squashOnCompletion: true,
    unattended: true,
  });

  assert.deepEqual(parsePlanAndExecuteArgs(['run', '--no-squash', '--unattended', 'plans/A.md', 'plans/B.md'], defaults), {
    planDocs: ['plans/A.md', 'plans/B.md'],
    agentConfig: defaults,
    squashOnCompletion: false,
    unattended: true,
  });
});

test('parsePlanAndExecuteArgs rejects missing paths, unsupported commands, and flags', () => {
  assert.throws(
    () => parsePlanAndExecuteArgs(['run'], testAgentConfig()),
    /neal run requires at least one plan file path argument/,
  );
  assert.throws(
    () => parsePlanAndExecuteArgs(['frobnicate', 'plans/A.md'], testAgentConfig()),
    /Unknown argument: frobnicate/,
  );
  assert.throws(
    () => parsePlanAndExecuteArgs(['run', 'plans/A.md', '--unexpected'], testAgentConfig()),
    /unsupported flag: --unexpected/,
  );
  assert.throws(
    () => parsePlanAndExecuteArgs(['run', 'plans/A.md', '--unexpected'], testAgentConfig()),
    /unsupported flag: --unexpected/,
  );
});

test('parseReviewArgs supports default and positional review contexts', () => {
  assert.deepEqual(parseReviewArgs(['review', '--last', '3']), {
    instruction: DEFAULT_REVIEW_INSTRUCTION,
    instructionSource: 'default',
    selector: { kind: 'last', count: 3 },
  });
  assert.deepEqual(parseReviewArgs(['review', '--last', '3', 'Focus on auth/session handling.']), {
    instruction: 'Focus on auth/session handling.',
    instructionSource: 'positional',
    selector: { kind: 'last', count: 3 },
  });
  assert.deepEqual(parseReviewArgs(['review', ' Focus on auth/session handling. ', '--last', '3']), {
    instruction: 'Focus on auth/session handling.',
    instructionSource: 'positional',
    selector: { kind: 'last', count: 3 },
  });
  assert.deepEqual(parseReviewArgs(['review', ' Review this branch ', '--since', 'main']), {
    instruction: 'Review this branch',
    instructionSource: 'positional',
    selector: { kind: 'since', baseRef: 'main' },
  });
});

test('parseReviewArgs rejects invalid selector forms', () => {
  assert.throws(
    () => parseReviewArgs(['review', 'Review', '--last', '0']),
    /--last requires a positive integer count/,
  );
  assert.throws(
    () => parseReviewArgs(['review', 'Review', '--since', 'main..HEAD']),
    /--since accepts only a base ref/,
  );
  assert.throws(
    () => parseReviewArgs(['review', 'Review']),
    /requires exactly one selector/,
  );
});

test('parseReviewArgs rejects conflicting instructions, selectors, and incompatible command modes', () => {
  assert.throws(
    () => parseReviewArgs(['review', 'first context', 'second context', '--last', '1']),
    /accepts at most one positional message/,
  );
  assert.throws(
    () => parseReviewArgs(['review', '', '--last', '1']),
    /requires a non-empty positional message/,
  );
  assert.throws(
    () => parseReviewArgs(['review', '--last', '1', '--unexpected']),
    /Unknown argument: --unexpected/,
  );
  assert.throws(
    () => parseReviewArgs(['review', 'Review', '--last', '1', '--since', 'main']),
    /Choose exactly one review selector/,
  );
  assert.throws(
    () => parseReviewArgs(['review', 'Review', '--last', '1', '--unexpected']),
    /Unknown argument: --unexpected/,
  );
  assert.throws(
    () => parseReviewArgs(['review', 'Review', '--last', '1', '--unknown']),
    /Unknown argument: --unknown/,
  );
});

test('parseSquashArgs accepts an optional plan path', () => {
  assert.deepEqual(parseSquashArgs(['squash']), {
    planDoc: null,
  });
  const parsed = parseSquashArgs(['squash', 'plans/PLAN.md']);
  assert.deepEqual(parsed, {
    planDoc: 'plans/PLAN.md',
  });
});

test('parseSquashArgs rejects unsupported flags and extra arguments', () => {
  assert.throws(() => parseSquashArgs(['squash', '--unexpected']), /unsupported flag: --unexpected/);
  assert.throws(() => parseSquashArgs(['frobnicate', 'plans/PLAN.md']), /Unknown argument: frobnicate/);
  assert.throws(() => parseSquashArgs(['squash', 'plans/PLAN.md', '--unexpected']), /unsupported flag: --unexpected/);
  assert.throws(() => parseSquashArgs(['squash', 'plans/PLAN.md', 'other.md']), /at most one plan file path/);
});

test('parseResumeArgs accepts public run ids and optional guidance payloads', () => {
  assert.deepEqual(parseResumeArgs(['resume', '--message', 'try the smaller fix']), {
    runId: null,
    message: 'try the smaller fix',
  });
  assert.deepEqual(parseResumeArgs(['resume', '--run', 'run-1', '--message', 'try the smaller fix']), {
    runId: 'run-1',
    message: 'try the smaller fix',
  });
});

test('parseResumeArgs rejects unknown commands, extra operands, duplicate messages, and empty guidance', () => {
  assert.throws(
    () => parseResumeArgs(['resume', 'extra']),
    /accepts only --run <run-id> and optional --message <guidance>/,
  );
  assert.throws(
    () => parseResumeArgs(['frobnicate', '--run', 'run-1']),
    /Unknown argument: frobnicate/,
  );
  assert.throws(
    () => parseResumeArgs(['resume', '--message', 'first', '--message', 'second']),
    /neal resume accepts --message only once/,
  );
  assert.throws(
    () => parseResumeArgs(['resume', '--message', '   ']),
    /neal resume --message requires a non-empty guidance value/,
  );
});

test('parseCheckArgs accepts only the check subcommand', () => {
  assert.deepEqual(parseCheckArgs(['check']), {});
  assert.throws(() => parseCheckArgs(['check', '--providers']), /neal check accepts no arguments/);
  assert.throws(() => parseCheckArgs(['frobnicate']), /Unknown argument: frobnicate/);
});

test('parseSetupArgs accepts interactive, shared, and role-specific setup forms', () => {
  assert.deepEqual(parseSetupArgs(['setup']), {
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
  });
  assert.deepEqual(parseSetupArgs(['setup', '--provider', 'anthropic-claude', '--all-roles']), {
    force: false,
    allRoles: true,
    provider: 'anthropic-claude',
    model: null,
    coderProvider: null,
    coderModel: null,
    plannerProvider: null,
    plannerModel: null,
    reviewerProvider: null,
    reviewerModel: null,
  });
  assert.deepEqual(parseSetupArgs(['setup', '--provider', 'anthropic-claude', '--all-roles', '--planner-model', 'gpt-plan']), {
    force: false,
    allRoles: true,
    provider: 'anthropic-claude',
    model: null,
    coderProvider: null,
    coderModel: null,
    plannerProvider: null,
    plannerModel: 'gpt-plan',
    reviewerProvider: null,
    reviewerModel: null,
  });
  assert.deepEqual(
    parseSetupArgs([
      'setup',
      '--force',
      '--coder-provider',
      'openai-codex',
      '--coder-model',
      'gpt-test',
      '--planner-provider',
      'openai-codex',
      '--planner-model',
      'gpt-plan',
      '--reviewer-provider',
      'anthropic-claude',
      '--reviewer-model',
      'claude-test',
    ]),
    {
      force: true,
      allRoles: false,
      provider: null,
      model: null,
      coderProvider: 'openai-codex',
      coderModel: 'gpt-test',
      plannerProvider: 'openai-codex',
      plannerModel: 'gpt-plan',
      reviewerProvider: 'anthropic-claude',
      reviewerModel: 'claude-test',
    },
  );
});

test('parseSetupArgs rejects unsupported or ambiguous setup forms', () => {
  assert.throws(() => parseSetupArgs(['setup', '--unknown']), /Unknown argument: --unknown/);
  assert.throws(
    () => parseSetupArgs(['setup', '--force', '--force']),
    /neal setup accepts --force only once/,
  );
  assert.throws(
    () => parseSetupArgs(['setup', '--provider', 'anthropic-claude']),
    /--provider requires --all-roles/,
  );
  assert.throws(
    () => parseSetupArgs(['setup', '--all-roles']),
    /--all-roles requires --provider <provider-id>/,
  );
  assert.throws(
    () => parseSetupArgs(['setup', '--model', 'claude-sonnet-4-5']),
    /--model requires --provider <provider-id>/,
  );
  assert.throws(
    () => parseSetupArgs(['setup', '--provider', 'anthropic-claude', '--all-roles', '--coder-provider', 'openai-codex']),
    /cannot mix --provider with role-specific provider flags/,
  );
  assert.throws(
    () => parseSetupArgs(['setup', '--coder-model', 'gpt-test']),
    /--coder-model requires --coder-provider in the same invocation/,
  );
  assert.throws(
    () => parseSetupArgs(['setup', '--reviewer-model', 'claude-test']),
    /--reviewer-model requires --reviewer-provider in the same invocation/,
  );
  assert.throws(
    () => parseSetupArgs(['setup', '--planner-model', 'gpt-plan']),
    /--planner-model requires --planner-provider, --coder-provider, or --provider in the same invocation/,
  );
  assert.throws(
    () => parseSetupArgs(['setup', '--provider', 'not-a-provider', '--all-roles']),
    /Invalid provider for --provider: "not-a-provider"\. Registered providers:/,
  );
});

test('buildUsageLines teaches only the public command surface by default', () => {
  const usageLines = buildUsageLines('0.1.0');
  const usage = usageLines.join('\n');
  assert.match(usage, /^neal 0\.1\.0\n\nUsage: neal setup/m);
  assert.match(usage, /neal plan <plan\.md> \[--unattended\]/);
  assert.match(usage, /neal execute <plan\.md> \[--no-squash\] \[--unattended\]/);
  assert.match(usage, /neal run \[--no-squash\] \[--unattended\] <plan\.md> \[more-plans\.\.\.\]/);
  assert.match(usage, /neal resume \[--run <run-id>\] \[--message "\.\.\."\]/);
  assert.match(usage, /neal review \[message\] \(--last <n> \| --since <base>\)/);
  assert.match(usage, /neal squash \[plan\.md\]/);
  assert.match(usage, /neal check/);
  assert.match(usage, /neal setup/);
  assert.match(usage, /neal status \[--json\] \[--run <run-id>\]/);
  assert.match(usage, /neal status \[--json\] --all/);
  assert.match(usage, /neal version/);
  assert.match(usage, /neal --version/);
  assert.match(usage, /neal -V/);
  assert.match(usage, /neal help/);
  assert.match(usage, /neal --help/);
  assert.match(usage, /neal -h/);

  assert.doesNotMatch(usage, /# refine plan in place/);

  const setupUsage = usageLines.indexOf('Usage: neal setup');
  const planUsage = usageLines.indexOf('   or: neal plan <plan.md> [--unattended]');
  const plainResumeExample = usageLines.indexOf('  neal resume');
  const messageResumeExample = usageLines.indexOf('  neal resume --run <run-id> --message "Use the narrower helper approach."');
  const statusExample = usageLines.indexOf('  neal status');
  const statusAllExample = usageLines.indexOf('  neal status --all');
  const interactiveSetupExample = usageLines.indexOf('  neal setup');
  const setupExample = usageLines.indexOf('  neal setup --provider anthropic-claude --all-roles');
  assert.notEqual(setupUsage, -1);
  assert.notEqual(planUsage, -1);
  assert.notEqual(plainResumeExample, -1);
  assert.notEqual(messageResumeExample, -1);
  assert.notEqual(statusExample, -1);
  assert.notEqual(statusAllExample, -1);
  assert.notEqual(interactiveSetupExample, -1);
  assert.notEqual(setupExample, -1);
  assert.ok(setupUsage < planUsage);
  assert.ok(plainResumeExample < messageResumeExample);
  assert.ok(statusExample < statusAllExample);
  assert.ok(interactiveSetupExample < setupExample);
});
