import test from 'node:test';
import assert from 'node:assert/strict';
import { access, mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Writable } from 'node:stream';

import { DEFAULT_REVIEW_INSTRUCTION, parseReviewArgs } from '../src/neal/cli.js';
import {
  clearProviderDefinitionRegistrationsForTesting,
  registerProviderDefinitionForTesting,
} from '../src/neal/providers/registry.js';
import { runNealReviewCli } from '../src/neal/review-findings/run.js';
import { resolveReviewTarget } from '../src/neal/review-mode.js';
import { getActiveRunLockPath, getCurrentPlanAndExecuteQueuePointerPath, getCurrentRunPointerPath } from '../src/neal/storage-paths.js';
import { createFakeProviderDefinition } from './helpers/fake-provider.js';
import { runGit } from './helpers/git.js';
import type {
  ReviewFindingsDraft,
  ReviewFindingsProviderAdapter,
  ReviewFindingsProviderDraftArgs,
  ReviewFindingsProviderReviewArgs,
  ReviewFindingsReview,
} from '../src/neal/review-findings/types.js';

// This file exercises notify behavior through its own fixture scripts; the
// suite-wide NEAL_NOTIFY_BIN= kill switch (pnpm test script) must not shadow
// them. Fixture repo configs pin notify_bin, so this stays hermetic.
delete process.env.NEAL_NOTIFY_BIN;


process.env.HOME = join(tmpdir(), 'neal-test-home-review-mode');

class CaptureWritable extends Writable {
  readonly chunks: string[] = [];

  override _write(chunk: Buffer | string, _encoding: BufferEncoding, callback: (error?: Error | null) => void) {
    this.chunks.push(Buffer.isBuffer(chunk) ? chunk.toString('utf8') : chunk);
    callback();
  }

  text() {
    return this.chunks.join('');
  }
}

class QueueReviewProvider implements ReviewFindingsProviderAdapter {
  readonly draftCalls: ReviewFindingsProviderDraftArgs[] = [];
  readonly reviewCalls: ReviewFindingsProviderReviewArgs[] = [];

  constructor(
    private readonly drafts: ReviewFindingsDraft[],
    private readonly reviews: ReviewFindingsReview[],
  ) {}

  async draftFindings(args: ReviewFindingsProviderDraftArgs): Promise<ReviewFindingsDraft> {
    this.draftCalls.push(args);
    const draft = this.drafts[args.round - 1] ?? this.drafts[this.drafts.length - 1];
    assert.ok(draft, 'expected a queued review draft');
    return draft;
  }

  async reviewDraft(args: ReviewFindingsProviderReviewArgs): Promise<ReviewFindingsReview> {
    this.reviewCalls.push(args);
    const review = this.reviews[args.round - 1] ?? this.reviews[this.reviews.length - 1];
    assert.ok(review, 'expected a queued review verdict');
    return review;
  }
}

class CommitDuringDraftReviewProvider extends QueueReviewProvider {
  private committed = false;

  constructor(private readonly cwd: string) {
    super(
      [sampleDraft()],
      [
        acceptedFinal([
          '# Review Findings',
          '',
          'Accepted findings for the originally selected range.',
        ].join('\n')),
      ],
    );
  }

  override async draftFindings(args: ReviewFindingsProviderDraftArgs): Promise<ReviewFindingsDraft> {
    if (!this.committed) {
      this.committed = true;
      await writeFile(join(this.cwd, 'concurrent.txt'), 'concurrent change\n', 'utf8');
      await runGit(this.cwd, 'add', 'concurrent.txt');
      await runGit(this.cwd, 'commit', '-m', 'concurrent commit');
    }
    return super.draftFindings(args);
  }
}

class ScratchDuringDraftReviewProvider extends QueueReviewProvider {
  constructor(private readonly cwd: string) {
    super(
      [sampleDraft()],
      [
        acceptedFinal([
          '# Review Findings',
          '',
          'This should not be accepted after a worktree mutation.',
        ].join('\n')),
      ],
    );
  }

  override async draftFindings(args: ReviewFindingsProviderDraftArgs): Promise<ReviewFindingsDraft> {
    await writeFile(join(this.cwd, 'scratch.txt'), 'provider scratch output\n', 'utf8');
    return super.draftFindings(args);
  }
}

