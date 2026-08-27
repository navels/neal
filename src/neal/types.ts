import type { ProviderId } from './providers/types.js';
import type { SquashCommitMessageDraft } from './squash-message.js';

export type OrchestrationPhase =
  | 'coder_plan'
  | 'reviewer_plan'
  | 'coder_plan_response'
  | 'coder_plan_optional_response'
  | 'awaiting_derived_plan_execution'
  | 'coder_scope'
  | 'manual_gate'
  | 'reviewer_scope'
  | 'coder_response'
  | 'coder_optional_response'
  | 'interactive_blocked_recovery'
  | 'execute_finalization'
  | 'final_completion_review'
  | 'done'
  | 'blocked';

export type ScopeMarker = 'AUTONOMY_SCOPE_DONE' | 'AUTONOMY_CHUNK_DONE' | 'AUTONOMY_DONE' | 'AUTONOMY_BLOCKED' | 'AUTONOMY_SPLIT_PLAN';
export type CoderSessionProtocol = 'legacy_marker_v1' | 'structured_json_v1';
export type AgentProvider = ProviderId;
export type ExecutionShape = 'one_shot' | 'multi_scope' | 'multi_scope_unknown';
export type TopLevelMode = 'plan' | 'execute';

export type ManualGateResumeCheck = {
  type: 'command';
  name: string;
  command: string[];
  cwd?: 'repo' | 'run_dir';
  timeoutMs?: number;
};

export type ManualGateState = {
  id: string;
  title: string;
  reason: string;
  instructionsPath: string;
  resumeChecks: ManualGateResumeCheck[];
  resumePhase: 'coder_scope';
  createdAt: string;
  updatedAt: string;
  lastCheckedAt: string | null;
  lastFailure: {
    checkName: string;
    exitCode: number | null;
    signal: string | null;
    stdoutTail: string;
    stderrTail: string;
  } | null;
};

export type AgentRoleConfig = {
  provider: AgentProvider;
  model: string | null;
  effort?: string | null;
};

export type AgentConfig = {
  planner: AgentRoleConfig;
  coder: AgentRoleConfig;
  reviewer: AgentRoleConfig;
};

export type FindingSeverity = 'blocking' | 'non_blocking';
export type FindingStatus = 'open' | 'fixed' | 'rejected' | 'deferred';
export type ReviewFindingSource = 'reviewer' | 'plan_structure';
// Plan-review findings declare whether they demand a plan-correctness fix or a
// verification-hardening one. The class is optional here because execute-review
// findings never carry one and legacy run states predate the field.
export type PlanReviewFindingClass = 'plan_correctness' | 'verification_hardening';

export type ReviewFinding = {
  id: string;
  canonicalId: string;
  round: number;
  source: ReviewFindingSource;
  severity: FindingSeverity;
  // Declared only for plan-review findings; absent/undefined for execute-review
  // findings and for legacy run states. Disposition sites treat an absent class
  // as fail-safe round-forcing (blocking).
  findingClass?: PlanReviewFindingClass;
  files: string[];
  claim: string;
  evidence?: string | null;
  requiredAction: string;
  status: FindingStatus;
  roundSummary: string;
  coderDisposition: string | null;
  coderCommit: string | null;
};

export type ResidualReviewDebtItem = {
  id: string;
  canonicalId: string;
  status: Extract<FindingStatus, 'open' | 'deferred'>;
  files: string[];
  claim: string;
  evidence: string | null;
  requiredAction: string;
  coderDisposition: string | null;
  coderCommit: string | null;
  // Declared only for plan-review debt; absent/undefined for execute-phase
  // residual debt (which carries no finding class or origin round). Preserved
  // optional so legacy execute-phase debt hydrates unchanged.
  findingClass?: PlanReviewFindingClass;
  originRound?: number;
};

