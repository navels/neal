export type OrchestrationPhase =
  | 'codex_chunk'
  | 'claude_review'
  | 'codex_response'
  | 'final_squash'
  | 'done'
  | 'blocked';

export type ExecutionMode = 'one_shot' | 'chunked';

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

export type OrchestrationState = {
  version: 1;
  planDoc: string;
  cwd: string;
  runDir: string;
  executionMode: ExecutionMode;
  phase: OrchestrationPhase;
  createdAt: string;
  updatedAt: string;
  reviewMarkdownPath: string;
  archivedReviewPath: string | null;
  baseCommit: string | null;
  finalCommit: string | null;
  codexThreadId: string | null;
  rounds: ReviewRound[];
  findings: ReviewFinding[];
  createdCommits: string[];
  maxRounds: number;
  status: 'running' | 'done' | 'blocked' | 'failed';
};

export type OrchestratorInit = {
  cwd: string;
  planDoc: string;
  stateDir: string;
  runDir: string;
  reviewMarkdownPath: string;
  maxRounds: number;
  executionMode: ExecutionMode;
};
