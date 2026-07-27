import { z } from 'zod';
import type {
  CoderBlockedRecoveryDisposition,
  ExecuteScopeProgressJustification,
  ExecutionShape,
  FinalCompletionReviewerVerdict,
  FinalCompletionSummary,
  ManualGateResumeCheck,
  PlanReviewFindingClass,
  ReviewerMeaningfulProgressAction,
  ConsultantVerdict,
} from '../types.js';
import { normalizeExecutionShapeDeclaration, validatePlanDocument } from '../plan-validation.js';
import { repairReviewerSquashMessageDraft, validateReviewerSquashMessageDraft } from '../squash-message.js';

// Each agent payload below has exactly ONE zod definition. Both consumer
// surfaces derive from it:
// - The JSON-Schema builders (`build*Schema`) run `z.toJSONSchema` output
//   through `normalizeEmittedSchemaNode`, which reproduces the exact byte
//   serialization the previous hand-written builders emitted. Property order
//   is prompt-visible (emitted schemas are serialized into prompt text with
//   `JSON.stringify(schema, null, 2)`), so the normalizer's key ordering and
//   nullable-union collapsing are load-bearing and pinned byte-for-byte by
//   test/agent-payload-schemas.test.ts.
// - The validators parse with the same definition (or a documented
//   parse-stage loosening of it) and translate the first relevant zod issue
//   through a shared formatter that reproduces the historical error grammar
//   and first-failure ordering pinned by test/agent-payload-schemas.test.ts.
// Cross-field rules (split_plan/derivedPlan pairing and friends), the
// delimiter-protocol progress messages, manual-gate deep validation, and the
// squash-draft repair path intentionally remain explicit post-parse steps:
// their messages, trimming, and acceptance semantics predate zod and are
// pinned by the same characterization suite.

export type ReviewerFindingPayload = {
  severity: 'blocking' | 'non_blocking';
  files: string[];
  claim: string;
  evidence: string;
  requiredAction: string;
  // Plan-review only: absent for execute-review findings. Normalized to a
  // concrete class (defaulting to plan_correctness) by validatePlanReviewerPayload.
  findingClass?: PlanReviewFindingClass;
};

export type ReviewerPayload = {
  summary: string;
  findings: ReviewerFindingPayload[];
  meaningfulProgressAction: ReviewerMeaningfulProgressAction;
  meaningfulProgressRationale: string;
};

export type PlanReviewerPayload = {
  summary: string;
  executionShape: ExecutionShape;
  findings: ReviewerFindingPayload[];
};

export type CoderResponsePayload = {
  outcome: 'responded' | 'blocked' | 'split_plan';
  summary: string;
  blocker?: string;
  derivedPlan?: string;
  responses: Array<{
    id: string;
    decision: 'fixed' | 'rejected' | 'deferred';
    summary: string;
  }>;
};

export type CoderPlanResponsePayload = {
  outcome: 'responded' | 'blocked';
  summary: string;
  blocker: string;
  responses: Array<{
    id: string;
    decision: 'fixed' | 'rejected' | 'deferred';
    summary: string;
  }>;
};

export type CoderPlanPayload = {
  action: 'ready_for_review' | 'blocked';
  message: string;
  executionShape: ExecutionShape;
  planBody: string;
  blockedReason: string;
};

export type CoderScopePayload = {
  action: 'continue' | 'scope_done' | 'done' | 'blocked' | 'split_plan' | 'manual_gate';
  message: string;
  progress: ExecuteScopeProgressJustification;
  manualGate: {
    id: string;
    title: string;
    reason: string;
    instructionsMarkdown: string;
    resumeChecks: ManualGateResumeCheck[];
  } | null;
  derivedPlan: string;
  blockedReason: string;
};

export type CoderBlockedRecoveryDispositionPayload = CoderBlockedRecoveryDisposition;
export type ExecuteScopeProgressPayload = ExecuteScopeProgressJustification;
export type FinalCompletionSummaryPayload = FinalCompletionSummary;
export type FinalCompletionReviewerPayload = Omit<FinalCompletionReviewerVerdict, 'squashCommitMessage'> & {
  squashCommitMessage?: FinalCompletionReviewerVerdict['squashCommitMessage'];
};

export const EXECUTE_SCOPE_PROGRESS_PAYLOAD_START = 'NEAL_PROGRESS_JUSTIFICATION_JSON_START';
export const EXECUTE_SCOPE_PROGRESS_PAYLOAD_END = 'NEAL_PROGRESS_JUSTIFICATION_JSON_END';

// --- zod payload definitions (single source of truth) -----------------------

const REVIEWER_FINDING_SEVERITIES = ['blocking', 'non_blocking'] as const;
export const PLAN_REVIEWER_FINDING_CLASSES = [
  'plan_correctness',
  'verification_hardening',
] as const satisfies readonly PlanReviewFindingClass[];
const REVIEWER_MEANINGFUL_PROGRESS_ACTIONS = [
  'accept',
  'block_for_operator',
  'replace_plan',
  'advance_parent',
] as const satisfies readonly ReviewerMeaningfulProgressAction[];
const EXECUTION_SHAPES = ['one_shot', 'multi_scope', 'multi_scope_unknown'] as const satisfies readonly ExecutionShape[];
const CONSULTANT_TRIAGE_CATEGORIES = [
  'misunderstanding',
  'authorization',
  'external_precondition',
  'impossible_task',
] as const;
const CODER_FINDING_RESPONSE_DECISIONS = ['fixed', 'rejected', 'deferred'] as const;
const CODER_RESPONSE_OUTCOMES = ['responded', 'blocked', 'split_plan'] as const;
const CODER_BLOCKED_RECOVERY_ACTIONS = [
  'resume_current_scope',
  'replace_current_scope',
  'stay_blocked',
  'terminal_block',
] as const;
const CODER_PLAN_RESPONSE_OUTCOMES = ['responded', 'blocked'] as const;
const CODER_PLAN_ACTIONS = ['ready_for_review', 'blocked'] as const;
const CODER_SCOPE_ACTIONS = ['continue', 'scope_done', 'done', 'blocked', 'split_plan', 'manual_gate'] as const;
const MANUAL_GATE_RESUME_CHECK_TYPES = ['command'] as const;
const MANUAL_GATE_RESUME_CHECK_CWDS = ['repo', 'run_dir'] as const;
const FINAL_COMPLETION_REVIEWER_ACTIONS = ['accept_complete', 'continue_execution', 'block_for_operator'] as const;
const SQUASH_COMMIT_MESSAGE_DESCRIPTION =
  'Project-facing Git history metadata used only when action is accept_complete; set null for continue_execution or block_for_operator.';
const SQUASH_COMMIT_SUBJECT_DESCRIPTION =
  'Concise project-facing commit subject summarizing code or product behavior, not plan documents, paths, scopes, Neal mechanics, provider process, reviewer process, or final cleanup.';
const SQUASH_COMMIT_BULLETS_DESCRIPTION =
  'Two to five project-facing Git history bullets summarizing behavior changes; avoid plan paths, markdown plan filenames, temporary run paths, scope wording, Neal mechanics, provider process, or reviewer process.';

// The reviewer payload is the strict unknown-key family: unknown properties
// are rejected at both the top level and inside findings (z.strictObject).
// Every other payload uses zod's default strip-mode z.object — unknown
// properties are accepted and omitted from the normalized output.
const reviewerFindingSchema = z.strictObject({
  severity: z.enum(REVIEWER_FINDING_SEVERITIES),
  files: z.array(z.string()),
  claim: z.string(),
  evidence: z.string(),
  requiredAction: z.string(),
});

const reviewerPayloadSchema = z.strictObject({
  summary: z.string(),
  findings: z.array(reviewerFindingSchema),
  meaningfulProgressAction: z.enum(REVIEWER_MEANINGFUL_PROGRESS_ACTIONS),
  meaningfulProgressRationale: z.string(),
});

