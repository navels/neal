import type {
  CoderBlockedRecoveryDisposition,
  CoderConsultDisposition,
  ExecuteScopeProgressJustification,
  ExecutionShape,
  FinalCompletionReviewerVerdict,
  FinalCompletionSummary,
  ReviewerMeaningfulProgressAction,
} from '../types.js';

export type ReviewerFindingPayload = {
  severity: 'blocking' | 'non_blocking';
  files: string[];
  claim: string;
  requiredAction: string;
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

export type CoderConsultDispositionPayload = CoderConsultDisposition;
export type CoderBlockedRecoveryDispositionPayload = CoderBlockedRecoveryDisposition;
export type ExecuteScopeProgressPayload = ExecuteScopeProgressJustification;
export type FinalCompletionSummaryPayload = FinalCompletionSummary;
export type FinalCompletionReviewerPayload = FinalCompletionReviewerVerdict;

export const EXECUTE_SCOPE_PROGRESS_PAYLOAD_START = 'NEAL_PROGRESS_JUSTIFICATION_JSON_START';
export const EXECUTE_SCOPE_PROGRESS_PAYLOAD_END = 'NEAL_PROGRESS_JUSTIFICATION_JSON_END';

export function buildReviewerSchema() {
  return {
    type: 'object',
    properties: {
      summary: { type: 'string' },
      findings: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            severity: { type: 'string', enum: ['blocking', 'non_blocking'] },
            files: { type: 'array', items: { type: 'string' } },
            claim: { type: 'string' },
            requiredAction: { type: 'string' },
          },
          required: ['severity', 'files', 'claim', 'requiredAction'],
          additionalProperties: false,
        },
      },
      meaningfulProgressAction: { type: 'string', enum: ['accept', 'block_for_operator', 'replace_plan'] },
      meaningfulProgressRationale: { type: 'string' },
    },
    required: ['summary', 'findings', 'meaningfulProgressAction', 'meaningfulProgressRationale'],
    additionalProperties: false,
  } as const;
}

export function buildPlanReviewerSchema() {
  return {
    type: 'object',
    properties: {
      summary: { type: 'string' },
      executionShape: { type: 'string', enum: ['one_shot', 'multi_scope', 'multi_scope_unknown'] },
      findings: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            severity: { type: 'string', enum: ['blocking', 'non_blocking'] },
            files: { type: 'array', items: { type: 'string' } },
            claim: { type: 'string' },
            requiredAction: { type: 'string' },
          },
          required: ['severity', 'files', 'claim', 'requiredAction'],
          additionalProperties: false,
        },
      },
    },
    required: ['summary', 'executionShape', 'findings'],
    additionalProperties: false,
  } as const;
}

export function buildConsultReviewerSchema() {
  return {
    type: 'object',
    properties: {
      summary: { type: 'string' },
      diagnosis: { type: 'string' },
      confidence: { type: 'string', enum: ['low', 'medium', 'high'] },
      recoverable: { type: 'boolean' },
      recommendations: { type: 'array', items: { type: 'string' } },
      relevantFiles: { type: 'array', items: { type: 'string' } },
      rationale: { type: 'string' },
    },
    required: ['summary', 'diagnosis', 'confidence', 'recoverable', 'recommendations', 'relevantFiles', 'rationale'],
    additionalProperties: false,
  } as const;
}

export function buildCoderResponseSchema() {
  return {
    type: 'object',
    properties: {
      outcome: { type: 'string', enum: ['responded', 'blocked', 'split_plan'] },
      summary: { type: 'string' },
      blocker: { type: 'string' },
      derivedPlan: { type: 'string' },
      responses: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            id: { type: 'string' },
            decision: { type: 'string', enum: ['fixed', 'rejected', 'deferred'] },
            summary: { type: 'string' },
          },
          required: ['id', 'decision', 'summary'],
          additionalProperties: false,
        },
      },
    },
    required: ['outcome', 'summary', 'blocker', 'derivedPlan', 'responses'],
    additionalProperties: false,
  } as const;
}

