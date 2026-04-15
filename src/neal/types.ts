export type OrchestrationPhase =
  | 'coder_plan'
  | 'reviewer_plan'
  | 'coder_plan_response'
  | 'coder_plan_optional_response'
  | 'coder_scope'
  | 'reviewer_scope'
  | 'coder_response'
  | 'coder_optional_response'
  | 'reviewer_consult'
  | 'coder_consult_response'
  | 'final_squash'
  | 'done'
  | 'blocked';

export type ScopeMarker = 'AUTONOMY_SCOPE_DONE' | 'AUTONOMY_CHUNK_DONE' | 'AUTONOMY_DONE' | 'AUTONOMY_BLOCKED';
export type AgentProvider = 'openai-codex' | 'anthropic-claude';

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

export type ReviewFinding = {
  id: string;
  canonicalId: string;
  round: number;
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
  commitRange: {
    base: string;
    head: string;
  };
  openBlockingCanonicalCount: number;
  findings: string[];
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

export type ConsultRound = {
  number: number;
  sourcePhase: 'coder_scope' | 'coder_response';
  coderSessionHandle: string | null;
  reviewerSessionHandle: string | null;
  request: CoderConsultRequest;
  response: ReviewerConsultResponse | null;
  disposition: CoderConsultDisposition | null;
};

export type ProgressScope = {
  number: number;
  marker: ScopeMarker;
  result: 'accepted' | 'blocked';
  baseCommit: string | null;
  finalCommit: string | null;
  commitSubject: string | null;
  reviewRounds: number;
  findings: number;
  archivedReviewPath: string | null;
  blocker: string | null;
};

export type OrchestrationState = {
  version: 1;
  planDoc: string;
  cwd: string;
  runDir: string;
  topLevelMode: 'plan' | 'execute';
  agentConfig: AgentConfig;
  progressJsonPath: string;
  progressMarkdownPath: string;
  consultMarkdownPath: string;
  phase: OrchestrationPhase;
  createdAt: string;
  updatedAt: string;
  reviewMarkdownPath: string;
  archivedReviewPath: string | null;
  baseCommit: string | null;
  finalCommit: string | null;
  coderSessionHandle: string | null;
  reviewerSessionHandle: string | null;
  currentScopeNumber: number;
  coderRetryCount: number;
  lastScopeMarker: ScopeMarker | null;
  rounds: ReviewRound[];
  consultRounds: ConsultRound[];
  findings: ReviewFinding[];
  createdCommits: string[];
  completedScopes: ProgressScope[];
  maxRounds: number;
  maxConsultsPerScope: number;
  blockedFromPhase: OrchestrationPhase | null;
  status: 'running' | 'done' | 'blocked' | 'failed';
};

export type OrchestratorInit = {
  cwd: string;
  planDoc: string;
  stateDir: string;
  runDir: string;
  topLevelMode: 'plan' | 'execute';
  agentConfig: AgentConfig;
  progressJsonPath: string;
  progressMarkdownPath: string;
  reviewMarkdownPath: string;
  consultMarkdownPath: string;
  maxRounds: number;
};
