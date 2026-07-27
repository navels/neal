export type AdversarialReviewDoctrineContext = {
  reviewSubject: string;
  falsificationTarget?: string;
  creditPhrase?: string;
  claimSources?: string;
  judgmentTarget?: string;
  proofTarget?: string;
};

// 'tool-access' is the default doctrine for reviewers that can inspect AND
// execute against the repository directly (git commands, test runs, scratch
// directories). 'read-only' is for reviewers that can read and search the
// repository through read tools — including the read-only git_diff
// commit-range tool — but cannot run commands; it must not instruct command
// execution, test runs, shell git-command usage, or scratch-directory work.
// Every reviewer provider has repository read access; there is no reviewer
// doctrine for providers without read tools.
export type ReviewDoctrineAccessMode = 'tool-access' | 'read-only';

export type CodeReviewFalsificationContext = {
  rangeLabel?: string | null;
  gitInspectionExamples?: string;
  reviewTarget?: string;
  includeExecuteFailureClasses?: boolean;
  mode?: ReviewDoctrineAccessMode;
  // Only meaningful with mode === 'read-only'. When true, Neal has inlined the
  // commit-range diff into the reviewer prompt (the reviewer has read tools but
  // no commit-range diff tool), so the doctrine references that inlined diff as
  // the source of truth and must not name a `git_diff` tool or instruct shell.
  // When false (the default, e.g. openai-compatible), the doctrine keeps the
  // existing `git_diff`-tool phrasing.
  rangeDiffInlined?: boolean;
};

export type VerificationSkepticismContext = {
  reviewTarget?: string;
  coverageTarget?: string;
  coverageGapDescription?: string;
  insufficientCoverageTarget?: string;
  mode?: ReviewDoctrineAccessMode;
};

export type FindingQualityContext = {
  outputContract?: 'structured_findings' | 'completion_verdict';
};

export type RegressionPreservationContext = {
  reviewTarget?: string;
  mode?: ReviewDoctrineAccessMode;
};

export type PreexistingFailureContractContext = {
  reviewTarget?: string;
  mode?: ReviewDoctrineAccessMode;
};

export function getAdversarialReviewDoctrineLines(context: AdversarialReviewDoctrineContext) {
  const falsificationTarget = context.falsificationTarget ?? 'the implementation';
  const creditPhrase = context.creditPhrase ?? 'give it credit for working';
  const claimSources = context.claimSources ?? 'the coder narrative, progress justification, or prior acceptance history';
  const judgmentTarget = context.judgmentTarget ?? 'correctness';
  const proofTarget = context.proofTarget ?? 'the code is sound';

  return [
    `Treat ${context.reviewSubject} as hostile input. Try to falsify ${falsificationTarget} before you ${creditPhrase}.`,
    `Do not anchor on ${claimSources} when judging ${judgmentTarget}. Those are convergence signals, not proof that ${proofTarget}.`,
  ];
}

