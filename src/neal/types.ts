export type OrchestrationPhase =
  | 'coder_plan'
  | 'reviewer_plan'
  | 'coder_plan_response'
  | 'coder_plan_optional_response'
  | 'awaiting_derived_plan_execution'
  | 'coder_scope'
  | 'reviewer_scope'
  | 'coder_response'
  | 'coder_optional_response'
  | 'reviewer_consult'
  | 'coder_consult_response'
  | 'interactive_blocked_recovery'
  | 'diagnostic_recovery_collect'
  | 'diagnostic_recovery_analyze'
  | 'diagnostic_recovery_author_plan'
  | 'diagnostic_recovery_review'
  | 'diagnostic_recovery_adopt'
  | 'final_squash'
  | 'final_completion_review'
  | 'done'
  | 'blocked';

export type ScopeMarker = 'AUTONOMY_SCOPE_DONE' | 'AUTONOMY_CHUNK_DONE' | 'AUTONOMY_DONE' | 'AUTONOMY_BLOCKED' | 'AUTONOMY_SPLIT_PLAN';
export type AgentProvider = 'openai-codex' | 'anthropic-claude';
export type ExecutionShape = 'one_shot' | 'multi_scope' | 'multi_scope_unknown';

export type AgentRoleConfig = {
  provider: AgentProvider;
  model: string | null;
};

export type AgentConfig = {
  coder: AgentRoleConfig;
  reviewer: AgentRoleConfig;
};

export type FindingSeverity = 'blocking' | 'non_blocking';
export type FindingStatus = 'open' | 'fixed' | 'rejected' | 'deferred';
export type ReviewFindingSource = 'reviewer' | 'plan_structure';

export type ReviewFinding = {
  id: string;
  canonicalId: string;
  round: number;
  source: ReviewFindingSource;
  severity: FindingSeverity;
  files: string[];
  claim: string;
  requiredAction: string;
  status: FindingStatus;
  roundSummary: string;
  coderDisposition: string | null;
  coderCommit: string | null;
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
  findings: string[];
};

export type ExecuteScopeProgressJustification = {
  milestoneTargeted: string;
  newEvidence: string;
  whyNotRedundant: string;
  nextStepUnlocked: string;
};

export type ReviewerMeaningfulProgressAction = 'accept' | 'block_for_operator' | 'replace_plan';

