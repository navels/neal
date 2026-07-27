import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  formatSummary,
  parseIssueLine,
  parseIssues,
  summarizeIssues,
} from '../src/issue-triage.js';

describe('issue triage example', () => {
  it('parses a basic issue line', () => {
    assert.deepEqual(
      parseIssueLine('- [P1] auth: Login fails @web #bug #customer'),
      {
        priority: 'P1',
        area: 'auth',
        title: 'Login fails',
        owner: 'web',
        tags: ['bug', 'customer'],
      },
    );
  });

  it('parses multiple issue lines while ignoring blanks and comments', () => {
    assert.deepEqual(
      parseIssues(`
- [P1] auth: Login fails @web #bug #customer

// keep this scenario in the sample input but out of the parsed issues
- [P2] billing: Invoice total is wrong @api #bug
`),
      [
        {
          priority: 'P1',
          area: 'auth',
          title: 'Login fails',
          owner: 'web',
          tags: ['bug', 'customer'],
        },
        {
          priority: 'P2',
          area: 'billing',
          title: 'Invoice total is wrong',
          owner: 'api',
          tags: ['bug'],
        },
      ],
    );
  });

  it('summarizes counts by priority, area, owner, and tag', () => {
    const summary = summarizeIssues([
      parseIssueLine('- [P1] auth: Login fails @web #bug #customer'),
      parseIssueLine('- [P1] auth: Session expires early @web #bug'),
      parseIssueLine('- [P2] billing: Invoice total is wrong @api #bug'),
    ]);

    assert.deepEqual(summary, {
      total: 3,
      byPriority: {
        P1: 2,
        P2: 1,
      },
      byArea: {
        auth: 2,
        billing: 1,
      },
      byOwner: {
        web: 2,
        api: 1,
      },
      byTag: {
        bug: 3,
        customer: 1,
      },
    });
  });

  it('formats a minimal markdown summary', () => {
    const summary = summarizeIssues([
      parseIssueLine('- [P1] auth: Login fails @web #bug #customer'),
    ]);

    assert.equal(
      formatSummary(summary),
      [
        '# Issue Summary',
        '',
        'Total: 1',
        '',
        '## Priorities',
        '- P1: 1',
        '',
        '## Areas',
        '- auth: 1',
        '',
        '## Owners',
        '- web: 1',
        '',
        '## Tags',
        '- bug: 1',
        '- customer: 1',
      ].join('\n'),
    );
  });
});
