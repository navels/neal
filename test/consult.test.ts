import test from 'node:test';
import assert from 'node:assert/strict';

import {
  buildBlockedRecoveryCoderPrompt,
  buildCoderBlockedRecoveryDispositionSchema,
  parseCoderBlockedRecoveryDispositionPayload,
} from '../src/neal/agents.js';

test('blocked-recovery coder prompt defines the in-band four-action contract', () => {
  const prompt = buildBlockedRecoveryCoderPrompt({
    planDoc: '/tmp/PLAN.md',
    progressText: 'Current scope: 2',
    consultMarkdownPath: '/tmp/CONSULT.md',
    blockedReason: 'Need operator guidance about scope shape.',
    operatorGuidance: 'Replace this scope with a narrower derived plan.',
    maxTurns: 3,
    turnsTaken: 1,
  });

  assert.match(prompt, /Blocked recovery is now in-band inside Neal/);
  assert.match(prompt, /Choose exactly one recovery action/);
  assert.match(prompt, /`resume_current_scope`/);
  assert.match(prompt, /`replace_current_scope`/);
  assert.match(prompt, /`stay_blocked`/);
  assert.match(prompt, /`terminal_block`/);
  assert.match(prompt, /existing split-plan \/ derived-plan machinery/);
  assert.match(prompt, /Latest operator guidance: Replace this scope with a narrower derived plan\./);
});

test('blocked-recovery schema requires the deterministic recovery contract', () => {
  const schema = buildCoderBlockedRecoveryDispositionSchema();

  assert.deepEqual(schema.properties.action.enum, [
    'resume_current_scope',
    'replace_current_scope',
    'stay_blocked',
    'terminal_block',
  ]);
  assert.deepEqual(schema.required, ['action', 'summary', 'rationale', 'blocker', 'replacementPlan']);
  assert.equal(schema.additionalProperties, false);
});

test('blocked-recovery parser accepts all four recovery actions', () => {
  const resume = parseCoderBlockedRecoveryDispositionPayload(
    JSON.stringify({
      action: 'resume_current_scope',
      summary: 'The current scope is still correct.',
      rationale: 'The operator clarified the intended direction.',
      blocker: '',
      replacementPlan: '',
    }),
  );
  const replace = parseCoderBlockedRecoveryDispositionPayload(
    JSON.stringify({
      action: 'replace_current_scope',
      summary: 'The scope should be replaced.',
      rationale: 'The direct shape is wrong but the target is still viable.',
      blocker: '',
      replacementPlan: '## Goal\n\nReplace the scope safely.\n',
    }),
  );
  const stayBlocked = parseCoderBlockedRecoveryDispositionPayload(
    JSON.stringify({
      action: 'stay_blocked',
      summary: 'More input is needed.',
      rationale: 'The operator guidance does not resolve the ambiguity yet.',
      blocker: 'Need a concrete decision on whether infrastructure edits are allowed.',
      replacementPlan: '',
    }),
  );
  const terminalBlock = parseCoderBlockedRecoveryDispositionPayload(
    JSON.stringify({
      action: 'terminal_block',
      summary: 'No safe in-repo path remains.',
      rationale: 'The blocker requires an out-of-band prerequisite.',
      blocker: 'Production credentials must be rotated externally first.',
      replacementPlan: '',
    }),
  );

  assert.equal(resume.action, 'resume_current_scope');
  assert.equal(replace.action, 'replace_current_scope');
  assert.equal(stayBlocked.action, 'stay_blocked');
  assert.equal(terminalBlock.action, 'terminal_block');
});

test('blocked-recovery parser rejects malformed replacement and blocker payloads', () => {
  assert.throws(
    () =>
      parseCoderBlockedRecoveryDispositionPayload(
        JSON.stringify({
          action: 'replace_current_scope',
          summary: 'Replace the scope.',
          rationale: 'The scope shape is wrong.',
          blocker: '',
          replacementPlan: '',
        }),
      ),
    /without a replacementPlan payload/,
  );

  assert.throws(
    () =>
      parseCoderBlockedRecoveryDispositionPayload(
        JSON.stringify({
          action: 'resume_current_scope',
          summary: 'Resume the scope.',
          rationale: 'The operator answered the question.',
          blocker: '',
          replacementPlan: '## Goal\n\nThis should not be here.\n',
        }),
      ),
    /without action=replace_current_scope/,
  );

  assert.throws(
    () =>
      parseCoderBlockedRecoveryDispositionPayload(
        JSON.stringify({
          action: 'stay_blocked',
          summary: 'Still blocked.',
          rationale: 'More input is required.',
          blocker: '',
          replacementPlan: '',
        }),
      ),
    /without a blocker payload/,
  );
});
