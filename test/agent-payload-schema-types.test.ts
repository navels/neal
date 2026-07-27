// Compile-time contract checks for the exported build*Schema return types.
//
// The zod migration derives the emitted JSON Schemas at runtime, so the
// builders' precise literal return shapes are declared types backed by the
// byte-level serialization pins in test/agent-payload-schemas.test.ts. This
// file makes the DECLARED types themselves part of the verified contract:
// - Equal/Expect assertions pin representative literal node types (enum and
//   required tuples, scalar node shapes, nullable type arrays) for every
//   exported builder;
// - plain typed traversal proves `properties`/`items` remain navigable
//   without casts;
// - @ts-expect-error directives prove nonexistent fields are rejected and
//   nodes stay readonly (an unused directive fails `pnpm typecheck`).
// The runtime test at the bottom spot-checks that representative deep nodes
// carry the values the declared types promise.

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  buildConsultantSchema,
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
  EXECUTE_SCOPE_PROGRESS_PAYLOAD_END,
  EXECUTE_SCOPE_PROGRESS_PAYLOAD_START,
  parseExecuteScopeProgressPayload,
  parseFinalCompletionReviewerPayload,
  validateConsultantVerdictPayload,
  validateCoderResponsePayload,
  validateCoderScopePayload,
} from '../src/neal/agents/schemas.js';

type Expect<T extends true> = T;
type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;

const reviewerSchema = buildReviewerSchema();
const planReviewerSchema = buildPlanReviewerSchema();
const consultantSchema = buildConsultantSchema();
const coderResponseSchema = buildCoderResponseSchema();
const coderBlockedRecoverySchema = buildCoderBlockedRecoveryDispositionSchema();
const coderPlanResponseSchema = buildCoderPlanResponseSchema();
const coderPlanSchema = buildCoderPlanSchema();
const coderScopeSchema = buildCoderScopeSchema();
const executeScopeProgressSchema = buildExecuteScopeProgressSchema();
const finalCompletionSummarySchema = buildFinalCompletionSummarySchema();
const finalCompletionReviewerSchema = buildFinalCompletionReviewerSchema();

// Typed traversal: nested properties/items stay navigable without casts.
const reviewerFindingSchema = reviewerSchema.properties.findings.items;
const resumeCheckSchema = coderScopeSchema.properties.manualGate.properties.resumeChecks.items;
const squashDraftSchema = finalCompletionReviewerSchema.properties.squashCommitMessage;

// Representative literal types for every exported builder.
type _ReviewerTopLevelType = Expect<Equal<typeof reviewerSchema.type, 'object'>>;
type _ReviewerSummaryNode = Expect<Equal<typeof reviewerSchema.properties.summary, { readonly type: 'string' }>>;
type _ReviewerRequired = Expect<
  Equal<
    typeof reviewerSchema.required,
    readonly ['summary', 'findings', 'meaningfulProgressAction', 'meaningfulProgressRationale']
  >
>;
type _ReviewerProgressActionEnum = Expect<
  Equal<
    typeof reviewerSchema.properties.meaningfulProgressAction.enum,
    readonly ['accept', 'block_for_operator', 'replace_plan', 'advance_parent']
  >
>;
type _ReviewerFindingSeverityEnum = Expect<
  Equal<typeof reviewerFindingSchema.properties.severity.enum, readonly ['blocking', 'non_blocking']>
>;
type _ReviewerAdditionalProperties = Expect<Equal<typeof reviewerSchema.additionalProperties, false>>;

type _PlanReviewerRequired = Expect<
  Equal<typeof planReviewerSchema.required, readonly ['summary', 'executionShape', 'findings']>
>;
type _PlanReviewerShapeEnum = Expect<
  Equal<
    typeof planReviewerSchema.properties.executionShape.enum,
    readonly ['one_shot', 'multi_scope', 'multi_scope_unknown']
  >
>;
// findingClass is present as a plan-review finding property with the class enum,
// but stays out of the finding `required` tuple (its optionality at the payload
// boundary): an absent class is normalized to plan_correctness downstream.
const planReviewerFindingSchema = planReviewerSchema.properties.findings.items;
type _PlanReviewerFindingClassEnum = Expect<
  Equal<
    typeof planReviewerFindingSchema.properties.findingClass.enum,
    readonly ['plan_correctness', 'verification_hardening']
  >
>;
type _PlanReviewerFindingRequired = Expect<
  Equal<typeof planReviewerFindingSchema.required, readonly ['severity', 'files', 'claim', 'requiredAction']>