const planReviewerFindingSchema = z.object({
  severity: z.enum(REVIEWER_FINDING_SEVERITIES),
  files: z.array(z.string()),
  claim: z.string(),
  requiredAction: z.string(),
  // Optional at the payload boundary: an absent class normalizes to the fail-safe
  // plan_correctness downstream (see validatePlanReviewerPayload), while a
  // present-but-invalid value is rejected by the sequential validator before any
  // normalization runs. The reviewer round is a `neal-json-block-v1` structured
  // round (the schema is advisory prompt context, not native strict output), so —
  // like the consultant's optional targetCanonicalIds — this property is
  // intentionally absent from the emitted `required` tuple and buildPlanReviewerSchema
  // is excluded from the strict all-required contract.
  findingClass: z.enum(PLAN_REVIEWER_FINDING_CLASSES).optional(),
});

const planReviewerPayloadSchema = z.object({
  summary: z.string(),
  executionShape: z.enum(EXECUTION_SHAPES),
  findings: z.array(planReviewerFindingSchema),
});

const consultantPayloadSchema = z.object({
  recoverable: z.boolean(),
  triageCategory: z.enum(CONSULTANT_TRIAGE_CATEGORIES),
  resolutionDirective: z.string(),
  targetCanonicalIds: z.array(z.string()).optional(),
  rationale: z.string(),
});

const coderFindingResponseSchema = z.object({
  id: z.string(),
  decision: z.enum(CODER_FINDING_RESPONSE_DECISIONS),
  summary: z.string(),
});

const coderResponsePayloadSchema = z.object({
  outcome: z.enum(CODER_RESPONSE_OUTCOMES),
  summary: z.string(),
  blocker: z.string(),
  derivedPlan: z.string(),
  responses: z.array(coderFindingResponseSchema),
});

const coderBlockedRecoveryDispositionPayloadSchema = z.object({
  action: z.enum(CODER_BLOCKED_RECOVERY_ACTIONS),
  summary: z.string(),
  rationale: z.string(),
  blocker: z.string(),
  replacementPlan: z.string(),
});

const coderPlanResponsePayloadSchema = z.object({
  outcome: z.enum(CODER_PLAN_RESPONSE_OUTCOMES),
  summary: z.string(),
  blocker: z.string(),
  responses: z.array(coderFindingResponseSchema),
});

const coderPlanPayloadSchema = z.object({
  action: z.enum(CODER_PLAN_ACTIONS),
  message: z.string(),
  executionShape: z.enum(EXECUTION_SHAPES),
  planBody: z.string(),
  blockedReason: z.string(),
});

const executeScopeProgressSchema = z.object({
  milestoneTargeted: z.string(),
  newEvidence: z.string(),
  whyNotRedundant: z.string(),
  nextStepUnlocked: z.string(),
});

const manualGateResumeCheckSchema = z.object({
  type: z.enum(MANUAL_GATE_RESUME_CHECK_TYPES),
  name: z.string(),
  command: z.array(z.string()),
  cwd: z.enum(MANUAL_GATE_RESUME_CHECK_CWDS).nullable(),
  timeoutMs: z.number().nullable(),
});

const manualGateSchema = z.object({
  id: z.string(),
  title: z.string(),
  reason: z.string(),
  instructionsMarkdown: z.string(),
  resumeChecks: z.array(manualGateResumeCheckSchema),
});

const coderScopePayloadSchema = z.object({
  action: z.enum(CODER_SCOPE_ACTIONS),
  message: z.string(),
  progress: executeScopeProgressSchema,
  manualGate: manualGateSchema.nullable(),
  derivedPlan: z.string(),
  blockedReason: z.string(),
});

// Parse-stage view of the coder scope payload. The full definition above is
// what the emitted JSON Schema promises callers; validation historically only
// checks object-ness of `progress` and `manualGate` up front, then applies
// the delimiter-protocol progress messages and the manual-gate deep
// validation (which trims strings and accepts absent cwd/timeoutMs) as
// explicit post-parse steps with their own pinned message grammar.
const coderScopeParseSchema = coderScopePayloadSchema.extend({
  progress: z.looseObject({}),
  manualGate: z.looseObject({}).nullable(),
});

const finalCompletionSummaryPayloadSchema = z.object({
  planGoalSatisfied: z.boolean(),
  whatChangedOverall: z.string(),
  verificationSummary: z.string(),
  remainingKnownGaps: z.array(z.string()),
});

const squashCommitMessageDraftSchema = z.object({
  subject: z.string().describe(SQUASH_COMMIT_SUBJECT_DESCRIPTION),
  bullets: z.array(z.string()).min(2).max(5).describe(SQUASH_COMMIT_BULLETS_DESCRIPTION),
});

const finalCompletionReviewerPayloadSchema = z.object({
  action: z.enum(FINAL_COMPLETION_REVIEWER_ACTIONS),
  summary: z.string(),
  rationale: z.string(),
  missingWork: z
    .object({
      summary: z.string(),
      requiredOutcome: z.string(),
      verification: z.string(),
    })
    .nullable(),
  squashCommitMessage: squashCommitMessageDraftSchema.nullable().describe(SQUASH_COMMIT_MESSAGE_DESCRIPTION),
});

// Parse-stage view of the final-completion reviewer verdict. The squash draft
// is advisory: a malformed or absent draft must never reject the verdict, so
// validation only checks object-ness here and routes the draft through
// validate/repair in parseFinalCompletionReviewerPayload.
const finalCompletionReviewerParseSchema = finalCompletionReviewerPayloadSchema.extend({
  squashCommitMessage: z.looseObject({}).nullable().optional(),
});

// --- JSON-Schema emission ----------------------------------------------------

// Public compile-time contract of the exported builders. These literal types
// reproduce the return types of the previous hand-written `as const` builders
// exactly, so downstream code can keep traversing `properties`/`items`,
// spreading `enum` tuples, and reading `required` tuples with precise types.
// The runtime values are zod-derived (emitJsonSchema below); their agreement
// with these declared shapes is enforced two ways: the serialized-schema
// string pins in test/agent-payload-schemas.test.ts prove the emitted bytes,
// and test/agent-payload-schema-types.test.ts holds compile-time assertions
// over representative nodes of every builder.
type JsonStringSchema = { readonly type: 'string' };
type JsonBooleanSchema = { readonly type: 'boolean' };
type JsonArraySchema<TItems> = { readonly type: 'array'; readonly items: TItems };
type JsonStringArraySchema = JsonArraySchema<JsonStringSchema>;
type JsonEnumSchema<TValues extends readonly string[]> = {
  readonly type: 'string';
  readonly enum: TValues;
};
type JsonObjectSchema<TProperties, TRequired extends readonly string[]> = {
  readonly type: 'object';
  readonly properties: TProperties;
  readonly required: TRequired;
  readonly additionalProperties: false;
};
type JsonNullableObjectSchema<TProperties, TRequired extends readonly string[]> = {
  readonly type: readonly ['object', 'null'];
  readonly properties: TProperties;
  readonly required: TRequired;
  readonly additionalProperties: false;
};

type ReviewerFindingJsonSchema = JsonObjectSchema<
  {
    readonly severity: JsonEnumSchema<typeof REVIEWER_FINDING_SEVERITIES>;
    readonly files: JsonStringArraySchema;
    readonly claim: JsonStringSchema;
    readonly evidence: JsonStringSchema;
    readonly requiredAction: JsonStringSchema;
  },
  readonly ['severity', 'files', 'claim', 'evidence', 'requiredAction']
>;

type ReviewerJsonSchema = JsonObjectSchema<
  {
    readonly summary: JsonStringSchema;
    readonly findings: JsonArraySchema<ReviewerFindingJsonSchema>;
    readonly meaningfulProgressAction: JsonEnumSchema<typeof REVIEWER_MEANINGFUL_PROGRESS_ACTIONS>;
    readonly meaningfulProgressRationale: JsonStringSchema;
  },
  readonly ['summary', 'findings', 'meaningfulProgressAction', 'meaningfulProgressRationale']
