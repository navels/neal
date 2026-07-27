import test, { afterEach } from 'node:test';
import assert from 'node:assert/strict';

import {
  INLINE_SECTION_MAX_CHARS,
  NO_READ_PROMPT_FORBIDDEN_MARKERS,
  assertNoReadPromptInstructionText,
  createInlineSection,
  getReviewerDoctrineAccessMode,
  readOnlyReviewerNeedsInlinedDiff,
  renderInlineReviewerContext,
  renderInlinedRangeDiffSection,
  truncateInlineSectionBody,
} from '../src/neal/context/inline-review-context.js';
import {
  clearProviderDefinitionRegistrationsForTesting,
  registerProviderDefinitionForTesting,
} from '../src/neal/providers/registry.js';
import { createFakeProviderDefinition, fakeProviderDefaultCapabilities } from './helpers/fake-provider.js';

afterEach(() => {
  clearProviderDefinitionRegistrationsForTesting();
});

test('getReviewerDoctrineAccessMode maps every registered provider capability shape to a doctrine mode', () => {
  // Native reviewers are read-only (read access, no shell), so they select the
  // read-only doctrine: they inspect the repository with read tools but are
  // never instructed to run commands.
  assert.equal(getReviewerDoctrineAccessMode({ provider: 'anthropic-claude', model: null }), 'read-only');
  assert.equal(getReviewerDoctrineAccessMode({ provider: 'openai-codex', model: null }), 'read-only');
  // openai-compatible advisor rounds run the read-only tool loop (read access,
  // no shell), selecting the read-only doctrine.
  assert.equal(getReviewerDoctrineAccessMode({ provider: 'openai-compatible', model: null }), 'read-only');
  // Unregistered ids default to 'tool-access'.
  assert.equal(getReviewerDoctrineAccessMode({ provider: 'unregistered-provider', model: null }), 'tool-access');
});

test('getReviewerDoctrineAccessMode selects read-only for read access without shell access', () => {
  registerProviderDefinitionForTesting(
    createFakeProviderDefinition({
      id: 'fake-read-only-reviewer',
      capabilities: {
        coder: fakeProviderDefaultCapabilities.coder,
        'structured-advisor': {
          ...fakeProviderDefaultCapabilities['structured-advisor'],
          toolAccess: { read: true, write: false, shell: false },
        },
      },
    }),
  );

  assert.equal(getReviewerDoctrineAccessMode({ provider: 'fake-read-only-reviewer', model: null }), 'read-only');
});

test('readOnlyReviewerNeedsInlinedDiff is true only for read-only reviewers lacking a commit-range diff tool', () => {
  // Native read-only reviewers (read tools, no shell, no commit-range diff tool)
  // need Neal to inline the commit-range diff.
  assert.equal(readOnlyReviewerNeedsInlinedDiff({ provider: 'anthropic-claude', model: null }), true);
  assert.equal(readOnlyReviewerNeedsInlinedDiff({ provider: 'openai-codex', model: null }), true);
  // openai-compatible exposes its own git_diff range tool, so it does not need an
  // inlined diff.
  assert.equal(readOnlyReviewerNeedsInlinedDiff({ provider: 'openai-compatible', model: null }), false);
  // Unregistered ids default to false (tool-access doctrine).
  assert.equal(readOnlyReviewerNeedsInlinedDiff({ provider: 'unregistered-provider', model: null }), false);
});

test('readOnlyReviewerNeedsInlinedDiff respects the providesRangeDiffTool capability flag', () => {
  registerProviderDefinitionForTesting(
    createFakeProviderDefinition({
      id: 'fake-read-only-with-diff-tool',
      capabilities: {
        coder: fakeProviderDefaultCapabilities.coder,
        'structured-advisor': {
          ...fakeProviderDefaultCapabilities['structured-advisor'],
          toolAccess: { read: true, write: false, shell: false },
          providesRangeDiffTool: true,
        },
      },
    }),
  );
  registerProviderDefinitionForTesting(
    createFakeProviderDefinition({
      id: 'fake-read-only-without-diff-tool',
      capabilities: {
        coder: fakeProviderDefaultCapabilities.coder,
        'structured-advisor': {
          ...fakeProviderDefaultCapabilities['structured-advisor'],
          toolAccess: { read: true, write: false, shell: false },
        },
      },
    }),
  );

  assert.equal(readOnlyReviewerNeedsInlinedDiff({ provider: 'fake-read-only-with-diff-tool', model: null }), false);
  assert.equal(readOnlyReviewerNeedsInlinedDiff({ provider: 'fake-read-only-without-diff-tool', model: null }), true);
});