>;

type _ConsultantRequired = Expect<
  Equal<
    typeof consultantSchema.required,
    readonly ['recoverable', 'triageCategory', 'resolutionDirective', 'rationale']
  >
>;
type _ConsultantRecoverableNode = Expect<
  Equal<typeof consultantSchema.properties.recoverable, { readonly type: 'boolean' }>
>;
type _ConsultantTriageEnum = Expect<
  Equal<
    typeof consultantSchema.properties.triageCategory.enum,
    readonly ['misunderstanding', 'authorization', 'external_precondition', 'impossible_task']
  >
>;

type _CoderResponseOutcomeEnum = Expect<
  Equal<typeof coderResponseSchema.properties.outcome.enum, readonly ['responded', 'blocked', 'split_plan']>
>;
type _CoderResponseNestedRequired = Expect<
  Equal<typeof coderResponseSchema.properties.responses.items.required, readonly ['id', 'decision', 'summary']>
>;

type _CoderBlockedRecoveryActionEnum = Expect<
  Equal<
    typeof coderBlockedRecoverySchema.properties.action.enum,
    readonly ['resume_current_scope', 'replace_current_scope', 'stay_blocked', 'terminal_block']
  >
>;

type _CoderPlanResponseRequired = Expect<
  Equal<typeof coderPlanResponseSchema.required, readonly ['outcome', 'summary', 'blocker', 'responses']>
>;

type _CoderPlanActionEnum = Expect<
  Equal<typeof coderPlanSchema.properties.action.enum, readonly ['ready_for_review', 'blocked']>
>;

type _CoderScopeActionEnum = Expect<
  Equal<
    typeof coderScopeSchema.properties.action.enum,
    readonly ['continue', 'scope_done', 'done', 'blocked', 'split_plan', 'manual_gate']
  >
>;
type _CoderScopeManualGateType = Expect<
  Equal<typeof coderScopeSchema.properties.manualGate.type, readonly ['object', 'null']>
>;
type _ResumeCheckCwdType = Expect<Equal<typeof resumeCheckSchema.properties.cwd.type, readonly ['string', 'null']>>;
type _ResumeCheckCwdEnum = Expect<
  Equal<typeof resumeCheckSchema.properties.cwd.enum, readonly ['repo', 'run_dir', null]>
>;
type _ResumeCheckTimeoutType = Expect<
  Equal<typeof resumeCheckSchema.properties.timeoutMs.type, readonly ['number', 'null']>
>;

type _ExecuteScopeProgressRequired = Expect<
  Equal<
    typeof executeScopeProgressSchema.required,
    readonly ['milestoneTargeted', 'newEvidence', 'whyNotRedundant', 'nextStepUnlocked']
  >
>;

type _FinalCompletionSummaryRequired = Expect<
  Equal<
    typeof finalCompletionSummarySchema.required,
    readonly ['planGoalSatisfied', 'whatChangedOverall', 'verificationSummary', 'remainingKnownGaps']
  >
>;
type _FinalCompletionSummaryGoalNode = Expect<
  Equal<typeof finalCompletionSummarySchema.properties.planGoalSatisfied, { readonly type: 'boolean' }>
>;

type _FinalCompletionReviewerRequired = Expect<
  Equal<
    typeof finalCompletionReviewerSchema.required,
    readonly ['action', 'summary', 'rationale', 'missingWork', 'squashCommitMessage']
  >
>;
type _FinalCompletionReviewerMissingWorkType = Expect<
  Equal<typeof finalCompletionReviewerSchema.properties.missingWork.type, readonly ['object', 'null']>
>;
type _SquashDraftBulletsMinItems = Expect<Equal<typeof squashDraftSchema.properties.bullets.minItems, 2>>;
type _SquashDraftBulletsMaxItems = Expect<Equal<typeof squashDraftSchema.properties.bullets.maxItems, 5>>;

// Rejection of nonexistent fields and mutation. Never invoked: the directives
// below are compile-time-only checks (tsc fails on an unused @ts-expect-error,
// so each suppressed line is guaranteed to be a real type error).
export function assertBuilderTypeRejectionsAtCompileTimeOnly() {
  // @ts-expect-error the reviewer payload schema declares no such property node.
  void reviewerSchema.properties.nonexistent;
  // @ts-expect-error string nodes carry no nested properties member.
  void reviewerSchema.properties.summary.properties;
  // @ts-expect-error the coder scope top level is an object node, not an enum node.
  void coderScopeSchema.enum;
  // @ts-expect-error the coder plan schema has no manualGate property.
  void coderPlanSchema.properties.manualGate;
  // @ts-expect-error emitted schema nodes are readonly.
  reviewerSchema.properties.summary.type = 'number';
  // @ts-expect-error required tuples are readonly.
  planReviewerSchema.required.push('summary');
}

