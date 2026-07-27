export type AdjudicatedLoopKind =
  | 'plan'
  | 'execute'
  | 'review'
  | 'final_completion';

export type LoopSideEffectPolicy =
  | 'read_only'
  | 'plan_doc_only'
  | 'code_changes';

export type AdjudicatedLoopOutcome =
  | 'accepted'
  | 'revise'
  | 'blocked'
  | 'failed'
  | 'cap_reached';

export type TerminalArtifactKind =
  | 'plan_document'
  | 'derived_plan_document'
  | 'implementation_scope'
  | 'review_findings'
  | 'final_completion_review';

export type LoopRoundCapMetadata = {
  source: string;
  appliesTo: 'review_iterations' | 'continued_execution';
  outcomeWhenReached: AdjudicatedLoopOutcome;
  notes: string;
};

export type TerminalArtifactMetadata = {
  kind: TerminalArtifactKind;
  storage: string;
  description: string;
};

export type AdjudicatedLoopContract = {
  loopKind: AdjudicatedLoopKind;
  sideEffectPolicy: LoopSideEffectPolicy;
  allowedOutcomes: readonly AdjudicatedLoopOutcome[];
  terminalOutcomes: readonly AdjudicatedLoopOutcome[];
  roundCap: LoopRoundCapMetadata;
  terminalArtifact: TerminalArtifactMetadata;
};

export type ReviewedDraftLoopVerdict = Extract<AdjudicatedLoopOutcome, 'accepted' | 'revise' | 'blocked'>;
export type ReviewedDraftLoopTerminalOutcome = Extract<AdjudicatedLoopOutcome, 'accepted' | 'blocked' | 'cap_reached'>;

export const REVIEW_FINDINGS_ADJUDICATED_LOOP_CONTRACT: AdjudicatedLoopContract = {
  loopKind: 'review',
  sideEffectPolicy: 'read_only',
  allowedOutcomes: ['accepted', 'revise', 'blocked', 'failed', 'cap_reached'],
  terminalOutcomes: ['accepted', 'blocked', 'failed', 'cap_reached'],
  roundCap: {
    source: 'neal.max_review_rounds',
    appliesTo: 'review_iterations',
    outcomeWhenReached: 'cap_reached',
    notes: 'Review findings revise the read-only findings artifact until reviewer acceptance or the configured review-round cap is reached.',
  },
  terminalArtifact: {
    kind: 'review_findings',
    storage: '.neal/reviews/<review-id>/REVIEW_FINAL.md',
    description: 'Accepted read-only findings for a selected local commit range.',
  },
};

export const ADJUDICATED_LOOP_KINDS: readonly AdjudicatedLoopKind[] = [
  'plan',
  'execute',
  'review',
  'final_completion',
] as const;

export const LOOP_SIDE_EFFECT_POLICIES: readonly LoopSideEffectPolicy[] = [
  'read_only',
  'plan_doc_only',
  'code_changes',
] as const;

export const ADJUDICATED_LOOP_OUTCOMES: readonly AdjudicatedLoopOutcome[] = [
  'accepted',
  'revise',
  'blocked',
  'failed',
  'cap_reached',
] as const;

export function assertAllowedLoopOutcome(
  contract: AdjudicatedLoopContract,
  outcome: AdjudicatedLoopOutcome,
  ownerId: string,
) {
  if (contract.allowedOutcomes.includes(outcome)) {
    return;
  }

  throw new Error(
    `Adjudicated loop ${ownerId} resolved outcome ${outcome}, but allowed outcomes are: ${contract.allowedOutcomes.join(', ')}.`,
  );
}

export function assertTerminalLoopOutcome(
  contract: AdjudicatedLoopContract,
  outcome: AdjudicatedLoopOutcome,
  ownerId: string,
) {
  assertAllowedLoopOutcome(contract, outcome, ownerId);
  if (contract.terminalOutcomes.includes(outcome)) {
    return;
  }

  throw new Error(
    `Adjudicated loop ${ownerId} resolved terminal outcome ${outcome}, but terminal outcomes are: ${contract.terminalOutcomes.join(', ')}.`,
  );
}

function isReviewedDraftTerminalOutcome(outcome: AdjudicatedLoopOutcome): outcome is ReviewedDraftLoopTerminalOutcome {
  return outcome === 'accepted' || outcome === 'blocked' || outcome === 'cap_reached';
}