export type ReviewRound = {
  round: number;
  reviewerSessionHandle: string | null;
  reviewedPlanPath: string | null;
  normalizationApplied: boolean;
  normalizationOperations: string[];
  normalizationScopeLabelMappings: {
    normalizedScopeNumber: number;
    originalScopeLabel: string;
  }[];
  commitRange: {
    base: string;
    head: string;
  };
  openBlockingCanonicalCount: number;
  openBlockingCanonicalIds?: string[];
  findings: string[];
};

export type ExecuteScopeProgressJustification = {
  milestoneTargeted: string;
  newEvidence: string;
  whyNotRedundant: string;
  nextStepUnlocked: string;
};

export type ReviewerMeaningfulProgressAction = 'accept' | 'block_for_operator' | 'replace_plan' | 'advance_parent';

export type ReviewerMeaningfulProgressVerdict = {
  action: ReviewerMeaningfulProgressAction;
  rationale: string;
};

// Triage outcome from the read-only review_stuck consultant. Exactly one category
// is autonomously recoverable: `misunderstanding` (the reviewer and coder talked
// past each other and the coder can resolve it within the existing scope). The
// other three are genuine walls that must fall through to today's escalation:
// `authorization` (needs new credentials/permission), `external_precondition`
// (needs network/services/external state), `impossible_task` (the scope as
// written cannot be satisfied). `bounded_clarification` is deliberately excluded
// from this increment.
export type ConsultantTriageCategory =
  | 'misunderstanding'
  | 'authorization'
  | 'external_precondition'
  | 'impossible_task';

export type ConsultantVerdict = {
  recoverable: boolean;
  triageCategory: ConsultantTriageCategory;
  resolutionDirective: string;
  targetCanonicalIds?: string[];
  rationale: string;
};

// Anti-thrash window record for the generalized consultant. A record is
// written only by `enterInteractiveBlockedRecovery` (the sole writer) when the
// consultant actually ran for a block, and is matched on
// the full scope identity (`scopeNumber` + `derivedScopeIndex`) plus `sourcePhase`
// and the normalized blocker key. The scope identity is what makes the guard
// resume-safe: a later scope's blocker can never be mistaken for a repeat of an
// earlier scope's block.
export type RecentBlockRecord = {
  scopeNumber: number;
  derivedScopeIndex: number | null;
  sourcePhase: InteractiveBlockedRecoveryState['sourcePhase'];
  normalizedKey: string;
  evidenceFingerprint: string;
  count: number;
  recordedAt: string;
};

export type FinalCompletionSummary = {
  planGoalSatisfied: boolean;
  whatChangedOverall: string;
  verificationSummary: string;
  remainingKnownGaps: string[];
};

export type FinalCompletionMissingWork = {
  summary: string;
  requiredOutcome: string;
  verification: string;
};

export type FinalCompletionReviewerAction = 'accept_complete' | 'continue_execution' | 'block_for_operator';

export type FinalCompletionReviewerVerdict = {
  action: FinalCompletionReviewerAction;
  summary: string;
  rationale: string;
  missingWork: FinalCompletionMissingWork | null;
  squashCommitMessage: SquashCommitMessageDraft | null;
};

export type FinalCompletionTerminalScope = {
  finalCommit: string | null;
  commitSubject: string | null;
  changedFiles: string[];
  archivedReviewPath: string | null;
  marker?: ScopeMarker | null;
};

export type FinalCompletionReferenceScope = Pick<
  ProgressScope,
  'number' | 'finalCommit' | 'commitSubject' | 'changedFiles' | 'archivedReviewPath'
>;

export type ScopeAccountingSummary = {
  acceptedScopeRecords: number;
  acceptedTopLevelScopeRecords: number;
  acceptedDerivedSubScopeRecords: number;
  blockedScopeRecords: number;
  blockedTopLevelScopeRecords: number;
  blockedDerivedSubScopeRecords: number;
  replacedParentScopes: {
    number: string;
    derivedPlanPath: string;
  }[];
  summary: string;
};