test('validator enum enforcement derives from the zod schema definition', () => {
  // Both surfaces derive from the same zod definition, and the validator's
  // enum enforcement runs through zod's own parse at the traversal point.
  // Exercise the validator against the option list read from the zod-derived
  // EMITTED schema (not a hardcoded copy): every zod-declared option is
  // accepted, and the rejection message lists exactly the zod-declared
  // options — so validation cannot be satisfied by a forked parallel list.
  const outcomeOptions = [...coderResponseSchema.properties.outcome.enum] as string[];
  assert.ok(outcomeOptions.length >= 2);
  for (const outcome of outcomeOptions) {
    const payload = {
      outcome,
      summary: 'Addressed every finding.',
      blocker: '',
      derivedPlan: outcome === 'split_plan' ? '# Derived plan' : '',
      responses: [],
    };
    assert.equal(validateCoderResponsePayload(payload).outcome, outcome);
  }
  assert.throws(
    () =>
      validateCoderResponsePayload({
        outcome: 'not-a-zod-option',
        summary: 'Addressed every finding.',
        blocker: '',
        derivedPlan: '',
        responses: [],
      }),
    new Error(`Coder response round payload.outcome must be exactly one of: ${outcomeOptions.join(', ')}.`),
  );
});

function validScopeProgress() {
  return {
    milestoneTargeted: 'Slice one of the parser rework.',
    newEvidence: 'New tests cover the trailing-token path.',
    whyNotRedundant: 'No previous scope touched the parser loop.',
    nextStepUnlocked: 'Slice two can build on the shared tokenizer.',
  };
}

function manualGateScopePayload(resumeCheck: Record<string, unknown>) {
  return {
    action: 'manual_gate',
    message: 'Waiting on operator.',
    progress: validScopeProgress(),
    manualGate: {
      id: 'gate-1',
      title: 'Rotate credentials',
      reason: 'Requires operator-held access.',
      instructionsMarkdown: 'Rotate the key, then rerun the check.',
      resumeChecks: [resumeCheck],
    },
    derivedPlan: '',
    blockedReason: '',
  };
}

test('execute-progress field enforcement derives from the zod schema definition', () => {
  // The field names come from the zod-derived EMITTED schema; each
  // wrong-typed value is rejected by that field's zod string node behind the
  // pinned delimiter-protocol message.
  const progressKeys = Object.keys(executeScopeProgressSchema.properties);
  assert.deepEqual(progressKeys, ['milestoneTargeted', 'newEvidence', 'whyNotRedundant', 'nextStepUnlocked']);
  for (const key of progressKeys) {
    const raw = [
      EXECUTE_SCOPE_PROGRESS_PAYLOAD_START,
      JSON.stringify({ ...validScopeProgress(), [key]: 42 }),
      EXECUTE_SCOPE_PROGRESS_PAYLOAD_END,
    ].join('\n');
    assert.throws(
      () => parseExecuteScopeProgressPayload(raw),
      new Error(`Coder scope round returned an empty or missing ${key} field in the progress-justification payload.`),
    );
  }
});

test('manual-gate resume-check base constraints derive from the zod schema definition', () => {
  // The cwd option list comes from the zod-derived EMITTED schema; every
  // zod-declared option is accepted, while values outside the zod nodes for
  // cwd, type, and timeoutMs are rejected with the pinned messages.
  const gateResumeCheckSchema = coderScopeSchema.properties.manualGate.properties.resumeChecks.items;
  const cwdOptions = [...gateResumeCheckSchema.properties.cwd.enum].filter(
    (option): option is 'repo' | 'run_dir' => typeof option === 'string',
  );
  assert.deepEqual(cwdOptions, ['repo', 'run_dir']);
  for (const cwd of cwdOptions) {
    const result = validateCoderScopePayload(
      manualGateScopePayload({ type: 'command', name: 'check', command: ['true'], cwd, timeoutMs: 1000 }),
    );
    assert.equal(result.manualGate?.resumeChecks[0].cwd, cwd);
  }
  assert.throws(
    () =>
      validateCoderScopePayload(
        manualGateScopePayload({ type: 'command', name: 'check', command: ['true'], cwd: 'home', timeoutMs: null }),
      ),
    new Error('Coder scope round returned manualGate.resumeChecks[0].cwd that is not "repo" or "run_dir".'),
  );
  assert.throws(
    () =>
      validateCoderScopePayload(
        manualGateScopePayload({ type: 'script', name: 'check', command: ['true'], cwd: null, timeoutMs: null }),
      ),
    new Error('Coder scope round returned manualGate.resumeChecks[0].type that is not "command".'),
  );
  assert.throws(
    () =>
      validateCoderScopePayload(
        manualGateScopePayload({ type: 'command', name: 'check', command: ['true'], cwd: null, timeoutMs: '5000' }),
      ),
    new Error('Coder scope round returned manualGate.resumeChecks[0].timeoutMs that is not a positive safe integer.'),
  );
});