test('renderInlinedRangeDiffSection affirms read tools and presents the diff as the source of truth', () => {
  const rendered = renderInlinedRangeDiffSection({ rangeLabel: 'aaa..bbb', diff: '+added line' });

  assert.match(rendered, /## Inlined commit-range diff from Neal \(aaa\.\.bbb\)/);
  assert.match(rendered, /You have read-only repository tools \(read and search, no shell\) but no commit-range diff tool/);
  assert.match(rendered, /source of truth for exactly what this range changed/);
  assert.match(rendered, /\+added line/);
  // This is not the no-read framing: it must not deny all repository access.
  assert.doesNotMatch(rendered, /You do not have repository, file, shell, or tool access of any kind/);
  assert.doesNotMatch(rendered, /git_diff/);

  const empty = renderInlinedRangeDiffSection({ rangeLabel: 'aaa..bbb', diff: '   ' });
  assert.match(empty, /\(empty diff\)/);
});

test('truncateInlineSectionBody appends an explicit truncation marker', () => {
  const short = 'short body';
  assert.equal(truncateInlineSectionBody(short), short);

  const body = 'x'.repeat(120);
  const truncated = truncateInlineSectionBody(body, 100);
  assert.equal(truncated.startsWith('x'.repeat(100)), true);
  assert.match(truncated, /\n\[truncated 20 character\(s\)\]$/);

  const defaultCapped = truncateInlineSectionBody('y'.repeat(INLINE_SECTION_MAX_CHARS + 5));
  assert.match(defaultCapped, /\[truncated 5 character\(s\)\]$/);
});

test('createInlineSection caps section bodies at the inline section limit', () => {
  const section = createInlineSection('Full diff', 'z'.repeat(INLINE_SECTION_MAX_CHARS + 1));
  assert.equal(section.title, 'Full diff');
  assert.match(section.body, /\[truncated 1 character\(s\)\]$/);
});

test('renderInlineReviewerContext frames the inlined sections as the source of truth without tool access', () => {
  const rendered = renderInlineReviewerContext({
    sections: [
      { title: 'Full diff for commit range a..b', body: '+added line' },
      { title: 'Plan document content (PLAN.md)', body: '# Plan' },
    ],
  });

  assert.match(rendered, /## Inlined review context from Neal/);
  assert.match(rendered, /You do not have repository, file, shell, or tool access of any kind for this review\./);
  assert.match(rendered, /### Full diff for commit range a\.\.b/);
  assert.match(rendered, /\+added line/);
  assert.match(rendered, /### Plan document content \(PLAN\.md\)/);
  assert.match(rendered, /# Plan/);
  for (const marker of NO_READ_PROMPT_FORBIDDEN_MARKERS) {
    assert.equal(
      rendered.toLowerCase().includes(marker.toLowerCase()),
      false,
      `inline context framing must not contain forbidden marker: ${marker}`,
    );
  }
});

test('assertNoReadPromptInstructionText rejects every canonical forbidden marker', () => {
  assert.doesNotThrow(() => assertNoReadPromptInstructionText('Judge entirely from the inlined diff below.', 'test'));

  for (const marker of NO_READ_PROMPT_FORBIDDEN_MARKERS) {
    assert.throws(
      () => assertNoReadPromptInstructionText(`Some instruction mentioning ${marker} here.`, 'test'),
      new RegExp(`forbidden repository-access phrasing`),
      `marker should be rejected: ${marker}`,
    );
    assert.throws(
      () => assertNoReadPromptInstructionText(`case-insensitive ${marker.toUpperCase()} mention`, 'test'),
      /forbidden repository-access phrasing/,
      `marker should be rejected case-insensitively: ${marker}`,
    );
  }
});