export type VerificationCommandResult = {
  command: string;
  provider: string | null;
  status: string | null;
  exitCode: number | null;
  cwd: string | null;
  gitHead: string | null;
  completedAt: string | null;
  itemId: string | null;
  outputLength: number | null;
};

// Bounded tally of the run's recorded verification commands for the
// final-completion prompts. Counts cover the latest result per distinct
// command; recentFailures carries at most the last few failing commands with
// command strings capped, so the tally stays a fixed size regardless of how
// many verification commands the run recorded. The complete per-command record
// lives in the run's events.ndjson.
export type FinalCompletionVerificationTally = {
  totalRuns: number;
  distinctCommands: number;
  passed: number;
  failed: number;
  unknown: number;
  recentFailures: {
    command: string;
    exitCode: number | null;
  }[];
};

export type FinalCompletionAggregateReviewContext = {
  baseCommit: string | null;
  headCommit: string | null;
  range: string | null;
  commitSubjects: string[];
  diffStat: string;
  changedFiles: string[];
  unavailableReason: string | null;
};

export type FinalCompletionPacket = {
  planDoc: string;
  executionShape: ExecutionShape | null;
  currentScopeLabel: string;
  finalCommit: string | null;
  aggregateReviewContext: FinalCompletionAggregateReviewContext;
  completedScopeSummary: string;
  acceptedScopeCount: number;
  blockedScopeCount: number;
  scopeAccounting: ScopeAccountingSummary;
  scopeAccountingSummary: string;
  verificationOnlyCompletion: boolean;
  terminalChangedFiles: string[];
  terminalChangedFilesSummary: string;
  planChangedFiles: string[];
  planChangedFilesSummary: string;
  residualReviewDebt: ResidualReviewDebtItem[];
  residualReviewDebtSummary: string;
  verificationTally: FinalCompletionVerificationTally;
  lastNonEmptyImplementationScope: FinalCompletionReferenceScope | null;
  continueExecutionCount: number;
  continueExecutionMax: number;
};

export type InteractiveBlockedRecoveryAction =
  | 'resume_current_scope'
  | 'replace_current_scope'
  | 'stay_blocked'
  | 'terminal_block';

export type CoderBlockedRecoveryDisposition = {
  action: InteractiveBlockedRecoveryAction;
  summary: string;
  rationale: string;
  blocker: string;
  replacementPlan: string;
  laterScopeNumber: number;
  laterScopeBody: string;
};

export type InteractiveBlockedRecoveryTurnDisposition = {
  recordedAt: string;
  sessionHandle: string | null;
  action: InteractiveBlockedRecoveryAction;
  summary: string;
  rationale: string;
  blocker: string;
  replacementPlan: string;
  laterScopeNumber: number;
  laterScopeBody: string;
  resultingPhase: OrchestrationPhase;
};

export type InteractiveBlockedRecoveryTurn = {
  number: number;
  recordedAt: string;
  operatorGuidance: string;
  disposition: InteractiveBlockedRecoveryTurnDisposition | null;
};

export type InteractiveBlockedRecoveryDirective = {
  recordedAt: string;
  operatorGuidance: string;
  terminalOnly: boolean;
};

// Read-only advice produced by the consultant when it triages a block. A
// recoverable verdict with a concrete directive is auto-applied (the directive
// is injected as a recovery turn and the run continues), so this record is
// persisted only when the run yields for the operator: the verdict is surfaced
// as advice alongside the wait so the operator sees why it stopped. Populated
// only when the disable knob and per-scope budget allow the consultant to run;
// otherwise left unset (a plain operator yield).
export type InteractiveBlockedRecoveryConsultantAdvice = {
  recordedAt: string;
  recoverable: boolean;
  triageCategory: ConsultantTriageCategory;
  resolutionDirective: string;
  rationale: string;
};