export function resolveReviewedDraftLoopStep(args: {
  ownerId: string;
  contract: AdjudicatedLoopContract;
  verdict: ReviewedDraftLoopVerdict;
  round: number;
  maxRounds: number;
}): {
  outcome: AdjudicatedLoopOutcome;
  terminalOutcome: ReviewedDraftLoopTerminalOutcome | null;
  shouldRevise: boolean;
  capReached: boolean;
} {
  if (args.round < 1) {
    throw new Error(`Adjudicated loop ${args.ownerId} round must be at least 1.`);
  }
  if (args.maxRounds < 1) {
    throw new Error(`Adjudicated loop ${args.ownerId} maxRounds must be at least 1.`);
  }

  assertAllowedLoopOutcome(args.contract, args.verdict, args.ownerId);

  if (args.verdict === 'accepted' || args.verdict === 'blocked') {
    assertTerminalLoopOutcome(args.contract, args.verdict, args.ownerId);
    return {
      outcome: args.verdict,
      terminalOutcome: args.verdict,
      shouldRevise: false,
      capReached: false,
    };
  }

  if (args.round >= args.maxRounds) {
    const capOutcome = args.contract.roundCap.outcomeWhenReached;
    assertTerminalLoopOutcome(args.contract, capOutcome, args.ownerId);
    if (!isReviewedDraftTerminalOutcome(capOutcome)) {
      throw new Error(
        `Adjudicated loop ${args.ownerId} round cap outcome ${capOutcome} is not valid for a reviewed draft loop.`,
      );
    }

    return {
      outcome: capOutcome,
      terminalOutcome: capOutcome,
      shouldRevise: false,
      capReached: true,
    };
  }

  return {
    outcome: 'revise',
    terminalOutcome: null,
    shouldRevise: true,
    capReached: false,
  };
}

export function renderAdjudicatedLoopContractLines(contract: AdjudicatedLoopContract) {
  return [
    `- Loop kind: ${contract.loopKind}`,
    `- Side-effect policy: ${contract.sideEffectPolicy}`,
    `- Allowed loop outcomes: ${contract.allowedOutcomes.join(', ')}`,
    `- Terminal loop outcomes: ${contract.terminalOutcomes.join(', ')}`,
    `- Round cap: ${contract.roundCap.source} -> ${contract.roundCap.outcomeWhenReached}`,
    `- Terminal artifact: ${contract.terminalArtifact.kind} at ${contract.terminalArtifact.storage}`,
  ];
}

export function validateAdjudicatedLoopContract(ownerId: string, contract: AdjudicatedLoopContract | undefined) {
  if (!contract) {
    throw new Error(`Adjudication spec ${ownerId} is missing an adjudicated loop contract.`);
  }

  if (!ADJUDICATED_LOOP_KINDS.includes(contract.loopKind)) {
    throw new Error(`Adjudication spec ${ownerId} declares unknown loop kind ${contract.loopKind}.`);
  }

  if (!LOOP_SIDE_EFFECT_POLICIES.includes(contract.sideEffectPolicy)) {
    throw new Error(`Adjudication spec ${ownerId} must declare a valid side-effect policy.`);
  }

  if (contract.allowedOutcomes.length === 0) {
    throw new Error(`Adjudication spec ${ownerId} must declare at least one allowed loop outcome.`);
  }

  if (contract.terminalOutcomes.length === 0) {
    throw new Error(`Adjudication spec ${ownerId} must declare at least one terminal loop outcome.`);
  }

  const allowedOutcomes = new Set(contract.allowedOutcomes);
  for (const outcome of contract.allowedOutcomes) {
    if (!ADJUDICATED_LOOP_OUTCOMES.includes(outcome)) {
      throw new Error(`Adjudication spec ${ownerId} declares unknown loop outcome ${outcome}.`);
    }
  }

  for (const outcome of contract.terminalOutcomes) {
    if (!allowedOutcomes.has(outcome)) {
      throw new Error(`Adjudication spec ${ownerId} terminal outcome ${outcome} is not in allowed loop outcomes.`);
    }
  }

  if (!allowedOutcomes.has(contract.roundCap.outcomeWhenReached)) {
    throw new Error(
      `Adjudication spec ${ownerId} round cap outcome ${contract.roundCap.outcomeWhenReached} is not in allowed loop outcomes.`,
    );
  }

  if (!contract.roundCap.source.trim()) {
    throw new Error(`Adjudication spec ${ownerId} must declare a round-cap source.`);
  }

  if (!contract.roundCap.notes.trim()) {
    throw new Error(`Adjudication spec ${ownerId} must declare round-cap semantics.`);
  }

  if (!contract.terminalArtifact.storage.trim() || !contract.terminalArtifact.description.trim()) {
    throw new Error(`Adjudication spec ${ownerId} must declare terminal artifact storage and description.`);
  }
}

validateAdjudicatedLoopContract('review', REVIEW_FINDINGS_ADJUDICATED_LOOP_CONTRACT);
