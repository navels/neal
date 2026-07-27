import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  runCoderPlanResponseRound,
  runCoderPlanRound,
  runCoderScopeRound,
  runPlanReviewerRound,
} from '../src/neal/agents.js';
import {
  clearProviderDefinitionRegistrationsForTesting,
  registerProviderDefinitionForTesting,
} from '../src/neal/providers/registry.js';
import type {
  CoderAdapter,
  CoderRunPromptArgs,
  CoderRunPromptResult,
  CoderStructuredPromptArgs,
  CoderStructuredPromptResult,
  NealProviderDefinition,
  ProviderAdapterOptions,
  StructuredAdvisorAdapter,
  StructuredAdvisorRoundArgs,
  StructuredAdvisorRoundResult,
} from '../src/neal/providers/types.js';
import { createFakeProviderDefinition } from './helpers/fake-provider.js';

function captureProviderEvents() {
  const events: Array<{ type: string; data?: Record<string, unknown> }> = [];
  return {
    events,
    logger: {
      event: async (type: string, data?: Record<string, unknown>) => {
        events.push({ type, data });
      },
      stderr: async () => {},
    },
  };
}

test('role-specific model overrides route through planner, coder, and reviewer adapter factories', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'neal-role-model-routing-'));
  const planDoc = join(cwd, 'PLAN.md');
  const progressMarkdownPath = join(cwd, 'PLAN_PROGRESS.md');
  const reviewMarkdownPath = join(cwd, 'REVIEW.md');
  await writeFile(planDoc, '# Plan\n', 'utf8');
  await writeFile(progressMarkdownPath, '# Progress\n', 'utf8');
  await writeFile(reviewMarkdownPath, '# Review\n', 'utf8');
  const coderModels: Array<string | null> = [];
  const reviewerModels: Array<string | null> = [];
  const structuredCoderLabels: string[] = [];
  const reviewerLabels: string[] = [];

  const provider: NealProviderDefinition = {
    id: 'fake-three-role-model-routing',
    displayName: 'Fake Three Role Model Routing',
    capabilities: {
      coder: {
        supported: true,
        toolAccess: { read: true, write: true, shell: true },
        supportsSessionResume: true,
        supportsModelOverride: true,
        supportsStructuredOutput: true,
        usageReporting: 'none',
      },
      'structured-advisor': {
        supported: true,
        toolAccess: { read: true, write: false, shell: false },
        supportsSessionResume: true,
        supportsModelOverride: true,
        supportsStructuredOutput: true,
        usageReporting: 'none',
      },
    },
    createCoderAdapter(options?: ProviderAdapterOptions): CoderAdapter {
      coderModels.push(options?.model ?? null);
      return {
        async runPrompt(_args: CoderRunPromptArgs): Promise<CoderRunPromptResult> {
          return { sessionHandle: 'legacy-coder-session', finalResponse: 'legacy response' };
        },
        async runStructuredPrompt<TStructured>(
          args: CoderStructuredPromptArgs,
        ): Promise<CoderStructuredPromptResult<TStructured>> {
          structuredCoderLabels.push(args.label);
          const structured =
            args.label === 'Planner plan round'
              ? {
                  action: 'ready_for_review',
                  message: 'Planner authored the plan.',
                  executionShape: 'one_shot',
                  planBody: '## Execution Shape\n\nexecutionShape: one_shot',
                  blockedReason: '',
                }
              : {
                  action: 'scope_done',
                  message: 'Coder completed the scope.',
                  progress: {
                    milestoneTargeted: 'Role routing smoke',
                    newEvidence: 'The coder adapter returned a scope payload.',
                    whyNotRedundant: 'This exercises the execute role after planner authoring.',
                    nextStepUnlocked: 'The reviewer can inspect the completed scope.',
                  },
                  manualGate: null,
                  derivedPlan: '',
                  blockedReason: '',
                };
          return {
            sessionHandle: `${args.label === 'Planner plan round' ? 'planner' : 'coder'}-session`,
            structured: structured as TStructured,
          };
        },
      };
    },
    createStructuredAdvisorAdapter(options?: ProviderAdapterOptions): StructuredAdvisorAdapter {
      reviewerModels.push(options?.model ?? null);
      return {
        async runStructuredRound<TStructured>(
          args: StructuredAdvisorRoundArgs,
        ): Promise<StructuredAdvisorRoundResult<TStructured>> {
          reviewerLabels.push(args.label);
          return {
            sessionHandle: 'reviewer-session',
            structured: {
              summary: 'Reviewer accepted the routed work.',
              executionShape: 'one_shot',
              findings: [],
            } as TStructured,
          };
        },
      };
    },
  };

  registerProviderDefinitionForTesting(provider);
  try {
    const planResult = await runCoderPlanRound({
      coder: { provider: provider.id, model: 'planner-model' },
      cwd,
      planDoc,
      sessionHandle: null,
      coderSessionProtocol: null,
    });
    const scopeResult = await runCoderScopeRound({
      coder: { provider: provider.id, model: 'coder-model' },
      cwd,
      planDoc,
      progressMarkdownPath,
      sessionHandle: null,
      coderSessionProtocol: null,
    });
    const reviewResult = await runPlanReviewerRound({
      reviewer: { provider: provider.id, model: 'reviewer-model' },
      cwd,
      planDoc,
      round: 1,
      reviewMarkdownPath,
    });

    assert.equal(planResult.marker, 'AUTONOMY_DONE');
    assert.equal(scopeResult.marker, 'AUTONOMY_SCOPE_DONE');
    assert.equal(reviewResult.summary, 'Reviewer accepted the routed work.');
    assert.deepEqual(coderModels, ['planner-model', 'coder-model']);
    assert.deepEqual(structuredCoderLabels, ['Planner plan round', 'Coder scope round']);
    assert.deepEqual(reviewerModels, ['reviewer-model']);
    assert.deepEqual(reviewerLabels, ['plan-review']);
  } finally {
    clearProviderDefinitionRegistrationsForTesting();
  }
});

