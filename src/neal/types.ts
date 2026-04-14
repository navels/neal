export type OrchestrationPhase =
  | 'codex_plan'
  | 'claude_plan_review'
  | 'codex_plan_response'
  | 'codex_scope'
  | 'claude_review'
  | 'codex_response'
  | 'claude_consult'
  | 'codex_consult_response'
  | 'final_squash'
  | 'done'
  | 'blocked';

export type CodexMarker = 'AUTONOMY_SCOPE_DONE' | 'AUTONOMY_CHUNK_DONE' | 'AUTONOMY_DONE' | 'AUTONOMY_BLOCKED';
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
  codexDisposition: string | null;
  codexCommit: string | null;
};

export type ReviewRound = {
  round: number;
  claudeSessionId: string | null;
  commitRange: {
    base: string;
    head: string;
  };
  openBlockingCanonicalCount: number;
  findings: string[];
};

export type CodexConsultRequest = {
  summary: string;
  blocker: string;
  question: string;
  attempts: string[];
  relevantFiles: string[];
  verificationContext: string[];
};

export type ClaudeConsultResponse = {
  summary: string;
  diagnosis: string;
  confidence: 'low' | 'medium' | 'high';
  recoverable: boolean;
  recommendations: string[];
  relevantFiles: string[];
  rationale: string;
};

export type CodexConsultDisposition = {
  outcome: 'resumed' | 'blocked';
  summary: string;
  blocker: string;
  decision: 'followed' | 'partially_followed' | 'rejected';
  rationale: string;
};

export type ConsultRound = {
  number: number;
  sourcePhase: 'codex_scope' | 'codex_response';
  codexThreadId: string | null;
  claudeSessionId: string | null;
  request: CodexConsultRequest;
  response: ClaudeConsultResponse | null;
  disposition: CodexConsultDisposition | null;
};

export type ProgressScope = {
  number: number;
  marker: CodexMarker;
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
  codexThreadId: string | null;
  claudeSessionId: string | null;
  currentScopeNumber: number;
  codexRetryCount: number;
  lastCodexMarker: CodexMarker | null;
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
