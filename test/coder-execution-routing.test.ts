import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  buildCoderBlockedRecoveryDispositionSchema,
  buildCoderPlanResponseSchema,
  buildCoderPlanSchema,
  buildCoderResponseSchema,
  buildCoderScopeSchema,
  buildExecuteScopeProgressSchema,
  buildFinalCompletionReviewerSchema,
  buildFinalCompletionSummarySchema,
  buildPlanReviewerSchema,
  buildReviewerSchema,
  runCoderScopeRound,
  validateCoderPlanPayload,
  validateCoderPlanResponsePayload,
  validateCoderResponsePayload,
  validateCoderScopePayload,
} from '../src/neal/agents.js';
import {
  clearProviderDefinitionRegistrationsForTesting,
  registerProviderDefinitionForTesting,
} from '../src/neal/providers/registry.js';
import type { CoderRunPromptArgs, CoderStructuredPromptArgs } from '../src/neal/providers/types.js';
import {
  CODER_PREEXISTING_FAILURE_LINES,
  CODER_REGRESSION_PRESERVATION_LINE,
} from '../src/neal/prompts/execute.js';
import { createFakeProviderDefinition } from './helpers/fake-provider.js';

async function createExecutionFixture() {
  const cwd = await mkdtemp(join(tmpdir(), 'neal-execute-routing-'));
  const planDoc = join(cwd, 'PLAN.md');
  const progressMarkdownPath = join(cwd, 'PLAN_PROGRESS.md');
  await writeFile(planDoc, '## Execution Shape\n\nexecutionShape: one_shot\n', 'utf8');
  await writeFile(progressMarkdownPath, '## Current Scope\n- Number: 1\n', 'utf8');
  return { cwd, planDoc, progressMarkdownPath };
}

test('structured execution resume uses structured coder provider path', async () => {
  const fixture = await createExecutionFixture();
  let textRuns = 0;
  let structuredRuns = 0;
  registerProviderDefinitionForTesting(
    createFakeProviderDefinition({
      id: 'fake-execute-structured',
      coderStructuredResponses: [
        {
          action: 'scope_done',
          message: 'Implemented the bounded execution slice.',
          progress: {
            milestoneTargeted: 'Structured execution routing',
            newEvidence: 'The fake provider returned a CoderScopePayload.',
            whyNotRedundant: 'This covers the structured resume branch.',
            nextStepUnlocked: 'The scope can advance to review.',
          },
          manualGate: null,
          derivedPlan: '',
          blockedReason: '',
        },
      ],
      onCoderRun: async (_args: CoderRunPromptArgs) => {
        textRuns += 1;
      },
      onCoderStructuredRun: async (_args: CoderStructuredPromptArgs) => {
        structuredRuns += 1;
        assert.equal(_args.structuredJsonProtocol?.protocol, 'neal-json-block-v1');
        assert.equal(_args.structuredJsonProtocol?.schemaLabel, 'coder_scope_payload');
      },
    }),
  );
  try {
    const result = await runCoderScopeRound({
      coder: { provider: 'fake-execute-structured', model: null },
      cwd: fixture.cwd,
      planDoc: fixture.planDoc,
      progressMarkdownPath: fixture.progressMarkdownPath,
      sessionHandle: 'coder-execute-session',
      coderSessionProtocol: 'structured_json_v1',
    });

    assert.equal(result.marker, 'AUTONOMY_SCOPE_DONE');
    assert.equal(result.responseWithoutProgressPayload, 'Implemented the bounded execution slice.');
    assert.equal(result.progressJustification.milestoneTargeted, 'Structured execution routing');
    assert.equal(structuredRuns, 1);
    assert.equal(textRuns, 0);
  } finally {
    clearProviderDefinitionRegistrationsForTesting();
  }
});