export type InteractiveBlockedRecoveryState = {
  enteredAt: string;
  sourcePhase: Exclude<
    OrchestrationPhase,
    | 'interactive_blocked_recovery'
    | 'manual_gate'
    | 'done'
    | 'blocked'
  >;
  blockedReason: string;
  maxTurns: number;
  lastHandledTurn: number;
  turns: InteractiveBlockedRecoveryTurn[];
  pendingDirective?: InteractiveBlockedRecoveryDirective | null;
  // Present only when the consultant was allowed to triage the block (knob > 0,
  // budget available, eligible source phase) and the run then yielded for the
  // operator instead of auto-applying a recoverable directive. Surfaced in the
  // operator yield + RECOVERY artifact.
  consultantAdvice?: InteractiveBlockedRecoveryConsultantAdvice | null;
};

export type InteractiveBlockedRecoveryRecord = InteractiveBlockedRecoveryState & {
  resolvedAt: string;
  resolvedByAction: InteractiveBlockedRecoveryAction;
  resultPhase: OrchestrationPhase;
};

// The plan-stage phase whose block the pending operator guidance answers. The
// reviewer-plan message-resume path records `'reviewer_plan'` (delivered to the
// coder at `coder_plan_response`), while a coder-authored response block records
// its own origin phase so the resumed round returns to it. The initial
// `coder_plan` authoring block is deliberately excluded from this route.
export type PendingPlanReviewGuidanceSourcePhase =
  | 'reviewer_plan'
  | 'coder_plan_response'
  | 'coder_plan_optional_response';

export type PendingPlanReviewGuidance = {
  message: string;
  sourcePhase: PendingPlanReviewGuidanceSourcePhase;
  recordedAt: string;
} | null;

export type ProgressScope = {
  number: string;
  marker: ScopeMarker;
  result: 'accepted' | 'blocked';
  baseCommit: string | null;
  finalCommit: string | null;
  summary?: string | null;
  commitSubject: string | null;
  changedFiles: string[];
  reviewRounds: number;
  findings: number;
  residualReviewDebt?: ResidualReviewDebtItem[];
  archivedReviewPath: string | null;
  blocker: string | null;
  derivedFromParentScope: string | null;
  replacedByDerivedPlanPath: string | null;
};