>;

type PlanReviewerFindingJsonSchema = JsonObjectSchema<
  {
    readonly severity: JsonEnumSchema<typeof REVIEWER_FINDING_SEVERITIES>;
    readonly files: JsonStringArraySchema;
    readonly claim: JsonStringSchema;
    readonly requiredAction: JsonStringSchema;
    // Optional property: present in `properties` but intentionally absent from the
    // `required` tuple (mirrors the optional targetCanonicalIds on the
    // consultant). buildPlanReviewerSchema is excluded from the strict
    // all-required test for this reason.
    readonly findingClass: JsonEnumSchema<typeof PLAN_REVIEWER_FINDING_CLASSES>;
  },
  readonly ['severity', 'files', 'claim', 'requiredAction']
>;

type PlanReviewerJsonSchema = JsonObjectSchema<
  {
    readonly summary: JsonStringSchema;
    readonly executionShape: JsonEnumSchema<typeof EXECUTION_SHAPES>;
    readonly findings: JsonArraySchema<PlanReviewerFindingJsonSchema>;
  },
  readonly ['summary', 'executionShape', 'findings']
>;

type ConsultantJsonSchema = JsonObjectSchema<
  {
    readonly recoverable: JsonBooleanSchema;
    readonly triageCategory: JsonEnumSchema<typeof CONSULTANT_TRIAGE_CATEGORIES>;
    readonly resolutionDirective: JsonStringSchema;
    readonly targetCanonicalIds: JsonStringArraySchema;
    readonly rationale: JsonStringSchema;
  },
  readonly ['recoverable', 'triageCategory', 'resolutionDirective', 'rationale']
>;

type CoderFindingResponseJsonSchema = JsonObjectSchema<
  {
    readonly id: JsonStringSchema;
    readonly decision: JsonEnumSchema<typeof CODER_FINDING_RESPONSE_DECISIONS>;
    readonly summary: JsonStringSchema;
  },
  readonly ['id', 'decision', 'summary']
>;

type CoderResponseJsonSchema = JsonObjectSchema<
  {
    readonly outcome: JsonEnumSchema<typeof CODER_RESPONSE_OUTCOMES>;
    readonly summary: JsonStringSchema;
    readonly blocker: JsonStringSchema;
    readonly derivedPlan: JsonStringSchema;
    readonly responses: JsonArraySchema<CoderFindingResponseJsonSchema>;
  },
  readonly ['outcome', 'summary', 'blocker', 'derivedPlan', 'responses']
>;

type CoderBlockedRecoveryDispositionJsonSchema = JsonObjectSchema<
  {
    readonly action: JsonEnumSchema<typeof CODER_BLOCKED_RECOVERY_ACTIONS>;
    readonly summary: JsonStringSchema;
    readonly rationale: JsonStringSchema;
    readonly blocker: JsonStringSchema;
    readonly replacementPlan: JsonStringSchema;
  },
  readonly ['action', 'summary', 'rationale', 'blocker', 'replacementPlan']
>;

type CoderPlanResponseJsonSchema = JsonObjectSchema<
  {
    readonly outcome: JsonEnumSchema<typeof CODER_PLAN_RESPONSE_OUTCOMES>;
    readonly summary: JsonStringSchema;
    readonly blocker: JsonStringSchema;
    readonly responses: JsonArraySchema<CoderFindingResponseJsonSchema>;
  },
  readonly ['outcome', 'summary', 'blocker', 'responses']
>;

type CoderPlanJsonSchema = JsonObjectSchema<
  {
    readonly action: JsonEnumSchema<typeof CODER_PLAN_ACTIONS>;
    readonly message: JsonStringSchema;
    readonly executionShape: JsonEnumSchema<typeof EXECUTION_SHAPES>;
    readonly planBody: JsonStringSchema;
    readonly blockedReason: JsonStringSchema;
  },
  readonly ['action', 'message', 'executionShape', 'planBody', 'blockedReason']
>;

type ExecuteScopeProgressJsonSchema = JsonObjectSchema<
  {
    readonly milestoneTargeted: JsonStringSchema;
    readonly newEvidence: JsonStringSchema;
    readonly whyNotRedundant: JsonStringSchema;
    readonly nextStepUnlocked: JsonStringSchema;
  },
  readonly ['milestoneTargeted', 'newEvidence', 'whyNotRedundant', 'nextStepUnlocked']
>;

type ManualGateResumeCheckJsonSchema = JsonObjectSchema<
  {
    readonly type: JsonEnumSchema<typeof MANUAL_GATE_RESUME_CHECK_TYPES>;
    readonly name: JsonStringSchema;
    readonly command: JsonStringArraySchema;
    readonly cwd: {
      readonly type: readonly ['string', 'null'];
      readonly enum: readonly ['repo', 'run_dir', null];
    };
    readonly timeoutMs: { readonly type: readonly ['number', 'null'] };
  },
  readonly ['type', 'name', 'command', 'cwd', 'timeoutMs']
>;

type ManualGateJsonSchema = JsonNullableObjectSchema<
  {
    readonly id: JsonStringSchema;
    readonly title: JsonStringSchema;
    readonly reason: JsonStringSchema;
    readonly instructionsMarkdown: JsonStringSchema;
    readonly resumeChecks: JsonArraySchema<ManualGateResumeCheckJsonSchema>;
  },
  readonly ['id', 'title', 'reason', 'instructionsMarkdown', 'resumeChecks']
>;

type CoderScopeJsonSchema = JsonObjectSchema<
  {
    readonly action: JsonEnumSchema<typeof CODER_SCOPE_ACTIONS>;
    readonly message: JsonStringSchema;
    readonly progress: ExecuteScopeProgressJsonSchema;
    readonly manualGate: ManualGateJsonSchema;
    readonly derivedPlan: JsonStringSchema;
    readonly blockedReason: JsonStringSchema;
  },
  readonly ['action', 'message', 'progress', 'manualGate', 'derivedPlan', 'blockedReason']
>;

type FinalCompletionSummaryJsonSchema = JsonObjectSchema<
  {
    readonly planGoalSatisfied: JsonBooleanSchema;
    readonly whatChangedOverall: JsonStringSchema;
    readonly verificationSummary: JsonStringSchema;
    readonly remainingKnownGaps: JsonStringArraySchema;
  },
  readonly ['planGoalSatisfied', 'whatChangedOverall', 'verificationSummary', 'remainingKnownGaps']
>;

type SquashCommitMessageJsonSchema = {
  readonly description: typeof SQUASH_COMMIT_MESSAGE_DESCRIPTION;
  readonly type: readonly ['object', 'null'];
  readonly properties: {
    readonly subject: {
      readonly description: typeof SQUASH_COMMIT_SUBJECT_DESCRIPTION;
      readonly type: 'string';
    };
    readonly bullets: {
      readonly description: typeof SQUASH_COMMIT_BULLETS_DESCRIPTION;
      readonly type: 'array';
      readonly minItems: 2;
      readonly maxItems: 5;
      readonly items: JsonStringSchema;
    };
  };
  readonly required: readonly ['subject', 'bullets'];
  readonly additionalProperties: false;
};

type FinalCompletionReviewerJsonSchema = JsonObjectSchema<
  {
    readonly action: JsonEnumSchema<typeof FINAL_COMPLETION_REVIEWER_ACTIONS>;
    readonly summary: JsonStringSchema;
    readonly rationale: JsonStringSchema;
    readonly missingWork: JsonNullableObjectSchema<
      {
        readonly summary: JsonStringSchema;
        readonly requiredOutcome: JsonStringSchema;
        readonly verification: JsonStringSchema;
      },
      readonly ['summary', 'requiredOutcome', 'verification']
    >;
    readonly squashCommitMessage: SquashCommitMessageJsonSchema;
  },
  readonly ['action', 'summary', 'rationale', 'missingWork', 'squashCommitMessage']