test('structured planning resume uses structured coder provider path', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'neal-plan-routing-'));
  const planDoc = join(cwd, 'PLAN.md');
  await writeFile(planDoc, '# Existing Plan\n\nSENTINEL_CURRENT_PLAN_TEXT\n', 'utf8');
  let textRuns = 0;
  let structuredRuns = 0;
  let prompt = '';
  let toolPolicy: CoderStructuredPromptArgs['toolPolicy'] | undefined;
  registerProviderDefinitionForTesting(
    createFakeProviderDefinition({
      id: 'fake-plan-structured',
      coderStructuredResponses: [
        {
          action: 'ready_for_review',
          message: 'ready',
          executionShape: 'one_shot',
          planBody: '# Plan\n\n## Goal\n\nDo the bounded thing.\n',
          blockedReason: '',
        },
      ],
      onCoderRun: async (_args: CoderRunPromptArgs) => {
        textRuns += 1;
      },
      onCoderStructuredRun: async (args: CoderStructuredPromptArgs) => {
        structuredRuns += 1;
        prompt = args.prompt;
        toolPolicy = args.toolPolicy;
      },
    }),
  );
  try {
    const result = await runCoderPlanRound({
      coder: { provider: 'fake-plan-structured', model: null },
      cwd,
      planDoc,
      sessionHandle: 'coder-plan-session',
      coderSessionProtocol: 'structured_json_v1',
    });

    assert.equal(result.marker, 'AUTONOMY_DONE');
    assert.equal(structuredRuns, 1);
    assert.equal(textRuns, 0);
    assert.deepEqual(toolPolicy, { allowedWritePaths: [planDoc], allowRun: false });
    assert.match(prompt, /SENTINEL_CURRENT_PLAN_TEXT/);
    assert.equal(
      await readFile(planDoc, 'utf8'),
      '# Plan\n\n## Execution Shape\n\nexecutionShape: one_shot\n\n## Goal\n\nDo the bounded thing.\n',
    );
  } finally {
    clearProviderDefinitionRegistrationsForTesting();
  }
});

test('legacy planning resume uses text coder provider path', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'neal-plan-routing-'));
  let textRuns = 0;
  let structuredRuns = 0;
  let prompt = '';
  let toolPolicy: CoderRunPromptArgs['toolPolicy'] | undefined;
  registerProviderDefinitionForTesting(
    createFakeProviderDefinition({
      id: 'fake-plan-legacy',
      coderResponses: ['legacy response\n\nAUTONOMY_DONE'],
      onCoderRun: async (_args: CoderRunPromptArgs) => {
        textRuns += 1;
        prompt = _args.prompt;
        toolPolicy = _args.toolPolicy;
      },
      onCoderStructuredRun: async (_args: CoderStructuredPromptArgs) => {
        structuredRuns += 1;
      },
    }),
  );
  try {
    const result = await runCoderPlanRound({
      coder: { provider: 'fake-plan-legacy', model: null },
      cwd,
      planDoc: join(cwd, 'PLAN.md'),
      sessionHandle: 'coder-plan-session',
      coderSessionProtocol: 'legacy_marker_v1',
    });

    assert.equal(result.marker, 'AUTONOMY_DONE');
    assert.equal(textRuns, 1);
    assert.equal(structuredRuns, 0);
    assert.deepEqual(toolPolicy, { allowedWritePaths: [join(cwd, 'PLAN.md')], allowRun: false });
    assert.match(prompt, /Final line must be exactly one of:/);
    assert.match(prompt, /- AUTONOMY_DONE/);
    assert.doesNotMatch(prompt, /Return only a structured planning envelope/);
  } finally {
    clearProviderDefinitionRegistrationsForTesting();
  }
});

