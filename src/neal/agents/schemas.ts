import type { CoderConsultDisposition, ExecutionShape } from '../types.js';

export type ReviewerFindingPayload = {
  severity: 'blocking' | 'non_blocking';
  files: string[];
  claim: string;
  requiredAction: string;
};

export type ReviewerPayload = {
  summary: string;
  findings: ReviewerFindingPayload[];
};

export type PlanReviewerPayload = ReviewerPayload & {
  executionShape: ExecutionShape;
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
    },
    required: ['summary', 'findings'],
    additionalProperties: false,
  } as const;
}

export function buildPlanReviewerSchema() {
  return {
    type: 'object',
    properties: {
      summary: { type: 'string' },
      executionShape: { type: 'string', enum: ['one_shot', 'multi_scope'] },
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

function parseJsonPayload<TPayload>(raw: string, label: string): TPayload {
  try {
    return JSON.parse(raw) as TPayload;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`${label} returned invalid JSON: ${message}\nRaw response:\n${raw}`);
  }
}

export function parseCoderResponsePayload(raw: string) {
  return parseJsonPayload<CoderResponsePayload>(raw, 'Coder response round');
}

export function parseCoderConsultDispositionPayload(raw: string) {
  return parseJsonPayload<CoderConsultDispositionPayload>(raw, 'Coder consult-response round');
}
