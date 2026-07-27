import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

import { buildReviewerSchema, validateReviewerPayload } from '../src/neal/agents/schemas.js';
import {
  CONFLICTING_OUTPUT_FORMAT_MARKERS,
  assertNoConflictingOutputFormatInstruction,
  buildStructuredJsonPrompt,
  buildStructuredJsonRepairPrompt,
  extractStructuredJsonPayload,
  guardStructuredJsonOutputFormatLines,
  runStructuredJsonProtocol,
  runStructuredJsonRepairLoop,
  validateStructuredJsonPayload,
} from '../src/neal/agents/structured-json.js';
import { completionJsonOutputFormatLines } from '../src/neal/prompts/specialized.js';
import type { ProviderRuntimeEvent, StructuredJsonProtocolSpec } from '../src/neal/providers/types.js';
import type { ReviewerPayload } from '../src/neal/agents/schemas.js';

// Deterministic source-contract helpers (mirrors the comment-robust slicing
// used by test/prompt-spec-fixtures.test.ts): strip line and block comments so a
// commented-out call cannot satisfy or defeat a substring assertion, then slice
// a single exported function body from its declaration to the next top-level
// function declaration (or end-of-file).
function stripSourceComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1');
}

function sliceExportedFunctionBody(source: string, name: string): string {
  const declaration = `export function ${name}`;
  const start = source.indexOf(declaration);
  assert.notEqual(start, -1, `could not find ${declaration}`);
  const afterDeclaration = start + declaration.length;
  const boundary = /\n(export )?function /.exec(source.slice(afterDeclaration));
  const end = boundary ? afterDeclaration + boundary.index : source.length;
  return source.slice(start, end);
}

function validReviewerPayload(overrides: Partial<ReviewerPayload> = {}): ReviewerPayload {
  return {
    summary: 'Build succeeds and all tests pass.',
    findings: [],
    meaningfulProgressAction: 'accept',
    meaningfulProgressRationale: 'The scope materially advances the active objective.',
    ...overrides,
  };
}

function reviewerJson(payload: unknown = validReviewerPayload()) {
  return JSON.stringify(payload, null, 2);
}

function reviewerBlock(payload: unknown = validReviewerPayload(), prose = 'Review complete.') {
  return `${prose}\n\n\`\`\`neal-json\n${reviewerJson(payload)}\n\`\`\``;
}

function reviewerProtocol(
  overrides: Partial<StructuredJsonProtocolSpec<ReviewerPayload>> = {},
): StructuredJsonProtocolSpec<ReviewerPayload> {
  return {
    protocol: 'neal-json-block-v1',
    schemaLabel: 'reviewer_payload',
    schema: buildReviewerSchema(),
    validator: validateReviewerPayload,
    repairAttemptLimit: 2,
    ...overrides,
  };
}

test('prompt wrapper appends provider-neutral final neal-json block instructions', () => {
  const prompt = buildStructuredJsonPrompt('Review current scope.', {
    ...reviewerProtocol(),
    responseShapeHint: 'Use the caller-owned reviewer payload shape.',
    examplePayload: validReviewerPayload(),
  });

  assert.match(prompt, /^Review current scope\./);
  assert.match(prompt, /Protocol: neal-json-block-v1/);
  assert.match(prompt, /exactly one final fenced ```neal-json JSON block/);
  assert.match(prompt, /No non-whitespace content may appear after the closing fence/);
  assert.match(prompt, /Response shape guidance/);
  assert.match(prompt, /Example control payload/);
  assert.doesNotMatch(prompt, /Claude|Codex/);
});

test('extracts and validates prose followed by a final neal-json control block', () => {
  const rawJson = reviewerJson();
  const response = `Build succeeds.\n\nNo findings.\n\n\`\`\`neal-json\n${rawJson}\n\`\`\``;
  const result = validateStructuredJsonPayload(response, validateReviewerPayload);

  if (!result.ok) {
    assert.fail(result.errorSummary);
  }
  assert.equal(result.source, 'neal-json-block');
  assert.equal(result.prose, 'Build succeeds.\n\nNo findings.');
  assert.equal(result.rawJson, rawJson);
  assert.deepEqual(result.structured, validReviewerPayload());
});

test('accepts a raw whole-response JSON object when no neal-json block is present', () => {
  const result = validateStructuredJsonPayload(reviewerJson(), validateReviewerPayload);

  if (!result.ok) {
    assert.fail(result.errorSummary);
  }
  assert.equal(result.source, 'raw-json');
  assert.equal(result.prose, '');
  assert.deepEqual(result.structured, validReviewerPayload());
});

test('rejects raw JSON arrays before schema validation', () => {
  const result = validateStructuredJsonPayload('[]', validateReviewerPayload);

  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.phase, 'extraction');
    assert.equal(result.errorKind, 'malformed_json');
    assert.equal(result.extraction.rawJson, '[]');
    assert.match(result.errorSummary, /expected a single JSON object/);
  }
});