test('coder structured validators reject malformed top-level payload shapes', () => {
  assert.throws(
    () => validateCoderScopePayload(null),
    /Coder scope round payload must be a non-null object/,
  );
  assert.throws(
    () =>
      validateCoderPlanPayload({
        action: 'ready_for_review',
        message: 'ready',
        executionShape: 'one_shot',
        planBody: 42,
        blockedReason: '',
      }),
    /Planner plan round payload\.planBody must be a string/,
  );
  assert.throws(
    () =>
      validateCoderPlanResponsePayload({
        outcome: 'responded',
        summary: 'fixed',
        blocker: '',
        responses: [{ id: 'F1', decision: 'fixed', summary: 12 }],
      }),
    /Planner plan-response round payload\.responses\[0\]\.summary must be a string/,
  );
  assert.throws(
    () =>
      validateCoderResponsePayload({
        outcome: 'split_plan',
        summary: 'needs replacement',
        blocker: '',
        derivedPlan: '',
        responses: [],
      }),
    /outcome=split_plan without a derivedPlan payload/,
  );
});

test('structured execution manual_gate returns no marker and preserves gate payload', async () => {
  const fixture = await createExecutionFixture();
  registerProviderDefinitionForTesting(
    createFakeProviderDefinition({
      id: 'fake-execute-manual-gate',
      coderStructuredResponses: [
        {
          action: 'manual_gate',
          message: 'Waiting for external approval.',
          progress: {
            milestoneTargeted: 'Manual approval gate',
            newEvidence: 'The provider requested deterministic external approval.',
            whyNotRedundant: 'This covers the structured manual gate branch.',
            nextStepUnlocked: 'Resume checks can continue the same coder scope.',
          },
          manualGate: {
            id: 'approval-1',
            title: 'Approve staging deployment',
            reason: 'The deployment requires a human approval outside Neal.',
            instructionsMarkdown: 'Approve the staging deployment in the external system.',
            resumeChecks: [{ type: 'command', name: 'approval marker', command: ['test', '-f', 'approved.txt'] }],
          },
          derivedPlan: '',
          blockedReason: '',
        },
      ],
    }),
  );
  try {
    const result = await runCoderScopeRound({
      coder: { provider: 'fake-execute-manual-gate', model: null },
      cwd: fixture.cwd,
      planDoc: fixture.planDoc,
      progressMarkdownPath: fixture.progressMarkdownPath,
      coderSessionProtocol: null,
    });

    assert.equal(result.marker, null);
    assert.equal(result.responseWithoutProgressPayload, 'Waiting for external approval.');
    assert.equal(result.finalResponse, 'Waiting for external approval.');
    assert.equal(result.manualGate?.id, 'approval-1');
    assert.deepEqual(result.manualGate?.resumeChecks[0].command, ['test', '-f', 'approved.txt']);
  } finally {
    clearProviderDefinitionRegistrationsForTesting();
  }
});

test('coder scope schema makes manual gate resume check defaults strict-schema safe', () => {
  const schema = buildCoderScopeSchema();
  const manualGateSchema = schema.properties.manualGate;
  assert.equal(Array.isArray(manualGateSchema.type), true);
  assert.notEqual(manualGateSchema.type, null);
  if (!('properties' in manualGateSchema)) {
    throw new Error('manualGate schema is missing object properties');
  }
  const resumeCheckSchema = manualGateSchema.properties.resumeChecks.items;
  assert.deepEqual(
    resumeCheckSchema.required,
    Object.keys(resumeCheckSchema.properties),
  );
  assert.deepEqual(resumeCheckSchema.properties.cwd.type, ['string', 'null']);
  assert.deepEqual(resumeCheckSchema.properties.timeoutMs.type, ['number', 'null']);
});