async function createRepo(prefix: string, options: { maxReviewRounds?: number; agentProvider?: string } = {}) {
  const root = await mkdtemp(join(tmpdir(), prefix));
  const cwd = join(root, 'repo');
  await runGit(root, 'init', 'repo');
  await runGit(cwd, 'config', 'user.name', 'Neal Test');
  await runGit(cwd, 'config', 'user.email', 'neal@example.com');
  await runGit(cwd, 'config', 'commit.gpgsign', 'false');
  const agentConfig = options.agentProvider
    ? `agent:\n  coder:\n    provider: ${options.agentProvider}\n  reviewer:\n    provider: ${options.agentProvider}\n`
    : '';
  await writeFile(
    join(cwd, 'neal.yml'),
    `neal:\n  notify_bin: /usr/bin/true\n  max_review_rounds: ${options.maxReviewRounds ?? 3}\n${agentConfig}`,
    'utf8',
  );
  await writeFile(join(cwd, 'README.md'), 'bootstrap\n', 'utf8');
  await runGit(cwd, 'add', 'README.md', 'neal.yml');
  await runGit(cwd, 'commit', '-m', 'base commit');

  async function commitFile(name: string, content: string, message: string) {
    await writeFile(join(cwd, name), content, 'utf8');
    await runGit(cwd, 'add', name);
    await runGit(cwd, 'commit', '-m', message);
    return runGit(cwd, 'rev-parse', 'HEAD');
  }

  return {
    cwd,
    baseCommit: await runGit(cwd, 'rev-parse', 'HEAD'),
    branch: await runGit(cwd, 'branch', '--show-current'),
    commitFile,
  };
}

function acceptedFinal(markdown: string): ReviewFindingsReview {
  return {
    verdict: 'accepted',
    findings: [],
    finalMarkdown: markdown,
    blockedReason: '',
    warnings: [],
  };
}

function sampleDraft(overrides: Partial<ReviewFindingsDraft> = {}): ReviewFindingsDraft {
  return {
    summary: 'Read-only review found one concrete issue.',
    findings: [
      {
        severity: 'blocking',
        files: ['feature.txt'],
        claim: 'The feature omits the required persisted value.',
        evidence: 'feature.txt adds the feature header but not the required persisted value.',
        requiredAction: 'Update the reviewed range before merging.',
      },
    ],
    warnings: [],
    ...overrides,
  };
}

async function assertMissing(path: string) {
  await assert.rejects(() => access(path), /ENOENT/);
}

test('resolveReviewTarget resolves last and since selectors to external metadata', async () => {
  const repo = await createRepo('neal-review-mode-valid-');
  const alpha = await repo.commitFile('alpha.txt', 'alpha\n', 'add alpha');
  const beta = await repo.commitFile('beta.txt', 'beta\n', 'add beta');
  const gamma = await repo.commitFile('gamma.txt', 'gamma\n', 'add gamma');

  const lastTarget = await resolveReviewTarget(
    repo.cwd,
    parseReviewArgs(['review', 'Review the last two commits', '--last', '2']),
  );
  assert.equal(lastTarget.baseRef, 'HEAD~2');
  assert.equal(lastTarget.headRef, 'HEAD');
  assert.equal(lastTarget.externalBaseCommit, alpha);
  assert.equal(lastTarget.externalHeadCommit, gamma);
  assert.deepEqual(lastTarget.externalCommits, [beta, gamma]);
  assert.deepEqual(lastTarget.externalCommitSubjects, [`${beta} add beta`, `${gamma} add gamma`]);
  assert.deepEqual(new Set(lastTarget.externalChangedFiles), new Set(['beta.txt', 'gamma.txt']));

  const sinceTarget = await resolveReviewTarget(
    repo.cwd,
    parseReviewArgs(['review', 'Review the branch', '--since', repo.baseCommit]),
  );
  assert.equal(sinceTarget.externalBaseCommit, repo.baseCommit);
  assert.equal(sinceTarget.externalHeadCommit, gamma);
  assert.deepEqual(sinceTarget.externalCommits, [alpha, beta, gamma]);
});