test('legacy planning resume does not infer a marker from structured-shaped JSON', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'neal-plan-routing-'));
  let textRuns = 0;
  let structuredRuns = 0;
  registerProviderDefinitionForTesting(
    createFakeProviderDefinition({
      id: 'fake-plan-legacy-json',
      coderResponses: [
        JSON.stringify({
          action: 'ready_for_review',
          message: 'ready',
          executionShape: 'one_shot',
          planBody: '## Execution Shape\n\nexecutionShape: one_shot',
          blockedReason: '',
        }),
      ],
      onCoderRun: async (_args: CoderRunPromptArgs) => {
        textRuns += 1;
      },
      onCoderStructuredRun: async (_args: CoderStructuredPromptArgs) => {
        structuredRuns += 1;
      },
    }),
  );
  try {
    const result = await runCoderPlanRound({
      coder: { provider: 'fake-plan-legacy-json', model: null },
      cwd,
      planDoc: join(cwd, 'PLAN.md'),
      sessionHandle: 'coder-plan-session',
      coderSessionProtocol: 'legacy_marker_v1',
    });

    assert.equal(result.marker, null);
    assert.equal(textRuns, 1);
    assert.equal(structuredRuns, 0);
  } finally {
    clearProviderDefinitionRegistrationsForTesting();
  }
});

test('planning resume without protocol fails before provider invocation', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'neal-plan-routing-'));
  let providerRuns = 0;
  registerProviderDefinitionForTesting(
    createFakeProviderDefinition({
      id: 'fake-plan-null-protocol',
      onCoderRun: async (_args: CoderRunPromptArgs) => {
        providerRuns += 1;
      },
      onCoderStructuredRun: async (_args: CoderStructuredPromptArgs) => {
        providerRuns += 1;
      },
    }),
  );
  try {
    await assert.rejects(
      () =>
        runCoderPlanRound({
          coder: { provider: 'fake-plan-null-protocol', model: null },
          cwd,
          planDoc: join(cwd, 'PLAN.md'),
          sessionHandle: 'coder-plan-session',
          coderSessionProtocol: null,
        }),
      /Cannot resume planner planning session without plannerSessionProtocol/,
    );
    assert.equal(providerRuns, 0);
  } finally {
    clearProviderDefinitionRegistrationsForTesting();
  }
});

test('plan-response telemetry carries planner display label on the coder adapter path', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'neal-plan-response-telemetry-'));
  const { events, logger } = captureProviderEvents();
  const planDoc = join(cwd, 'PLAN.md');
  let toolPolicy: CoderStructuredPromptArgs['toolPolicy'] | undefined;
  registerProviderDefinitionForTesting(
    createFakeProviderDefinition({
      id: 'fake-plan-response-telemetry',
      coderStructuredResponses: [
        {
          outcome: 'responded',
          summary: 'Addressed the finding.',
          blocker: '',
          responses: [],
        },
      ],
      onCoderStructuredRun: async (args: CoderStructuredPromptArgs) => {
        toolPolicy = args.toolPolicy;
        await args.events?.({
          type: 'turn_started',
          provider: 'fake-plan-response-telemetry',
          role: 'coder',
        });
      },
    }),
  );

  try {
    await runCoderPlanResponseRound({
      coder: { provider: 'fake-plan-response-telemetry', model: null },
      cwd,
      planDoc,
      openFindings: [],
      sessionHandle: 'planner-session-1',
      logger: logger as any,
    });

    const event = events.find((item) => item.type === 'provider.turn_started');
    assert.equal(event?.data?.role, 'coder');
    assert.equal(event?.data?.label, 'planner');
    assert.deepEqual(toolPolicy, { allowedWritePaths: [planDoc], allowRun: false });
  } finally {
    clearProviderDefinitionRegistrationsForTesting();
  }
});

