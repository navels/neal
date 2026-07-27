// Regression coverage for the strict reviewer validator's own-property
// contract (P5 Scope 2 review follow-up): the historical validator required
// every declared property to be an OWN property via
// Object.prototype.hasOwnProperty, at the top level and inside findings, so
// prototype-inherited required properties must be rejected with the pinned
// missing-property message and first-failure ordering. zod reads declared
// properties through the prototype chain, so validateReviewerPayload
// synthesizes missing-own-property issues to preserve that contract. This
// coverage lives outside test/agent-payload-schemas.test.ts because the
// Scope 1 characterization baseline is immutable. Only the strict reviewer
// family is affected: the historical permissive validators always
// read fields via plain property access, which zod's behavior matches.

import test from 'node:test';
import assert from 'node:assert/strict';

import { validateCoderResponsePayload, validateReviewerPayload } from '../src/neal/agents/schemas.js';

function validFinding() {
  return {
    severity: 'blocking',
    files: ['src/a.ts'],
    claim: 'The parser drops trailing tokens.',
    evidence: 'test/parser.test.ts fails on the trailing-token case.',
    requiredAction: 'Handle trailing tokens in the parser loop.',
  };
}

function validPayload() {
  return {
    summary: 'Build succeeds and all tests pass.',
    findings: [validFinding()],
    meaningfulProgressAction: 'accept',
    meaningfulProgressRationale: 'The scope materially advances the active objective.',
  };
}

function withInheritedProperty(base: Record<string, unknown>, inheritedKey: string): Record<string, unknown> {
  const { [inheritedKey]: inheritedValue, ...ownProperties } = base;
  return Object.assign(Object.create({ [inheritedKey]: inheritedValue }) as Record<string, unknown>, ownProperties);
}

test('validateReviewerPayload rejects a top-level required property that is only inherited', () => {
  const payload = withInheritedProperty(validPayload(), 'summary');
  assert.equal(payload.summary, 'Build succeeds and all tests pass.');
  assert.throws(
    () => validateReviewerPayload(payload),
    new Error('Reviewer payload is missing required property "summary".'),
  );
});

test('validateReviewerPayload rejects a nested finding property that is only inherited', () => {
  const payload = { ...validPayload(), findings: [withInheritedProperty(validFinding(), 'claim')] };
  assert.throws(
    () => validateReviewerPayload(payload),
    new Error('Reviewer payload.findings[0] is missing required property "claim".'),
  );
});

test('validateReviewerPayload reports an inherited missing property before an unknown property', () => {
  const payload = { ...withInheritedProperty(validPayload(), 'summary'), extra: 'nope' };
  assert.throws(
    () => validateReviewerPayload(payload),
    new Error('Reviewer payload is missing required property "summary".'),
  );
});

test('validateReviewerPayload reports an inherited missing property before non-array findings', () => {
  // The historical validator ran its required-own-property sweep before the
  // findings array-ness check.
  const payload = { ...withInheritedProperty(validPayload(), 'summary'), findings: 'none' };
  assert.throws(
    () => validateReviewerPayload(payload),
    new Error('Reviewer payload is missing required property "summary".'),
  );
});

test('validateReviewerPayload reports an own wrong-typed summary before a nested inherited property', () => {
  // The historical validator checked top-level fields before mapping
  // findings, so the summary type failure wins over the nested missing claim.
  const payload = {
    ...validPayload(),
    summary: 42,
    findings: [withInheritedProperty(validFinding(), 'claim')],
  };
  assert.throws(() => validateReviewerPayload(payload), new Error('Reviewer payload.summary must be a string.'));
});

test('validateReviewerPayload reports an inherited nested property before a later finding defect', () => {
  const payload = {
    ...validPayload(),
    findings: [withInheritedProperty(validFinding(), 'claim'), { ...validFinding(), severity: 'fatal' }],
  };
  assert.throws(
    () => validateReviewerPayload(payload),
    new Error('Reviewer payload.findings[0] is missing required property "claim".'),
  );
});

test('validateReviewerPayload still accepts and returns a fully own-property payload', () => {
  assert.deepStrictEqual(validateReviewerPayload(validPayload()), validPayload());
});

// Historical repeated-read semantics: the array-ness checks performed their
// own reads and the item mappings re-read the property, so stateful
// accessors observe both reads and the SECOND read supplies the validated,
// normalized items — a snapshot-once parse would normalize the first read.