test('resolveReviewTarget tolerates dirty worktrees because review targets committed ranges', async () => {
  const repo = await createRepo('neal-review-mode-dirty-');
  await repo.commitFile('feature.txt', 'feature\n', 'add feature');
  await mkdir(join(repo.cwd, '.neal'), { recursive: true });
  await writeFile(join(repo.cwd, '.neal', 'NOTES.md'), 'wrapper-owned note\n', 'utf8');
  await writeFile(join(repo.cwd, 'visible-notes.txt'), 'dirty\n', 'utf8');

  const target = await resolveReviewTarget(
    repo.cwd,
    parseReviewArgs(['review', 'Review dirty case', '--last', '1']),
  );

  assert.equal(target.externalCommits.length, 1);
  assert.deepEqual(target.externalChangedFiles, ['feature.txt']);
});

test('resolveReviewTarget rejects empty ranges', async () => {
  const repo = await createRepo('neal-review-mode-empty-');
  await assert.rejects(
    () =>
      resolveReviewTarget(
        repo.cwd,
        parseReviewArgs(['review', 'Review empty range', '--since', 'HEAD']),
      ),
    /requires at least one commit/,
  );
});

test('resolveReviewTarget rejects non-ancestor base/head pairs', async () => {
  const repo = await createRepo('neal-review-mode-non-ancestor-');
  await runGit(repo.cwd, 'checkout', '-b', 'side');
  const sideCommit = await repo.commitFile('side.txt', 'side\n', 'add side');
  await runGit(repo.cwd, 'checkout', repo.branch);
  await repo.commitFile('main.txt', 'main\n', 'add main');

  await assert.rejects(
    () =>
      resolveReviewTarget(
        repo.cwd,
        parseReviewArgs(['review', 'Review divergent range', '--since', sideCommit]),
      ),
    /requires the selected base to be an ancestor of the selected head/,
  );
});

test('resolveReviewTarget reports unresolved refs clearly', async () => {
  const repo = await createRepo('neal-review-mode-unresolved-');
  await repo.commitFile('feature.txt', 'feature\n', 'add feature');

  await assert.rejects(
    () =>
      resolveReviewTarget(
        repo.cwd,
        parseReviewArgs(['review', 'Review missing ref', '--since', 'missing-ref']),
      ),
    /Unable to resolve review base ref "missing-ref" to a commit/,
  );
});