export type ReviewerMeaningfulProgressVerdict = {
  action: ReviewerMeaningfulProgressAction;
  rationale: string;
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

export type FinalCompletionPacket = {
  planDoc: string;
  executionShape: ExecutionShape | null;
  currentScopeLabel: string;
  finalCommit: string | null;
  completedScopeSummary: string;
  acceptedScopeCount: number;
  blockedScopeCount: number;
  verificationOnlyCompletion: boolean;
  terminalChangedFiles: string[];
  terminalChangedFilesSummary: string;
  planChangedFiles: string[];
  planChangedFilesSummary: string;
  verificationCommands: string[];
  verificationSummary: string;
  lastNonEmptyImplementationScope: FinalCompletionReferenceScope | null;
  continueExecutionCount: number;
  continueExecutionMax: number;
};

export type CoderConsultRequest = {
  summary: string;
  blocker: string;
  question: string;
  attempts: string[];
  relevantFiles: string[];
  verificationContext: string[];
};

export type ReviewerConsultResponse = {
  summary: string;
  diagnosis: string;
  confidence: 'low' | 'medium' | 'high';
  recoverable: boolean;
  recommendations: string[];
  relevantFiles: string[];
  rationale: string;
};

export type CoderConsultDisposition = {
  outcome: 'resumed' | 'blocked';
  summary: string;
  blocker: string;
  decision: 'followed' | 'partially_followed' | 'rejected';
  rationale: string;
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
};

export type InteractiveBlockedRecoveryTurnDisposition = {
  recordedAt: string;
  sessionHandle: string | null;
  action: InteractiveBlockedRecoveryAction;
  summary: string;
  rationale: string;
  blocker: string;
  replacementPlan: string;
  resultingPhase: OrchestrationPhase;
};

export type ConsultRound = {
  number: number;
  sourcePhase: 'coder_scope' | 'coder_response';
  coderSessionHandle: string | null;
  reviewerSessionHandle: string | null;
  request: CoderConsultRequest;
  response: ReviewerConsultResponse | null;
  disposition: CoderConsultDisposition | null;
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

export type InteractiveBlockedRecoveryState = {
  enteredAt: string;
  sourcePhase: Exclude<
    OrchestrationPhase,
    | 'interactive_blocked_recovery'
    | 'diagnostic_recovery_collect'
    | 'diagnostic_recovery_analyze'
    | 'diagnostic_recovery_author_plan'
    | 'diagnostic_recovery_review'
    | 'diagnostic_recovery_adopt'
    | 'done'
    | 'blocked'
  >;
  blockedReason: string;
  maxTurns: number;
  lastHandledTurn: number;
  turns: InteractiveBlockedRecoveryTurn[];
  pendingDirective?: InteractiveBlockedRecoveryDirective | null;
};

export type InteractiveBlockedRecoveryRecord = InteractiveBlockedRecoveryState & {
  resolvedAt: string;
  resolvedByAction: InteractiveBlockedRecoveryAction;
  resultPhase: OrchestrationPhase;
};

export type DiagnosticRecoveryBaselineSource = 'explicit' | 'active_parent_base_commit' | 'run_base_commit';

export type DiagnosticRecoveryState = {
  sequence: number;
  startedAt: string;
  sourcePhase: 'blocked' | 'interactive_blocked_recovery' | 'coder_scope';
  resumePhase: OrchestrationPhase | null;
  parentScopeLabel: string;
  blockedReason: string | null;
  question: string;
  target: string;
  requestedBaselineRef: string | null;
  effectiveBaselineRef: string | null;
  effectiveBaselineSource: DiagnosticRecoveryBaselineSource;
  analysisArtifactPath: string;
  recoveryPlanPath: string;
};

export type DiagnosticRecoveryDecision = 'adopt_recovery_plan' | 'keep_as_reference' | 'cancel';

export type DiagnosticRecoveryRecord = DiagnosticRecoveryState & {
  resolvedAt: string;
  decision: DiagnosticRecoveryDecision;
  rationale: string | null;
  resultPhase: OrchestrationPhase;
  adoptedPlanPath: string | null;
  reviewArtifactPath: string | null;
  reviewRoundCount: number;
  reviewFindingCount: number;
};

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
  topLevelMode: 'plan' | 'execute';
  ignoreLocalChanges: boolean;
  agentConfig: AgentConfig;
  progressJsonPath: string;
  progressMarkdownPath: string;
  consultMarkdownPath: string;
  phase: OrchestrationPhase;
  createdAt: string;
  updatedAt: string;
  reviewMarkdownPath: string;
  archivedReviewPath: string | null;
  initialBaseCommit: string | null;
  baseCommit: string | null;
  finalCommit: string | null;
  coderSessionHandle: string | null;
  reviewerSessionHandle: string | null;
  executionShape: ExecutionShape | null;
  currentScopeNumber: number;
  coderRetryCount: number;
  lastScopeMarker: ScopeMarker | null;
  currentScopeProgressJustification: ExecuteScopeProgressJustification | null;
  currentScopeMeaningfulProgressVerdict: ReviewerMeaningfulProgressVerdict | null;
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
  consultRounds: ConsultRound[];
  findings: ReviewFinding[];
  createdCommits: string[];
  completedScopes: ProgressScope[];
  maxRounds: number;
  maxConsultsPerScope: number;
  blockedFromPhase: OrchestrationPhase | null;
  interactiveBlockedRecovery: InteractiveBlockedRecoveryState | null;
  interactiveBlockedRecoveryHistory: InteractiveBlockedRecoveryRecord[];
  diagnosticRecovery: DiagnosticRecoveryState | null;
  diagnosticRecoveryHistory: DiagnosticRecoveryRecord[];
  status: 'running' | 'done' | 'blocked' | 'failed';
};

export type OrchestratorInit = {
  cwd: string;
  planDoc: string;
  planDocBackupPath?: string | null;
  stateDir: string;
  runDir: string;
  topLevelMode: 'plan' | 'execute';
  ignoreLocalChanges: boolean;
  agentConfig: AgentConfig;
  progressJsonPath: string;
  progressMarkdownPath: string;
  reviewMarkdownPath: string;
  consultMarkdownPath: string;
  maxRounds: number;
};