test('structured output schemas require every object property for strict provider schemas', () => {
  // buildPlanReviewerSchema (and buildConsultantSchema) intentionally keep
  // a genuinely-optional property (findingClass / targetCanonicalIds) out of
  // `required` to preserve their tolerant validator contract, so the canonical
  // emitted schema cannot satisfy the all-required contract. The openai-compatible
  // finalization detects such schemas and disables OpenAI strict mode on the
  // request (json_schema strict: false) so an omitted optional property survives
  // to the validator's default — proven against the real serialized transport, plus
  // the omitted- and invalid-findingClass provider-path tests, in
  // test/openai-compatible-provider.test.ts — so this exemption is behavior-backed
  // rather than a blind skip.
  const schemaBuilders = {
    buildReviewerSchema,
    buildCoderResponseSchema,
    buildCoderBlockedRecoveryDispositionSchema,
    buildCoderPlanResponseSchema,
    buildCoderPlanSchema,
    buildCoderScopeSchema,
    buildExecuteScopeProgressSchema,
    buildFinalCompletionSummarySchema,
    buildFinalCompletionReviewerSchema,
  };

  for (const [name, buildSchema] of Object.entries(schemaBuilders)) {
    assertObjectSchemasRequireEveryProperty(buildSchema(), name);
  }

  // The plan reviewer's optional findingClass stays out of the finding required
  // tuple (the tolerant validator contract); its provider-path omission and
  // rejection behavior is covered in test/openai-compatible-provider.test.ts.
  assert.equal(
    (buildPlanReviewerSchema().properties.findings.items.required as readonly string[]).includes('findingClass'),
    false,
  );
});

test('coder scope manual_gate treats nullable resume check defaults as omitted', () => {
  const payload = validateCoderScopePayload({
    action: 'manual_gate',
    message: 'Waiting for external approval.',
    progress: {
      milestoneTargeted: 'Manual approval gate',
      newEvidence: 'The provider requested deterministic external approval.',
      whyNotRedundant: 'This covers strict-schema nullable defaults.',
      nextStepUnlocked: 'Resume checks can continue the same coder scope.',
    },
    manualGate: {
      id: 'approval-1',
      title: 'Approve staging deployment',
      reason: 'The deployment requires a human approval outside Neal.',
      instructionsMarkdown: 'Approve the staging deployment in the external system.',
      resumeChecks: [
        {
          type: 'command',
          name: 'approval marker',
          command: ['test', '-f', 'approved.txt'],
          cwd: null,
          timeoutMs: null,
        },
      ],
    },
    derivedPlan: '',
    blockedReason: '',
  } as unknown as Parameters<typeof validateCoderScopePayload>[0]);

  assert.deepEqual(payload.manualGate?.resumeChecks, [
    {
      type: 'command',
      name: 'approval marker',
      command: ['test', '-f', 'approved.txt'],
    },
  ]);
});

