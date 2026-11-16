import test, { afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

import { clearConfigCache } from '../src/neal/config.js';
import {
  clearProviderCapabilitiesOverridesForTesting,
  clearProviderDefinitionRegistrationsForTesting,
  registerProviderDefinitionForTesting,
  setProviderCapabilitiesOverrideForTesting,
} from '../src/neal/providers/registry.js';
import type {
  CoderStructuredPromptArgs,
  StructuredAdvisorAdapter,
  StructuredAdvisorRoundArgs,
  StructuredAdvisorRoundResult,
} from '../src/neal/providers/types.js';
import { createAgentReviewFindingsProviderAdapter } from '../src/neal/review-findings/provider.js';
import {
  buildReviewFindingsReviewPrompt,
} from '../src/neal/review-findings/prompts.js';
import type { ReviewFindingsContext, ReviewFindingsDraft } from '../src/neal/review-findings/types.js';
import {
  createFakeProviderDefinition,
  fakeProviderDefaultCapabilities,
} from './helpers/fake-provider.js';
import type { AgentConfig } from '../src/neal/types.js';

process.env.HOME = join(tmpdir(), 'neal-test-home-review-findings-provider');

const execFileAsync = promisify(execFile);

const DIFF_SENTINEL = 'const inlineReviewSentinel = "captured-by-review-findings-test";';
const DRAFT_CLAIM_SENTINEL = 'Draft claim sentinel: the helper drops its error path.';

afterEach(() => {
  clearProviderCapabilitiesOverridesForTesting();
  clearProviderDefinitionRegistrationsForTesting();
});

async function runGit(cwd: string, args: string[]) {
  const { stdout } = await execFileAsync('git', args, { cwd });
  return stdout.trim();
}

function agentConfig(reviewerProvider: string): AgentConfig {
  return {
    planner: { provider: 'openai-codex', model: null },
    coder: { provider: 'openai-codex', model: null },
    reviewer: { provider: reviewerProvider, model: null },
  };
}

async function createReviewFindingsCwd() {
  const root = await mkdtemp(join(tmpdir(), 'neal-review-findings-provider-'));
  const cwd = join(root, 'repo');
  await mkdir(cwd, { recursive: true });
  await writeFile(join(cwd, 'neal.yml'), 'neal:\n  notify_bin: /usr/bin/true\n', 'utf8');
  clearConfigCache(cwd);

  await runGit(cwd, ['init']);
  await runGit(cwd, ['config', 'user.email', 'neal-test@example.invalid']);
  await runGit(cwd, ['config', 'user.name', 'Neal Test']);
  await runGit(cwd, ['config', 'commit.gpgsign', 'false']);
  await writeFile(join(cwd, 'feature.ts'), 'export const base = 1;\n', 'utf8');
  await runGit(cwd, ['add', '-A']);
  await runGit(cwd, ['commit', '--no-verify', '-m', 'base commit']);

  return cwd;
}

function installCapturingStructuredAdvisor(provider: string) {
  const captured: StructuredAdvisorRoundArgs[] = [];
  const adapter: StructuredAdvisorAdapter = {
    async runStructuredRound<TStructured>(
      args: StructuredAdvisorRoundArgs<TStructured>,
    ): Promise<StructuredAdvisorRoundResult<TStructured>> {
      captured.push(args as StructuredAdvisorRoundArgs);
      return {
        sessionHandle: null,
        structured: {
          verdict: 'accepted',
          findings: [],
          finalMarkdown: 'Accepted findings artifact for the capture test.',
          blockedReason: '',
          warnings: [],
        } as TStructured,
      };
    },
  };
  setProviderCapabilitiesOverrideForTesting(provider, {
    createStructuredAdvisorAdapter: () => adapter,
  });
  return captured;
}

function createReviewFindingsFixtures() {
  const diff = `diff --git a/feature.ts b/feature.ts\n+export ${DIFF_SENTINEL}\n`;
  const context: ReviewFindingsContext = {
    version: 1,
    instruction: 'Review the selected committed range for regressions.',
    instructionSource: 'default',
    selector: { kind: 'last', count: 1 },
    baseRef: 'HEAD~1',
    headRef: 'HEAD',
    externalBaseCommit: 'base123',
    externalHeadCommit: 'head456',
    externalCommits: ['head456'],
    externalCommitSubjects: ['head456 scope commit'],
    externalChangedFiles: ['feature.ts'],
    diffStat: ' feature.ts | 1 +',
    diff,
  };
  const draft: ReviewFindingsDraft = {
    summary: 'Draft summary for the capture test.',
    findings: [
      {
        severity: 'non_blocking',
        files: ['feature.ts'],
        claim: DRAFT_CLAIM_SENTINEL,
        evidence: 'The helper swallows its catch block.',
        requiredAction: 'Re-raise or report the swallowed error.',
      },
    ],
    warnings: [],
  };
  return { context, draft };
}

// `neal review` is read-only and never resumes a draft session, so the draft
// turn must ask the coder adapter not to persist resumable session state into
// the repository. Without the flag the openai-compatible coder writes a
// `.neal/provider-sessions/` mirror and the review's own unchanged-worktree
// assertion fails.
test('review-findings draft runs the coder with an ephemeral, never-resumed session', async () => {
  const cwd = await createReviewFindingsCwd();
  const { context, draft } = createReviewFindingsFixtures();
  const captured: CoderStructuredPromptArgs[] = [];
  registerProviderDefinitionForTesting(
    createFakeProviderDefinition({
      id: 'fake-draft-coder',
      coderStructuredResponses: [draft],
      onCoderStructuredRun: (args) => {
        captured.push(args);
      },
    }),
  );
  const provider = createAgentReviewFindingsProviderAdapter({
    cwd,
    agentConfig: {
      planner: { provider: 'fake-draft-coder', model: null },
      coder: { provider: 'fake-draft-coder', model: null },
      reviewer: { provider: 'fake-draft-coder', model: null },
    },
  });

  const result = await provider.draftFindings({
    context,
    round: 1,
    previousDraft: null,
    reviewFindings: [],
    prompt: 'Draft findings for the selected range.',
  });

  assert.deepEqual(result, draft);
  assert.equal(captured.length, 1);
  assert.equal(captured[0]!.ephemeralSession, true);
  assert.ok(!captured[0]!.resumeHandle, 'a draft round always starts a fresh session');
});

// Negative capability case for the module-private assertReviewAgentCapabilities
// gate inside createAgentReviewFindingsProviderAdapter. This is a SEPARATE call
// path from assertAgentConfigSupportsWriterRun: the registry/harness tests do
// not cover it, and without this case the gate could be "satisfied" by deleting
// the old inline-context requirement without adding requireReadToolAccess.
test('review-findings capability gate rejects a structured-output-capable reviewer without read tool access', async () => {
  registerProviderDefinitionForTesting(
    createFakeProviderDefinition({
      id: 'fake-read-less-reviewer',
      capabilities: {
        coder: { ...fakeProviderDefaultCapabilities.coder, supported: false },
        'structured-advisor': {
          ...fakeProviderDefaultCapabilities['structured-advisor'],
          toolAccess: { read: false, write: false, shell: false },
          supportsStructuredOutput: true,
        },
      },
    }),
  );
  const cwd = await createReviewFindingsCwd();

  assert.throws(
    () =>
      createAgentReviewFindingsProviderAdapter({
        cwd,
        agentConfig: agentConfig('fake-read-less-reviewer'),
      }),
    /reviewer role: .* is missing read tool access/,
  );

  // The coder gate keeps strict read tool access too.
  assert.throws(
    () =>
      createAgentReviewFindingsProviderAdapter({
        cwd,
        agentConfig: {
          planner: { provider: 'openai-codex', model: null },
          coder: { provider: 'fake-read-less-reviewer', model: null },
          reviewer: { provider: 'anthropic-claude', model: null },
        },
      }),
    /capability/i,
  );
});

for (const reviewerProvider of ['anthropic-claude', 'openai-codex', 'openai-compatible']) {
  test(`review-findings delivers the same file-only prompt to ${reviewerProvider}`, async () => {
    const cwd = await createReviewFindingsCwd();
    const captured = installCapturingStructuredAdvisor(reviewerProvider);
    const { context, draft } = createReviewFindingsFixtures();
    const provider = createAgentReviewFindingsProviderAdapter({
      cwd,
      agentConfig: agentConfig(reviewerProvider),
    });
    const indexPath = '.neal/reviews/capture/range-diff/index.md';
    const builtPrompt = buildReviewFindingsReviewPrompt(context, draft, indexPath, 1);

    const review = await provider.reviewDraft({ context, round: 1, draft, prompt: builtPrompt });

    assert.equal(captured.length, 1);
    const round = captured[0]!;
    assert.equal(round.label, 'review-findings');
    assert.equal(round.prompt, builtPrompt);
    assert.ok(round.prompt.includes(indexPath));
    assert.ok(round.prompt.includes(DRAFT_CLAIM_SENTINEL));
    assert.ok(!round.prompt.includes(DIFF_SENTINEL));
    assert.doesNotMatch(round.prompt, /Diff preview:|diff --git|git_diff|git diff/);
    assert.doesNotMatch(round.prompt, /## Inlined Selected-Range Diff|## Read-Only Range Inspection/);
    assert.equal(review.verdict, 'accepted');
  });
}