>;

// Canonical key order of the previous hand-written builders. Emitted schemas
// are serialized into prompt text with JSON.stringify(schema, null, 2), so
// this ordering changes prompt bytes and is pinned byte-for-byte by
// test/agent-payload-schemas.test.ts.
const EMITTED_SCHEMA_KEY_ORDER = [
  'description',
  'type',
  'enum',
  'minItems',
  'maxItems',
  'items',
  'properties',
  'required',
  'additionalProperties',
] as const;

function isJsonSchemaRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

// Collapse zod's `anyOf: [X, { type: 'null' }]` encoding of .nullable() into
// the hand-written builders' merged form: X with `type: [<X type>, 'null']`,
// appending null to X's enum when one is present (e.g. the resume-check cwd).
function collapseNullableAnyOf(node: Record<string, unknown>): Record<string, unknown> {
  const { anyOf, ...rest } = node;
  if (!Array.isArray(anyOf) || anyOf.length !== 2) {
    return node;
  }
  const [base, nullBranch] = anyOf;
  if (!isJsonSchemaRecord(base) || !isJsonSchemaRecord(nullBranch)) {
    return node;
  }
  if (nullBranch.type !== 'null' || Object.keys(nullBranch).length !== 1) {
    return node;
  }
  const merged: Record<string, unknown> = { ...base, ...rest };
  merged.type = Array.isArray(base.type) ? [...base.type, 'null'] : [base.type, 'null'];
  if (Array.isArray(base.enum)) {
    merged.enum = [...base.enum, null];
  }
  return merged;
}

function normalizeEmittedSchemaNode(node: Record<string, unknown>): Record<string, unknown> {
  const record = collapseNullableAnyOf(node);
  const keys = Object.keys(record);
  const orderedKeys: string[] = [
    ...EMITTED_SCHEMA_KEY_ORDER.filter((key) => keys.includes(key)),
    ...keys.filter((key) => !(EMITTED_SCHEMA_KEY_ORDER as readonly string[]).includes(key)),
  ];
  const normalized: Record<string, unknown> = {};
  for (const key of orderedKeys) {
    const value = record[key];
    if (key === 'items' && isJsonSchemaRecord(value)) {
      normalized[key] = normalizeEmittedSchemaNode(value);
    } else if (key === 'properties' && isJsonSchemaRecord(value)) {
      const properties: Record<string, unknown> = {};
      for (const [propertyName, propertySchema] of Object.entries(value)) {
        properties[propertyName] = isJsonSchemaRecord(propertySchema)
          ? normalizeEmittedSchemaNode(propertySchema)
          : propertySchema;
      }
      normalized[key] = properties;
    } else {
      normalized[key] = value;
    }
  }
  const type = normalized.type;
  const isObjectNode = type === 'object' || (Array.isArray(type) && type.includes('object'));
  if (isObjectNode && normalized.properties !== undefined) {
    normalized.additionalProperties = false;
  }
  return normalized;
}

// The declared literal return shape is asserted here rather than proven
// structurally: the byte-level serialization pins in
// test/agent-payload-schemas.test.ts fail whenever the zod-derived emission
// diverges from the declared shapes.
function emitJsonSchema<TEmitted>(schema: z.ZodType): TEmitted {
  const emitted = z.toJSONSchema(schema) as Record<string, unknown>;
  delete emitted.$schema;
  return normalizeEmittedSchemaNode(emitted) as TEmitted;
}

export function buildReviewerSchema(): ReviewerJsonSchema {
  return emitJsonSchema<ReviewerJsonSchema>(reviewerPayloadSchema);
}

export function buildPlanReviewerSchema(): PlanReviewerJsonSchema {
  return emitJsonSchema<PlanReviewerJsonSchema>(planReviewerPayloadSchema);
}

export function buildConsultantSchema(): ConsultantJsonSchema {
  return emitJsonSchema<ConsultantJsonSchema>(consultantPayloadSchema);
}

export function buildCoderResponseSchema(): CoderResponseJsonSchema {
  return emitJsonSchema<CoderResponseJsonSchema>(coderResponsePayloadSchema);
}

export function buildCoderBlockedRecoveryDispositionSchema(): CoderBlockedRecoveryDispositionJsonSchema {
  return emitJsonSchema<CoderBlockedRecoveryDispositionJsonSchema>(coderBlockedRecoveryDispositionPayloadSchema);
}

export function buildCoderPlanResponseSchema(): CoderPlanResponseJsonSchema {
  return emitJsonSchema<CoderPlanResponseJsonSchema>(coderPlanResponsePayloadSchema);
}

export function buildCoderPlanSchema(): CoderPlanJsonSchema {
  return emitJsonSchema<CoderPlanJsonSchema>(coderPlanPayloadSchema);
}

export function buildCoderScopeSchema(): CoderScopeJsonSchema {
  return emitJsonSchema<CoderScopeJsonSchema>(coderScopePayloadSchema);
}

export function buildExecuteScopeProgressSchema(): ExecuteScopeProgressJsonSchema {
  return emitJsonSchema<ExecuteScopeProgressJsonSchema>(executeScopeProgressSchema);
}

export function buildFinalCompletionSummarySchema(): FinalCompletionSummaryJsonSchema {
  return emitJsonSchema<FinalCompletionSummaryJsonSchema>(finalCompletionSummaryPayloadSchema);
}

export function buildFinalCompletionReviewerSchema(): FinalCompletionReviewerJsonSchema {
  return emitJsonSchema<FinalCompletionReviewerJsonSchema>(finalCompletionReviewerPayloadSchema);
}

// --- sequential zod-backed validation ------------------------------------------
//
// The historical validators were strictly sequential: each field was read and
// checked one at a time in a fixed order, throwing at the FIRST failure, so a
// property later in the validation order was never read once an earlier check
// failed — a later throwing accessor could not mask an earlier error. A
// whole-payload safeParse instead reads every field eagerly to collect all
// issues. The traversal below therefore keeps the historical sequential read
// order and short-circuit semantics while zod performs the actual
// validation: each field or array element is parsed by its own zod
// sub-schema at the point the traversal reaches it, and the first zod issue
// is translated through ONE shared formatter into the historical grammar:
//   `<Label>[.<path>] must be a non-null object.` / `... must be a string.` /
//   `... must be a boolean.` / `... must be an array.` /
//   `... must be exactly one of: a, b.`

function describeSchemaIssue(fieldPath: string, issue: z.core.$ZodIssue): string {
  if (issue.code === 'invalid_type') {
    switch (issue.expected) {
      case 'object':
        return `${fieldPath} must be a non-null object.`;
      case 'string':
        return `${fieldPath} must be a string.`;
      case 'boolean':
        return `${fieldPath} must be a boolean.`;
      case 'array':
        return `${fieldPath} must be an array.`;
      default:
        break;
    }
  }
  if (issue.code === 'invalid_value') {
    return `${fieldPath} must be exactly one of: ${issue.values.join(', ')}.`;
  }
  // Any other zod constraint surfaces with zod's own issue description.
  return `${fieldPath} failed validation: ${issue.message}`;
}

function firstSchemaIssueMessage(schema: z.ZodType, value: unknown, fieldPath: string): string {
  const result = schema.safeParse(value);
  if (result.success) {
    // Unreachable: callers invoke this only for values the schema rejects.
    return `${fieldPath} failed validation.`;
  }
  return describeSchemaIssue(fieldPath, result.error.issues[0]);
}

// Container gates: return the value when it has the container type the
// schema demands; otherwise derive the failure message from the schema's own
// zod issue. zod fails fast on container-type mismatches without reading any
// property or element, so no accessor is invoked for a rejected value, and
// the gate lets the traversal defer member reads to their historical
// positions instead of letting a whole-container parse read them eagerly.
function requireRecordSequential(schema: z.ZodType, value: unknown, fieldPath: string): Record<string, unknown> {
  if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  throw new Error(firstSchemaIssueMessage(schema, value, fieldPath));
}