test('validateReviewerPayload re-reads findings after summary for mapping', () => {
  let reads = 0;
  const firstArray = [validFinding()];
  const secondArray = [{ ...validFinding(), severity: 'non_blocking' }];
  const payload: Record<string, unknown> = {
    summary: 'Build succeeds and all tests pass.',
    meaningfulProgressAction: 'accept',
    meaningfulProgressRationale: 'The scope materially advances the active objective.',
  };
  Object.defineProperty(payload, 'findings', {
    enumerable: true,
    configurable: true,
    get() {
      reads += 1;
      return reads === 1 ? firstArray : secondArray;
    },
  });
  const result = validateReviewerPayload(payload);
  assert.equal(result.findings[0].severity, 'non_blocking');
  assert.equal(reads, 2);
});

test('validateReviewerPayload reads finding files, then severity, then re-reads files for items', () => {
  const readLog: string[] = [];
  const finding: Record<string, unknown> = {
    claim: 'The parser drops trailing tokens.',
    evidence: 'test/parser.test.ts fails on the trailing-token case.',
    requiredAction: 'Handle trailing tokens in the parser loop.',
  };
  Object.defineProperty(finding, 'files', {
    enumerable: true,
    configurable: true,
    get() {
      readLog.push('files');
      return readLog.filter((entry) => entry === 'files').length === 1 ? ['first.ts'] : ['second.ts'];
    },
  });
  Object.defineProperty(finding, 'severity', {
    enumerable: true,
    configurable: true,
    get() {
      readLog.push('severity');
      return 'blocking';
    },
  });
  const result = validateReviewerPayload({ ...validPayload(), findings: [finding] });
  assert.deepEqual(result.findings[0].files, ['second.ts']);
  assert.deepEqual(readLog, ['files', 'severity', 'files']);
});

// The historical validator ran its hasOwnProperty/Object.keys preflight
// before reading ANY declared field, so a prototype-inherited accessor —
// including one that throws — was never invoked; the pinned missing-property
// error fired instead. The zod-backed validator must preserve that
// trust-boundary contract at both levels.

function throwingAccessorPrototype(key: string, onInvoke: () => void): object {
  const prototype = {};
  Object.defineProperty(prototype, key, {
    enumerable: true,
    get() {
      onInvoke();
      throw new Error(`inherited ${key} accessor was invoked`);
    },
  });
  return prototype;
}

function withoutKey(base: Record<string, unknown>, key: string): Record<string, unknown> {
  const copy = { ...base };
  delete copy[key];
  return copy;
}

test('validateReviewerPayload never invokes a throwing inherited top-level accessor', () => {
  let invoked = false;
  const payload = Object.assign(
    Object.create(throwingAccessorPrototype('summary', () => {
      invoked = true;
    })) as Record<string, unknown>,
    withoutKey(validPayload(), 'summary'),
  );
  assert.throws(
    () => validateReviewerPayload(payload),
    new Error('Reviewer payload is missing required property "summary".'),
  );
  assert.equal(invoked, false);
});

test('validateReviewerPayload never invokes a throwing inherited finding accessor', () => {
  let invoked = false;
  const defectiveFinding = Object.assign(
    Object.create(throwingAccessorPrototype('claim', () => {
      invoked = true;
    })) as Record<string, unknown>,
    withoutKey(validFinding(), 'claim'),
  );
  // A healthy sibling finding proves untouched findings still parse normally.
  const payload = { ...validPayload(), findings: [validFinding(), defectiveFinding] };
  assert.throws(
    () => validateReviewerPayload(payload),
    new Error('Reviewer payload.findings[1] is missing required property "claim".'),
  );
  assert.equal(invoked, false);
});

function withThrowingOwnAccessor(
  base: Record<string, unknown>,
  key: string,
  onInvoke: () => void,
): Record<string, unknown> {
  const copy = withoutKey(base, key);
  Object.defineProperty(copy, key, {
    enumerable: true,
    configurable: true,
    get() {
      onInvoke();
      throw new Error(`own ${key} accessor was invoked`);
    },
  });
  return copy;
}