test('reports a missing control block when prose has no final JSON control payload', () => {
  const result = extractStructuredJsonPayload('Review complete with no structured payload.');

  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.errorKind, 'missing_control_block');
    assert.match(result.errorSummary, /final neal-json control block/);
  }
});

test('reports malformed JSON from a neal-json control block', () => {
  const result = extractStructuredJsonPayload('Review complete.\n\n```neal-json\n{"summary":\n```');

  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.errorKind, 'malformed_json');
    assert.equal(result.rawJson, '{"summary":');
    assert.match(result.errorSummary, /malformed JSON/);
  }
});

test('rejects multiple neal-json control blocks', () => {
  const response = `${reviewerBlock()}\n\nMore text.\n\n${reviewerBlock()}`;
  const result = extractStructuredJsonPayload(response);

  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.errorKind, 'multiple_control_blocks');
    assert.match(result.errorSummary, /found 2/);
  }
});

test('rejects a non-final neal-json control block', () => {
  const result = extractStructuredJsonPayload(`${reviewerBlock()}\n\nTrailing prose is not allowed.`);

  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.errorKind, 'non_final_control_block');
    assert.match(result.errorSummary, /final non-whitespace content/);
  }
});

test('preserves XML-ish and tool-call-like prose before a valid final control block', () => {
  const prose = [
    '<tool_call>{"name":"Bash","args":{"cmd":"git diff --stat"}}</tool_call>',
    '<tool_result>1 file changed, 8 insertions(+)</tool_result>',
    'The runtime path is covered by tests.',
  ].join('\n');
  const result = validateStructuredJsonPayload(reviewerBlock(validReviewerPayload(), prose), validateReviewerPayload);

  if (!result.ok) {
    assert.fail(result.errorSummary);
  }
  assert.equal(result.source, 'neal-json-block');
  assert.equal(result.prose, prose);
  assert.deepEqual(result.structured, validReviewerPayload());
});

test('repair loop succeeds after an initial parse failure', async () => {
  const initial = validateStructuredJsonPayload('Review complete.\n\n```neal-json\n{"summary":\n```', validateReviewerPayload);
  assert.equal(initial.ok, false);
  if (initial.ok) {
    assert.fail('initial response should fail parsing');
  }

  let capturedPrompt = '';
  const result = await runStructuredJsonRepairLoop({
    originalAssistantText: 'Review complete.\n\n```neal-json\n{"summary":\n```',
    initialFailure: initial,
    schemaLabel: 'reviewer_payload',
    schema: buildReviewerSchema(),
    attemptLimit: 2,
    validator: validateReviewerPayload,
    callRepair: async ({ prompt, attemptNumber, attemptLimit }) => {
      capturedPrompt = prompt;
      assert.equal(attemptNumber, 1);
      assert.equal(attemptLimit, 2);
      return {
        assistantText: reviewerBlock(),
        sessionHandle: 'repair-session-1',
      };
    },
  });

  if (!result.ok) {
    assert.fail(result.lastFailure.errorSummary);
  }
  assert.equal(result.attemptNumber, 1);
  assert.equal(result.sessionHandle, 'repair-session-1');
  assert.deepEqual(result.result.structured, validReviewerPayload());
  assert.match(capturedPrompt, /The neal-json control block contained malformed JSON/);
});

