import type { NealStatusSnapshot } from './status.js';
import type { SuggestedNealAction } from './context/shared.js';

export type RecentEvent = {
  ts: string | null;
  type: string;
  data: Record<string, unknown>;
};

export type RunNarrativeArtifactAvailability = {
  runStateJson: boolean;
  eventsNdjson: boolean;
  planProgressJson: boolean;
  reviewMarkdown: boolean;
  progressMarkdown: boolean;
  recoveryMarkdown: boolean;
  archivedReviewMarkdown: boolean;
  invalidDerivedPlanPayload: boolean;
};

export type RunNarrativeArtifactPaths = {
  runStateJson: string | null;
  eventsNdjson: string | null;
  planProgressJson: string | null;
  reviewMarkdown: string | null;
  progressMarkdown: string | null;
  recoveryMarkdown: string | null;
  archivedReviewMarkdown: string | null;
  invalidDerivedPlanPayload: string | null;
};

export type RunNarrativeBenchmarkTrace = {
  publicStatus: string | null;
  publicPhase: string | null;
  patch: {
    defaultSubmissionEligible: boolean;
    reason: string;
    source: NealStatusSnapshot['patch']['source'];
    baseCommit: string | null;
    headCommit: string | null;
    range: string | null;
    changedFileCount: number | null;
  };
  squash: {
    replacementCommit: string | null;
  };
  providerError: {
    provider: string | null;
    role: string | null;
    kind: string | null;
    message: string;
  } | null;
  build: {
    packageVersion: string | null;
    sourceGitSha: string | null;
    nodeVersion: string | null;
  };
  agent: {
    planner: {
      provider: string | null;
      model: string | null;
    };
    coder: {
      provider: string | null;
      model: string | null;
    };
    reviewer: {
      provider: string | null;
      model: string | null;
    };
  };
};

export type RunNarrativeSummary = {
  version: 1;
  generatedAt: string;
  sourceDigest?: string;
  headline: string;
  run: {
    cwd: string;
    statePath: string;
    runDir: string | null;
    runDirName: string | null;
    planPath: string | null;
    topLevelMode: 'plan' | 'execute' | null;
    phase: string | null;
    status: string | null;
    effectiveStatus: NealStatusSnapshot['effectiveStatus'] | null;
    waitingForOperatorGuidance: boolean;
    pendingOperatorGuidance: boolean;
    currentScopeNumber: number | null;
    derivedPlan: NealStatusSnapshot['derivedPlan'];
    manualGate: NealStatusSnapshot['manualGate'];
    health: NealStatusSnapshot['health'] | null;
  };
  latestActivity: {
    at: string | null;
    type: string | null;
    summary: string;
    source: string | null;
  };
  findings: NealStatusSnapshot['findings'];
  verification: {
    commands: string[];
    lastCommand: string | null;
    summary: string;
    source: string | null;
  };
  blocker: {
    active: boolean;
    summary: string | null;
    technicalDetails: string[];
    sources: string[];
  };
  benchmarkTrace: RunNarrativeBenchmarkTrace;
  recommendedAction: SuggestedNealAction | null;
  artifactAvailability: RunNarrativeArtifactAvailability;
  artifactPaths: RunNarrativeArtifactPaths;
  warnings: string[];
};