export function buildCoderConsultDispositionSchema() {
  return {
    type: 'object',
    properties: {
      outcome: { type: 'string', enum: ['resumed', 'blocked'] },
      summary: { type: 'string' },
      blocker: { type: 'string' },
      decision: { type: 'string', enum: ['followed', 'partially_followed', 'rejected'] },
      rationale: { type: 'string' },
    },
    required: ['outcome', 'summary', 'blocker', 'decision', 'rationale'],
    additionalProperties: false,
  } as const;
}

export function buildCoderBlockedRecoveryDispositionSchema() {
  return {
    type: 'object',
    properties: {
      action: {
        type: 'string',
        enum: ['resume_current_scope', 'replace_current_scope', 'stay_blocked', 'terminal_block'],
      },
      summary: { type: 'string' },
      rationale: { type: 'string' },
      blocker: { type: 'string' },
      replacementPlan: { type: 'string' },
    },
    required: ['action', 'summary', 'rationale', 'blocker', 'replacementPlan'],
    additionalProperties: false,
  } as const;
}

export function buildCoderPlanResponseSchema() {
  return {
    type: 'object',
    properties: {
      outcome: { type: 'string', enum: ['responded', 'blocked'] },
      summary: { type: 'string' },
      blocker: { type: 'string' },
      responses: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            id: { type: 'string' },
            decision: { type: 'string', enum: ['fixed', 'rejected', 'deferred'] },
            summary: { type: 'string' },
          },
          required: ['id', 'decision', 'summary'],
          additionalProperties: false,
        },
      },
    },
    required: ['outcome', 'summary', 'blocker', 'responses'],
    additionalProperties: false,
  } as const;
}

export function buildExecuteScopeProgressSchema() {
  return {
    type: 'object',
    properties: {
      milestoneTargeted: { type: 'string' },
      newEvidence: { type: 'string' },
      whyNotRedundant: { type: 'string' },
      nextStepUnlocked: { type: 'string' },
    },
    required: ['milestoneTargeted', 'newEvidence', 'whyNotRedundant', 'nextStepUnlocked'],
    additionalProperties: false,
  } as const;
}

export function buildFinalCompletionSummarySchema() {
  return {
    type: 'object',
    properties: {
      planGoalSatisfied: { type: 'boolean' },
      whatChangedOverall: { type: 'string' },
      verificationSummary: { type: 'string' },
      remainingKnownGaps: {
        type: 'array',
        items: { type: 'string' },
      },
    },
    required: ['planGoalSatisfied', 'whatChangedOverall', 'verificationSummary', 'remainingKnownGaps'],
    additionalProperties: false,
  } as const;
}

export function buildFinalCompletionReviewerSchema() {
  return {
    type: 'object',
    properties: {
      action: { type: 'string', enum: ['accept_complete', 'continue_execution', 'block_for_operator'] },
      summary: { type: 'string' },
      rationale: { type: 'string' },
      missingWork: {
        type: ['object', 'null'],
        properties: {
          summary: { type: 'string' },
          requiredOutcome: { type: 'string' },
          verification: { type: 'string' },
        },
        required: ['summary', 'requiredOutcome', 'verification'],
        additionalProperties: false,
      },
    },
    required: ['action', 'summary', 'rationale', 'missingWork'],
    additionalProperties: false,
  } as const;
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
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error(`${label} returned an empty or missing ${field} field in the progress-justification payload.`);
  }

  return value.trim();
}

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

export function parseCoderResponsePayload(raw: string) {
  return parseJsonPayload<CoderResponsePayload>(raw, 'Coder response round');
}

export function parseCoderConsultDispositionPayload(raw: string) {
  return parseJsonPayload<CoderConsultDispositionPayload>(raw, 'Coder consult-response round');
}

export function parseCoderBlockedRecoveryDispositionPayload(raw: string) {
  const payload = parseJsonPayload<CoderBlockedRecoveryDispositionPayload>(raw, 'Coder blocked-recovery round');
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

export function parseFinalCompletionSummaryPayload(payload: FinalCompletionSummaryPayload) {
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

export function parseFinalCompletionReviewerPayload(payload: FinalCompletionReviewerPayload) {
  const summary = payload.summary.trim();
  const rationale = payload.rationale.trim();

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

  return {
    action: payload.action,
    summary,
    rationale,
    missingWork,
  };
}