test('repair loop succeeds after an initial validation failure', async () => {
  const invalidPayload = {
    ...validReviewerPayload(),
    meaningfulProgressAction: 'maybe',
  };
  const initial = validateStructuredJsonPayload(reviewerBlock(invalidPayload), validateReviewerPayload);
  assert.equal(initial.ok, false);
  if (initial.ok) {
    assert.fail('initial response should fail validation');
  }

  const result = await runStructuredJsonRepairLoop({
    originalAssistantText: reviewerBlock(invalidPayload),
    initialFailure: initial,
    schemaLabel: 'reviewer_payload',
    schema: buildReviewerSchema(),
    attemptLimit: 2,
    validator: validateReviewerPayload,
    callRepair: async () => reviewerJson(),
  });

  if (!result.ok) {
    assert.fail(result.lastFailure.errorSummary);
  }
  assert.equal(result.result.source, 'raw-json');
  assert.deepEqual(result.result.structured, validReviewerPayload());
});

test('repair loop reports exhaustion after bounded failed attempts', async () => {
  const initial = validateStructuredJsonPayload('No structured control block.', validateReviewerPayload);
  assert.equal(initial.ok, false);
  if (initial.ok) {
    assert.fail('initial response should fail extraction');
  }

  const result = await runStructuredJsonRepairLoop({
    originalAssistantText: 'No structured control block.',
    initialFailure: initial,
    schemaLabel: 'reviewer_payload',
    schema: buildReviewerSchema(),
    attemptLimit: 2,
    validator: validateReviewerPayload,
    callRepair: async ({ attemptNumber }) =>
      attemptNumber === 1 ? '```neal-json\n{"summary":\n```' : 'Still no JSON.',
  });

  assert.equal(result.ok, false);
  if (result.ok) {
    assert.fail('repair should be exhausted');
  }
  assert.equal(result.attempts.length, 2);
  assert.equal(result.lastFailure.phase, 'extraction');
  assert.equal(result.lastFailure.errorKind, 'missing_control_block');
});

test('repair loop records empty repair responses as failed attempts', async () => {
  const initial = validateStructuredJsonPayload('No structured control block.', validateReviewerPayload);
  assert.equal(initial.ok, false);
  if (initial.ok) {
    assert.fail('initial response should fail extraction');
  }

  const result = await runStructuredJsonRepairLoop({
    originalAssistantText: 'No structured control block.',
    initialFailure: initial,
    schemaLabel: 'reviewer_payload',
    schema: buildReviewerSchema(),
    attemptLimit: 1,
    validator: validateReviewerPayload,
    callRepair: async () => ({
      assistantText: '   ',
      sessionHandle: 'empty-repair-session',
    }),
  });

  assert.equal(result.ok, false);
  if (result.ok) {
    assert.fail('empty repair response should be exhausted');
  }
  assert.equal(result.attempts.length, 1);
  assert.equal(result.attempts[0]?.sessionHandle, 'empty-repair-session');
  assert.equal(result.lastFailure.phase, 'extraction');
  assert.equal(result.lastFailure.errorKind, 'missing_control_block');
  assert.match(result.lastFailure.errorSummary, /raw whole-response JSON object/);
});

test('repair prompt includes parse and validation summaries', () => {
  const prompt = buildStructuredJsonRepairPrompt({
    originalAssistantText: 'Original review prose.',
    invalidJson: '{"summary": 42}',
    extractionErrorSummary: 'Unexpected token } in JSON.',
    validationErrorSummary: 'Reviewer payload.summary must be a string.',
    schemaLabel: 'reviewer_payload',
    schema: buildReviewerSchema(),
    attemptNumber: 2,
    attemptLimit: 3,
  });

  assert.match(prompt, /schema "reviewer_payload"/);
  assert.match(prompt, /Repair attempt 2 of 3/);
  assert.match(prompt, /Neal structured control payload/);
  assert.match(prompt, /Preserve the original control decision and substantive meaning/);
  assert.doesNotMatch(prompt, /review control payload/);
  assert.doesNotMatch(prompt, /original review decision/);
  assert.match(prompt, /Unexpected token } in JSON/);
  assert.match(prompt, /Reviewer payload\.summary must be a string/);
  assert.match(prompt, /Do not inspect the repository/);
  assert.match(prompt, /invent new implementation or review work/);
  assert.match(prompt, /Original assistant response/);
});

