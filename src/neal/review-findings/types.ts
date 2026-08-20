import type { AdjudicatedLoopOutcome, ReviewedDraftLoopVerdict } from '../adjudicator/contracts.js';
import type { ParsedReviewArgs, ParsedReviewSelector, ReviewInstructionSource } from '../cli.js';
import type { ResolvedReviewTarget } from '../review-mode.js';
import type { FindingSeverity } from '../types.js';

export type ReviewFindingsReviewerVerdict = ReviewedDraftLoopVerdict;

export type ReviewFindingsOutcome = Extract<AdjudicatedLoopOutcome, 'accepted' | 'blocked' | 'failed' | 'cap_reached'>;

export type ReviewFindingItem = {
  severity: FindingSeverity;
  files: string[];
  claim: string;
  evidence: string;
  requiredAction: string;
};

export type ReviewFindingsDraft = {
  summary: string;
  findings: ReviewFindingItem[];
  warnings?: string[];
};

export type ReviewFindingsReview = {
  verdict: ReviewFindingsReviewerVerdict;
  findings: string[];
  finalMarkdown?: string;
  blockedReason?: string;
  warnings?: string[];
};

export type ReviewFindingsContext = {
  version: 1;
  instruction: string;
  instructionSource: ReviewInstructionSource;
  selector: ParsedReviewSelector;
  baseRef: string;
  headRef: string;
  externalBaseCommit: string;
  externalHeadCommit: string;
  externalCommits: string[];
  externalCommitSubjects: string[];
  externalChangedFiles: string[];
  diffStat: string;
  diff: string;
};

export type ReviewFindingsProviderDraftArgs = {
  context: ReviewFindingsContext;
  round: number;
  previousDraft: ReviewFindingsDraft | null;
  reviewFindings: string[];
  prompt: string;
  // Optional sink for the provider session id of the draft (coder) turn, so the
  // run can record a resumable handle. The second argument names the provider
  // that owns the session (e.g. 'anthropic-claude', 'openai-codex') so the
  // resume hint can print that provider's resume command. Mirrors the
  // plan/execute onSessionStarted callback; non-SDK/test adapters simply leave
  // it uncalled.
  onSessionHandle?: (sessionHandle: string | null, provider?: string) => void;
};

export type ReviewFindingsProviderReviewArgs = {
  context: ReviewFindingsContext;
  round: number;
  draft: ReviewFindingsDraft;
  prompt: string;
  // Optional sink for the provider session id of the reviewer turn (see above).
  onSessionHandle?: (sessionHandle: string | null, provider?: string) => void;
};

// ReviewFindingsProviderAdapter is a review-local findings loop strategy and
// test-injection seam. It is intentionally separate from writer-run SDK
// provider adapters.
export type ReviewFindingsProviderAdapter = {
  draftFindings(args: ReviewFindingsProviderDraftArgs): Promise<ReviewFindingsDraft>;
  reviewDraft(args: ReviewFindingsProviderReviewArgs): Promise<ReviewFindingsReview>;
};

export type ReviewFindingsArtifactPaths = {
  reviewDir: string;
  meta: string;
  events: string;
  request: string;
  context: string;
  draft: string;
  review: string;
  rounds: string;
  final: string;
};

export type ReviewFindingsMeta = {
  version: 1;
  reviewId: string;
  createdAt: string;
  cwd: string;
  instruction: string;
  instructionSource: ReviewInstructionSource;
  selector: ParsedReviewSelector;
  target: ResolvedReviewTarget;
  reviewDir: string;
  maxRounds: number;
  outcome: ReviewFindingsOutcome;
};

export type ReviewFindingsLoopRound = {
  round: number;
  draftPrompt: string;
  reviewPrompt: string;
  draft: ReviewFindingsDraft;
  review: ReviewFindingsReview;
  // Provider session ids for the draft (coder) and review (reviewer) turns of
  // this round, when the provider surfaced them, plus the provider id that
  // owns each session. The coder and reviewer can be different providers, so
  // each handle carries its own provider; the resume hint maps the provider to
  // its CLI resume command. Absent for non-SDK/test providers.
  draftSessionHandle?: string | null;
  draftSessionProvider?: string | null;
  reviewSessionHandle?: string | null;
  reviewSessionProvider?: string | null;
};

export type ReviewFindingsReviewArtifact = {
  version: 1;
  outcome: ReviewFindingsOutcome;
  maxRounds: number;
  rounds: ReviewFindingsLoopRound[];
};

export type ReviewFindingsRunResult = {
  reviewId: string;
  paths: ReviewFindingsArtifactPaths;
  meta: ReviewFindingsMeta;
  context: ReviewFindingsContext;
  draft: ReviewFindingsDraft;
  review: ReviewFindingsReview;
  rounds: ReviewFindingsLoopRound[];
  outcome: ReviewFindingsOutcome;
  finalMarkdown: string | null;
};