test('legacy execution resume uses text coder provider path and legacy payload parsing', async () => {
  const fixture = await createExecutionFixture();
  let textRuns = 0;
  let structuredRuns = 0;
  let prompt = '';
  registerProviderDefinitionForTesting(
    createFakeProviderDefinition({
      id: 'fake-execute-legacy',
      coderResponses: [
        [
          'Legacy execution made progress.',
          '',
          'NEAL_PROGRESS_JUSTIFICATION_JSON_START',
          JSON.stringify({
            milestoneTargeted: 'Legacy execution routing',
            newEvidence: 'The fake provider returned delimited progress JSON.',
            whyNotRedundant: 'This covers the legacy resume branch.',
            nextStepUnlocked: 'The scope can advance to review.',
          }),
          'NEAL_PROGRESS_JUSTIFICATION_JSON_END',
          '',
          'AUTONOMY_SCOPE_DONE',
        ].join('\n'),
      ],
      onCoderRun: async (args: CoderRunPromptArgs) => {
        textRuns += 1;
        prompt = args.prompt;
      },
      onCoderStructuredRun: async (_args: CoderStructuredPromptArgs) => {
        structuredRuns += 1;
      },
    }),
  );
  try {
    const result = await runCoderScopeRound({
      coder: { provider: 'fake-execute-legacy', model: null },
      cwd: fixture.cwd,
      planDoc: fixture.planDoc,
      progressMarkdownPath: fixture.progressMarkdownPath,
      sessionHandle: 'coder-execute-session',
      coderSessionProtocol: 'legacy_marker_v1',
    });

    assert.equal(result.marker, 'AUTONOMY_SCOPE_DONE');
    assert.equal(result.responseWithoutProgressPayload, 'Legacy execution made progress.\n\nAUTONOMY_SCOPE_DONE');
    assert.equal(result.progressJustification.milestoneTargeted, 'Legacy execution routing');
    assert.equal(textRuns, 1);
    assert.equal(structuredRuns, 0);
    assert.match(prompt, /Final line must be exactly one of:/);
    assert.match(prompt, /NEAL_PROGRESS_JUSTIFICATION_JSON_START/);
    assert.equal(
      prompt.split(CODER_REGRESSION_PRESERVATION_LINE).length - 1,
      1,
      'legacy coder prompt must contain the regression-preservation line exactly once',
    );
    for (const line of CODER_PREEXISTING_FAILURE_LINES) {
      assert.equal(
        prompt.split(line).length - 1,
        1,
        `legacy coder prompt must contain the pre-existing-failure contract line exactly once: ${line}`,
      );
    }
  } finally {
    clearProviderDefinitionRegistrationsForTesting();
  }
});

test('coder pre-existing-failure contract lines stay field-vocabulary neutral', () => {
  for (const line of CODER_PREEXISTING_FAILURE_LINES) {
    assert.equal(
      line.includes('action='),
      false,
      `pre-existing-failure contract line must not bind to action-field vocabulary: ${line}`,
    );
    assert.equal(
      line.includes('outcome='),
      false,
      `pre-existing-failure contract line must not bind to outcome-field vocabulary: ${line}`,
    );
  }
});

function assertObjectSchemasRequireEveryProperty(schema: unknown, path: string) {
  const record = asRecord(schema);
  if (!record) {
    return;
  }

  const properties = asRecord(record.properties);
  const type = record.type;
  const isObjectSchema = type === 'object' || (Array.isArray(type) && type.includes('object'));
  if (isObjectSchema && properties) {
    const required = record.required;
    assert.ok(Array.isArray(required), `${path}.required is missing`);
    assert.deepEqual(
      [...required].sort(),
      Object.keys(properties).sort(),
      `${path}.required must include every property for strict structured output providers`,
    );
  }

  if (properties) {
    for (const [key, value] of Object.entries(properties)) {
      assertObjectSchemasRequireEveryProperty(value, `${path}.properties.${key}`);
    }
  }

  if ('items' in record) {
    assertObjectSchemasRequireEveryProperty(record.items, `${path}.items`);
  }
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

test('execution resume with missing coderSessionProtocol fails before provider invocation', async () => {
  const fixture = await createExecutionFixture();
  let textRuns = 0;
  let structuredRuns = 0;
  registerProviderDefinitionForTesting(
    createFakeProviderDefinition({
      id: 'fake-execute-missing-protocol',
      onCoderRun: async (_args: CoderRunPromptArgs) => {
        textRuns += 1;
      },
      onCoderStructuredRun: async (_args: CoderStructuredPromptArgs) => {
        structuredRuns += 1;
      },
    }),
  );
  try {
    await assert.rejects(
      runCoderScopeRound({
        coder: { provider: 'fake-execute-missing-protocol', model: null },
        cwd: fixture.cwd,
        planDoc: fixture.planDoc,
        progressMarkdownPath: fixture.progressMarkdownPath,
        sessionHandle: 'coder-execute-session',
        coderSessionProtocol: null,
      }),
      /Cannot resume coder scope session without coderSessionProtocol/,
    );
    assert.equal(textRuns, 0);
    assert.equal(structuredRuns, 0);
  } finally {
    clearProviderDefinitionRegistrationsForTesting();
  }
});