test('shared protocol runner wraps initial prompt and emits structured output only after validation succeeds', async () => {
  const events: ProviderRuntimeEvent[] = [];
  let initialPrompt = '';
  const result = await runStructuredJsonProtocol({
    provider: 'test-provider',
    role: 'structured-advisor',
    label: 'review',
    protocol: reviewerProtocol(),
    prompt: 'Review current scope.',
    events: (event) => {
      events.push(event);
    },
    runInitial: async (prompt) => {
      initialPrompt = prompt;
      return {
        assistantText: reviewerBlock(),
        sessionHandle: 'initial-session',
      };
    },
    runRepair: async () => {
      assert.fail('repair should not run when initial payload is valid');
    },
  });

  assert.equal(result.sessionHandle, 'initial-session');
  assert.deepEqual(result.structured, validReviewerPayload());
  assert.match(initialPrompt, /Neal structured control protocol/);
  assert.deepEqual(
    events.map((event) => event.type === 'tool_progress' ? event.toolName : event.type),
    ['structured_json_extraction_started', 'structured_output_received'],
  );
  assert.equal(events.at(-1)?.type, 'structured_output_received');
});

test('shared protocol runner repairs invalid initial payload before emitting structured output', async () => {
  const events: ProviderRuntimeEvent[] = [];
  const result = await runStructuredJsonProtocol({
    provider: 'test-provider',
    role: 'structured-advisor',
    label: 'review',
    protocol: reviewerProtocol(),
    prompt: 'Review current scope.',
    events: (event) => {
      events.push(event);
    },
    runInitial: async () => ({
      assistantText: 'Review done without a control payload.',
      sessionHandle: 'initial-session',
    }),
    runRepair: async (prompt, attemptNumber) => {
      assert.equal(attemptNumber, 1);
      assert.match(prompt, /No JSON payload was extracted/);
      return {
        assistantText: reviewerBlock(),
        sessionHandle: 'repair-session',
      };
    },
  });

  assert.equal(result.sessionHandle, 'initial-session');
  assert.deepEqual(result.structured, validReviewerPayload());
  assert.deepEqual(
    events.map((event) => event.type === 'tool_progress' ? event.toolName : event.type),
    [
      'structured_json_extraction_started',
      'structured_json_extraction_failed',
      'structured_json_repair_started',
      'structured_json_repair_succeeded',
      'structured_output_received',
    ],
  );
  assert.equal(events.at(-1)?.type, 'structured_output_received');
  assert.equal(events.at(-1)?.sessionHandle, 'initial-session');
});

test('shared protocol runner throws provider error after repair exhaustion', async () => {
  const events: ProviderRuntimeEvent[] = [];
  await assert.rejects(
    () =>
      runStructuredJsonProtocol({
        provider: 'test-provider',
        role: 'structured-advisor',
        label: 'review',
        protocol: reviewerProtocol({ repairAttemptLimit: 1 }),
        prompt: 'Review current scope.',
        events: (event) => {
          events.push(event);
        },
        runInitial: async () => ({
          assistantText: 'Review done without a control payload.',
          sessionHandle: 'initial-session',
        }),
        runRepair: async () => ({
          assistantText: 'Still no control payload.',
          sessionHandle: 'repair-session',
        }),
      }),
    /remained invalid after 1 repair attempt/,
  );

  assert.deepEqual(
    events.map((event) => event.type === 'tool_progress' ? event.toolName : event.type),
    [
      'structured_json_extraction_started',
      'structured_json_extraction_failed',
      'structured_json_repair_started',
      'structured_json_extraction_failed',
      'structured_json_repair_failed',
    ],
  );
  assert.equal(events.some((event) => event.type === 'structured_output_received'), false);
});

