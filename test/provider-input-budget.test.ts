import test from 'node:test';
import assert from 'node:assert/strict';

import {
  assertPromptWithinInputBudget,
  buildInputTooLargeMessage,
  measurePromptSections,
} from '../src/neal/providers/input-budget.js';
import { getProviderDefinition } from '../src/neal/providers/registry.js';
import { NealProviderError } from '../src/neal/providers/types.js';

test('measurePromptSections splits on ## headings, labels leading text instructions, and accounts for every char', () => {
  const prompt = [
    'Follow the review contract below.',
    '',
    '## Plan',
    'plan body',
    '',
    '## Aggregate Diff',
    'x'.repeat(500),
    '### Not a top-level heading',
    'still inside the diff section',
  ].join('\n');

  const sections = measurePromptSections(prompt);

  assert.deepEqual(sections.map((section) => section.name), ['instructions', 'Plan', 'Aggregate Diff']);
  assert.equal(sections.reduce((total, section) => total + section.chars, 0), prompt.length);
});

test('measurePromptSections labels a heading-free prompt as one instructions section', () => {
  const prompt = 'no headings at all';
  assert.deepEqual(measurePromptSections(prompt), [{ name: 'instructions', chars: prompt.length }]);
});

test('buildInputTooLargeMessage names sizes and the three largest sections in a short bounded report', () => {
  const message = buildInputTooLargeMessage({
    provider: 'openai-codex',
    promptChars: 1_259_386,
    maxInputChars: 1_048_576,
    sections: [
      { name: 'instructions', chars: 40_000 },
      { name: 'Final Completion Packet', chars: 900_000 },
      { name: `Section with a very long heading ${'y'.repeat(200)}`, chars: 200_000 },
      { name: 'Plan', chars: 119_386 },
    ],
  });

  assert.match(message, /Prompt is 1,259,386 chars; openai-codex accepts at most 1,048,576 input chars per turn\./);
  assert.match(message, /"Final Completion Packet" 900,000 chars/);
  assert.match(message, /"Plan" 119,386 chars/);
  // Only the three largest sections appear.
  assert.doesNotMatch(message, /instructions/);
  // Long section names are capped so the report survives status's 1,000-char
  // message truncation.
  assert.doesNotMatch(message, /y{100}/);
  assert.ok(message.length <= 1_000);
});

test('assertPromptWithinInputBudget is a no-op without a declared budget or under the limit', () => {
  assertPromptWithinInputBudget({
    prompt: 'x'.repeat(10_000),
    maxInputChars: undefined,
    provider: 'anthropic-claude',
    role: 'coder',
  });
  assertPromptWithinInputBudget({
    prompt: 'x'.repeat(100),
    maxInputChars: 100,
    provider: 'openai-codex',
    role: 'structured-advisor',
  });
});

test('assertPromptWithinInputBudget throws a non-retryable input_too_large error with the section report', () => {
  assert.throws(
    () =>
      assertPromptWithinInputBudget({
        prompt: `## Aggregate Diff\n${'d'.repeat(200)}\n\n## Plan\nshort`,
        maxInputChars: 100,
        provider: 'openai-codex',
        role: 'structured-advisor',
        sessionHandle: 'reviewer-session',
      }),
    (error: unknown) => {
      assert.equal(error instanceof NealProviderError, true);
      const providerError = error as NealProviderError;
      assert.equal(providerError.kind, 'input_too_large');
      assert.equal(providerError.retryable, false);
      assert.equal(providerError.provider, 'openai-codex');
      assert.equal(providerError.role, 'structured-advisor');
      assert.equal(providerError.sessionHandle, 'reviewer-session');
      assert.match(providerError.message, /Largest sections: "Aggregate Diff" 220 chars; "Plan" 13 chars\./);
      return true;
    },
  );
});

test('only OpenAI Codex declares a per-turn input budget', () => {
  const codex = getProviderDefinition('openai-codex').capabilities;
  const claude = getProviderDefinition('anthropic-claude').capabilities;
  const compatible = getProviderDefinition('openai-compatible').capabilities;
  assert.equal(codex.coder.maxInputChars, 1_048_576);
  assert.equal(codex['structured-advisor'].maxInputChars, 1_048_576);
  assert.equal(claude.coder.maxInputChars, undefined);
  assert.equal(claude['structured-advisor'].maxInputChars, undefined);
  assert.equal(compatible.coder.maxInputChars, undefined);
  assert.equal(compatible['structured-advisor'].maxInputChars, undefined);
});