export function getCodeReviewFalsificationLines(context: CodeReviewFalsificationContext) {
  const mode = context.mode ?? 'tool-access';
  const reviewTarget = context.reviewTarget ?? 'changed behavior';
  const rangeDiffInlined = mode === 'read-only' && context.rangeDiffInlined === true;
  const lines: string[] = [];

  if (context.rangeLabel) {
    lines.push(
      mode === 'read-only'
        ? rangeDiffInlined
          ? `The commit-range diff for that ${context.rangeLabel} is inlined below and is the source of truth for exactly what the ${context.rangeLabel} changed (including deletions and renames). Use your read tools to verify the surrounding code; you have no commit-range diff tool, so rely on the inlined diff for what changed.`
          : `Review that ${context.rangeLabel} directly with your read-only repository tools: use the git_diff tool to see exactly what the ${context.rangeLabel} changed (including deletions and renames), and your read tools to verify the surrounding code. The ${context.rangeLabel} is the source of truth for this review.`
        : `Review that ${context.rangeLabel} directly with repository tools. The ${context.rangeLabel} is the source of truth for this review.`,
    );
  }

  if (mode === 'read-only') {
    lines.push(
      'A diff shows only changed hunks; declarations such as imports, struct fields, or helpers may exist in unchanged parts of the file. Absence from the diff is not evidence of absence from the repository — open the affected file with your read tools and verify before claiming a missing import or missing declaration.',
    );
  }

  if (context.gitInspectionExamples) {
    if (mode === 'tool-access') {
      lines.push(context.gitInspectionExamples);
    } else if (mode === 'read-only') {
      lines.push(
        rangeDiffInlined
          ? 'Inspect the change using the inlined commit-range diff below for what changed (including deletions and renames), then read the changed files in full with your read tools and search the tree for affected symbols and callers to verify claims.'
          : 'Inspect the change with your read-only tools: call git_diff with the base and head commits named in this prompt (stat:true first for the changed-file overview, then per-path diffs), read the changed files in full, and search the tree for affected symbols and callers to verify claims.',
      );
    }
  }

  lines.push(
    `Trace the changed runtime path far enough to prove the happy path is reachable and that runtime invariants, data-shape transitions, persistence, and error paths line up with the implementation claims.`,
    `Compare claimed behavior against the actual code and data transitions in the ${reviewTarget}; do not accept summaries when repository inspection gives a more direct answer.`,
    'For refactors and config/runtime plumbing changes, actively look for implementation-quality regressions, not just behavioral correctness. Examples include replacing a robust library with a weaker hand-rolled parser, introducing repeated disk reads or reparsing in hot paths, silently weakening error handling, or otherwise making the implementation materially less robust than the prior version.',
  );

  lines.push(
    'When the requirements enumerate multiple discrete items to change — a list of identifiers, fields, files, endpoints, or call sites — enumerate them yourself and confirm each maps to a concrete change before accepting; do not accept based only on the subset the implementation happened to touch.',
    'Treat an unrequested change to a public or exported symbol — a renamed or removed exported function, type, field, constant, or signature that the requirements did not call for — as scope drift and a blocking finding unless the requirements require it: an unrequested public-symbol change widens the blast radius and can break callers the diff does not show.',
  );

  if (context.includeExecuteFailureClasses) {
    lines.push(
      'Bias your search toward execute-mode failure classes in this repository: persistence or state-shape mismatches, resume or recovery transition regressions, split-plan or execution-shape contract violations, artifact or reporting mismatches, and verification that does not actually cover the changed behavior.',
    );
  }

  return lines;
}

export function getVerificationSkepticismLines(context: VerificationSkepticismContext = {}) {
  const mode = context.mode ?? 'tool-access';
  const reviewTarget = context.reviewTarget ?? 'changed behavior';
  const coverageTarget = context.coverageTarget;
  const coverageLine = coverageTarget
    ? [
        `Check whether test coverage for the ${coverageTarget} is missing or degraded.`,
        `If ${context.coverageGapDescription ?? `the review lacks, weakens, or fails to preserve meaningful test coverage for the ${coverageTarget}`}, treat that as a review finding.`,
        `Use blocking severity when the missing or degraded coverage leaves the ${context.insufficientCoverageTarget ?? coverageTarget} insufficiently protected.`,
      ].join(' ')
    : 'Check whether test coverage for the changed behavior degraded. If the change removes, weakens, or fails to preserve meaningful test coverage for the affected behavior, treat that as a review finding. Use blocking severity when the missing or degraded coverage leaves the changed behavior insufficiently protected.';

  return [
    'Do not infer that verification was skipped merely because this prompt does not embed full terminal output. Treat missing verification as a finding only when the repository state, plan requirements, or review history give concrete evidence that required verification was not run or was insufficient.',
    `Look for verification that cannot catch the failure mode, including tests that mock away the risky runtime path or only assert mocked adapters instead of the ${reviewTarget}.`,
    coverageLine,
  ];
}