function requireArraySequential(schema: z.ZodType, value: unknown, fieldPath: string): unknown[] {
  if (Array.isArray(value)) {
    return value;
  }
  throw new Error(firstSchemaIssueMessage(schema, value, fieldPath));
}

function validateFieldSequential(fieldSchema: z.ZodType, value: unknown, fieldPath: string): unknown {
  if (fieldSchema instanceof z.ZodOptional) {
    if (value === undefined) {
      return undefined;
    }
    return validateFieldSequential(fieldSchema.unwrap() as z.ZodType, value, fieldPath);
  }
  if (fieldSchema instanceof z.ZodNullable) {
    if (value === null) {
      return null;
    }
    return validateFieldSequential(fieldSchema.unwrap() as z.ZodType, value, fieldPath);
  }
  if (fieldSchema instanceof z.ZodArray) {
    const items = requireArraySequential(fieldSchema, value, fieldPath);
    const element = fieldSchema.element as z.ZodType;
    if (element instanceof z.ZodObject) {
      // Historical object-array semantics: every item's object-ness is
      // checked before any item's fields are read.
      const records = items.map((item, index) => requireRecordSequential(element, item, `${fieldPath}[${index}]`));
      return records.map((item, index) => walkObjectSequential(element, item, `${fieldPath}[${index}]`));
    }
    return items.map((item, index) => validateFieldSequential(element, item, `${fieldPath}[${index}]`));
  }
  if (fieldSchema instanceof z.ZodObject) {
    const record = requireRecordSequential(fieldSchema, value, fieldPath);
    // Empty-shape loose objects are the historical object-ness-only
    // passthroughs (coder-scope progress/manualGate, the squash draft): the
    // ORIGINAL reference is returned so the explicit post-parse steps read
    // fields at their historical positions.
    if (Object.keys(fieldSchema.shape).length === 0) {
      return record;
    }
    return walkObjectSequential(fieldSchema, record, fieldPath);
  }
  // Leaf schema: zod itself enforces the constraint at the point the
  // traversal reaches this field; its first issue is translated through the
  // shared formatter.
  const result = fieldSchema.safeParse(value);
  if (!result.success) {
    throw new Error(describeSchemaIssue(fieldPath, result.error.issues[0]));
  }
  return result.data;
}

// Walks a strip-mode object schema field-by-field in shape declaration order,
// reading each property only when its turn comes and throwing at the first
// failure. Unknown keys are omitted from the rebuilt output (historical
// permissive behavior).
function walkObjectSequential(
  schema: z.ZodObject,
  record: Record<string, unknown>,
  basePath: string,
): Record<string, unknown> {
  const output: Record<string, unknown> = {};
  for (const [key, fieldSchema] of Object.entries(schema.shape as Record<string, z.ZodType>)) {
    const fieldPath = `${basePath}.${key}`;
    // Historical optional/nullable field patterns performed one property
    // read for the undefined/null test and a FRESH read for validation when
    // the field was present, so stateful accessors observe both reads (the
    // consultant targetCanonicalIds ternary and the coder-scope
    // manualGate ternary behaved this way).
    if (fieldSchema instanceof z.ZodOptional) {
      if (record[key] === undefined) {
        continue;
      }
      output[key] = validateFieldSequential(fieldSchema.unwrap() as z.ZodType, record[key], fieldPath);
      continue;
    }
    if (fieldSchema instanceof z.ZodNullable) {
      if (record[key] === null) {
        output[key] = null;
        continue;
      }
      output[key] = validateFieldSequential(fieldSchema.unwrap() as z.ZodType, record[key], fieldPath);
      continue;
    }
    output[key] = validateFieldSequential(fieldSchema, record[key], fieldPath);
  }
  return output;
}

// Permissive-family entry point: object-ness first (`<Label> must be a
// non-null object.`), then the sequential field walk in shape declaration
// order, which matches the historical field-by-field check order of these
// validators.
function parsePayload<TSchema extends z.ZodType>(schema: TSchema, payload: unknown, label: string): z.output<TSchema> {
  if (!(schema instanceof z.ZodObject)) {
    throw new Error(`${label} failed validation: sequential parsing requires an object schema.`);
  }
  const record = requireRecordSequential(schema, payload, label);
  return walkObjectSequential(schema, record, label) as z.output<TSchema>;
}

// --- reviewer payload (strict unknown-key family) ----------------------------

// The strict reviewer family additionally enforced, at each object level and
// BEFORE reading any declared field: required own properties (in key order,
// via Object.prototype.hasOwnProperty — prototype-inherited properties are
// rejected and their accessors never invoked) and unknown-key rejection (in
// input order, via Object.keys). The historical sequence, reproduced below:
// object-ness, missing required own properties, unknown properties, findings
// array-ness, summary, each finding in order (object-ness, missing, unknown,
// files array-ness, severity, files items, claim, evidence, requiredAction),
// then meaningfulProgressAction and meaningfulProgressRationale.
function assertReviewerOwnProperties(
  record: Record<string, unknown>,
  shape: Record<string, z.ZodType>,
  label: string,
): void {
  for (const key of Object.keys(shape)) {
    if (!Object.prototype.hasOwnProperty.call(record, key)) {
      throw new Error(`${label} is missing required property "${key}".`);
    }
  }
  for (const key of Object.keys(record)) {
    if (!Object.prototype.hasOwnProperty.call(shape, key)) {
      throw new Error(`${label} included unknown property "${key}".`);
    }
  }
}

function validateReviewerFindingSequential(finding: unknown, index: number): ReviewerFindingPayload {
  const label = `Reviewer payload.findings[${index}]`;
  const record = requireRecordSequential(reviewerFindingSchema, finding, label);
  const shape = reviewerFindingSchema.shape;
  assertReviewerOwnProperties(record, shape as Record<string, z.ZodType>, label);
  // Historical order and access pattern: the files array-ness check read
  // `files` before severity (or any other declared field) was read, and the
  // items mapping below RE-READS the property after severity, so a stateful
  // accessor's second read supplies the validated items.
  const filesProbe = record.files;
  if (!Array.isArray(filesProbe)) {
    throw new Error(firstSchemaIssueMessage(shape.files, filesProbe, `${label}.files`));
  }
  return {
    severity: validateFieldSequential(shape.severity, record.severity, `${label}.severity`) as ReviewerFindingPayload['severity'],
    files: (record.files as unknown[]).map(
      (file, fileIndex) =>
        validateFieldSequential(shape.files.element as z.ZodType, file, `${label}.files[${fileIndex}]`) as string,
    ),
    claim: validateFieldSequential(shape.claim, record.claim, `${label}.claim`) as string,
    evidence: validateFieldSequential(shape.evidence, record.evidence, `${label}.evidence`) as string,
    requiredAction: validateFieldSequential(shape.requiredAction, record.requiredAction, `${label}.requiredAction`) as string,
  };
}

export function validateReviewerPayload(payload: unknown): ReviewerPayload {
  const record = requireRecordSequential(reviewerPayloadSchema, payload, 'Reviewer payload');
  const shape = reviewerPayloadSchema.shape;
  assertReviewerOwnProperties(record, shape as Record<string, z.ZodType>, 'Reviewer payload');
  // Historical access pattern: the array-ness check performs its own read,
  // and the mapping below re-reads the property (after summary), so a
  // stateful accessor's second read is the one validated and normalized.
  const findingsProbe = record.findings;
  if (!Array.isArray(findingsProbe)) {
    throw new Error(firstSchemaIssueMessage(shape.findings, findingsProbe, 'Reviewer payload.findings'));
  }
  return {
    summary: validateFieldSequential(shape.summary, record.summary, 'Reviewer payload.summary') as string,
    findings: (record.findings as unknown[]).map((finding, index) => validateReviewerFindingSequential(finding, index)),
    meaningfulProgressAction: validateFieldSequential(
      shape.meaningfulProgressAction,
      record.meaningfulProgressAction,
      'Reviewer payload.meaningfulProgressAction',
    ) as ReviewerPayload['meaningfulProgressAction'],
    meaningfulProgressRationale: validateFieldSequential(
      shape.meaningfulProgressRationale,
      record.meaningfulProgressRationale,
      'Reviewer payload.meaningfulProgressRationale',
    ) as string,
  };
}