test('validateReviewerPayload accepts the buildReviewerSchema shape from unknown', () => {
  assert.deepEqual(validateReviewerPayload(validReviewerPayload()), validReviewerPayload());
  assert.deepEqual(
    validateReviewerPayload({
      ...validReviewerPayload(),
      findings: [
        {
          severity: 'blocking',
          files: ['src/neal/index.ts'],
          claim: 'The CLI exits early.',
          evidence: 'The changed branch returns before verification.',
          requiredAction: 'Move verification before the return.',
        },
      ],
    }),
    {
      ...validReviewerPayload(),
      findings: [
        {
          severity: 'blocking',
          files: ['src/neal/index.ts'],
          claim: 'The CLI exits early.',
          evidence: 'The changed branch returns before verification.',
          requiredAction: 'Move verification before the return.',
        },
      ],
    },
  );
});

test('validateReviewerPayload rejects invalid enum values', () => {
  assert.throws(
    () =>
      validateReviewerPayload({
        ...validReviewerPayload(),
        meaningfulProgressAction: 'maybe',
      }),
    /meaningfulProgressAction.*exactly one of/,
  );
  assert.throws(
    () =>
      validateReviewerPayload({
        ...validReviewerPayload(),
        findings: [
          {
            severity: 'warning',
            files: [],
            claim: 'Claim.',
            evidence: 'Evidence.',
            requiredAction: 'Action.',
          },
        ],
      }),
    /findings\[0\]\.severity.*exactly one of/,
  );
});

test('validateReviewerPayload rejects missing required fields and wrong field types', () => {
  assert.throws(
    () =>
      validateReviewerPayload({
        findings: [],
        meaningfulProgressAction: 'accept',
        meaningfulProgressRationale: 'Rationale.',
      }),
    /missing required property "summary"/,
  );
  assert.throws(
    () =>
      validateReviewerPayload({
        ...validReviewerPayload(),
        summary: 42,
      }),
    /summary must be a string/,
  );
  assert.throws(
    () =>
      validateReviewerPayload({
        ...validReviewerPayload(),
        findings: 'none',
      }),
    /findings must be an array/,
  );
});

test('validateReviewerPayload rejects invalid nullability', () => {
  assert.throws(
    () =>
      validateReviewerPayload({
        ...validReviewerPayload(),
        summary: null,
      }),
    /summary must be a string/,
  );
  assert.throws(
    () => validateReviewerPayload(null),
    /Reviewer payload must be a non-null object/,
  );
});

test('validateReviewerPayload rejects invalid nested object and array element shapes', () => {
  assert.throws(
    () =>
      validateReviewerPayload({
        ...validReviewerPayload(),
        findings: [null],
      }),
    /findings\[0\] must be a non-null object/,
  );
  assert.throws(
    () =>
      validateReviewerPayload({
        ...validReviewerPayload(),
        findings: [
          {
            severity: 'blocking',
            files: ['src/neal/index.ts', 7],
            claim: 'Claim.',
            evidence: 'Evidence.',
            requiredAction: 'Action.',
          },
        ],
      }),
    /findings\[0\]\.files\[1\] must be a string/,
  );
});

test('assertNoConflictingOutputFormatInstruction rejects every transport-conflicting marker case-insensitively', () => {
  assert.ok(CONFLICTING_OUTPUT_FORMAT_MARKERS.length > 0, 'the conflicting-marker list must be non-empty');
  assert.doesNotThrow(() =>
    assertNoConflictingOutputFormatInstruction('Return only JSON that matches the required schema.', 'test'),
  );

  for (const marker of CONFLICTING_OUTPUT_FORMAT_MARKERS) {
    assert.throws(
      () => assertNoConflictingOutputFormatInstruction(`Some instruction mentioning ${marker} here.`, 'test'),
      /conflict with the neal-json transport contract/,
      `marker should be rejected: ${marker}`,
    );
    assert.throws(
      () => assertNoConflictingOutputFormatInstruction(`case-insensitive ${marker.toUpperCase()} mention`, 'test'),
      /conflict with the neal-json transport contract/,
      `marker should be rejected case-insensitively: ${marker}`,
    );
  }
});

