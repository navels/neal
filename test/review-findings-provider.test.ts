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
  StructuredAdvisorAdapter,
  StructuredAdvisorRoundArgs,
  StructuredAdvisorRoundResult,
} from '../src/neal/providers/types.js';
import { createAgentReviewFindingsProviderAdapter } from '../src/neal/review-findings/provider.js';
import {
  buildReviewFindingsInlinedDiffSection,
  buildReviewFindingsReadOnlyInspectionSection,
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

// A native read-only reviewer (read tools, no shell, no commit-range diff tool —
// anthropic-claude/openai-codex) cannot run git commands or call a git_diff tool
// and the base adjudication prompt only previews the diff, so the provider
// adapter appends the inlined full selected-range diff and must not name a
// git_diff tool — and must not inline the removed Neal review context.
test('review-findings adjudication prompt reaching a native read-only structured advisor inlines the selected diff with no git_diff instruction', async () => {
  const cwd = await createReviewFindingsCwd();
  const captured = installCapturingStructuredAdvisor('anthropic-claude');
  const { context, draft } = createReviewFindingsFixtures();
  const provider = createAgentReviewFindingsProviderAdapter({
    cwd,
    agentConfig: agentConfig('anthropic-claude'),
  });
  const builtPrompt = buildReviewFindingsReviewPrompt(context, draft, 1);

  const review = await provider.reviewDraft({ context, round: 1, draft, prompt: builtPrompt });

  assert.equal(captured.length, 1);
  const round = captured[0]!;
  assert.equal(round.label, 'review-findings');
  const prompt = round.prompt;

  // The appended section is exactly the exported inlined-diff builder over the
  // same context, so the full selected diff is the source of truth.
  assert.equal(prompt, `${builtPrompt}\n\n${buildReviewFindingsInlinedDiffSection(context)}`);
  assert.match(prompt, /## Inlined Selected-Range Diff/);
  assert.ok(prompt.includes(DIFF_SENTINEL), 'native read-only review-findings prompt should inline the selected diff');
  assert.match(prompt, /no commit-range diff tool, so the full selected-range diff is inlined below/);

  // No git_diff-tool instruction and no removed Neal inline-review-context framing.
  assert.doesNotMatch(prompt, /git_diff/);
  assert.doesNotMatch(prompt, /## Read-Only Range Inspection/);
  assert.doesNotMatch(prompt, /## Inlined review context from Neal/);

  assert.equal(review.verdict, 'accepted');
});

// A read-only reviewer with its own commit-range diff tool (openai-compatible)
// cannot run git commands and the base adjudication prompt only previews the
// diff, so the provider adapter must append the read-only range-inspection
// section directing it to the git_diff tool with the exact resolved revisions —
// and must not inline Neal context.
test('review-findings adjudication prompt reaching a read-only structured advisor instructs git_diff range inspection with no inline sections', async () => {
  const cwd = await createReviewFindingsCwd();
  const captured = installCapturingStructuredAdvisor('openai-compatible');
  const { context, draft } = createReviewFindingsFixtures();
  const provider = createAgentReviewFindingsProviderAdapter({
    cwd,
    agentConfig: agentConfig('openai-compatible'),
  });
  const builtPrompt = buildReviewFindingsReviewPrompt(context, draft, 1);

  const review = await provider.reviewDraft({ context, round: 1, draft, prompt: builtPrompt });

  assert.equal(captured.length, 1);
  const round = captured[0]!;
  assert.equal(round.label, 'review-findings');
  const prompt = round.prompt;

  // The appended section is exactly the exported builder over the same
  // context, so the resolved revisions are named verbatim.
  assert.equal(prompt, `${builtPrompt}\n\n${buildReviewFindingsReadOnlyInspectionSection(context)}`);
  // Assert the section header, the git_diff tool token, the resolved
  // base/head revisions, and the stat:true option are named — not the verbatim
  // inspection-instruction sentences.
  assert.match(prompt, /## Read-Only Range Inspection/);
  assert.match(prompt, /git_diff/);
  assert.match(prompt, /base base123, head head456/);
  assert.match(prompt, /stat:true/);
  // The fixture diff fits inside the preview, so the section must not claim
  // the preview was truncated.
  assert.doesNotMatch(prompt, /diff preview above is truncated/);

  // No Neal-inlined context on the read-only path.
  assert.doesNotMatch(prompt, /## Inlined review context from Neal/);
  assert.doesNotMatch(prompt, /Full selected diff for range/);
  assert.doesNotMatch(prompt, /Draft findings artifact under adjudication/);

  assert.equal(review.verdict, 'accepted');
});

test('read-only range-inspection section claims preview truncation only when the diff exceeds the preview limit', () => {
  const { context } = createReviewFindingsFixtures();

  const small = buildReviewFindingsReadOnlyInspectionSection(context);
  assert.doesNotMatch(small, /diff preview above is truncated/);
  assert.match(small, /git_diff tool is the source of truth/);

  const large = buildReviewFindingsReadOnlyInspectionSection({
    ...context,
    diff: `diff --git a/big.ts b/big.ts\n${'+x\n'.repeat(8000)}`,
  });
  assert.match(large, /The diff preview above is truncated; the git_diff tool is the source of truth/);
});