// --- permissive validators ----------------------------------------------------

// Validates a read-only review_stuck consultant verdict. Exactly one triage
// category is autonomously recoverable: `misunderstanding` requires
// recoverable=true plus a non-empty resolutionDirective; the three genuine-wall
// categories (`authorization`, `external_precondition`, `impossible_task`)
// require recoverable=false. Anything else (recoverable=true with another
// triage, or recoverable=false paired with `misunderstanding`) is rejected so a
// malformed verdict can never drive an autonomous recovery.
export function validateConsultantVerdictPayload(rawPayload: unknown): ConsultantVerdict {
  const parsed = parsePayload(consultantPayloadSchema, rawPayload, 'Consultant payload');
  const payload: ConsultantVerdict = {
    recoverable: parsed.recoverable,
    triageCategory: parsed.triageCategory,
    resolutionDirective: parsed.resolutionDirective,
    // The verdict's targetCanonicalIds is optional: a coder/split-plan block has
    // no reviewer findings to point at, so an absent value defaults to [].
    targetCanonicalIds: parsed.targetCanonicalIds ?? [],
    rationale: parsed.rationale,
  };

  if (!payload.rationale.trim()) {
    throw new Error('Consultant returned an empty rationale.');
  }

  if (payload.recoverable) {
    if (payload.triageCategory !== 'misunderstanding') {
      throw new Error(
        'Consultant returned recoverable=true with a triageCategory other than misunderstanding.',
      );
    }
    if (!payload.resolutionDirective.trim()) {
      throw new Error('Consultant returned recoverable=true without a non-empty resolutionDirective.');
    }
  } else if (payload.triageCategory === 'misunderstanding') {
    throw new Error('Consultant returned recoverable=false paired with triageCategory=misunderstanding.');
  }

  return payload;
}

export function validatePlanReviewerPayload(payload: unknown): PlanReviewerPayload {
  const parsed = parsePayload(planReviewerPayloadSchema, payload, 'Plan reviewer payload');
  return {
    summary: parsed.summary,
    executionShape: parsed.executionShape,
    findings: parsed.findings.map((finding) => ({
      severity: finding.severity,
      files: finding.files,
      claim: finding.claim,
      // Plan-review findings carry no evidence field; the normalized finding
      // always forces an empty string.
      evidence: '',
      requiredAction: finding.requiredAction,
      // Default only the absent case to plan_correctness (the fail-safe class).
      // A present-but-invalid class was already rejected upstream in parsePayload,
      // so this never silently downgrades a bad value.
      findingClass: finding.findingClass ?? 'plan_correctness',
    })),
  };
}

function parseJsonPayload<TPayload>(raw: string, label: string): TPayload {
  try {
    return JSON.parse(raw) as TPayload;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`${label} returned invalid JSON: ${message}\nRaw response:\n${raw}`);
  }
}

function extractDelimitedPayload(raw: string, label: string) {
  const startIndex = raw.indexOf(EXECUTE_SCOPE_PROGRESS_PAYLOAD_START);
  if (startIndex === -1) {
    throw new Error(`${label} did not include the required progress-justification payload start marker.`);
  }

  if (raw.indexOf(EXECUTE_SCOPE_PROGRESS_PAYLOAD_START, startIndex + EXECUTE_SCOPE_PROGRESS_PAYLOAD_START.length) !== -1) {
    throw new Error(`${label} included multiple progress-justification payload start markers.`);
  }

  const endIndex = raw.indexOf(EXECUTE_SCOPE_PROGRESS_PAYLOAD_END, startIndex + EXECUTE_SCOPE_PROGRESS_PAYLOAD_START.length);
  if (endIndex === -1) {
    throw new Error(`${label} did not include the required progress-justification payload end marker.`);
  }

  if (raw.indexOf(EXECUTE_SCOPE_PROGRESS_PAYLOAD_END, endIndex + EXECUTE_SCOPE_PROGRESS_PAYLOAD_END.length) !== -1) {
    throw new Error(`${label} included multiple progress-justification payload end markers.`);
  }

  const payloadText = raw.slice(startIndex + EXECUTE_SCOPE_PROGRESS_PAYLOAD_START.length, endIndex).trim();
  if (!payloadText) {
    throw new Error(`${label} returned an empty progress-justification payload.`);
  }

  return {
    payloadText,
    startIndex,
    endIndex,
  };
}

function requireNonEmptyString(value: unknown, field: keyof ExecuteScopeProgressPayload, label: string) {
  // Base string-ness is enforced by the field's zod node from
  // executeScopeProgressSchema; the non-empty rule, trimming, and the pinned
  // delimiter-protocol message (shared by missing, wrong-typed, and blank
  // values) are runtime semantics layered on top.
  const parsed = executeScopeProgressSchema.shape[field].safeParse(value);
  if (!parsed.success || parsed.data.trim().length === 0) {
    throw new Error(`${label} returned an empty or missing ${field} field in the progress-justification payload.`);
  }

  return parsed.data.trim();
}

// Legacy marker-protocol compatibility for active legacy_marker_v1 execution
// sessions. New primary execution sessions use CoderScopePayload instead.
export function parseExecuteScopeProgressPayload(raw: string): ExecuteScopeProgressPayload {
  const label = 'Coder scope round';
  const { payloadText } = extractDelimitedPayload(raw, label);
  const payload = parseJsonPayload<ExecuteScopeProgressPayload>(payloadText, `${label} progress-justification payload`);

  return {
    milestoneTargeted: requireNonEmptyString(payload.milestoneTargeted, 'milestoneTargeted', label),
    newEvidence: requireNonEmptyString(payload.newEvidence, 'newEvidence', label),
    whyNotRedundant: requireNonEmptyString(payload.whyNotRedundant, 'whyNotRedundant', label),
    nextStepUnlocked: requireNonEmptyString(payload.nextStepUnlocked, 'nextStepUnlocked', label),
  };
}

export function stripExecuteScopeProgressPayload(raw: string) {
  const { startIndex, endIndex } = extractDelimitedPayload(raw, 'Coder scope round');
  const before = raw.slice(0, startIndex).trimEnd();
  const after = raw.slice(endIndex + EXECUTE_SCOPE_PROGRESS_PAYLOAD_END.length).trimStart();

  if (before && after) {
    return `${before}\n\n${after}`;
  }

  return before || after;
}

export function validateCoderResponsePayload(rawPayload: unknown): CoderResponsePayload {
  const payload: CoderResponsePayload = parsePayload(coderResponsePayloadSchema, rawPayload, 'Coder response round payload');

  const derivedPlan = payload.derivedPlan?.trim() ?? '';
  if (payload.outcome === 'split_plan' && !derivedPlan) {
    throw new Error('Coder response round returned outcome=split_plan without a derivedPlan payload.');
  }

  if (payload.outcome !== 'split_plan' && derivedPlan) {
    throw new Error('Coder response round returned a derivedPlan payload without outcome=split_plan.');
  }

  return payload;
}

export function validateCoderPlanResponsePayload(payload: unknown): CoderPlanResponsePayload {
  return parsePayload(coderPlanResponsePayloadSchema, payload, 'Planner plan-response round payload');
}