// The historical manual-gate validator performed ONE property read per
// comparison for cwd/timeoutMs (short-circuiting between reads) and re-read
// the property for the normalized output, so stateful accessors observe the
// exact historical read counts and per-read values — a snapshot-once parse
// would change both the counts and, for value-changing accessors, the
// accepted payload set and normalized result.

function withCountingAccessor(
  base: Record<string, unknown>,
  key: string,
  values: readonly unknown[],
): { check: Record<string, unknown>; reads: () => number } {
  let reads = 0;
  const check = { ...base };
  delete check[key];
  Object.defineProperty(check, key, {
    enumerable: true,
    configurable: true,
    get() {
      const value = reads < values.length ? values[reads] : values[values.length - 1];
      reads += 1;
      return value;
    },
  });
  return { check, reads: () => reads };
}

function baseResumeCheck() {
  return { type: 'command', name: 'check', command: ['true'], cwd: null, timeoutMs: null };
}

test('manual-gate cwd keeps the historical per-comparison reads and output re-read', () => {
  // Constant accessor 'repo': three guard reads (undefined, null, first enum
  // option match) plus three normalized-output reads.
  const constant = withCountingAccessor(baseResumeCheck(), 'cwd', ['repo']);
  const constantResult = validateCoderScopePayload(manualGateScopePayload(constant.check));
  assert.equal(constantResult.manualGate?.resumeChecks[0].cwd, 'repo');
  assert.equal(constant.reads(), 6);

  // Stateful accessor: the first read returns undefined, so the historical
  // guard short-circuits and accepts, and the output re-reads observe the
  // later value — a snapshot-once implementation would omit cwd instead.
  const stateful = withCountingAccessor(baseResumeCheck(), 'cwd', [undefined, 'run_dir', 'run_dir', 'run_dir']);
  const statefulResult = validateCoderScopePayload(manualGateScopePayload(stateful.check));
  assert.equal(statefulResult.manualGate?.resumeChecks[0].cwd, 'run_dir');
  assert.equal(stateful.reads(), 4);
});

test('manual-gate cwd rejection happens after the four historical guard reads and before timeoutMs', () => {
  const check = baseResumeCheck();
  let cwdReads = 0;
  let timeoutMsReads = 0;
  Object.defineProperty(check, 'cwd', {
    enumerable: true,
    configurable: true,
    get() {
      cwdReads += 1;
      return 'home';
    },
  });
  Object.defineProperty(check, 'timeoutMs', {
    enumerable: true,
    configurable: true,
    get() {
      timeoutMsReads += 1;
      return null;
    },
  });
  assert.throws(
    () => validateCoderScopePayload(manualGateScopePayload(check)),
    new Error('Coder scope round returned manualGate.resumeChecks[0].cwd that is not "repo" or "run_dir".'),
  );
  assert.equal(cwdReads, 4);
  // Historical order: the cwd guard rejects before any timeoutMs read.
  assert.equal(timeoutMsReads, 0);
});

test('manual-gate timeoutMs keeps the historical per-comparison reads and output re-read', () => {
  // Accepted number: two optionality reads, the zod number-node read, the
  // safe-integer read, the lower-bound read, then three output reads.
  const accepted = withCountingAccessor(baseResumeCheck(), 'timeoutMs', [5000]);
  const acceptedResult = validateCoderScopePayload(manualGateScopePayload(accepted.check));
  assert.equal(acceptedResult.manualGate?.resumeChecks[0].timeoutMs, 5000);
  assert.equal(accepted.reads(), 8);

  // Wrong-typed value: the zod number node rejects on the third read and the
  // guard short-circuits with the pinned message.
  const rejected = withCountingAccessor(baseResumeCheck(), 'timeoutMs', ['5000']);
  assert.throws(
    () => validateCoderScopePayload(manualGateScopePayload(rejected.check)),
    new Error('Coder scope round returned manualGate.resumeChecks[0].timeoutMs that is not a positive safe integer.'),
  );
  assert.equal(rejected.reads(), 3);
});

