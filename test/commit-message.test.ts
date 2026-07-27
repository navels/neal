import assert from 'node:assert/strict';
import test from 'node:test';

import { stripScopePrefixFromCommitMessage, stripScopePrefixFromSubject } from '../src/neal/commit-message.js';

test('stripScopePrefixFromSubject removes numbered scope prefixes with commit separators', () => {
  assert.equal(stripScopePrefixFromSubject('Scope 1: Add run state checks'), 'Add run state checks');
  assert.equal(stripScopePrefixFromSubject('Scope: 2 - Normalize final messages'), 'Normalize final messages');
  assert.equal(stripScopePrefixFromSubject('Scope 3.2: Handle derived sub-scopes'), 'Handle derived sub-scopes');
  assert.equal(stripScopePrefixFromSubject('scope 4: keep lowercase prose untouched'), 'scope 4: keep lowercase prose untouched');
});

test('stripScopePrefixFromCommitMessage promotes body text when the subject is only a scope marker', () => {
  assert.equal(
    stripScopePrefixFromCommitMessage('Scope: 2\n\nAdd deterministic squash message handling.\n\nKeep the audit trail intact.'),
    'Add deterministic squash message handling.\n\nKeep the audit trail intact.',
  );
  assert.equal(stripScopePrefixFromCommitMessage('Scope 3'), '');
});