test('guardStructuredJsonOutputFormatLines throws on any injected marker and passes clean lines through unchanged', () => {
  const cleanLines = completionJsonOutputFormatLines('test');
  assert.doesNotThrow(() => guardStructuredJsonOutputFormatLines(cleanLines, 'x'));
  assert.deepEqual(guardStructuredJsonOutputFormatLines(cleanLines, 'x'), cleanLines);

  for (const marker of CONFLICTING_OUTPUT_FORMAT_MARKERS) {
    assert.throws(
      () => guardStructuredJsonOutputFormatLines([...cleanLines, `An injected line with ${marker} in it.`], 'x'),
      /conflict with the neal-json transport contract/,
      `injecting marker through the guarded unit should throw: ${marker}`,
    );
  }
});

test('completionJsonOutputFormatLines pins the exact provider-neutral guarded output-format lines both completion builders consume', () => {
  const expected = [
    'Return only JSON that matches the required schema.',
    'Return the final answer only as the required structured output object, not as prose or markdown.',
    'Defer exact output framing to the active structured-output transport; do not add your own output-format constraints.',
  ];
  assert.doesNotThrow(() => completionJsonOutputFormatLines('buildFinalCompletionSummaryPrompt'));
  assert.deepEqual(completionJsonOutputFormatLines('buildFinalCompletionSummaryPrompt'), expected);
  assert.deepEqual(completionJsonOutputFormatLines('buildFinalCompletionReviewerPrompt'), expected);

  // Regression: the transport-deferring line must stay provider-neutral. The
  // neal-json protocol block is appended below the base prompt only on the
  // wrapper path (anthropic-claude + repair loop); other transports such as
  // openai-compatible send the base prompt with no protocol below it, so the
  // output-format framing must never claim instructions appear "below".
  for (const label of ['buildFinalCompletionSummaryPrompt', 'buildFinalCompletionReviewerPrompt']) {
    for (const line of completionJsonOutputFormatLines(label)) {
      assert.doesNotMatch(line, /below/i, `output-format line must not claim a protocol appears below: ${line}`);
    }
  }
});

test('completion builders route all output-format lines through the guarded completionJsonOutputFormatLines helper', async () => {
  const source = await readFile(
    fileURLToPath(new URL('../src/neal/prompts/specialized.ts', import.meta.url)),
    'utf8',
  );
  const stripped = stripSourceComments(source);

  // The helper must return the guarded assembly (with `label` passed as the
  // second argument), never a raw array that bypasses the guard.
  const helperSlice = sliceExportedFunctionBody(stripped, 'completionJsonOutputFormatLines');
  // Require the guarded call to be the returned value (return immediately
  // precedes it), so a `guardStructuredJsonOutputFormatLines(...); return [raw]`
  // bypass cannot satisfy this contract.
  assert.match(
    helperSlice,
    /return\s+guardStructuredJsonOutputFormatLines\(\s*\[[\s\S]*?\]\s*,\s*label\s*,?\s*\)/,
    'helper must return the guarded assembly with label passed as the second argument',
  );
  assert.equal(helperSlice.includes('return ['), false, 'helper must not return a raw array bypassing the guard');

  // Derive the helper-owned literals from the helper itself so every
  // output-format line it owns is covered; the label does not affect content.
  const helperOwnedLines = completionJsonOutputFormatLines('buildFinalCompletionSummaryPrompt');
  for (const name of ['buildFinalCompletionSummaryPrompt', 'buildFinalCompletionReviewerPrompt']) {
    const slice = sliceExportedFunctionBody(stripped, name);
    assert.equal(
      slice.split('...completionJsonOutputFormatLines(').length - 1,
      1,
      `${name} must spread the guarded helper exactly once`,
    );
    for (const line of helperOwnedLines) {
      assert.equal(
        slice.includes(line),
        false,
        `${name} must not inline the helper-owned output-format line: ${line}`,
      );
    }
  }
});

test('validateReviewerPayload rejects unknown top-level and nested properties', () => {
  assert.throws(
    () =>
      validateReviewerPayload({
        ...validReviewerPayload(),
        extra: true,
      }),
    /unknown property "extra"/,
  );
  assert.throws(
    () =>
      validateReviewerPayload({
        ...validReviewerPayload(),
        findings: [
          {
            severity: 'blocking',
            files: [],
            claim: 'Claim.',
            evidence: 'Evidence.',
            requiredAction: 'Action.',
            extra: true,
          },
        ],
      }),
    /findings\[0\].*unknown property "extra"/,
  );
});