test('validateReviewerPayload checks files array-ness before reading severity', () => {
  // Historical per-finding access order: the files array-ness check read
  // `files` BEFORE `severity` (or any other declared field) was read, so an
  // own throwing severity accessor combined with non-array files produced
  // the exact files-array error without ever invoking the accessor.
  let invoked = false;
  const finding = withThrowingOwnAccessor({ ...validFinding(), files: 'not-an-array' }, 'severity', () => {
    invoked = true;
  });
  const payload = { ...validPayload(), findings: [finding] };
  assert.throws(
    () => validateReviewerPayload(payload),
    new Error('Reviewer payload.findings[0].files must be an array.'),
  );
  assert.equal(invoked, false);
});

test('validateReviewerPayload reports a missing own property before reading a throwing severity accessor', () => {
  // Historical per-finding order: the required-own-property sweep preceded
  // the files array-ness check and every declared-field read.
  let invoked = false;
  const finding = withThrowingOwnAccessor(withoutKey(validFinding(), 'claim'), 'severity', () => {
    invoked = true;
  });
  const payload = { ...validPayload(), findings: [finding] };
  assert.throws(
    () => validateReviewerPayload(payload),
    new Error('Reviewer payload.findings[0] is missing required property "claim".'),
  );
  assert.equal(invoked, false);
});

// Historical sequential short-circuiting: validation read and checked one
// property at a time and threw at the FIRST failure, so no property later in
// the validation order was ever read after an earlier failure — a later
// throwing accessor could not mask the earlier historical error.

test('validateReviewerPayload does not read finding files after a wrong-typed summary', () => {
  let invoked = false;
  const finding = withThrowingOwnAccessor(validFinding(), 'files', () => {
    invoked = true;
  });
  const payload = { ...validPayload(), summary: 42, findings: [finding] };
  assert.throws(() => validateReviewerPayload(payload), new Error('Reviewer payload.summary must be a string.'));
  assert.equal(invoked, false);
});

function validCoderResponsePayload() {
  return {
    outcome: 'responded',
    summary: 'Addressed every finding.',
    blocker: '',
    derivedPlan: '',
    responses: [{ id: 'finding-1', decision: 'fixed', summary: 'Handled trailing tokens.' }],
  };
}

test('validateCoderResponsePayload does not read later fields after an invalid outcome', () => {
  // Representative permissive validator: the historical check sequence
  // threw on the outcome enum before reading any later field.
  let invoked = false;
  const payload = withThrowingOwnAccessor({ ...validCoderResponsePayload(), outcome: 'nope' }, 'responses', () => {
    invoked = true;
  });
  assert.throws(
    () => validateCoderResponsePayload(payload),
    new Error('Coder response round payload.outcome must be exactly one of: responded, blocked, split_plan.'),
  );
  assert.equal(invoked, false);
});

test('validateCoderResponsePayload does not read later fields after a wrong-typed mid-order field', () => {
  let invoked = false;
  const payload = withThrowingOwnAccessor({ ...validCoderResponsePayload(), blocker: 7 }, 'responses', () => {
    invoked = true;
  });
  assert.throws(
    () => validateCoderResponsePayload(payload),
    new Error('Coder response round payload.blocker must be a string.'),
  );
  assert.equal(invoked, false);
});

test('validateReviewerPayload keeps summary-type precedence over a nested files-array defect', () => {
  // Historical ordering: the top-level summary type failure was thrown
  // before findings were mapped, so it wins over a nested files-array
  // defect — and the defective finding's own severity accessor stays
  // uninvoked while zod surfaces the summary failure.
  let invoked = false;
  const finding = withThrowingOwnAccessor({ ...validFinding(), files: 'not-an-array' }, 'severity', () => {
    invoked = true;
  });
  const payload = { ...validPayload(), summary: 42, findings: [finding] };
  assert.throws(() => validateReviewerPayload(payload), new Error('Reviewer payload.summary must be a string.'));
  assert.equal(invoked, false);
});

test('validateReviewerPayload keeps summary-type precedence without invoking a defective finding accessor', () => {
  // Historical ordering: the top-level summary type failure wins over the
  // nested missing claim — and even while zod parses the payload to surface
  // that summary failure, the defective finding's inherited accessor must
  // stay uninvoked.
  let invoked = false;
  const defectiveFinding = Object.assign(
    Object.create(throwingAccessorPrototype('claim', () => {
      invoked = true;
    })) as Record<string, unknown>,
    withoutKey(validFinding(), 'claim'),
  );
  const payload = { ...validPayload(), summary: 42, findings: [defectiveFinding] };
  assert.throws(() => validateReviewerPayload(payload), new Error('Reviewer payload.summary must be a string.'));
  assert.equal(invoked, false);
});