// Historical repeated-read semantics for optional/nullable fields: the
// undefined/null tests each performed their own property read and validation
// read the property again, so stateful accessors observe every read and the
// LAST read supplies the validated value — snapshot-once parsing would use
// the first read instead.

test('consultant targetCanonicalIds keeps the historical undefined test plus fresh validation read', () => {
  let reads = 0;
  const payload: Record<string, unknown> = {
    recoverable: false,
    triageCategory: 'authorization',
    resolutionDirective: '',
    rationale: 'The coder needs credentials only the operator holds.',
  };
  Object.defineProperty(payload, 'targetCanonicalIds', {
    enumerable: true,
    configurable: true,
    get() {
      reads += 1;
      return reads === 1 ? ['first'] : ['second'];
    },
  });
  const result = validateConsultantVerdictPayload(payload);
  assert.deepEqual(result.targetCanonicalIds, ['second']);
  assert.equal(reads, 2);
});

test('coder-scope manualGate keeps the historical null test plus fresh validation read', () => {
  let reads = 0;
  const gateA = {
    id: 'gate-a',
    title: 'Rotate credentials',
    reason: 'Requires operator-held access.',
    instructionsMarkdown: 'Rotate the key, then rerun the check.',
    resumeChecks: [{ type: 'command', name: 'check', command: ['true'], cwd: null, timeoutMs: null }],
  };
  const gateB = { ...gateA, id: 'gate-b' };
  const payload: Record<string, unknown> = {
    action: 'manual_gate',
    message: 'Waiting on operator.',
    progress: validScopeProgress(),
    derivedPlan: '',
    blockedReason: '',
  };
  Object.defineProperty(payload, 'manualGate', {
    enumerable: true,
    configurable: true,
    get() {
      reads += 1;
      return reads === 1 ? gateA : gateB;
    },
  });
  const result = validateCoderScopePayload(payload);
  assert.equal(result.manualGate?.id, 'gate-b');
  assert.equal(reads, 2);
});

test('final-reviewer squashCommitMessage keeps the historical null/undefined tests plus object read', () => {
  let reads = 0;
  const draftA = { subject: 'Subject A', bullets: ['First bullet.', 'Second bullet.'] };
  const draftB = { subject: 'Subject B', bullets: ['Third bullet.', 'Fourth bullet.'] };
  const payload: Record<string, unknown> = {
    action: 'accept_complete',
    summary: 'All plan work landed.',
    rationale: 'Every scope is verified by the suite.',
    missingWork: null,
  };
  Object.defineProperty(payload, 'squashCommitMessage', {
    enumerable: true,
    configurable: true,
    get() {
      reads += 1;
      return reads <= 2 ? draftA : draftB;
    },
  });
  const result = parseFinalCompletionReviewerPayload(payload);
  assert.equal(result.squashCommitMessage?.subject, 'Subject B');
  assert.equal(reads, 3);
});

test('exported schema builders return traversable literal-typed nodes at runtime', () => {
  assert.equal(reviewerSchema.properties.summary.type, 'string');
  assert.deepEqual(
    [...reviewerSchema.properties.meaningfulProgressAction.enum],
    ['accept', 'block_for_operator', 'replace_plan', 'advance_parent'],
  );
  assert.deepEqual([...resumeCheckSchema.properties.cwd.enum], ['repo', 'run_dir', null]);
  assert.deepEqual([...resumeCheckSchema.properties.timeoutMs.type], ['number', 'null']);
  assert.equal(squashDraftSchema.properties.bullets.minItems, 2);
  assert.equal(squashDraftSchema.properties.bullets.maxItems, 5);
  assert.equal(consultantSchema.properties.recoverable.type, 'boolean');
  assert.equal(reviewerFindingSchema.additionalProperties, false);
  // The plan-review finding class enum is emitted with both values, and the
  // property stays optional (absent from the finding `required` tuple).
  assert.deepEqual(
    [...planReviewerFindingSchema.properties.findingClass.enum],
    ['plan_correctness', 'verification_hardening'],
  );
  assert.equal((planReviewerFindingSchema.required as readonly string[]).includes('findingClass'), false);
});