test('neal review writes accepted findings artifacts without writer-run mutations or lock acquisition', async () => {
  const repo = await createRepo('neal-review-readonly-');
  const featureCommit = await repo.commitFile('feature.txt', 'feature\n', 'add feature');
  const currentPointerPath = getCurrentRunPointerPath(repo.cwd);
  const currentQueuePath = getCurrentPlanAndExecuteQueuePointerPath(repo.cwd);
  const runStatePath = join(repo.cwd, '.neal', 'runs', 'writer-run', 'RUN_STATE.json');
  const lockPath = getActiveRunLockPath(repo.cwd);
  await mkdir(join(repo.cwd, '.neal', 'runs', 'writer-run'), { recursive: true });
  await writeFile(currentPointerPath, '{"sentinel":"current"}\n', 'utf8');
  await writeFile(currentQueuePath, '{"sentinel":"queue"}\n', 'utf8');
  await writeFile(runStatePath, '{"sentinel":"run-state"}\n', 'utf8');
  await writeFile(lockPath, '{"sentinel":"existing-lock"}\n', 'utf8');

  const before = {
    head: await runGit(repo.cwd, 'rev-parse', 'HEAD'),
    feature: await readFile(join(repo.cwd, 'feature.txt'), 'utf8'),
    current: await readFile(currentPointerPath, 'utf8'),
    queue: await readFile(currentQueuePath, 'utf8'),
    runState: await readFile(runStatePath, 'utf8'),
    lock: await readFile(lockPath, 'utf8'),
  };
  const provider = new QueueReviewProvider(
    [sampleDraft()],
    [
      acceptedFinal([
        '# Review Findings',
        '',
        '## Summary',
        '',
        'Accepted findings for the selected range.',
        '',
        '## Findings',
        '',
        '- The feature omits the required persisted value.',
      ].join('\n')),
    ],
  );
  const stdout = new CaptureWritable();
  const stderr = new CaptureWritable();

  const result = await runNealReviewCli({
    cwd: repo.cwd,
    parsed: parseReviewArgs(['review', 'Review this feature commit', '--since', repo.baseCommit]),
    stdout,
    stderr,
    provider,
    reviewId: 'review-readonly',
    now: new Date('2026-05-17T12:00:00.000Z'),
  });

  assert.equal(result.outcome, 'accepted');
  assert.equal(result.context.externalHeadCommit, featureCommit);
  assert.equal(await runGit(repo.cwd, 'rev-parse', 'HEAD'), before.head);
  assert.equal(await readFile(join(repo.cwd, 'feature.txt'), 'utf8'), before.feature);
  assert.equal(await readFile(currentPointerPath, 'utf8'), before.current);
  assert.equal(await readFile(currentQueuePath, 'utf8'), before.queue);
  assert.equal(await readFile(runStatePath, 'utf8'), before.runState);
  assert.equal(await readFile(lockPath, 'utf8'), before.lock);
  await assertMissing(join(repo.cwd, '.neal', 'runs', 'review-readonly', 'RUN_STATE.json'));

  const meta = JSON.parse(await readFile(result.paths.meta, 'utf8')) as { outcome: string; reviewId: string };
  assert.deepEqual(meta, {
    outcome: 'accepted',
    reviewId: 'review-readonly',
    version: 1,
    createdAt: '2026-05-17T12:00:00.000Z',
    cwd: repo.cwd,
    instruction: 'Review this feature commit',
    instructionSource: 'positional',
    selector: { kind: 'since', baseRef: repo.baseCommit },
    target: result.meta.target,
    reviewDir: result.paths.reviewDir,
    maxRounds: 3,
  });
  const finalMarkdown = await readFile(result.paths.final, 'utf8');
  assert.match(finalMarkdown, /# Review Findings/);
  assert.match(finalMarkdown, /The feature omits the required persisted value/);
  assert.match(stdout.text(), /# Review Findings/);
  assert.match(stdout.text(), /The feature omits the required persisted value/);
  assert.match(stdout.text(), /Review findings accepted: .*REVIEW_FINAL\.md/);
  assert.doesNotMatch(stdout.text(), /fix(es)? applied|fix commit|created commit/i);
  assert.match(stderr.text(), /review: analyzing 1 commit/);
});

test('neal review records resumable Agent SDK session handles and prints a resume hint', async () => {
  const repo = await createRepo('neal-review-resume-');
  await repo.commitFile('feature.txt', 'feature\n', 'add feature');

  // A provider that surfaces session ids the way the real SDK adapter does,
  // via the onSessionHandle callback.
  class SessionHandleReviewProvider extends QueueReviewProvider {
    override async draftFindings(args: ReviewFindingsProviderDraftArgs): Promise<ReviewFindingsDraft> {
      args.onSessionHandle?.('draft-sess-1');
      return super.draftFindings(args);
    }

    override async reviewDraft(args: ReviewFindingsProviderReviewArgs): Promise<ReviewFindingsReview> {
      args.onSessionHandle?.('reviewer-sess-1');
      return super.reviewDraft(args);
    }
  }

  const provider = new SessionHandleReviewProvider(
    [sampleDraft()],
    [acceptedFinal('# Review Findings\n\nAccepted.')],
  );
  const stdout = new CaptureWritable();
  const stderr = new CaptureWritable();

  const result = await runNealReviewCli({
    cwd: repo.cwd,
    parsed: parseReviewArgs(['review', 'Review this feature commit', '--since', repo.baseCommit]),
    stdout,
    stderr,
    provider,
    reviewId: 'review-resume',
  });

  assert.equal(result.outcome, 'accepted');

  // Handles are threaded into the round record (and thus the rounds artifact).
  const acceptedRound = result.rounds[result.rounds.length - 1];
  assert.equal(acceptedRound?.draftSessionHandle, 'draft-sess-1');
  assert.equal(acceptedRound?.reviewSessionHandle, 'reviewer-sess-1');
  const roundsArtifact = JSON.parse(await readFile(result.paths.rounds, 'utf8')) as {
    rounds: Array<{ draftSessionHandle?: string; reviewSessionHandle?: string }>;
  };
  assert.equal(roundsArtifact.rounds[0]?.reviewSessionHandle, 'reviewer-sess-1');

  // REVIEW_FINAL.md gains a Resume Sessions section with both handles.
  const finalMarkdown = await readFile(result.paths.final, 'utf8');
  assert.match(finalMarkdown, /## Resume Sessions/);
  assert.match(finalMarkdown, /Reviewer: `claude --resume reviewer-sess-1`/);
  assert.match(finalMarkdown, /Draft \(coder\): `claude --resume draft-sess-1`/);

  // stdout prints a compact, copy-pasteable hint preferring the reviewer.
  assert.match(stdout.text(), /Resume the reviewer session: \(cd .* && claude --resume reviewer-sess-1\)/);
});

test('neal review keeps its frozen target if HEAD advances during the read-only loop', async () => {
  const repo = await createRepo('neal-review-concurrent-head-');
  const featureCommit = await repo.commitFile('feature.txt', 'feature\n', 'add feature');
  const stdout = new CaptureWritable();
  const stderr = new CaptureWritable();
  const provider = new CommitDuringDraftReviewProvider(repo.cwd);

  const result = await runNealReviewCli({
    cwd: repo.cwd,
    parsed: parseReviewArgs(['review', 'Review this feature commit', '--since', repo.baseCommit]),
    stdout,
    stderr,
    provider,
    reviewId: 'review-concurrent-head',
  });

  const finalHead = await runGit(repo.cwd, 'rev-parse', 'HEAD');
  assert.equal(result.outcome, 'accepted');
  assert.equal(result.context.externalHeadCommit, featureCommit);
  assert.notEqual(finalHead, featureCommit);
  assert.match(await readFile(result.paths.context, 'utf8'), new RegExp(featureCommit));
  assert.match(stdout.text(), /Accepted findings for the originally selected range/);
  assert.match(stdout.text(), /Review findings accepted:/);
});

test('neal review rejects provider worktree mutations outside review artifacts', async () => {
  const repo = await createRepo('neal-review-worktree-mutation-');
  const featureCommit = await repo.commitFile('feature.txt', 'feature\n', 'add feature');
  const stdout = new CaptureWritable();
  const stderr = new CaptureWritable();
  const provider = new ScratchDuringDraftReviewProvider(repo.cwd);

  await assert.rejects(
    () =>
      runNealReviewCli({
        cwd: repo.cwd,
        parsed: parseReviewArgs(['review', 'Review this feature commit', '--since', repo.baseCommit]),
        stdout,
        stderr,
        provider,
        reviewId: 'review-worktree-mutation',
      }),
    /neal review is read-only but the worktree changed outside its review artifacts:[\s\S]*scratch\.txt/,
  );

  assert.equal(await runGit(repo.cwd, 'rev-parse', 'HEAD'), featureCommit);
  assert.equal(await readFile(join(repo.cwd, 'scratch.txt'), 'utf8'), 'provider scratch output\n');
  assert.equal(stdout.text(), '');
  const context = JSON.parse(
    await readFile(join(repo.cwd, '.neal', 'reviews', 'review-worktree-mutation', 'REVIEW_CONTEXT.json'), 'utf8'),
  ) as { externalHeadCommit: string };
  assert.equal(context.externalHeadCommit, featureCommit);
  await assertMissing(join(repo.cwd, '.neal', 'reviews', 'review-worktree-mutation', 'REVIEW_FINAL.md'));
});

test('neal review revises findings until reviewer acceptance and stores round history', async () => {
  const repo = await createRepo('neal-review-revise-');
  await repo.commitFile('feature.txt', 'feature\n', 'add feature');
  const provider = new QueueReviewProvider(
    [
      sampleDraft({ summary: 'First draft is too thin.', findings: [] }),
      sampleDraft({ summary: 'Second draft addresses the review finding.' }),
    ],
    [
      {
        verdict: 'revise',
        findings: ['Draft needs at least one concrete finding with evidence.'],
        warnings: [],
      },
      acceptedFinal('# Review Findings\n\nAccepted second draft.\n'),
    ],
  );
  const stdout = new CaptureWritable();
  const stderr = new CaptureWritable();
  const activities: string[] = [];

  const result = await runNealReviewCli({
    cwd: repo.cwd,
    parsed: parseReviewArgs(['review', '--last', '1']),
    stdout,
    stderr,
    provider,
    reviewId: 'review-revise',
    onActivity(update) {
      activities.push(update.activity);
    },
  });

  assert.equal(result.rounds.length, 2);
  assert.equal(provider.draftCalls.length, 2);
  assert.match(provider.draftCalls[1].prompt, /## Required Revision Findings/);
  assert.match(provider.draftCalls[1].prompt, /Draft needs at least one concrete finding with evidence/);
  const reviewArtifact = JSON.parse(await readFile(result.paths.review, 'utf8')) as { outcome: string; rounds: unknown[] };
  assert.equal(reviewArtifact.outcome, 'accepted');
  assert.equal(reviewArtifact.rounds.length, 2);
  const draftMarkdown = await readFile(result.paths.draft, 'utf8');
  assert.match(draftMarkdown, /## Round 1/);
  assert.match(draftMarkdown, /## Round 2/);
  assert.match(stdout.text(), /Review findings accepted:/);
  assert.deepEqual(activities, [
    'resolving review target',
    'building review context',
    'coder drafting review findings round 1/3',
    'reviewer checking review findings round 1/3',
    'coder drafting review findings round 2/3',
    'reviewer checking review findings round 2/3',
    'review findings accepted',
  ]);
});

test('neal review records cap outcome without writing an accepted final artifact', async () => {
  const repo = await createRepo('neal-review-cap-', { maxReviewRounds: 1 });
  await repo.commitFile('feature.txt', 'feature\n', 'add feature');
  const provider = new QueueReviewProvider(
    [sampleDraft({ summary: 'Needs another pass.' })],
    [
      {
        verdict: 'revise',
        findings: ['Draft still lacks integration analysis.'],
        warnings: [],
      },
    ],
  );
  const stdout = new CaptureWritable();
  const stderr = new CaptureWritable();

  await assert.rejects(
    () =>
      runNealReviewCli({
        cwd: repo.cwd,
        parsed: parseReviewArgs(['review', '--last', '1']),
        stdout,
        stderr,
        provider,
        reviewId: 'review-cap',
      }),
    /neal review reached the review round cap without accepted findings/,
  );

  const reviewDir = join(repo.cwd, '.neal', 'reviews', 'review-cap');
  const meta = JSON.parse(await readFile(join(reviewDir, 'meta.json'), 'utf8')) as { outcome: string };
  const review = JSON.parse(await readFile(join(reviewDir, 'REVIEW_REVIEW.json'), 'utf8')) as { outcome: string; rounds: unknown[] };
  assert.equal(meta.outcome, 'cap_reached');
  assert.equal(review.outcome, 'cap_reached');
  assert.equal(review.rounds.length, 1);
  await assertMissing(join(reviewDir, 'REVIEW_FINAL.md'));
  assert.equal(stdout.text(), '');
});

test('neal review defaults through configured coder and reviewer agents', async () => {
  const providerId = 'fake-review-agent';
  registerProviderDefinitionForTesting(
    createFakeProviderDefinition({
      id: providerId,
      coderStructuredResponses: [sampleDraft({ summary: 'Coder drafted model-backed findings.' })],
      structuredAdvisorResponses: [
        acceptedFinal('# Review Findings\n\nReviewer accepted the model-backed findings.\n'),
      ],
    }),
  );

  try {
    const repo = await createRepo('neal-review-agent-default-', { agentProvider: providerId });
    await repo.commitFile('feature.txt', 'feature\n', 'add feature');
    const stdout = new CaptureWritable();
    const stderr = new CaptureWritable();

    const result = await runNealReviewCli({
      cwd: repo.cwd,
      parsed: parseReviewArgs(['review', '--last', '1']),
      stdout,
      stderr,
      reviewId: 'review-agent-default',
    });

    assert.equal(result.draft.summary, 'Coder drafted model-backed findings.');
    assert.equal(result.review.finalMarkdown, '# Review Findings\n\nReviewer accepted the model-backed findings.');
    assert.match(stdout.text(), /Review findings accepted:/);
  } finally {
    clearProviderDefinitionRegistrationsForTesting();
  }
});

test('default review instruction is read-only and repair-free', () => {
  assert.match(DEFAULT_REVIEW_INSTRUCTION, /read-only review posture/);
  assert.match(DEFAULT_REVIEW_INSTRUCTION, /without applying fixes or rewriting history/);
});