export function validateCoderPlanPayload(rawPayload: unknown): CoderPlanPayload {
  const payload: CoderPlanPayload = parsePayload(coderPlanPayloadSchema, rawPayload, 'Planner plan round payload');

  const planBody = payload.planBody.trim();
  const blockedReason = payload.blockedReason.trim();

  if (payload.action === 'ready_for_review' && !planBody) {
    throw new Error('Planner plan round returned action=ready_for_review without a planBody payload.');
  }
  if (payload.action === 'ready_for_review' && blockedReason) {
    throw new Error('Planner plan round returned a blockedReason payload with action=ready_for_review.');
  }
  if (payload.action === 'blocked' && !blockedReason) {
    throw new Error('Planner plan round returned action=blocked without a blockedReason payload.');
  }

  // The refined plan is persisted over the plan document and sent straight to
  // plan review, so it must satisfy the plan contract here — inside the
  // structured-output validator — where a failure triggers the repair loop
  // (the planner gets the errors and retries) instead of burning a reviewer
  // round on an invalid document. Split-plan payloads already have this gate
  // (validateSplitPlanPayload); a live run persisted a planner payload whose
  // planBody was a 39-line refinement summary declaring multi_scope with no
  // Execution Queue, and the reviewer round was spent rediscovering that.
  if (payload.action === 'ready_for_review') {
    const normalizedBody = normalizeExecutionShapeDeclaration(planBody, payload.executionShape);
    const validation = validatePlanDocument(normalizedBody);
    if (!validation.ok) {
      throw new Error(
        `Planner plan round returned a planBody that is not a valid Neal plan document: ${validation.errors.join('; ')}. ` +
          'Return the complete refined plan document, not a summary of the refinement.',
      );
    }
  }

  return {
    ...payload,
    message: payload.message.trim(),
  };
}

export function validateCoderScopePayload(rawPayload: unknown): CoderScopePayload {
  const parsed = parsePayload(coderScopeParseSchema, rawPayload, 'Coder scope round payload');
  const payload: CoderScopePayload = {
    action: parsed.action,
    message: parsed.message,
    progress: parsed.progress as ExecuteScopeProgressPayload,
    manualGate: parsed.manualGate as CoderScopePayload['manualGate'],
    derivedPlan: parsed.derivedPlan,
    blockedReason: parsed.blockedReason,
  };

  const progress = {
    milestoneTargeted: requireNonEmptyString(
      payload.progress?.milestoneTargeted,
      'milestoneTargeted',
      'Coder scope round',
    ),
    newEvidence: requireNonEmptyString(payload.progress?.newEvidence, 'newEvidence', 'Coder scope round'),
    whyNotRedundant: requireNonEmptyString(
      payload.progress?.whyNotRedundant,
      'whyNotRedundant',
      'Coder scope round',
    ),
    nextStepUnlocked: requireNonEmptyString(
      payload.progress?.nextStepUnlocked,
      'nextStepUnlocked',
      'Coder scope round',
    ),
  };
  const derivedPlan = payload.derivedPlan.trim();
  const blockedReason = payload.blockedReason.trim();
  const manualGate = payload.manualGate;

  if (payload.action === 'split_plan' && !derivedPlan) {
    throw new Error('Coder scope round returned action=split_plan without a derivedPlan payload.');
  }
  if (payload.action !== 'split_plan' && derivedPlan) {
    throw new Error('Coder scope round returned a derivedPlan payload without action=split_plan.');
  }
  if (payload.action === 'blocked' && !blockedReason) {
    throw new Error('Coder scope round returned action=blocked without a blockedReason payload.');
  }
  if (payload.action !== 'blocked' && blockedReason) {
    throw new Error('Coder scope round returned a blockedReason payload without action=blocked.');
  }
  if (payload.action === 'manual_gate') {
    if (manualGate === null || typeof manualGate !== 'object') {
      throw new Error('Coder scope round returned action=manual_gate without a manualGate payload.');
    }
    if (derivedPlan) {
      throw new Error('Coder scope round returned a derivedPlan payload with action=manual_gate.');
    }
    if (blockedReason) {
      throw new Error('Coder scope round returned a blockedReason payload with action=manual_gate.');
    }

    const id = requireNonEmptyManualGateString(manualGateSchema.shape.id, manualGate.id, 'manualGate.id');
    const title = requireNonEmptyManualGateString(manualGateSchema.shape.title, manualGate.title, 'manualGate.title');
    const reason = requireNonEmptyManualGateString(
      manualGateSchema.shape.reason,
      manualGate.reason,
      'manualGate.reason',
    );
    const instructionsMarkdown = requireNonEmptyManualGateString(
      manualGateSchema.shape.instructionsMarkdown,
      manualGate.instructionsMarkdown,
      'manualGate.instructionsMarkdown',
    );
    const resumeChecks = validateManualGateResumeChecks(manualGate.resumeChecks);

    return {
      ...payload,
      message: payload.message.trim(),
      progress,
      manualGate: {
        id,
        title,
        reason,
        instructionsMarkdown,
        resumeChecks,
      },
    };
  }

  if (manualGate !== null) {
    throw new Error('Coder scope round returned a manualGate payload without action=manual_gate.');
  }

  return {
    ...payload,
    message: payload.message.trim(),
    progress,
  };
}

// Base-constraint nodes for the resume-check cwd/timeoutMs fields, unwrapped
// from the emitted schema's nullable wrappers. Runtime optionality
// intentionally differs from the emitted schema's requiredness (the runtime
// validator accepts absence where the emitted schema requires the key), and
// the historical validator performed ONE property read per comparison and
// re-read the property for the normalized output — stateful accessors
// legitimately observe multiple short-circuited reads. The membership
// literals are therefore destructured from the zod enum node (one comparison
// per option, per read, as historically), and number-ness parses through the
// zod number node at its historical read position.
const resumeCheckCwdOptions = manualGateResumeCheckSchema.shape.cwd.unwrap().options;
const resumeCheckTimeoutMsNumberSchema = manualGateResumeCheckSchema.shape.timeoutMs.unwrap();

function requireNonEmptyManualGateString(fieldSchema: z.ZodType, value: unknown, fieldPath: string) {
  // Base string-ness is enforced by the field's zod node; the non-empty rule,
  // trimming, and the pinned message (shared by missing, wrong-typed, and
  // blank values) are runtime semantics layered on top.
  const parsed = fieldSchema.safeParse(value);
  if (!parsed.success || typeof parsed.data !== 'string' || parsed.data.trim().length === 0) {
    throw new Error(`Coder scope round returned an empty or missing ${fieldPath} field.`);
  }

  return parsed.data.trim();
}