export function getRegressionPreservationLines(context: RegressionPreservationContext = {}) {
  const mode = context.mode ?? 'tool-access';
  const reviewTarget = context.reviewTarget ?? 'changed behavior';

  return [
    `Identify the shared subsystems the ${reviewTarget} touches: state machines, event loops, parsers or byte framing, command dispatch, storage or shared-state abstractions, startup/load paths, and long-lived session or connection state.`,
    'Existing behavior that depends on those subsystems remains part of the contract unless the plan explicitly changes it. Do not accept solely because the newly requested behavior appears implemented; also confirm that adjacent behavior sharing those paths still holds.',
    mode === 'read-only'
      ? 'Before accepting, either cite existing tests that cover the plausible regression surfaces — reading them with your read tools — or reason through representative existing flows at the level of state transitions and data ownership.'
      : 'Before accepting, either cite existing tests that cover the plausible regression surfaces — running them when available — or reason through representative existing flows at the level of state transitions and data ownership.',
    `Expand this regression check only along paths the ${reviewTarget} actually touches or depends on; you do not need to re-audit unrelated parts of the project.`,
  ];
}

export function getPreexistingFailureContractLines(context: PreexistingFailureContractContext = {}) {
  const mode = context.mode ?? 'tool-access';
  const reviewTarget = context.reviewTarget ?? 'changed behavior';

  return [
    `When the plan requires existing behavior to keep working, this review is not limited to newly changed lines. Apply an acceptance-surface test to any pre-existing crash, failure, flaky behavior, or anomaly reported in the coder narrative, progress justification, or review history instead of discounting it because it predates the ${reviewTarget}.`,
    "A pre-existing failure is inside the required acceptance surface when the plan explicitly requires the affected existing behavior to keep working, when the plan's stated verification fails because of it, or when the behavior the plan delivers cannot be exercised end-to-end without the failing path. Otherwise it is outside the surface.",
    mode === 'read-only'
      ? "For a reported pre-existing failure inside the required surface, read the most relevant existing tests and affected code with your read tools and reason through the affected existing flows directly rather than relying on the coder's dismissal."
      : "For a reported pre-existing failure inside the required surface, exercise or reason through the affected existing flows directly — run the most relevant existing tests or reproduce the reported behavior when practical — rather than relying on the coder's dismissal.",
    'An in-surface pre-existing failure that was neither fixed nor surfaced as a blocking concern is a blocking finding, and a dismissal without a concrete out-of-surface reason is a finding.',
    'Conversely, treat a fix for a pre-existing issue that fails the acceptance-surface test as scope drift rather than extra credit: flag it so the change stays bounded to the plan.',
  ];
}

export function getFindingQualityLines(context: FindingQualityContext = {}) {
  if (context.outputContract === 'completion_verdict') {
    return [
      'Treat completion-blocking issues like review findings: each one needs concrete evidence, affected files or runtime behavior, and a required correction.',
      'Use `continue_execution` only for concrete missing work that is bounded enough for one follow-on scope; use `block_for_operator` for ambiguous or externally constrained gaps.',
      'Do not turn low-signal style preferences, trivial code-shape preferences, or optional refactors into missing work.',
      'If the plan is complete aside from low-signal trivia, return `accept_complete` rather than inventing a non-blocking completion concern.',
    ];
  }

  return [
    'Produce only structured review findings.',
    'Use blocking severity for correctness, regression, or missing-verification issues.',
    'Also use blocking severity for substantive robustness or performance regressions introduced by the implementation, especially in infrastructure, config, parser, caching, retry, or orchestration code.',
    'Use non_blocking severity for suggestions that do not block acceptance.',
    'Only emit non_blocking findings when they identify a concrete maintenance, observability, or testability issue that is genuinely worth a later follow-up turn.',
    'Do not emit non_blocking findings for formatting, whitespace, naming preferences, trivial code-shape preferences, or optional refactors.',
    'If the scope is acceptable aside from low-signal trivia, return no finding rather than a non_blocking note.',
    'Every finding must name the concrete issue, identify the affected files, explain the evidence or failure scenario that makes the issue credible, and state the required correction.',
  ];
}