export type OrchestrationState = {
  version: 1;
  planDoc: string;
  planDocBackupPath: string | null;
  cwd: string;
  runDir: string;
  topLevelMode: TopLevelMode;
  allowedDirtyPaths: string[];
  agentConfig: AgentConfig;
  // How many times the read-only consultant has run for the current scope.
  // Bounds autonomous block triage via `consultant_max_attempts` (default 1).
  // Persisted (default 0); reset at every scope boundary.
  consultantAttemptCount: number;
  // When false (`--no-squash`), the completed execute run is left unsquashed.
  // Persisted so `neal resume` and queue continuation honor the operator's
  // choice without re-supplying a flag; states persisted before this field
  // existed hydrate to true (the historical always-squash behavior).
  autoSquashOnCompletion: boolean;
  progressJsonPath: string;
  progressMarkdownPath: string;
  recoveryMarkdownPath: string;
  phase: OrchestrationPhase;
  createdAt: string;
  updatedAt: string;
  reviewMarkdownPath: string;
  archivedReviewPath: string | null;
  initialBaseCommit: string | null;
  baseCommit: string | null;
  finalCommit: string | null;
  plannerSessionHandle: string | null;
  plannerSessionProtocol: CoderSessionProtocol | null;
  coderSessionHandle: string | null;
  coderSessionProtocol: CoderSessionProtocol | null;
  reviewerSessionHandle: string | null;
  executionShape: ExecutionShape | null;
  // The execution shape the upstream author declared in the seed plan document at
  // run creation, captured write-once for every top-level mode. Plan refinement may
  // revise plan content but must not expand an author-declared `one_shot` plan into a
  // multi-scope shape; this field is the binding source of truth for that clamp and is
  // never mutated after initialization. Distinct from `executionShape`, which tracks the
  // currently adopted (possibly refined) shape.
  authoredExecutionShape: ExecutionShape | null;
  currentScopeNumber: number;
  coderRetryCount: number;
  lastScopeMarker: ScopeMarker | null;
  currentScopeProgressJustification: ExecuteScopeProgressJustification | null;
  currentScopeMeaningfulProgressVerdict: ReviewerMeaningfulProgressVerdict | null;
  manualGate: ManualGateState | null;
  finalCompletionSummary: FinalCompletionSummary | null;
  finalCompletionReviewVerdict: FinalCompletionReviewerVerdict | null;
  finalCompletionResolvedAction: FinalCompletionReviewerAction | null;
  finalCompletionContinueExecutionCount: number;
  finalCompletionContinueExecutionCapReached: boolean;
  derivedPlanPath: string | null;
  derivedFromScopeNumber: number | null;
  derivedPlanStatus: 'pending_review' | 'accepted' | 'rejected' | null;
  derivedScopeIndex: number | null;
  splitPlanStartedNotified: boolean;
  derivedPlanAcceptedNotified: boolean;
  splitPlanBlockedNotified: boolean;
  splitPlanCountForCurrentScope: number;
  derivedPlanDepth: number;
  maxDerivedPlanReviewRounds: number;
  rounds: ReviewRound[];
  // Bounded anti-thrash window for the generalized consultant. Written
  // only by `enterInteractiveBlockedRecovery` when the consultant ran for a
  // block; never written by the read-only consultant itself.
  recentBlocks: RecentBlockRecord[];
  findings: ReviewFinding[];
  createdCommits: string[];
  completedScopes: ProgressScope[];
  maxRounds: number;
  blockedFromPhase: OrchestrationPhase | null;
  interactiveBlockedRecovery: InteractiveBlockedRecoveryState | null;
  interactiveBlockedRecoveryHistory: InteractiveBlockedRecoveryRecord[];
  pendingPlanReviewGuidance: PendingPlanReviewGuidance;
  // Plan-review debt for the *current* negotiation: a canonical-keyed projection
  // of the current findings (see toPlanReviewDebt). Recomputed wherever findings
  // change; never an append-only accumulator. This is the field carried to the
  // queue item at a top-level plan run's completion.
  planReviewDebt: ResidualReviewDebtItem[];
  // Durable, write-once plan-review debt inherited from an accepted plan's
  // planning child (via the queue handoff). Seeded only at init; NEVER recomputed
  // by any plan-review phase, so a derived-plan review inside an execution child
  // cannot erase it. This is the field the execution reviewer actually needs.
  inheritedPlanReviewDebt: ResidualReviewDebtItem[];
  // Durable operator-facing reason for a plan-stage coder-authored *response*
  // block (`coder_plan_response` / `coder_plan_optional_response`). Set only by
  // that recoverable blocked landing and surfaced by `neal status`; cleared to
  // `null` on every return to `running`. Invariant: `null` whenever
  // `status !== 'blocked'`.
  blockerReason: string | null;
  status: 'running' | 'paused' | 'done' | 'blocked' | 'failed';
};

export type OrchestratorInit = {
  cwd: string;
  planDoc: string;
  planDocBackupPath?: string | null;
  stateDir: string;
  runDir: string;
  topLevelMode: TopLevelMode;
  allowedDirtyPaths: string[];
  agentConfig: AgentConfig;
  // Resolved squash-on-completion preference (`--no-squash` resolves false);
  // persisted onto the initial OrchestrationState. Optional on init (defaults
  // true) to match the historical always-squash behavior.
  autoSquashOnCompletion?: boolean;
  progressJsonPath: string;
  progressMarkdownPath: string;
  reviewMarkdownPath: string;
  recoveryMarkdownPath: string;
  maxRounds: number;
  // Optional plan-review debt to seed the durable `inheritedPlanReviewDebt`
  // state field from (the `neal run` queue handoff, execution stage only).
  // Defaults to an empty array when omitted.
  inheritedPlanReviewDebt?: ResidualReviewDebtItem[];
};