function validateManualGateResumeChecks(value: unknown): ManualGateResumeCheck[] {
  // The at-least-one-command rule is runtime-only semantics (the emitted
  // schema does not constrain resumeChecks length), and its pinned message
  // covers the array-ness base constraint too.
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error('Coder scope round returned manualGate.resumeChecks without at least one command check.');
  }

  const checkShape = manualGateResumeCheckSchema.shape;
  return value.map((check, index) => {
    const fieldPath = `manualGate.resumeChecks[${index}]`;
    // Historical container gate with its pinned message; array items
    // intentionally fall through to the type check below, exactly as the
    // old typeof-based gate behaved.
    if (check === null || typeof check !== 'object') {
      throw new Error(`Coder scope round returned invalid ${fieldPath}.`);
    }
    const candidate = check as Partial<ManualGateResumeCheck>;
    if (!checkShape.type.safeParse(candidate.type).success) {
      throw new Error(`Coder scope round returned ${fieldPath}.type that is not "command".`);
    }
    const name = requireNonEmptyManualGateString(checkShape.name, candidate.name, `${fieldPath}.name`);
    // Emptiness is runtime-only semantics with a pinned message that also
    // covers array-ness; each part's base string-ness routes through the
    // command element's zod node below.
    if (!Array.isArray(candidate.command) || candidate.command.length === 0) {
      throw new Error(`Coder scope round returned ${fieldPath}.command without a non-empty string array.`);
    }
    const command = candidate.command.map((part, commandIndex) =>
      requireNonEmptyManualGateString(checkShape.command.element, part, `${fieldPath}.command[${commandIndex}]`),
    );
    // Historical access semantics preserved exactly: one property read per
    // comparison with short-circuiting, and fresh reads for the normalized
    // output below. The undefined/null comparisons carry the runtime
    // optionality; membership tests one zod enum option per read; the
    // positive-safe-integer rule stays explicit runtime semantics.
    if (
      candidate.cwd !== undefined &&
      candidate.cwd !== null &&
      candidate.cwd !== resumeCheckCwdOptions[0] &&
      candidate.cwd !== resumeCheckCwdOptions[1]
    ) {
      throw new Error(`Coder scope round returned ${fieldPath}.cwd that is not "repo" or "run_dir".`);
    }
    if (
      candidate.timeoutMs !== undefined &&
      candidate.timeoutMs !== null &&
      (!resumeCheckTimeoutMsNumberSchema.safeParse(candidate.timeoutMs).success ||
        !Number.isSafeInteger(candidate.timeoutMs) ||
        candidate.timeoutMs < 1)
    ) {
      throw new Error(`Coder scope round returned ${fieldPath}.timeoutMs that is not a positive safe integer.`);
    }

    return {
      type: 'command',
      name,
      command,
      ...(candidate.cwd === undefined || candidate.cwd === null ? {} : { cwd: candidate.cwd }),
      ...(candidate.timeoutMs === undefined || candidate.timeoutMs === null ? {} : { timeoutMs: candidate.timeoutMs }),
    };
  });
}

export function validateCoderBlockedRecoveryDispositionPayload(rawPayload: unknown): CoderBlockedRecoveryDispositionPayload {
  const payload: CoderBlockedRecoveryDispositionPayload = parsePayload(
    coderBlockedRecoveryDispositionPayloadSchema,
    rawPayload,
    'Coder blocked-recovery payload',
  );

  const blocker = payload.blocker.trim();
  const replacementPlan = payload.replacementPlan.trim();

  if (payload.action === 'replace_current_scope' && !replacementPlan) {
    throw new Error('Coder blocked-recovery round returned action=replace_current_scope without a replacementPlan payload.');
  }

  if (payload.action !== 'replace_current_scope' && replacementPlan) {
    throw new Error('Coder blocked-recovery round returned a replacementPlan payload without action=replace_current_scope.');
  }

  if ((payload.action === 'stay_blocked' || payload.action === 'terminal_block') && !blocker) {
    throw new Error(`Coder blocked-recovery round returned action=${payload.action} without a blocker payload.`);
  }

  return payload;
}

export function parseFinalCompletionSummaryPayload(rawPayload: unknown): FinalCompletionSummaryPayload {
  const payload: FinalCompletionSummaryPayload = parsePayload(
    finalCompletionSummaryPayloadSchema,
    rawPayload,
    'Final completion summary payload',
  );

  const whatChangedOverall = payload.whatChangedOverall.trim();
  const verificationSummary = payload.verificationSummary.trim();
  const remainingKnownGaps = payload.remainingKnownGaps
    .map((gap) => gap.trim())
    .filter((gap) => gap.length > 0);

  if (!whatChangedOverall) {
    throw new Error('Final completion summary returned an empty whatChangedOverall field.');
  }

  if (!verificationSummary) {
    throw new Error('Final completion summary returned an empty verificationSummary field.');
  }

  if (payload.planGoalSatisfied && remainingKnownGaps.length > 0) {
    throw new Error('Final completion summary cannot set planGoalSatisfied=true while remainingKnownGaps is non-empty.');
  }

  if (!payload.planGoalSatisfied && remainingKnownGaps.length === 0) {
    throw new Error('Final completion summary cannot set planGoalSatisfied=false with an empty remainingKnownGaps array.');
  }

  return {
    planGoalSatisfied: payload.planGoalSatisfied,
    whatChangedOverall,
    verificationSummary,
    remainingKnownGaps,
  };
}

export function parseFinalCompletionReviewerPayload(rawPayload: unknown): FinalCompletionReviewerVerdict {
  // Historical sequential order (pinned by test/agent-payload-schemas.test.ts,
  // a deliberate deviation from shape order): action, missingWork
  // object-ness, summary, rationale, missingWork nested fields, then
  // squashCommitMessage object-ness. Each step short-circuits before any
  // later property is read.
  const label = 'Final completion reviewer verdict payload';
  const record = requireRecordSequential(finalCompletionReviewerParseSchema, rawPayload, label);
  const shape = finalCompletionReviewerParseSchema.shape;
  const missingWorkSchema = finalCompletionReviewerPayloadSchema.shape.missingWork.unwrap() as z.ZodObject;
  const action = validateFieldSequential(
    shape.action,
    record.action,
    `${label}.action`,
  ) as FinalCompletionReviewerPayload['action'];
  const missingWorkValue = record.missingWork;
  const missingWorkRecord =
    missingWorkValue === null
      ? null
      : requireRecordSequential(missingWorkSchema, missingWorkValue, `${label}.missingWork`);
  const summaryValue = validateFieldSequential(shape.summary, record.summary, `${label}.summary`) as string;
  const rationaleValue = validateFieldSequential(shape.rationale, record.rationale, `${label}.rationale`) as string;
  const payload: FinalCompletionReviewerPayload = {
    action,
    summary: summaryValue,
    rationale: rationaleValue,
    missingWork:
      missingWorkRecord === null
        ? null
        : (walkObjectSequential(
            missingWorkSchema,
            missingWorkRecord,
            `${label}.missingWork`,
          ) as FinalCompletionReviewerPayload['missingWork']),
    // Historical access pattern: the null test, the undefined test, and the
    // object-ness validation each read the property (three reads for a
    // present draft, short-circuiting for null). Only object-ness is checked
    // here — via the parse-variant zod node — because the advisory draft
    // routes through the validate/repair post-parse step below.
    squashCommitMessage: (record.squashCommitMessage === null || record.squashCommitMessage === undefined
      ? null
      : requireRecordSequential(
          shape.squashCommitMessage,
          record.squashCommitMessage,
          `${label}.squashCommitMessage`,
        )) as FinalCompletionReviewerPayload['squashCommitMessage'],
  };

  const summary = payload.summary.trim();
  const rationale = payload.rationale.trim();
  const squashCommitMessageValue = payload.squashCommitMessage ?? null;

  if (!summary) {
    throw new Error('Final completion reviewer verdict returned an empty summary field.');
  }

  if (!rationale) {
    throw new Error('Final completion reviewer verdict returned an empty rationale field.');
  }

  const missingWork =
    payload.missingWork === null
      ? null
      : {
          summary: payload.missingWork.summary.trim(),
          requiredOutcome: payload.missingWork.requiredOutcome.trim(),
          verification: payload.missingWork.verification.trim(),
        };

  if (payload.action === 'continue_execution') {
    if (
      !missingWork ||
      !missingWork.summary ||
      !missingWork.requiredOutcome ||
      !missingWork.verification
    ) {
      throw new Error(
        'Final completion reviewer verdict must include a non-empty missingWork payload when action=continue_execution.',
      );
    }
  }

  if (payload.action !== 'continue_execution' && missingWork) {
    throw new Error(
      `Final completion reviewer verdict cannot include missingWork when action=${payload.action}.`,
    );
  }

  let squashCommitMessage: FinalCompletionReviewerVerdict['squashCommitMessage'] = null;
  if (payload.action === 'accept_complete' && squashCommitMessageValue !== null) {
    try {
      squashCommitMessage = validateReviewerSquashMessageDraft(squashCommitMessageValue, {
        label: 'Final completion reviewer squashCommitMessage',
      });
    } catch {
      squashCommitMessage = repairReviewerSquashMessageDraft(squashCommitMessageValue);
    }
  }

  return {
    action: payload.action,
    summary,
    rationale,
    missingWork,
    squashCommitMessage,
  };
}
