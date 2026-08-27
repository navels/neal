// Characterization baseline for src/neal/agents/schemas.ts (P5 Scope 1).
//
// This file pins the CURRENT behavior of every JSON-Schema builder /
// payload-validator pair before the zod migration (P5 Scope 2): exact thrown
// messages (assert.throws with full Error), exact normalized return values
// (assert.deepStrictEqual), first-failure ordering, all cross-field rules in
// both directions, normalization quirks, and byte-identical serialized
// JSON-Schema output (assert.strictEqual on JSON.stringify(schema, null, 2) —
// object-level comparison is key-order-insensitive and cannot protect prompt
// bytes, so the string pin is mandatory).
//
// This file is the immutable oracle for the schemas.ts refactor: it must not
// be edited while that refactor lands. Symbols are imported directly from
// ../src/neal/agents/schemas.js (not the agents.ts barrel) so the pins
// survive later barrel changes.

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  EXECUTE_SCOPE_PROGRESS_PAYLOAD_END,
  EXECUTE_SCOPE_PROGRESS_PAYLOAD_START,
  buildConsultantSchema,
  buildCoderBlockedRecoveryDispositionSchema,
  buildCoderPlanResponseSchema,
  buildCoderPlanSchema,
  buildCoderResponseSchema,
  buildCoderScopeSchema,
  buildExecuteScopeProgressSchema,
  buildFinalCompletionReviewerSchema,
  buildFinalCompletionSummarySchema,
  buildPlanReviewerSchema,
  buildReviewerSchema,
  parseExecuteScopeProgressPayload,
  parseFinalCompletionReviewerPayload,
  parseFinalCompletionSummaryPayload,
  stripExecuteScopeProgressPayload,
  validateConsultantVerdictPayload,
  validateCoderBlockedRecoveryDispositionPayload,
  validateCoderPlanPayload,
  validateCoderPlanResponsePayload,
  validateCoderResponsePayload,
  validateCoderScopePayload,
  validatePlanReviewerPayload,
  validateReviewerPayload,
} from '../src/neal/agents/schemas.js';

function validReviewerFinding() {
  return {
    severity: 'blocking',
    files: ['src/a.ts'],
    claim: 'The parser drops trailing tokens.',
    evidence: 'test/parser.test.ts fails on the trailing-token case.',
    requiredAction: 'Handle trailing tokens in the parser loop.',
  };
}

function validReviewerPayload() {
  return {
    summary: 'Build succeeds and all tests pass.',
    findings: [validReviewerFinding()],
    meaningfulProgressAction: 'accept',
    meaningfulProgressRationale: 'The scope materially advances the active objective.',
  };
}

function validPlanReviewerFinding() {
  return {
    severity: 'blocking',
    files: ['PLAN.md'],
    claim: 'The plan omits verification for scope two.',
    requiredAction: 'Add a verification command to scope two.',
    // findingClass is optional; an omitted class normalizes to plan_correctness.
  };
}

function validPlanReviewerPayload() {
  return {
    summary: 'The plan is executable.',
    executionShape: 'multi_scope',
    findings: [validPlanReviewerFinding()],
  };
}

function validConsultantPayload() {
  return {
    recoverable: false,
    triageCategory: 'authorization',
    resolutionDirective: '',
    targetCanonicalIds: ['finding-1'],
    rationale: 'The coder needs credentials only the operator holds.',
  };
}

function validCoderResponsePayload() {
  return {
    outcome: 'responded',
    summary: 'Addressed every finding.',
    blocker: '',
    derivedPlan: '',
    responses: [
      {
        id: 'finding-1',
        decision: 'fixed',
        summary: 'Handled trailing tokens.',
      },
    ],
  };
}

function validCoderPlanResponsePayload() {
  return {
    outcome: 'responded',
    summary: 'Addressed every plan finding.',
    blocker: '',
    responses: [
      {
        id: 'finding-1',
        decision: 'fixed',
        summary: 'Added the missing verification step.',
      },
    ],
  };
}

const VALID_MULTI_SCOPE_PLAN_BODY = [
  '# Plan',
  '',
  '## Execution Shape',
  '',
  'executionShape: multi_scope',
  '',
  '## Execution Queue',
  '',
  '### Scope 1: First bounded change',
  '- Goal: Implement one bounded slice.',
  '- Verification: `pnpm typecheck`',
  '- Success Condition: The first slice is complete and verified.',
].join('\n');

function validCoderPlanPayload() {
  return {
    action: 'ready_for_review',
    message: 'Plan drafted.',
    executionShape: 'multi_scope',
    planBody: VALID_MULTI_SCOPE_PLAN_BODY,
    blockedReason: '',
  };
}

function validProgress() {
  return {
    milestoneTargeted: 'Slice one of the parser rework.',
    newEvidence: 'New tests cover the trailing-token path.',
    whyNotRedundant: 'No previous scope touched the parser loop.',
    nextStepUnlocked: 'Slice two can build on the shared tokenizer.',
  };
}

function validCoderScopePayload() {
  return {
    action: 'continue',
    message: 'Implemented the first slice.',
    progress: validProgress(),
    manualGate: null,
    derivedPlan: '',
    blockedReason: '',
  };
}

function validResumeCheck() {
  return {
    type: 'command',
    name: 'key check',
    command: ['git', 'status'],
    cwd: null,
    timeoutMs: null,
  };
}

function validManualGate() {
  return {
    id: 'gate-1',
    title: 'Rotate credentials',
    reason: 'Requires operator-held access.',
    instructionsMarkdown: 'Rotate the key, then rerun the check.',
    resumeChecks: [validResumeCheck()],
  };
}

function manualGatePayload(gateOverrides: Record<string, unknown>) {
  return {
    ...validCoderScopePayload(),
    action: 'manual_gate',
    manualGate: { ...validManualGate(), ...gateOverrides },
  };
}

function validCoderBlockedRecoveryPayload() {
  return {
    action: 'resume_current_scope',
    summary: 'The blocker was a misunderstanding.',
    rationale: 'The referenced file exists under a different name.',
    blocker: '',
    replacementPlan: '',
    laterScopeNumber: 0,
    laterScopeBody: '',
  };
}

function validFinalCompletionSummaryPayload() {
  return {
    planGoalSatisfied: true,
    whatChangedOverall: 'Reworked the parser and covered it with tests.',
    verificationSummary: 'pnpm test passes with the new coverage.',
    remainingKnownGaps: [],
  };
}

function validFinalCompletionReviewerPayload() {
  return {
    action: 'accept_complete',
    summary: 'All plan work landed.',
    rationale: 'Every scope is verified by the suite.',
    missingWork: null,
    squashCommitMessage: null,
  };
}

function progressRaw(payload: unknown, before = 'Some prose before.', after = 'Prose after.') {
  return [
    before,
    EXECUTE_SCOPE_PROGRESS_PAYLOAD_START,
    JSON.stringify(payload),
    EXECUTE_SCOPE_PROGRESS_PAYLOAD_END,
    after,
  ].join('\n');
}
const EXPECTED_REVIEWER_JSON = `{
  "type": "object",
  "properties": {
    "summary": {
      "type": "string"
    },
    "findings": {
      "type": "array",
      "items": {
        "type": "object",
        "properties": {
          "severity": {
            "type": "string",
            "enum": [
              "blocking",
              "non_blocking"
            ]
          },
          "files": {
            "type": "array",
            "items": {
              "type": "string"
            }
          },
          "claim": {
            "type": "string"
          },
          "evidence": {
            "type": "string"
          },
          "requiredAction": {
            "type": "string"
          }
        },
        "required": [
          "severity",
          "files",
          "claim",
          "evidence",
          "requiredAction"
        ],
        "additionalProperties": false
      }
    },
    "meaningfulProgressAction": {
      "type": "string",
      "enum": [
        "accept",
        "block_for_operator",
        "replace_plan",
        "advance_parent"
      ]
    },
    "meaningfulProgressRationale": {
      "type": "string"
    }
  },
  "required": [
    "summary",
    "findings",
    "meaningfulProgressAction",
    "meaningfulProgressRationale"
  ],
  "additionalProperties": false
}`;

const EXPECTED_PLAN_REVIEWER_JSON = `{
  "type": "object",
  "properties": {
    "summary": {
      "type": "string"
    },
    "executionShape": {
      "type": "string",
      "enum": [
        "one_shot",
        "multi_scope",
        "multi_scope_unknown"
      ]
    },
    "findings": {
      "type": "array",
      "items": {
        "type": "object",
        "properties": {
          "severity": {
            "type": "string",
            "enum": [
              "blocking",
              "non_blocking"
            ]
          },
          "files": {
            "type": "array",
            "items": {
              "type": "string"
            }
          },
          "claim": {
            "type": "string"
          },
          "requiredAction": {
            "type": "string"
          },
          "findingClass": {
            "type": "string",
            "enum": [
              "plan_correctness",
              "verification_hardening"
            ]
          }
        },
        "required": [
          "severity",
          "files",
          "claim",
          "requiredAction"
        ],
        "additionalProperties": false
      }
    }
  },
  "required": [
    "summary",
    "executionShape",
    "findings"
  ],
  "additionalProperties": false
}`;

const EXPECTED_CONSULTANT_JSON = `{
  "type": "object",
  "properties": {
    "recoverable": {
      "type": "boolean"
    },
    "triageCategory": {
      "type": "string",
      "enum": [
        "misunderstanding",
        "authorization",
        "external_precondition",
        "impossible_task"
      ]
    },
    "resolutionDirective": {
      "type": "string"
    },
    "targetCanonicalIds": {
      "type": "array",
      "items": {
        "type": "string"
      }
    },
    "rationale": {
      "type": "string"
    }
  },
  "required": [
    "recoverable",
    "triageCategory",
    "resolutionDirective",
    "rationale"
  ],
  "additionalProperties": false
}`;

const EXPECTED_CODER_RESPONSE_JSON = `{
  "type": "object",
  "properties": {
    "outcome": {
      "type": "string",
      "enum": [
        "responded",
        "blocked",
        "split_plan"
      ]
    },
    "summary": {
      "type": "string"
    },
    "blocker": {
      "type": "string"
    },
    "derivedPlan": {
      "type": "string"
    },
    "responses": {
      "type": "array",
      "items": {
        "type": "object",
        "properties": {
          "id": {
            "type": "string"
          },
          "decision": {
            "type": "string",
            "enum": [
              "fixed",
              "rejected",
              "deferred"
            ]
          },
          "summary": {
            "type": "string"
          }
        },
        "required": [
          "id",
          "decision",
          "summary"
        ],
        "additionalProperties": false
      }
    }
  },
  "required": [
    "outcome",
    "summary",
    "blocker",
    "derivedPlan",
    "responses"
  ],
  "additionalProperties": false
}`;

const EXPECTED_CODER_PLAN_RESPONSE_JSON = `{
  "type": "object",
  "properties": {
    "outcome": {
      "type": "string",
      "enum": [
        "responded",
        "blocked"
      ]
    },
    "summary": {
      "type": "string"
    },
    "blocker": {
      "type": "string"
    },
    "responses": {
      "type": "array",
      "items": {
        "type": "object",
        "properties": {
          "id": {
            "type": "string"
          },
          "decision": {
            "type": "string",
            "enum": [
              "fixed",
              "rejected",
              "deferred"
            ]
          },
          "summary": {
            "type": "string"
          }
        },
        "required": [
          "id",
          "decision",
          "summary"
        ],
        "additionalProperties": false
      }
    }
  },
  "required": [
    "outcome",
    "summary",
    "blocker",
    "responses"
  ],
  "additionalProperties": false
}`;

const EXPECTED_CODER_PLAN_JSON = `{
  "type": "object",
  "properties": {
    "action": {
      "type": "string",
      "enum": [
        "ready_for_review",
        "blocked"
      ]
    },
    "message": {
      "type": "string"
    },
    "executionShape": {
      "type": "string",
      "enum": [
        "one_shot",
        "multi_scope",
        "multi_scope_unknown"
      ]
    },
    "planBody": {
      "type": "string"
    },
    "blockedReason": {
      "type": "string"
    }
  },
  "required": [
    "action",
    "message",
    "executionShape",
    "planBody",
    "blockedReason"
  ],
  "additionalProperties": false
}`;

const EXPECTED_CODER_SCOPE_JSON = `{
  "type": "object",
  "properties": {
    "action": {
      "type": "string",
      "enum": [
        "continue",
        "scope_done",
        "done",
        "blocked",
        "split_plan",
        "manual_gate"
      ]
    },
    "message": {
      "type": "string"
    },
    "progress": {
      "type": "object",
      "properties": {
        "milestoneTargeted": {
          "type": "string"
        },
        "newEvidence": {
          "type": "string"
        },
        "whyNotRedundant": {
          "type": "string"
        },
        "nextStepUnlocked": {
          "type": "string"
        }
      },
      "required": [
        "milestoneTargeted",
        "newEvidence",
        "whyNotRedundant",
        "nextStepUnlocked"
      ],
      "additionalProperties": false
    },
    "manualGate": {
      "type": [
        "object",
        "null"
      ],
      "properties": {
        "id": {
          "type": "string"
        },
        "title": {
          "type": "string"
        },
        "reason": {
          "type": "string"
        },
        "instructionsMarkdown": {
          "type": "string"
        },
        "resumeChecks": {
          "type": "array",
          "items": {
            "type": "object",
            "properties": {
              "type": {
                "type": "string",
                "enum": [
                  "command"
                ]
              },
              "name": {
                "type": "string"
              },
              "command": {
                "type": "array",
                "items": {
                  "type": "string"
                }
              },
              "cwd": {
                "type": [
                  "string",
                  "null"
                ],
                "enum": [
                  "repo",
                  "run_dir",
                  null
                ]
              },
              "timeoutMs": {
                "type": [
                  "number",
                  "null"
                ]
              }
            },
            "required": [
              "type",
              "name",
              "command",
              "cwd",
              "timeoutMs"
            ],
            "additionalProperties": false
          }
        }
      },
      "required": [
        "id",
        "title",
        "reason",
        "instructionsMarkdown",
        "resumeChecks"
      ],
      "additionalProperties": false
    },
    "derivedPlan": {
      "type": "string"
    },
    "blockedReason": {
      "type": "string"
    }
  },
  "required": [
    "action",
    "message",
    "progress",
    "manualGate",
    "derivedPlan",
    "blockedReason"
  ],
  "additionalProperties": false
}`;

const EXPECTED_CODER_BLOCKED_RECOVERY_DISPOSITION_JSON = `{
  "type": "object",
  "properties": {
    "action": {
      "type": "string",
      "enum": [
        "resume_current_scope",
        "replace_current_scope",
        "stay_blocked",
        "terminal_block"
      ]
    },
    "summary": {
      "type": "string"
    },
    "rationale": {
      "type": "string"
    },
    "blocker": {
      "type": "string"
    },
    "replacementPlan": {
      "type": "string"
    },
    "laterScopeNumber": {
      "type": "number"
    },
    "laterScopeBody": {
      "type": "string"
    }
  },
  "required": [
    "action",
    "summary",
    "rationale",
    "blocker",
    "replacementPlan",
    "laterScopeNumber",
    "laterScopeBody"
  ],
  "additionalProperties": false
}`;

const EXPECTED_EXECUTE_SCOPE_PROGRESS_JSON = `{
  "type": "object",
  "properties": {
    "milestoneTargeted": {
      "type": "string"
    },
    "newEvidence": {
      "type": "string"
    },
    "whyNotRedundant": {
      "type": "string"
    },
    "nextStepUnlocked": {
      "type": "string"
    }
  },
  "required": [
    "milestoneTargeted",
    "newEvidence",
    "whyNotRedundant",
    "nextStepUnlocked"
  ],
  "additionalProperties": false
}`;

const EXPECTED_FINAL_COMPLETION_SUMMARY_JSON = `{
  "type": "object",
  "properties": {
    "planGoalSatisfied": {
      "type": "boolean"
    },
    "whatChangedOverall": {
      "type": "string"
    },
    "verificationSummary": {
      "type": "string"
    },
    "remainingKnownGaps": {
      "type": "array",
      "items": {
        "type": "string"
      }
    }
  },
  "required": [
    "planGoalSatisfied",
    "whatChangedOverall",
    "verificationSummary",
    "remainingKnownGaps"
  ],
  "additionalProperties": false
}`;

const EXPECTED_FINAL_COMPLETION_REVIEWER_JSON = `{
  "type": "object",
  "properties": {
    "action": {
      "type": "string",
      "enum": [
        "accept_complete",
        "continue_execution",
        "block_for_operator"
      ]
    },
    "summary": {
      "type": "string"
    },
    "rationale": {
      "type": "string"
    },
    "missingWork": {
      "type": [
        "object",
        "null"
      ],
      "properties": {
        "summary": {
          "type": "string"
        },
        "requiredOutcome": {
          "type": "string"
        },
        "verification": {
          "type": "string"
        }
      },
      "required": [
        "summary",
        "requiredOutcome",
        "verification"
      ],
      "additionalProperties": false
    },
    "squashCommitMessage": {
      "description": "Project-facing Git history metadata used only when action is accept_complete; set null for continue_execution or block_for_operator.",
      "type": [
        "object",
        "null"
      ],
      "properties": {
        "subject": {
          "description": "Concise project-facing commit subject summarizing code or product behavior, not plan documents, paths, scopes, Neal mechanics, provider process, reviewer process, or final cleanup.",
          "type": "string"
        },
        "bullets": {
          "description": "Two to five project-facing Git history bullets summarizing behavior changes; avoid plan paths, markdown plan filenames, temporary run paths, scope wording, Neal mechanics, provider process, or reviewer process.",
          "type": "array",
          "minItems": 2,
          "maxItems": 5,
          "items": {
            "type": "string"
          }
        }
      },
      "required": [
        "subject",
        "bullets"
      ],
      "additionalProperties": false
    }
  },
  "required": [
    "action",
    "summary",
    "rationale",
    "missingWork",
    "squashCommitMessage"
  ],
  "additionalProperties": false
}`;

// --- JSON-Schema builders: byte-identical serialized output -----------------

test('buildReviewerSchema serializes byte-identically', () => {
  assert.strictEqual(JSON.stringify(buildReviewerSchema(), null, 2), EXPECTED_REVIEWER_JSON);
});

test('buildPlanReviewerSchema serializes byte-identically', () => {
  assert.strictEqual(JSON.stringify(buildPlanReviewerSchema(), null, 2), EXPECTED_PLAN_REVIEWER_JSON);
});

test('buildConsultantSchema serializes byte-identically', () => {
  assert.strictEqual(JSON.stringify(buildConsultantSchema(), null, 2), EXPECTED_CONSULTANT_JSON);
});

test('buildCoderResponseSchema serializes byte-identically', () => {
  assert.strictEqual(JSON.stringify(buildCoderResponseSchema(), null, 2), EXPECTED_CODER_RESPONSE_JSON);
});

test('buildCoderPlanResponseSchema serializes byte-identically', () => {
  assert.strictEqual(JSON.stringify(buildCoderPlanResponseSchema(), null, 2), EXPECTED_CODER_PLAN_RESPONSE_JSON);
});

test('buildCoderPlanSchema serializes byte-identically', () => {
  assert.strictEqual(JSON.stringify(buildCoderPlanSchema(), null, 2), EXPECTED_CODER_PLAN_JSON);
});

test('buildCoderScopeSchema serializes byte-identically', () => {
  assert.strictEqual(JSON.stringify(buildCoderScopeSchema(), null, 2), EXPECTED_CODER_SCOPE_JSON);
});

test('buildCoderBlockedRecoveryDispositionSchema serializes byte-identically', () => {
  assert.strictEqual(
    JSON.stringify(buildCoderBlockedRecoveryDispositionSchema(), null, 2),
    EXPECTED_CODER_BLOCKED_RECOVERY_DISPOSITION_JSON,
  );
});

test('buildExecuteScopeProgressSchema serializes byte-identically', () => {
  assert.strictEqual(JSON.stringify(buildExecuteScopeProgressSchema(), null, 2), EXPECTED_EXECUTE_SCOPE_PROGRESS_JSON);
});

test('buildFinalCompletionSummarySchema serializes byte-identically', () => {
  assert.strictEqual(
    JSON.stringify(buildFinalCompletionSummarySchema(), null, 2),
    EXPECTED_FINAL_COMPLETION_SUMMARY_JSON,
  );
});

test('buildFinalCompletionReviewerSchema serializes byte-identically', () => {
  assert.strictEqual(
    JSON.stringify(buildFinalCompletionReviewerSchema(), null, 2),
    EXPECTED_FINAL_COMPLETION_REVIEWER_JSON,
  );
});

// --- validateReviewerPayload (strict unknown-key family) --------------------

test('validateReviewerPayload rejects non-object payloads', () => {
  assert.throws(() => validateReviewerPayload(null), new Error('Reviewer payload must be a non-null object.'));
  assert.throws(() => validateReviewerPayload([]), new Error('Reviewer payload must be a non-null object.'));
  assert.throws(() => validateReviewerPayload('text'), new Error('Reviewer payload must be a non-null object.'));
});

test('validateReviewerPayload returns the exact accepted payload without trimming', () => {
  const payload = validReviewerPayload();
  payload.summary = '  padded summary  ';
  assert.deepStrictEqual(validateReviewerPayload(payload), {
    summary: '  padded summary  ',
    findings: [
      {
        severity: 'blocking',
        files: ['src/a.ts'],
        claim: 'The parser drops trailing tokens.',
        evidence: 'test/parser.test.ts fails on the trailing-token case.',
        requiredAction: 'Handle trailing tokens in the parser loop.',
      },
    ],
    meaningfulProgressAction: 'accept',
    meaningfulProgressRationale: 'The scope materially advances the active objective.',
  });
});

test('validateReviewerPayload rejects unknown top-level properties', () => {
  const payload = { ...validReviewerPayload(), extra: 'nope' };
  assert.throws(() => validateReviewerPayload(payload), new Error('Reviewer payload included unknown property "extra".'));
});

test('validateReviewerPayload rejects unknown nested finding properties', () => {
  const payload = validReviewerPayload();
  payload.findings = [{ ...validReviewerFinding(), extra: 'nope' }] as never;
  assert.throws(
    () => validateReviewerPayload(payload),
    new Error('Reviewer payload.findings[0] included unknown property "extra".'),
  );
});

test('validateReviewerPayload rejects missing required top-level properties', () => {
  const payload: Record<string, unknown> = validReviewerPayload();
  delete payload.summary;
  assert.throws(() => validateReviewerPayload(payload), new Error('Reviewer payload is missing required property "summary".'));
});

test('validateReviewerPayload rejects missing required nested finding properties', () => {
  const payload = validReviewerPayload();
  const finding: Record<string, unknown> = validReviewerFinding();
  delete finding.claim;
  payload.findings = [finding as never];
  assert.throws(
    () => validateReviewerPayload(payload),
    new Error('Reviewer payload.findings[0] is missing required property "claim".'),
  );
});

test('validateReviewerPayload rejects a non-string summary', () => {
  const payload = { ...validReviewerPayload(), summary: 42 };
  assert.throws(() => validateReviewerPayload(payload), new Error('Reviewer payload.summary must be a string.'));
});

test('validateReviewerPayload rejects non-array findings', () => {
  const payload = { ...validReviewerPayload(), findings: 'none' };
  assert.throws(() => validateReviewerPayload(payload), new Error('Reviewer payload.findings must be an array.'));
});

test('validateReviewerPayload rejects a non-object finding entry', () => {
  const payload = validReviewerPayload();
  payload.findings = ['finding' as never];
  assert.throws(() => validateReviewerPayload(payload), new Error('Reviewer payload.findings[0] must be a non-null object.'));
});

test('validateReviewerPayload rejects an invalid finding severity with the index in the path', () => {
  const payload = validReviewerPayload();
  payload.findings = [validReviewerFinding(), { ...validReviewerFinding(), severity: 'fatal' }];
  assert.throws(
    () => validateReviewerPayload(payload),
    new Error('Reviewer payload.findings[1].severity must be exactly one of: blocking, non_blocking.'),
  );
});

test('validateReviewerPayload rejects an invalid meaningfulProgressAction', () => {
  const payload = { ...validReviewerPayload(), meaningfulProgressAction: 'reject' };
  assert.throws(
    () => validateReviewerPayload(payload),
    new Error(
      'Reviewer payload.meaningfulProgressAction must be exactly one of: accept, block_for_operator, replace_plan, advance_parent.',
    ),
  );
});

test('validateReviewerPayload rejects a non-string finding file with the nested index path', () => {
  const payload = validReviewerPayload();
  payload.findings = [{ ...validReviewerFinding(), files: ['src/a.ts', 7] as never }];
  assert.throws(
    () => validateReviewerPayload(payload),
    new Error('Reviewer payload.findings[0].files[1] must be a string.'),
  );
});

test('validateReviewerPayload reports a missing property before an unknown property', () => {
  const payload: Record<string, unknown> = { ...validReviewerPayload(), extra: 'nope' };
  delete payload.summary;
  assert.throws(() => validateReviewerPayload(payload), new Error('Reviewer payload is missing required property "summary".'));
});

test('validateReviewerPayload reports an unknown property before a wrong-typed field', () => {
  const payload = { ...validReviewerPayload(), summary: 42, extra: 'nope' };
  assert.throws(() => validateReviewerPayload(payload), new Error('Reviewer payload included unknown property "extra".'));
});

test('validateReviewerPayload reports non-array findings before a wrong-typed summary', () => {
  const payload = { ...validReviewerPayload(), summary: 42, findings: 'none' };
  assert.throws(() => validateReviewerPayload(payload), new Error('Reviewer payload.findings must be an array.'));
});

// --- validatePlanReviewerPayload ---------------------------------------------

test('validatePlanReviewerPayload rejects non-object payloads', () => {
  assert.throws(() => validatePlanReviewerPayload(null), new Error('Plan reviewer payload must be a non-null object.'));
});

test('validatePlanReviewerPayload accepts unknown properties and omits them from the output', () => {
  const payload = {
    ...validPlanReviewerPayload(),
    extra: 'dropped',
    findings: [{ ...validPlanReviewerFinding(), nestedExtra: 'dropped' }],
  };
  assert.deepStrictEqual(validatePlanReviewerPayload(payload), {
    summary: 'The plan is executable.',
    executionShape: 'multi_scope',
    findings: [
      {
        severity: 'blocking',
        files: ['PLAN.md'],
        claim: 'The plan omits verification for scope two.',
        evidence: '',
        requiredAction: 'Add a verification command to scope two.',
        // An absent class normalizes to the fail-safe plan_correctness.
        findingClass: 'plan_correctness',
      },
    ],
  });
});

test('validatePlanReviewerPayload forces evidence to an empty string even when provided', () => {
  const payload = validPlanReviewerPayload();
  payload.findings = [{ ...validPlanReviewerFinding(), evidence: 'ignored evidence' } as never];
  const result = validatePlanReviewerPayload(payload);
  assert.strictEqual(result.findings[0].evidence, '');
});

test('validatePlanReviewerPayload surfaces a missing summary as a string-type failure', () => {
  const payload: Record<string, unknown> = validPlanReviewerPayload();
  delete payload.summary;
  assert.throws(() => validatePlanReviewerPayload(payload), new Error('Plan reviewer payload.summary must be a string.'));
});

test('validatePlanReviewerPayload surfaces a missing nested claim as a string-type failure', () => {
  const payload = validPlanReviewerPayload();
  const finding: Record<string, unknown> = validPlanReviewerFinding();
  delete finding.claim;
  payload.findings = [finding as never];
  assert.throws(
    () => validatePlanReviewerPayload(payload),
    new Error('Plan reviewer payload.findings[0].claim must be a string.'),
  );
});

test('validatePlanReviewerPayload rejects a non-string summary', () => {
  const payload = { ...validPlanReviewerPayload(), summary: false };
  assert.throws(() => validatePlanReviewerPayload(payload), new Error('Plan reviewer payload.summary must be a string.'));
});

test('validatePlanReviewerPayload rejects non-array findings', () => {
  const payload = { ...validPlanReviewerPayload(), findings: 'none' };
  assert.throws(() => validatePlanReviewerPayload(payload), new Error('Plan reviewer payload.findings must be an array.'));
});

test('validatePlanReviewerPayload rejects a non-object finding entry', () => {
  const payload = validPlanReviewerPayload();
  payload.findings = [12 as never];
  assert.throws(
    () => validatePlanReviewerPayload(payload),
    new Error('Plan reviewer payload.findings[0] must be a non-null object.'),
  );
});

test('validatePlanReviewerPayload rejects an invalid executionShape', () => {
  const payload = { ...validPlanReviewerPayload(), executionShape: 'linear' };
  assert.throws(
    () => validatePlanReviewerPayload(payload),
    new Error('Plan reviewer payload.executionShape must be exactly one of: one_shot, multi_scope, multi_scope_unknown.'),
  );
});

test('validatePlanReviewerPayload rejects an invalid nested severity with the index in the path', () => {
  const payload = validPlanReviewerPayload();
  payload.findings = [validPlanReviewerFinding(), { ...validPlanReviewerFinding(), severity: 'warn' }] as never;
  assert.throws(
    () => validatePlanReviewerPayload(payload),
    new Error('Plan reviewer payload.findings[1].severity must be exactly one of: blocking, non_blocking.'),
  );
});

test('validatePlanReviewerPayload reports a wrong-typed summary before a wrong executionShape', () => {
  const payload = { ...validPlanReviewerPayload(), summary: 42, executionShape: 'linear' };
  assert.throws(() => validatePlanReviewerPayload(payload), new Error('Plan reviewer payload.summary must be a string.'));
});

// --- validateConsultantVerdictPayload --------------------------------

test('validateConsultantVerdictPayload rejects non-object payloads', () => {
  assert.throws(
    () => validateConsultantVerdictPayload(null),
    new Error('Consultant payload must be a non-null object.'),
  );
});

test('validateConsultantVerdictPayload accepts unknown properties and omits them', () => {
  const payload = { ...validConsultantPayload(), extra: 'dropped' };
  assert.deepStrictEqual(validateConsultantVerdictPayload(payload), {
    recoverable: false,
    triageCategory: 'authorization',
    resolutionDirective: '',
    targetCanonicalIds: ['finding-1'],
    rationale: 'The coder needs credentials only the operator holds.',
  });
});

test('validateConsultantVerdictPayload defaults an absent targetCanonicalIds to an empty array', () => {
  const payload: Record<string, unknown> = validConsultantPayload();
  delete payload.targetCanonicalIds;
  assert.deepStrictEqual(validateConsultantVerdictPayload(payload), {
    recoverable: false,
    triageCategory: 'authorization',
    resolutionDirective: '',
    targetCanonicalIds: [],
    rationale: 'The coder needs credentials only the operator holds.',
  });
});

test('validateConsultantVerdictPayload does not trim returned strings', () => {
  const payload = {
    ...validConsultantPayload(),
    recoverable: true,
    triageCategory: 'misunderstanding',
    resolutionDirective: '  Reread the plan boundary section.  ',
    rationale: '  The blocker misquotes the plan.  ',
  };
  assert.deepStrictEqual(validateConsultantVerdictPayload(payload), {
    recoverable: true,
    triageCategory: 'misunderstanding',
    resolutionDirective: '  Reread the plan boundary section.  ',
    targetCanonicalIds: ['finding-1'],
    rationale: '  The blocker misquotes the plan.  ',
  });
});

test('validateConsultantVerdictPayload surfaces a missing resolutionDirective as a string-type failure', () => {
  const payload: Record<string, unknown> = validConsultantPayload();
  delete payload.resolutionDirective;
  assert.throws(
    () => validateConsultantVerdictPayload(payload),
    new Error('Consultant payload.resolutionDirective must be a string.'),
  );
});

test('validateConsultantVerdictPayload rejects a non-boolean recoverable', () => {
  const payload = { ...validConsultantPayload(), recoverable: 'no' };
  assert.throws(
    () => validateConsultantVerdictPayload(payload),
    new Error('Consultant payload.recoverable must be a boolean.'),
  );
});

test('validateConsultantVerdictPayload rejects a non-array targetCanonicalIds', () => {
  const payload = { ...validConsultantPayload(), targetCanonicalIds: 'finding-1' };
  assert.throws(
    () => validateConsultantVerdictPayload(payload),
    new Error('Consultant payload.targetCanonicalIds must be an array.'),
  );
});

test('validateConsultantVerdictPayload rejects a non-string rationale', () => {
  const payload = { ...validConsultantPayload(), rationale: 9 };
  assert.throws(
    () => validateConsultantVerdictPayload(payload),
    new Error('Consultant payload.rationale must be a string.'),
  );
});

test('validateConsultantVerdictPayload rejects an invalid triageCategory', () => {
  const payload = { ...validConsultantPayload(), triageCategory: 'other' };
  assert.throws(
    () => validateConsultantVerdictPayload(payload),
    new Error(
      'Consultant payload.triageCategory must be exactly one of: misunderstanding, authorization, external_precondition, impossible_task.',
    ),
  );
});

test('validateConsultantVerdictPayload rejects a non-string targetCanonicalIds entry with the index', () => {
  const payload = { ...validConsultantPayload(), targetCanonicalIds: ['finding-1', 3] };
  assert.throws(
    () => validateConsultantVerdictPayload(payload),
    new Error('Consultant payload.targetCanonicalIds[1] must be a string.'),
  );
});

test('validateConsultantVerdictPayload reports recoverable before triageCategory', () => {
  const payload = { ...validConsultantPayload(), recoverable: 'no', triageCategory: 'other' };
  assert.throws(
    () => validateConsultantVerdictPayload(payload),
    new Error('Consultant payload.recoverable must be a boolean.'),
  );
});

test('validateConsultantVerdictPayload rejects an empty rationale', () => {
  const payload = { ...validConsultantPayload(), rationale: '   ' };
  assert.throws(
    () => validateConsultantVerdictPayload(payload),
    new Error('Consultant returned an empty rationale.'),
  );
});

test('validateConsultantVerdictPayload reports an empty rationale before the recoverable pairing rules', () => {
  const payload = {
    ...validConsultantPayload(),
    recoverable: true,
    triageCategory: 'authorization',
    rationale: '   ',
  };
  assert.throws(
    () => validateConsultantVerdictPayload(payload),
    new Error('Consultant returned an empty rationale.'),
  );
});

test('validateConsultantVerdictPayload rejects recoverable=true with a non-misunderstanding triage', () => {
  const payload = { ...validConsultantPayload(), recoverable: true, triageCategory: 'authorization' };
  assert.throws(
    () => validateConsultantVerdictPayload(payload),
    new Error('Consultant returned recoverable=true with a triageCategory other than misunderstanding.'),
  );
});

test('validateConsultantVerdictPayload rejects recoverable=true without a resolutionDirective', () => {
  const payload = {
    ...validConsultantPayload(),
    recoverable: true,
    triageCategory: 'misunderstanding',
    resolutionDirective: '   ',
  };
  assert.throws(
    () => validateConsultantVerdictPayload(payload),
    new Error('Consultant returned recoverable=true without a non-empty resolutionDirective.'),
  );
});

test('validateConsultantVerdictPayload rejects recoverable=false paired with misunderstanding', () => {
  const payload = { ...validConsultantPayload(), recoverable: false, triageCategory: 'misunderstanding' };
  assert.throws(
    () => validateConsultantVerdictPayload(payload),
    new Error('Consultant returned recoverable=false paired with triageCategory=misunderstanding.'),
  );
});

test('validateConsultantVerdictPayload accepts recoverable=false genuine-wall categories with an empty directive', () => {
  for (const triageCategory of ['authorization', 'external_precondition', 'impossible_task']) {
    const payload = { ...validConsultantPayload(), triageCategory };
    assert.deepStrictEqual(validateConsultantVerdictPayload(payload), {
      recoverable: false,
      triageCategory,
      resolutionDirective: '',
      targetCanonicalIds: ['finding-1'],
      rationale: 'The coder needs credentials only the operator holds.',
    });
  }
});

// --- validateCoderResponsePayload --------------------------------------------

test('validateCoderResponsePayload rejects non-object payloads', () => {
  assert.throws(
    () => validateCoderResponsePayload(null),
    new Error('Coder response round payload must be a non-null object.'),
  );
});

test('validateCoderResponsePayload accepts unknown properties and omits them', () => {
  const payload = {
    ...validCoderResponsePayload(),
    extra: 'dropped',
    responses: [{ id: 'finding-1', decision: 'fixed', summary: 'Handled trailing tokens.', nestedExtra: 'dropped' }],
  };
  assert.deepStrictEqual(validateCoderResponsePayload(payload), {
    outcome: 'responded',
    summary: 'Addressed every finding.',
    blocker: '',
    derivedPlan: '',
    responses: [
      {
        id: 'finding-1',
        decision: 'fixed',
        summary: 'Handled trailing tokens.',
      },
    ],
  });
});

test('validateCoderResponsePayload surfaces a missing blocker as a string-type failure', () => {
  const payload: Record<string, unknown> = validCoderResponsePayload();
  delete payload.blocker;
  assert.throws(
    () => validateCoderResponsePayload(payload),
    new Error('Coder response round payload.blocker must be a string.'),
  );
});

test('validateCoderResponsePayload surfaces a missing nested response summary as a string-type failure', () => {
  const payload = validCoderResponsePayload();
  payload.responses = [{ id: 'finding-1', decision: 'fixed' } as never];
  assert.throws(
    () => validateCoderResponsePayload(payload),
    new Error('Coder response round payload.responses[0].summary must be a string.'),
  );
});

test('validateCoderResponsePayload rejects a non-string summary', () => {
  const payload = { ...validCoderResponsePayload(), summary: 1 };
  assert.throws(
    () => validateCoderResponsePayload(payload),
    new Error('Coder response round payload.summary must be a string.'),
  );
});

test('validateCoderResponsePayload rejects non-array responses', () => {
  const payload = { ...validCoderResponsePayload(), responses: 'none' };
  assert.throws(
    () => validateCoderResponsePayload(payload),
    new Error('Coder response round payload.responses must be an array.'),
  );
});

test('validateCoderResponsePayload rejects a non-object response entry', () => {
  const payload = validCoderResponsePayload();
  payload.responses = ['done' as never];
  assert.throws(
    () => validateCoderResponsePayload(payload),
    new Error('Coder response round payload.responses[0] must be a non-null object.'),
  );
});

test('validateCoderResponsePayload rejects an invalid outcome', () => {
  const payload = { ...validCoderResponsePayload(), outcome: 'ok' };
  assert.throws(
    () => validateCoderResponsePayload(payload),
    new Error('Coder response round payload.outcome must be exactly one of: responded, blocked, split_plan.'),
  );
});

test('validateCoderResponsePayload rejects an invalid nested decision with the index in the path', () => {
  const payload = validCoderResponsePayload();
  payload.responses = [
    { id: 'finding-1', decision: 'fixed', summary: 'ok' },
    { id: 'finding-2', decision: 'punted', summary: 'later' },
  ] as never;
  assert.throws(
    () => validateCoderResponsePayload(payload),
    new Error('Coder response round payload.responses[1].decision must be exactly one of: fixed, rejected, deferred.'),
  );
});

test('validateCoderResponsePayload reports outcome before summary', () => {
  const payload = { ...validCoderResponsePayload(), outcome: 'ok', summary: 2 };
  assert.throws(
    () => validateCoderResponsePayload(payload),
    new Error('Coder response round payload.outcome must be exactly one of: responded, blocked, split_plan.'),
  );
});

test('validateCoderResponsePayload rejects split_plan without a derivedPlan', () => {
  const payload = { ...validCoderResponsePayload(), outcome: 'split_plan', derivedPlan: '   ' };
  assert.throws(
    () => validateCoderResponsePayload(payload),
    new Error('Coder response round returned outcome=split_plan without a derivedPlan payload.'),
  );
});

test('validateCoderResponsePayload rejects a derivedPlan without split_plan', () => {
  const payload = { ...validCoderResponsePayload(), derivedPlan: '# Derived plan' };
  assert.throws(
    () => validateCoderResponsePayload(payload),
    new Error('Coder response round returned a derivedPlan payload without outcome=split_plan.'),
  );
});

test('validateCoderResponsePayload accepts split_plan with a derivedPlan and preserves its whitespace', () => {
  const payload = { ...validCoderResponsePayload(), outcome: 'split_plan', derivedPlan: '  # Derived plan  ' };
  assert.deepStrictEqual(validateCoderResponsePayload(payload), {
    outcome: 'split_plan',
    summary: 'Addressed every finding.',
    blocker: '',
    derivedPlan: '  # Derived plan  ',
    responses: [
      {
        id: 'finding-1',
        decision: 'fixed',
        summary: 'Handled trailing tokens.',
      },
    ],
  });
});

test('validateCoderResponsePayload accepts blocked with an empty blocker', () => {
  const payload = { ...validCoderResponsePayload(), outcome: 'blocked' };
  assert.deepStrictEqual(validateCoderResponsePayload(payload), {
    outcome: 'blocked',
    summary: 'Addressed every finding.',
    blocker: '',
    derivedPlan: '',
    responses: [
      {
        id: 'finding-1',
        decision: 'fixed',
        summary: 'Handled trailing tokens.',
      },
    ],
  });
});

// --- validateCoderPlanResponsePayload -----------------------------------------

test('validateCoderPlanResponsePayload rejects non-object payloads', () => {
  assert.throws(
    () => validateCoderPlanResponsePayload(null),
    new Error('Planner plan-response round payload must be a non-null object.'),
  );
});

test('validateCoderPlanResponsePayload accepts unknown properties and omits them', () => {
  const payload = {
    ...validCoderPlanResponsePayload(),
    extra: 'dropped',
    responses: [
      { id: 'finding-1', decision: 'fixed', summary: 'Added the missing verification step.', nestedExtra: 'dropped' },
    ],
  };
  assert.deepStrictEqual(validateCoderPlanResponsePayload(payload), {
    outcome: 'responded',
    summary: 'Addressed every plan finding.',
    blocker: '',
    responses: [
      {
        id: 'finding-1',
        decision: 'fixed',
        summary: 'Added the missing verification step.',
      },
    ],
  });
});

test('validateCoderPlanResponsePayload surfaces a missing blocker as a string-type failure', () => {
  const payload: Record<string, unknown> = validCoderPlanResponsePayload();
  delete payload.blocker;
  assert.throws(
    () => validateCoderPlanResponsePayload(payload),
    new Error('Planner plan-response round payload.blocker must be a string.'),
  );
});

test('validateCoderPlanResponsePayload surfaces a missing nested summary as a string-type failure', () => {
  const payload = validCoderPlanResponsePayload();
  payload.responses = [{ id: 'finding-1', decision: 'fixed' } as never];
  assert.throws(
    () => validateCoderPlanResponsePayload(payload),
    new Error('Planner plan-response round payload.responses[0].summary must be a string.'),
  );
});

test('validateCoderPlanResponsePayload rejects an invalid outcome', () => {
  const payload = { ...validCoderPlanResponsePayload(), outcome: 'split_plan' };
  assert.throws(
    () => validateCoderPlanResponsePayload(payload),
    new Error('Planner plan-response round payload.outcome must be exactly one of: responded, blocked.'),
  );
});

test('validateCoderPlanResponsePayload rejects non-array responses', () => {
  const payload = { ...validCoderPlanResponsePayload(), responses: {} };
  assert.throws(
    () => validateCoderPlanResponsePayload(payload),
    new Error('Planner plan-response round payload.responses must be an array.'),
  );
});

test('validateCoderPlanResponsePayload rejects a non-object response entry', () => {
  const payload = validCoderPlanResponsePayload();
  payload.responses = [null as never];
  assert.throws(
    () => validateCoderPlanResponsePayload(payload),
    new Error('Planner plan-response round payload.responses[0] must be a non-null object.'),
  );
});

test('validateCoderPlanResponsePayload rejects a non-string nested id with the index in the path', () => {
  const payload = validCoderPlanResponsePayload();
  payload.responses = [{ id: 4, decision: 'fixed', summary: 'ok' } as never];
  assert.throws(
    () => validateCoderPlanResponsePayload(payload),
    new Error('Planner plan-response round payload.responses[0].id must be a string.'),
  );
});

test('validateCoderPlanResponsePayload rejects an invalid nested decision', () => {
  const payload = validCoderPlanResponsePayload();
  payload.responses = [{ id: 'finding-1', decision: 'wontfix', summary: 'no' } as never];
  assert.throws(
    () => validateCoderPlanResponsePayload(payload),
    new Error('Planner plan-response round payload.responses[0].decision must be exactly one of: fixed, rejected, deferred.'),
  );
});

test('validateCoderPlanResponsePayload reports outcome before summary', () => {
  const payload = { ...validCoderPlanResponsePayload(), outcome: 'nope', summary: 7 };
  assert.throws(
    () => validateCoderPlanResponsePayload(payload),
    new Error('Planner plan-response round payload.outcome must be exactly one of: responded, blocked.'),
  );
});

test('validateCoderPlanResponsePayload accepts blocked with an empty blocker (no cross-field rule)', () => {
  const payload = { ...validCoderPlanResponsePayload(), outcome: 'blocked' };
  assert.deepStrictEqual(validateCoderPlanResponsePayload(payload), {
    outcome: 'blocked',
    summary: 'Addressed every plan finding.',
    blocker: '',
    responses: [
      {
        id: 'finding-1',
        decision: 'fixed',
        summary: 'Added the missing verification step.',
      },
    ],
  });
});

// --- validateCoderPlanPayload -------------------------------------------------

test('validateCoderPlanPayload rejects non-object payloads', () => {
  assert.throws(() => validateCoderPlanPayload([]), new Error('Planner plan round payload must be a non-null object.'));
});

test('validateCoderPlanPayload trims message, preserves planBody, and omits unknown properties', () => {
  const payload = { ...validCoderPlanPayload(), message: '  Plan drafted.  ', extra: 'x' };
  assert.deepStrictEqual(validateCoderPlanPayload(payload), {
    action: 'ready_for_review',
    message: 'Plan drafted.',
    executionShape: 'multi_scope',
    planBody: VALID_MULTI_SCOPE_PLAN_BODY,
    blockedReason: '',
  });
});

// Regression: a live run persisted a planner payload whose planBody was a
// refinement *summary* (declared multi_scope, no Execution Queue, no scopes)
// and spent a full reviewer round rediscovering that the document was
// invalid. The contract gate must throw inside the validator so the
// structured-output repair loop handles it instead.
test('validateCoderPlanPayload rejects a refinement-summary planBody that violates the plan contract', () => {
  const payload = {
    ...validCoderPlanPayload(),
    planBody: [
      '# Refined Plan — summary',
      '',
      '## Execution Shape',
      '',
      'executionShape: multi_scope',
      '',
      '## Defining decisions carried by the six scopes',
      '',
      'This is a planning round only: no runtime source was edited.',
    ].join('\n'),
  };
  assert.throws(
    () => validateCoderPlanPayload(payload),
    (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.match(error.message, /not a valid Neal plan document/);
      assert.match(error.message, /Execution Queue/);
      assert.match(error.message, /complete refined plan document, not a summary/);
      return true;
    },
  );
});

test('validateCoderPlanPayload normalizes a mismatched shape declaration before contract validation', () => {
  // The payload declares one_shot; the body's declaration line says
  // multi_scope. Normalization rewrites the declaration to the payload shape,
  // so the body is judged as a one_shot document (no queue required).
  const payload = {
    ...validCoderPlanPayload(),
    executionShape: 'one_shot',
    planBody: [
      '# Plan',
      '',
      '## Execution Shape',
      '',
      'executionShape: multi_scope',
      '',
      '## Objective',
      '',
      'Do one bounded thing.',
    ].join('\n'),
  };
  const validated = validateCoderPlanPayload(payload);
  assert.equal(validated.executionShape, 'one_shot');
});

test('validateCoderPlanPayload does not contract-validate planBody for blocked payloads', () => {
  const payload = {
    ...validCoderPlanPayload(),
    action: 'blocked',
    planBody: 'not a plan at all',
    blockedReason: 'The plan author must supply the pinned commit.',
  };
  const validated = validateCoderPlanPayload(payload);
  assert.equal(validated.action, 'blocked');
});

test('validateCoderPlanPayload rejects an invalid action', () => {
  const payload = { ...validCoderPlanPayload(), action: 'done' };
  assert.throws(
    () => validateCoderPlanPayload(payload),
    new Error('Planner plan round payload.action must be exactly one of: ready_for_review, blocked.'),
  );
});

test('validateCoderPlanPayload rejects an invalid executionShape', () => {
  const payload = { ...validCoderPlanPayload(), executionShape: 'single' };
  assert.throws(
    () => validateCoderPlanPayload(payload),
    new Error('Planner plan round payload.executionShape must be exactly one of: one_shot, multi_scope, multi_scope_unknown.'),
  );
});

test('validateCoderPlanPayload rejects a non-string message', () => {
  const payload = { ...validCoderPlanPayload(), message: true };
  assert.throws(() => validateCoderPlanPayload(payload), new Error('Planner plan round payload.message must be a string.'));
});

test('validateCoderPlanPayload surfaces a missing planBody as a string-type failure', () => {
  const payload: Record<string, unknown> = validCoderPlanPayload();
  delete payload.planBody;
  assert.throws(() => validateCoderPlanPayload(payload), new Error('Planner plan round payload.planBody must be a string.'));
});

test('validateCoderPlanPayload reports action before message', () => {
  const payload = { ...validCoderPlanPayload(), action: 'done', message: 5 };
  assert.throws(
    () => validateCoderPlanPayload(payload),
    new Error('Planner plan round payload.action must be exactly one of: ready_for_review, blocked.'),
  );
});

test('validateCoderPlanPayload rejects ready_for_review without a planBody', () => {
  const payload = { ...validCoderPlanPayload(), planBody: '   ' };
  assert.throws(
    () => validateCoderPlanPayload(payload),
    new Error('Planner plan round returned action=ready_for_review without a planBody payload.'),
  );
});

test('validateCoderPlanPayload rejects ready_for_review with a blockedReason', () => {
  const payload = { ...validCoderPlanPayload(), blockedReason: 'not blocked really' };
  assert.throws(
    () => validateCoderPlanPayload(payload),
    new Error('Planner plan round returned a blockedReason payload with action=ready_for_review.'),
  );
});

test('validateCoderPlanPayload rejects blocked without a blockedReason', () => {
  const payload = { ...validCoderPlanPayload(), action: 'blocked', blockedReason: '   ' };
  assert.throws(
    () => validateCoderPlanPayload(payload),
    new Error('Planner plan round returned action=blocked without a blockedReason payload.'),
  );
});

test('validateCoderPlanPayload reports the missing planBody before the extraneous blockedReason', () => {
  const payload = { ...validCoderPlanPayload(), planBody: '', blockedReason: 'reason' };
  assert.throws(
    () => validateCoderPlanPayload(payload),
    new Error('Planner plan round returned action=ready_for_review without a planBody payload.'),
  );
});

test('validateCoderPlanPayload accepts blocked with a blockedReason and a non-empty planBody', () => {
  const payload = {
    ...validCoderPlanPayload(),
    action: 'blocked',
    blockedReason: '  The repo facts are stale.  ',
  };
  assert.deepStrictEqual(validateCoderPlanPayload(payload), {
    action: 'blocked',
    message: 'Plan drafted.',
    executionShape: 'multi_scope',
    planBody: VALID_MULTI_SCOPE_PLAN_BODY,
    blockedReason: '  The repo facts are stale.  ',
  });
});

// --- validateCoderScopePayload --------------------------------------------------

test('validateCoderScopePayload rejects non-object payloads', () => {
  assert.throws(() => validateCoderScopePayload('x'), new Error('Coder scope round payload must be a non-null object.'));
});

test('validateCoderScopePayload trims message and progress and omits unknown properties', () => {
  const payload = {
    ...validCoderScopePayload(),
    message: '  Implemented the first slice.  ',
    progress: {
      milestoneTargeted: '  Slice one of the parser rework.  ',
      newEvidence: '  New tests cover the trailing-token path.  ',
      whyNotRedundant: '  No previous scope touched the parser loop.  ',
      nextStepUnlocked: '  Slice two can build on the shared tokenizer.  ',
      extra: 'dropped',
    },
    extra: 'dropped',
  };
  assert.deepStrictEqual(validateCoderScopePayload(payload), {
    action: 'continue',
    message: 'Implemented the first slice.',
    progress: {
      milestoneTargeted: 'Slice one of the parser rework.',
      newEvidence: 'New tests cover the trailing-token path.',
      whyNotRedundant: 'No previous scope touched the parser loop.',
      nextStepUnlocked: 'Slice two can build on the shared tokenizer.',
    },
    manualGate: null,
    derivedPlan: '',
    blockedReason: '',
  });
});

test('validateCoderScopePayload preserves whitespace-only derivedPlan and blockedReason in the output', () => {
  const payload = { ...validCoderScopePayload(), derivedPlan: '   ', blockedReason: '\t' };
  assert.deepStrictEqual(validateCoderScopePayload(payload), {
    action: 'continue',
    message: 'Implemented the first slice.',
    progress: validProgress(),
    manualGate: null,
    derivedPlan: '   ',
    blockedReason: '\t',
  });
});

test('validateCoderScopePayload surfaces a missing top-level message as a string-type failure', () => {
  const payload: Record<string, unknown> = validCoderScopePayload();
  delete payload.message;
  assert.throws(() => validateCoderScopePayload(payload), new Error('Coder scope round payload.message must be a string.'));
});

test('validateCoderScopePayload surfaces a missing top-level manualGate as a non-object failure', () => {
  // An absent manualGate is not the same as an explicit null: undefined fails
  // the null check and falls through to the object requirement.
  const payload: Record<string, unknown> = validCoderScopePayload();
  delete payload.manualGate;
  assert.throws(
    () => validateCoderScopePayload(payload),
    new Error('Coder scope round payload.manualGate must be a non-null object.'),
  );
});

test('validateCoderScopePayload rejects an invalid action', () => {
  const payload = { ...validCoderScopePayload(), action: 'pause' };
  assert.throws(
    () => validateCoderScopePayload(payload),
    new Error(
      'Coder scope round payload.action must be exactly one of: continue, scope_done, done, blocked, split_plan, manual_gate.',
    ),
  );
});

test('validateCoderScopePayload rejects a non-string message', () => {
  const payload = { ...validCoderScopePayload(), message: 0 };
  assert.throws(() => validateCoderScopePayload(payload), new Error('Coder scope round payload.message must be a string.'));
});

test('validateCoderScopePayload rejects a non-object progress', () => {
  const payload = { ...validCoderScopePayload(), progress: 'good' };
  assert.throws(
    () => validateCoderScopePayload(payload),
    new Error('Coder scope round payload.progress must be a non-null object.'),
  );
});

test('validateCoderScopePayload rejects a non-object non-null manualGate', () => {
  const payload = { ...validCoderScopePayload(), manualGate: 'gate' };
  assert.throws(
    () => validateCoderScopePayload(payload),
    new Error('Coder scope round payload.manualGate must be a non-null object.'),
  );
});

test('validateCoderScopePayload rejects a non-string derivedPlan', () => {
  const payload = { ...validCoderScopePayload(), derivedPlan: [] };
  assert.throws(
    () => validateCoderScopePayload(payload),
    new Error('Coder scope round payload.derivedPlan must be a string.'),
  );
});

test('validateCoderScopePayload rejects an empty progress field with the delimiter-protocol message', () => {
  const payload = { ...validCoderScopePayload(), progress: { ...validProgress(), milestoneTargeted: '   ' } };
  assert.throws(
    () => validateCoderScopePayload(payload),
    new Error('Coder scope round returned an empty or missing milestoneTargeted field in the progress-justification payload.'),
  );
});

test('validateCoderScopePayload rejects a missing progress field', () => {
  const progress: Record<string, unknown> = validProgress();
  delete progress.nextStepUnlocked;
  const payload = { ...validCoderScopePayload(), progress };
  assert.throws(
    () => validateCoderScopePayload(payload),
    new Error('Coder scope round returned an empty or missing nextStepUnlocked field in the progress-justification payload.'),
  );
});

test('validateCoderScopePayload reports action before message', () => {
  const payload = { ...validCoderScopePayload(), action: 'pause', message: 0 };
  assert.throws(
    () => validateCoderScopePayload(payload),
    new Error(
      'Coder scope round payload.action must be exactly one of: continue, scope_done, done, blocked, split_plan, manual_gate.',
    ),
  );
});

test('validateCoderScopePayload reports an empty progress field before the cross-field rules', () => {
  const payload = {
    ...validCoderScopePayload(),
    action: 'split_plan',
    derivedPlan: '',
    progress: { ...validProgress(), newEvidence: '' },
  };
  assert.throws(
    () => validateCoderScopePayload(payload),
    new Error('Coder scope round returned an empty or missing newEvidence field in the progress-justification payload.'),
  );
});

test('validateCoderScopePayload rejects split_plan without a derivedPlan', () => {
  const payload = { ...validCoderScopePayload(), action: 'split_plan', derivedPlan: '   ' };
  assert.throws(
    () => validateCoderScopePayload(payload),
    new Error('Coder scope round returned action=split_plan without a derivedPlan payload.'),
  );
});

test('validateCoderScopePayload rejects a derivedPlan without split_plan', () => {
  const payload = { ...validCoderScopePayload(), derivedPlan: '# Derived' };
  assert.throws(
    () => validateCoderScopePayload(payload),
    new Error('Coder scope round returned a derivedPlan payload without action=split_plan.'),
  );
});

test('validateCoderScopePayload rejects blocked without a blockedReason', () => {
  const payload = { ...validCoderScopePayload(), action: 'blocked', blockedReason: '   ' };
  assert.throws(
    () => validateCoderScopePayload(payload),
    new Error('Coder scope round returned action=blocked without a blockedReason payload.'),
  );
});

test('validateCoderScopePayload rejects a blockedReason without blocked', () => {
  const payload = { ...validCoderScopePayload(), blockedReason: 'stuck' };
  assert.throws(
    () => validateCoderScopePayload(payload),
    new Error('Coder scope round returned a blockedReason payload without action=blocked.'),
  );
});

test('validateCoderScopePayload accepts split_plan with a derivedPlan and preserves its whitespace', () => {
  const payload = { ...validCoderScopePayload(), action: 'split_plan', derivedPlan: '  # Derived plan  ' };
  assert.deepStrictEqual(validateCoderScopePayload(payload), {
    action: 'split_plan',
    message: 'Implemented the first slice.',
    progress: validProgress(),
    manualGate: null,
    derivedPlan: '  # Derived plan  ',
    blockedReason: '',
  });
});

test('validateCoderScopePayload accepts blocked with a blockedReason', () => {
  const payload = { ...validCoderScopePayload(), action: 'blocked', blockedReason: 'Missing credentials.' };
  assert.deepStrictEqual(validateCoderScopePayload(payload), {
    action: 'blocked',
    message: 'Implemented the first slice.',
    progress: validProgress(),
    manualGate: null,
    derivedPlan: '',
    blockedReason: 'Missing credentials.',
  });
});

test('validateCoderScopePayload rejects manual_gate without a manualGate payload', () => {
  const payload = { ...validCoderScopePayload(), action: 'manual_gate' };
  assert.throws(
    () => validateCoderScopePayload(payload),
    new Error('Coder scope round returned action=manual_gate without a manualGate payload.'),
  );
});

test('validateCoderScopePayload rejects manual_gate with a derivedPlan via the generic split_plan rule', () => {
  // The generic derivedPlan/split_plan pairing check runs before the
  // manual-gate-specific exclusion, so this is the message that fires today.
  const payload = { ...validCoderScopePayload(), action: 'manual_gate', manualGate: validManualGate(), derivedPlan: 'x' };
  assert.throws(
    () => validateCoderScopePayload(payload),
    new Error('Coder scope round returned a derivedPlan payload without action=split_plan.'),
  );
});

test('validateCoderScopePayload rejects manual_gate with a blockedReason via the generic blocked rule', () => {
  // Same ordering quirk as above: the generic blockedReason/blocked pairing
  // check fires before the manual-gate-specific exclusion.
  const payload = { ...validCoderScopePayload(), action: 'manual_gate', manualGate: validManualGate(), blockedReason: 'x' };
  assert.throws(
    () => validateCoderScopePayload(payload),
    new Error('Coder scope round returned a blockedReason payload without action=blocked.'),
  );
});

test('validateCoderScopePayload rejects a manualGate payload without action=manual_gate', () => {
  const payload = { ...validCoderScopePayload(), manualGate: validManualGate() };
  assert.throws(
    () => validateCoderScopePayload(payload),
    new Error('Coder scope round returned a manualGate payload without action=manual_gate.'),
  );
});

test('validateCoderScopePayload normalizes an accepted manual gate payload', () => {
  const payload = {
    ...validCoderScopePayload(),
    action: 'manual_gate',
    message: '  Waiting on operator.  ',
    manualGate: {
      id: '  gate-1  ',
      title: '  Rotate credentials  ',
      reason: '  Requires operator-held access.  ',
      instructionsMarkdown: '  Rotate the key, then rerun the check.  ',
      resumeChecks: [
        {
          type: 'command',
          name: '  key check  ',
          command: ['  git  ', 'status'],
          cwd: null,
          timeoutMs: null,
          extra: 'dropped',
        },
        { type: 'command', name: 'second', command: ['true'], cwd: 'repo', timeoutMs: 5000 },
      ],
      extra: 'dropped',
    },
  };
  assert.deepStrictEqual(validateCoderScopePayload(payload), {
    action: 'manual_gate',
    message: 'Waiting on operator.',
    progress: validProgress(),
    manualGate: {
      id: 'gate-1',
      title: 'Rotate credentials',
      reason: 'Requires operator-held access.',
      instructionsMarkdown: 'Rotate the key, then rerun the check.',
      resumeChecks: [
        { type: 'command', name: 'key check', command: ['git', 'status'] },
        { type: 'command', name: 'second', command: ['true'], cwd: 'repo', timeoutMs: 5000 },
      ],
    },
    derivedPlan: '',
    blockedReason: '',
  });
});

test('validateCoderScopePayload rejects an empty manualGate.id', () => {
  const payload = manualGatePayload({ id: '   ' });
  assert.throws(
    () => validateCoderScopePayload(payload),
    new Error('Coder scope round returned an empty or missing manualGate.id field.'),
  );
});

test('validateCoderScopePayload rejects a missing manualGate.title', () => {
  const gate: Record<string, unknown> = validManualGate();
  delete gate.title;
  const payload = { ...validCoderScopePayload(), action: 'manual_gate', manualGate: gate };
  assert.throws(
    () => validateCoderScopePayload(payload),
    new Error('Coder scope round returned an empty or missing manualGate.title field.'),
  );
});

test('validateCoderScopePayload rejects empty resumeChecks', () => {
  for (const resumeChecks of [[], 'checks']) {
    const payload = manualGatePayload({ resumeChecks: resumeChecks as never });
    assert.throws(
      () => validateCoderScopePayload(payload),
      new Error('Coder scope round returned manualGate.resumeChecks without at least one command check.'),
    );
  }
});

test('validateCoderScopePayload rejects a non-object resume check', () => {
  const payload = manualGatePayload({ resumeChecks: [null] as never });
  assert.throws(
    () => validateCoderScopePayload(payload),
    new Error('Coder scope round returned invalid manualGate.resumeChecks[0].'),
  );
});

test('validateCoderScopePayload rejects a resume check whose type is not command', () => {
  const payload = manualGatePayload({ resumeChecks: [{ ...validResumeCheck(), type: 'script' }] as never });
  assert.throws(
    () => validateCoderScopePayload(payload),
    new Error('Coder scope round returned manualGate.resumeChecks[0].type that is not "command".'),
  );
});

test('validateCoderScopePayload rejects a resume check without a command array', () => {
  const payload = manualGatePayload({ resumeChecks: [{ ...validResumeCheck(), command: [] }] as never });
  assert.throws(
    () => validateCoderScopePayload(payload),
    new Error('Coder scope round returned manualGate.resumeChecks[0].command without a non-empty string array.'),
  );
});

test('validateCoderScopePayload rejects an empty resume-check command part with the nested path', () => {
  const payload = manualGatePayload({ resumeChecks: [{ ...validResumeCheck(), command: ['git', '  '] }] as never });
  assert.throws(
    () => validateCoderScopePayload(payload),
    new Error('Coder scope round returned an empty or missing manualGate.resumeChecks[0].command[1] field.'),
  );
});

test('validateCoderScopePayload rejects an invalid resume-check cwd', () => {
  const payload = manualGatePayload({ resumeChecks: [{ ...validResumeCheck(), cwd: 'home' }] as never });
  assert.throws(
    () => validateCoderScopePayload(payload),
    new Error('Coder scope round returned manualGate.resumeChecks[0].cwd that is not "repo" or "run_dir".'),
  );
});

test('validateCoderScopePayload rejects an invalid resume-check timeoutMs', () => {
  for (const timeoutMs of [0, 1.5, '5000']) {
    const payload = manualGatePayload({ resumeChecks: [{ ...validResumeCheck(), timeoutMs }] as never });
    assert.throws(
      () => validateCoderScopePayload(payload),
      new Error('Coder scope round returned manualGate.resumeChecks[0].timeoutMs that is not a positive safe integer.'),
    );
  }
});

// --- validateCoderBlockedRecoveryDispositionPayload ---------------------------

const LATER_SCOPE_PLAN = `# Plan

## Execution Shape

executionShape: multi_scope

## Execution Queue

### Scope 1: First
- Goal: One.
- Verification: \`pnpm typecheck\`
- Success Condition: One done.

### Scope 2: Second
- Goal: Two.
- Verification: \`pnpm test\`
- Success Condition: Two done.
`;

const LATER_SCOPE_BODY = '### Scope 2: Second, narrowed\n- Goal: Half of two.\n- Verification: `pnpm test`\n- Success Condition: Half done.';

const LATER_SCOPE_CONTEXT = { allowLaterScopeRevision: true, currentScopeNumber: 1, planDocument: LATER_SCOPE_PLAN };

test('validateCoderBlockedRecoveryDispositionPayload rejects a later-scope revision without per-round context', () => {
  const payload = { ...validCoderBlockedRecoveryPayload(), laterScopeNumber: 2, laterScopeBody: LATER_SCOPE_BODY };
  assert.throws(
    () => validateCoderBlockedRecoveryDispositionPayload(payload),
    /A later-scope revision is not available for this round/,
  );
});

test('validateCoderBlockedRecoveryDispositionPayload rejects a later-scope revision when the round did not offer it', () => {
  const payload = { ...validCoderBlockedRecoveryPayload(), laterScopeNumber: 2, laterScopeBody: LATER_SCOPE_BODY };
  assert.throws(
    () =>
      validateCoderBlockedRecoveryDispositionPayload(payload, { ...LATER_SCOPE_CONTEXT, allowLaterScopeRevision: false }),
    /A later-scope revision is not available for this round/,
  );
});

test('validateCoderBlockedRecoveryDispositionPayload requires laterScopeNumber and laterScopeBody together', () => {
  assert.throws(
    () =>
      validateCoderBlockedRecoveryDispositionPayload(
        { ...validCoderBlockedRecoveryPayload(), laterScopeNumber: 2 },
        LATER_SCOPE_CONTEXT,
      ),
    /must be set together/,
  );
  assert.throws(
    () =>
      validateCoderBlockedRecoveryDispositionPayload(
        { ...validCoderBlockedRecoveryPayload(), laterScopeBody: LATER_SCOPE_BODY },
        LATER_SCOPE_CONTEXT,
      ),
    /must be set together/,
  );
});

test('validateCoderBlockedRecoveryDispositionPayload rejects a later-scope revision with replace_current_scope or terminal_block', () => {
  for (const action of ['replace_current_scope', 'terminal_block']) {
    const payload = {
      ...validCoderBlockedRecoveryPayload(),
      action,
      blocker: 'Blocked.',
      replacementPlan: action === 'replace_current_scope' ? '# Replacement' : '',
      laterScopeNumber: 2,
      laterScopeBody: LATER_SCOPE_BODY,
    };
    assert.throws(
      () => validateCoderBlockedRecoveryDispositionPayload(payload, LATER_SCOPE_CONTEXT),
      new RegExp(`may accompany only action=resume_current_scope or action=stay_blocked, not action=${action}`),
    );
  }
});

test('validateCoderBlockedRecoveryDispositionPayload runs the splice helper on a later-scope revision', () => {
  const badBody = { ...validCoderBlockedRecoveryPayload(), laterScopeNumber: 2, laterScopeBody: '### Scope 2: No bullets' };
  assert.throws(
    () => validateCoderBlockedRecoveryDispositionPayload(badBody, LATER_SCOPE_CONTEXT),
    /Revised plan does not validate/,
  );
  const wrongTarget = { ...validCoderBlockedRecoveryPayload(), laterScopeNumber: 1, laterScopeBody: '### Scope 1: Current' };
  assert.throws(
    () => validateCoderBlockedRecoveryDispositionPayload(wrongTarget, LATER_SCOPE_CONTEXT),
    /must be a later scope than the current scope 1/,
  );
});

test('validateCoderBlockedRecoveryDispositionPayload accepts a valid later-scope revision with resume_current_scope and stay_blocked', () => {
  for (const action of ['resume_current_scope', 'stay_blocked']) {
    const payload = {
      ...validCoderBlockedRecoveryPayload(),
      action,
      blocker: action === 'stay_blocked' ? 'Still need a decision.' : '',
      laterScopeNumber: 2,
      laterScopeBody: LATER_SCOPE_BODY,
    };
    assert.deepStrictEqual(validateCoderBlockedRecoveryDispositionPayload(payload, LATER_SCOPE_CONTEXT), payload);
  }
});


test('validateCoderBlockedRecoveryDispositionPayload rejects non-object payloads', () => {
  assert.throws(
    () => validateCoderBlockedRecoveryDispositionPayload(7),
    new Error('Coder blocked-recovery payload must be a non-null object.'),
  );
});

test('validateCoderBlockedRecoveryDispositionPayload accepts unknown properties and preserves strings untrimmed', () => {
  const payload = {
    ...validCoderBlockedRecoveryPayload(),
    summary: '  The blocker was a misunderstanding.  ',
    extra: 'dropped',
  };
  assert.deepStrictEqual(validateCoderBlockedRecoveryDispositionPayload(payload), {
    action: 'resume_current_scope',
    summary: '  The blocker was a misunderstanding.  ',
    rationale: 'The referenced file exists under a different name.',
    blocker: '',
    replacementPlan: '',
    laterScopeNumber: 0,
    laterScopeBody: '',
  });
});

test('validateCoderBlockedRecoveryDispositionPayload rejects an invalid action', () => {
  const payload = { ...validCoderBlockedRecoveryPayload(), action: 'retry' };
  assert.throws(
    () => validateCoderBlockedRecoveryDispositionPayload(payload),
    new Error(
      'Coder blocked-recovery payload.action must be exactly one of: resume_current_scope, replace_current_scope, stay_blocked, terminal_block.',
    ),
  );
});

test('validateCoderBlockedRecoveryDispositionPayload rejects a non-string rationale', () => {
  const payload = { ...validCoderBlockedRecoveryPayload(), rationale: 11 };
  assert.throws(
    () => validateCoderBlockedRecoveryDispositionPayload(payload),
    new Error('Coder blocked-recovery payload.rationale must be a string.'),
  );
});

test('validateCoderBlockedRecoveryDispositionPayload surfaces a missing replacementPlan as a string-type failure', () => {
  const payload: Record<string, unknown> = validCoderBlockedRecoveryPayload();
  delete payload.replacementPlan;
  assert.throws(
    () => validateCoderBlockedRecoveryDispositionPayload(payload),
    new Error('Coder blocked-recovery payload.replacementPlan must be a string.'),
  );
});

test('validateCoderBlockedRecoveryDispositionPayload reports action before summary', () => {
  const payload = { ...validCoderBlockedRecoveryPayload(), action: 'retry', summary: 4 };
  assert.throws(
    () => validateCoderBlockedRecoveryDispositionPayload(payload),
    new Error(
      'Coder blocked-recovery payload.action must be exactly one of: resume_current_scope, replace_current_scope, stay_blocked, terminal_block.',
    ),
  );
});

test('validateCoderBlockedRecoveryDispositionPayload rejects replace_current_scope without a replacementPlan', () => {
  const payload = { ...validCoderBlockedRecoveryPayload(), action: 'replace_current_scope', replacementPlan: '   ' };
  assert.throws(
    () => validateCoderBlockedRecoveryDispositionPayload(payload),
    new Error('Coder blocked-recovery round returned action=replace_current_scope without a replacementPlan payload.'),
  );
});

test('validateCoderBlockedRecoveryDispositionPayload rejects a replacementPlan without replace_current_scope', () => {
  const payload = { ...validCoderBlockedRecoveryPayload(), replacementPlan: '# Replacement' };
  assert.throws(
    () => validateCoderBlockedRecoveryDispositionPayload(payload),
    new Error('Coder blocked-recovery round returned a replacementPlan payload without action=replace_current_scope.'),
  );
});

test('validateCoderBlockedRecoveryDispositionPayload rejects stay_blocked without a blocker', () => {
  const payload = { ...validCoderBlockedRecoveryPayload(), action: 'stay_blocked', blocker: '   ' };
  assert.throws(
    () => validateCoderBlockedRecoveryDispositionPayload(payload),
    new Error('Coder blocked-recovery round returned action=stay_blocked without a blocker payload.'),
  );
});

test('validateCoderBlockedRecoveryDispositionPayload rejects terminal_block without a blocker', () => {
  const payload = { ...validCoderBlockedRecoveryPayload(), action: 'terminal_block', blocker: '' };
  assert.throws(
    () => validateCoderBlockedRecoveryDispositionPayload(payload),
    new Error('Coder blocked-recovery round returned action=terminal_block without a blocker payload.'),
  );
});

test('validateCoderBlockedRecoveryDispositionPayload accepts replace_current_scope with a replacementPlan untrimmed', () => {
  const payload = {
    ...validCoderBlockedRecoveryPayload(),
    action: 'replace_current_scope',
    replacementPlan: '  # Replacement plan  ',
    laterScopeNumber: 0,
    laterScopeBody: '',
  };
  assert.deepStrictEqual(validateCoderBlockedRecoveryDispositionPayload(payload), {
    action: 'replace_current_scope',
    summary: 'The blocker was a misunderstanding.',
    rationale: 'The referenced file exists under a different name.',
    blocker: '',
    replacementPlan: '  # Replacement plan  ',
    laterScopeNumber: 0,
    laterScopeBody: '',
  });
});

test('validateCoderBlockedRecoveryDispositionPayload accepts stay_blocked with a blocker', () => {
  const payload = { ...validCoderBlockedRecoveryPayload(), action: 'stay_blocked', blocker: 'Still waiting on access.' };
  assert.deepStrictEqual(validateCoderBlockedRecoveryDispositionPayload(payload), {
    action: 'stay_blocked',
    summary: 'The blocker was a misunderstanding.',
    rationale: 'The referenced file exists under a different name.',
    blocker: 'Still waiting on access.',
    replacementPlan: '',
    laterScopeNumber: 0,
    laterScopeBody: '',
  });
});

// --- parseExecuteScopeProgressPayload / stripExecuteScopeProgressPayload ------

test('parseExecuteScopeProgressPayload trims fields and omits unknown properties', () => {
  const raw = progressRaw({
    milestoneTargeted: '  M1  ',
    newEvidence: '  E1  ',
    whyNotRedundant: '  W1  ',
    nextStepUnlocked: '  N1  ',
    extra: 'dropped',
  });
  assert.deepStrictEqual(parseExecuteScopeProgressPayload(raw), {
    milestoneTargeted: 'M1',
    newEvidence: 'E1',
    whyNotRedundant: 'W1',
    nextStepUnlocked: 'N1',
  });
});

test('parseExecuteScopeProgressPayload rejects a missing start marker', () => {
  assert.throws(
    () => parseExecuteScopeProgressPayload('No markers here.'),
    new Error('Coder scope round did not include the required progress-justification payload start marker.'),
  );
});

test('parseExecuteScopeProgressPayload rejects multiple start markers', () => {
  const raw = `${progressRaw(validProgress())}\n${EXECUTE_SCOPE_PROGRESS_PAYLOAD_START}`;
  assert.throws(
    () => parseExecuteScopeProgressPayload(raw),
    new Error('Coder scope round included multiple progress-justification payload start markers.'),
  );
});

test('parseExecuteScopeProgressPayload rejects a missing end marker', () => {
  const raw = `${EXECUTE_SCOPE_PROGRESS_PAYLOAD_START}\n{}`;
  assert.throws(
    () => parseExecuteScopeProgressPayload(raw),
    new Error('Coder scope round did not include the required progress-justification payload end marker.'),
  );
});

test('parseExecuteScopeProgressPayload rejects multiple end markers', () => {
  const raw = `${progressRaw(validProgress())}\n${EXECUTE_SCOPE_PROGRESS_PAYLOAD_END}`;
  assert.throws(
    () => parseExecuteScopeProgressPayload(raw),
    new Error('Coder scope round included multiple progress-justification payload end markers.'),
  );
});

test('parseExecuteScopeProgressPayload rejects an empty delimited payload', () => {
  const raw = `${EXECUTE_SCOPE_PROGRESS_PAYLOAD_START}\n   \n${EXECUTE_SCOPE_PROGRESS_PAYLOAD_END}`;
  assert.throws(
    () => parseExecuteScopeProgressPayload(raw),
    new Error('Coder scope round returned an empty progress-justification payload.'),
  );
});

test('parseExecuteScopeProgressPayload wraps JSON parse failures with the raw payload', () => {
  // The embedded fragment is JSON.parse's own message (pinned here as emitted
  // by the current runtime), wrapped in the parser's label and raw-echo frame.
  const raw = `${EXECUTE_SCOPE_PROGRESS_PAYLOAD_START}\nnot-json\n${EXECUTE_SCOPE_PROGRESS_PAYLOAD_END}`;
  assert.throws(
    () => parseExecuteScopeProgressPayload(raw),
    new Error(
      'Coder scope round progress-justification payload returned invalid JSON: ' +
        'Unexpected token \'o\', "not-json" is not valid JSON\nRaw response:\nnot-json',
    ),
  );
});

test('parseExecuteScopeProgressPayload rejects an empty progress field', () => {
  const raw = progressRaw({ ...validProgress(), whyNotRedundant: '   ' });
  assert.throws(
    () => parseExecuteScopeProgressPayload(raw),
    new Error('Coder scope round returned an empty or missing whyNotRedundant field in the progress-justification payload.'),
  );
});

test('parseExecuteScopeProgressPayload rejects an absent progress field', () => {
  const progress: Record<string, unknown> = validProgress();
  delete progress.newEvidence;
  assert.throws(
    () => parseExecuteScopeProgressPayload(progressRaw(progress)),
    new Error('Coder scope round returned an empty or missing newEvidence field in the progress-justification payload.'),
  );
});

test('parseExecuteScopeProgressPayload rejects a wrong-typed progress field', () => {
  const raw = progressRaw({ ...validProgress(), milestoneTargeted: 42 });
  assert.throws(
    () => parseExecuteScopeProgressPayload(raw),
    new Error('Coder scope round returned an empty or missing milestoneTargeted field in the progress-justification payload.'),
  );
});

test('parseExecuteScopeProgressPayload treats non-object JSON payloads as missing fields', () => {
  for (const payload of ['just text', [], 7, true]) {
    assert.throws(
      () => parseExecuteScopeProgressPayload(progressRaw(payload)),
      new Error('Coder scope round returned an empty or missing milestoneTargeted field in the progress-justification payload.'),
    );
  }
});

test('parseExecuteScopeProgressPayload throws a bare TypeError for a JSON null payload', () => {
  // Characterization: a delimited `null` payload parses to JSON null and the
  // subsequent field access itself throws a bare TypeError (the current
  // runtime's property-access message) rather than a protocol error message.
  assert.throws(
    () => parseExecuteScopeProgressPayload(progressRaw(null)),
    new TypeError("Cannot read properties of null (reading 'milestoneTargeted')"),
  );
});

test('parseExecuteScopeProgressPayload reports milestoneTargeted first when multiple fields are defective', () => {
  const raw = progressRaw({ ...validProgress(), milestoneTargeted: '', newEvidence: '   ' });
  assert.throws(
    () => parseExecuteScopeProgressPayload(raw),
    new Error('Coder scope round returned an empty or missing milestoneTargeted field in the progress-justification payload.'),
  );
});

test('parseExecuteScopeProgressPayload reports duplicate start markers before the missing end marker', () => {
  const raw = `${EXECUTE_SCOPE_PROGRESS_PAYLOAD_START}\n{}\n${EXECUTE_SCOPE_PROGRESS_PAYLOAD_START}`;
  assert.throws(
    () => parseExecuteScopeProgressPayload(raw),
    new Error('Coder scope round included multiple progress-justification payload start markers.'),
  );
});

test('stripExecuteScopeProgressPayload joins surrounding prose with a blank line', () => {
  assert.strictEqual(stripExecuteScopeProgressPayload(progressRaw(validProgress())), 'Some prose before.\n\nProse after.');
});

test('stripExecuteScopeProgressPayload returns only the surviving side when one side is empty', () => {
  assert.strictEqual(stripExecuteScopeProgressPayload(progressRaw(validProgress(), '', 'Prose after.')), 'Prose after.');
  assert.strictEqual(stripExecuteScopeProgressPayload(progressRaw(validProgress(), 'Some prose before.', '')), 'Some prose before.');
});

// --- parseFinalCompletionSummaryPayload ----------------------------------------

test('parseFinalCompletionSummaryPayload rejects non-object payloads', () => {
  assert.throws(
    () => parseFinalCompletionSummaryPayload(null),
    new Error('Final completion summary payload must be a non-null object.'),
  );
});

test('parseFinalCompletionSummaryPayload trims fields, filters empty gaps, and omits unknown properties', () => {
  const payload = {
    planGoalSatisfied: true,
    whatChangedOverall: '  Reworked the parser.  ',
    verificationSummary: '  pnpm test passes.  ',
    remainingKnownGaps: ['   ', ''],
    extra: 'dropped',
  };
  assert.deepStrictEqual(parseFinalCompletionSummaryPayload(payload), {
    planGoalSatisfied: true,
    whatChangedOverall: 'Reworked the parser.',
    verificationSummary: 'pnpm test passes.',
    remainingKnownGaps: [],
  });
});

test('parseFinalCompletionSummaryPayload trims and filters remainingKnownGaps entries', () => {
  const payload = {
    ...validFinalCompletionSummaryPayload(),
    planGoalSatisfied: false,
    remainingKnownGaps: ['  gap one  ', ' ', 'gap two'],
  };
  assert.deepStrictEqual(parseFinalCompletionSummaryPayload(payload), {
    planGoalSatisfied: false,
    whatChangedOverall: 'Reworked the parser and covered it with tests.',
    verificationSummary: 'pnpm test passes with the new coverage.',
    remainingKnownGaps: ['gap one', 'gap two'],
  });
});

test('parseFinalCompletionSummaryPayload surfaces a missing verificationSummary as a string-type failure', () => {
  const payload: Record<string, unknown> = validFinalCompletionSummaryPayload();
  delete payload.verificationSummary;
  assert.throws(
    () => parseFinalCompletionSummaryPayload(payload),
    new Error('Final completion summary payload.verificationSummary must be a string.'),
  );
});

test('parseFinalCompletionSummaryPayload rejects a non-boolean planGoalSatisfied', () => {
  const payload = { ...validFinalCompletionSummaryPayload(), planGoalSatisfied: 'yes' };
  assert.throws(
    () => parseFinalCompletionSummaryPayload(payload),
    new Error('Final completion summary payload.planGoalSatisfied must be a boolean.'),
  );
});

test('parseFinalCompletionSummaryPayload rejects a non-string whatChangedOverall', () => {
  const payload = { ...validFinalCompletionSummaryPayload(), whatChangedOverall: 3 };
  assert.throws(
    () => parseFinalCompletionSummaryPayload(payload),
    new Error('Final completion summary payload.whatChangedOverall must be a string.'),
  );
});

test('parseFinalCompletionSummaryPayload rejects non-array remainingKnownGaps', () => {
  const payload = { ...validFinalCompletionSummaryPayload(), remainingKnownGaps: 'none' };
  assert.throws(
    () => parseFinalCompletionSummaryPayload(payload),
    new Error('Final completion summary payload.remainingKnownGaps must be an array.'),
  );
});

test('parseFinalCompletionSummaryPayload rejects a non-string gap entry with the index', () => {
  const payload = { ...validFinalCompletionSummaryPayload(), planGoalSatisfied: false, remainingKnownGaps: ['gap', 1] };
  assert.throws(
    () => parseFinalCompletionSummaryPayload(payload),
    new Error('Final completion summary payload.remainingKnownGaps[1] must be a string.'),
  );
});

test('parseFinalCompletionSummaryPayload reports planGoalSatisfied before whatChangedOverall', () => {
  const payload = { ...validFinalCompletionSummaryPayload(), planGoalSatisfied: 'yes', whatChangedOverall: 3 };
  assert.throws(
    () => parseFinalCompletionSummaryPayload(payload),
    new Error('Final completion summary payload.planGoalSatisfied must be a boolean.'),
  );
});

test('parseFinalCompletionSummaryPayload rejects an empty whatChangedOverall', () => {
  const payload = { ...validFinalCompletionSummaryPayload(), whatChangedOverall: '   ' };
  assert.throws(
    () => parseFinalCompletionSummaryPayload(payload),
    new Error('Final completion summary returned an empty whatChangedOverall field.'),
  );
});

test('parseFinalCompletionSummaryPayload rejects an empty verificationSummary', () => {
  const payload = { ...validFinalCompletionSummaryPayload(), verificationSummary: '   ' };
  assert.throws(
    () => parseFinalCompletionSummaryPayload(payload),
    new Error('Final completion summary returned an empty verificationSummary field.'),
  );
});

test('parseFinalCompletionSummaryPayload reports an empty whatChangedOverall before the gap pairing rules', () => {
  const payload = {
    ...validFinalCompletionSummaryPayload(),
    whatChangedOverall: '   ',
    remainingKnownGaps: ['gap'],
  };
  assert.throws(
    () => parseFinalCompletionSummaryPayload(payload),
    new Error('Final completion summary returned an empty whatChangedOverall field.'),
  );
});

test('parseFinalCompletionSummaryPayload rejects planGoalSatisfied=true with remaining gaps', () => {
  const payload = { ...validFinalCompletionSummaryPayload(), remainingKnownGaps: ['docs are stale'] };
  assert.throws(
    () => parseFinalCompletionSummaryPayload(payload),
    new Error('Final completion summary cannot set planGoalSatisfied=true while remainingKnownGaps is non-empty.'),
  );
});

test('parseFinalCompletionSummaryPayload rejects planGoalSatisfied=false when gaps filter to empty', () => {
  const payload = { ...validFinalCompletionSummaryPayload(), planGoalSatisfied: false, remainingKnownGaps: ['   '] };
  assert.throws(
    () => parseFinalCompletionSummaryPayload(payload),
    new Error('Final completion summary cannot set planGoalSatisfied=false with an empty remainingKnownGaps array.'),
  );
});

// --- parseFinalCompletionReviewerPayload ----------------------------------------

test('parseFinalCompletionReviewerPayload rejects non-object payloads', () => {
  assert.throws(
    () => parseFinalCompletionReviewerPayload(undefined),
    new Error('Final completion reviewer verdict payload must be a non-null object.'),
  );
});

test('parseFinalCompletionReviewerPayload trims fields, defaults squashCommitMessage, and omits unknown properties', () => {
  const payload: Record<string, unknown> = {
    action: 'accept_complete',
    summary: '  All plan work landed.  ',
    rationale: '  Every scope is verified by the suite.  ',
    missingWork: null,
    extra: 'dropped',
  };
  assert.deepStrictEqual(parseFinalCompletionReviewerPayload(payload), {
    action: 'accept_complete',
    summary: 'All plan work landed.',
    rationale: 'Every scope is verified by the suite.',
    missingWork: null,
    squashCommitMessage: null,
  });
});

test('parseFinalCompletionReviewerPayload rejects an invalid action', () => {
  const payload = { ...validFinalCompletionReviewerPayload(), action: 'approve' };
  assert.throws(
    () => parseFinalCompletionReviewerPayload(payload),
    new Error(
      'Final completion reviewer verdict payload.action must be exactly one of: accept_complete, continue_execution, block_for_operator.',
    ),
  );
});

test('parseFinalCompletionReviewerPayload rejects an absent missingWork as a non-object failure', () => {
  const payload: Record<string, unknown> = validFinalCompletionReviewerPayload();
  delete payload.missingWork;
  assert.throws(
    () => parseFinalCompletionReviewerPayload(payload),
    new Error('Final completion reviewer verdict payload.missingWork must be a non-null object.'),
  );
});

test('parseFinalCompletionReviewerPayload rejects a non-string summary', () => {
  const payload = { ...validFinalCompletionReviewerPayload(), summary: 5 };
  assert.throws(
    () => parseFinalCompletionReviewerPayload(payload),
    new Error('Final completion reviewer verdict payload.summary must be a string.'),
  );
});

test('parseFinalCompletionReviewerPayload rejects a non-string nested missingWork field', () => {
  const payload = {
    ...validFinalCompletionReviewerPayload(),
    action: 'continue_execution',
    missingWork: { summary: 'left', requiredOutcome: 2, verification: 'check' },
  };
  assert.throws(
    () => parseFinalCompletionReviewerPayload(payload),
    new Error('Final completion reviewer verdict payload.missingWork.requiredOutcome must be a string.'),
  );
});

test('parseFinalCompletionReviewerPayload surfaces an absent nested missingWork property as a string-type failure', () => {
  const payload = {
    ...validFinalCompletionReviewerPayload(),
    action: 'continue_execution',
    missingWork: { summary: 'Docs remain stale.', requiredOutcome: 'Docs describe the new flag.' },
  };
  assert.throws(
    () => parseFinalCompletionReviewerPayload(payload),
    new Error('Final completion reviewer verdict payload.missingWork.verification must be a string.'),
  );
});

test('parseFinalCompletionReviewerPayload rejects a non-object squashCommitMessage', () => {
  const payload = { ...validFinalCompletionReviewerPayload(), squashCommitMessage: 'subject' };
  assert.throws(
    () => parseFinalCompletionReviewerPayload(payload),
    new Error('Final completion reviewer verdict payload.squashCommitMessage must be a non-null object.'),
  );
});

test('parseFinalCompletionReviewerPayload reports missingWork objectness before the summary type', () => {
  const payload = { ...validFinalCompletionReviewerPayload(), missingWork: 'nope', summary: 42 };
  assert.throws(
    () => parseFinalCompletionReviewerPayload(payload),
    new Error('Final completion reviewer verdict payload.missingWork must be a non-null object.'),
  );
});

test('parseFinalCompletionReviewerPayload rejects an empty summary', () => {
  const payload = { ...validFinalCompletionReviewerPayload(), summary: '   ' };
  assert.throws(
    () => parseFinalCompletionReviewerPayload(payload),
    new Error('Final completion reviewer verdict returned an empty summary field.'),
  );
});

test('parseFinalCompletionReviewerPayload rejects an empty rationale', () => {
  const payload = { ...validFinalCompletionReviewerPayload(), rationale: '' };
  assert.throws(
    () => parseFinalCompletionReviewerPayload(payload),
    new Error('Final completion reviewer verdict returned an empty rationale field.'),
  );
});

test('parseFinalCompletionReviewerPayload rejects continue_execution without missingWork', () => {
  const payload = { ...validFinalCompletionReviewerPayload(), action: 'continue_execution' };
  assert.throws(
    () => parseFinalCompletionReviewerPayload(payload),
    new Error('Final completion reviewer verdict must include a non-empty missingWork payload when action=continue_execution.'),
  );
});

test('parseFinalCompletionReviewerPayload rejects continue_execution with a whitespace-only missingWork field', () => {
  const payload = {
    ...validFinalCompletionReviewerPayload(),
    action: 'continue_execution',
    missingWork: { summary: 'left', requiredOutcome: 'done', verification: '   ' },
  };
  assert.throws(
    () => parseFinalCompletionReviewerPayload(payload),
    new Error('Final completion reviewer verdict must include a non-empty missingWork payload when action=continue_execution.'),
  );
});

test('parseFinalCompletionReviewerPayload rejects accept_complete with missingWork', () => {
  const payload = {
    ...validFinalCompletionReviewerPayload(),
    missingWork: { summary: 'left', requiredOutcome: 'done', verification: 'check' },
  };
  assert.throws(
    () => parseFinalCompletionReviewerPayload(payload),
    new Error('Final completion reviewer verdict cannot include missingWork when action=accept_complete.'),
  );
});

test('parseFinalCompletionReviewerPayload rejects block_for_operator with missingWork', () => {
  const payload = {
    ...validFinalCompletionReviewerPayload(),
    action: 'block_for_operator',
    missingWork: { summary: 'left', requiredOutcome: 'done', verification: 'check' },
  };
  assert.throws(
    () => parseFinalCompletionReviewerPayload(payload),
    new Error('Final completion reviewer verdict cannot include missingWork when action=block_for_operator.'),
  );
});

test('parseFinalCompletionReviewerPayload trims missingWork and nulls squashCommitMessage for continue_execution', () => {
  const payload = {
    ...validFinalCompletionReviewerPayload(),
    action: 'continue_execution',
    missingWork: {
      summary: '  Docs remain stale.  ',
      requiredOutcome: '  Docs describe the new flag.  ',
      verification: '  Docs build cleanly.  ',
      extra: 'dropped',
    },
    squashCommitMessage: {
      subject: 'Persist semantic commit drafts',
      bullets: ['Store squash summaries in completion state.', 'Render the accepted draft in artifacts.'],
    },
  };
  assert.deepStrictEqual(parseFinalCompletionReviewerPayload(payload), {
    action: 'continue_execution',
    summary: 'All plan work landed.',
    rationale: 'Every scope is verified by the suite.',
    missingWork: {
      summary: 'Docs remain stale.',
      requiredOutcome: 'Docs describe the new flag.',
      verification: 'Docs build cleanly.',
    },
    squashCommitMessage: null,
  });
});

test('parseFinalCompletionReviewerPayload validates an accept_complete squash draft', () => {
  const payload = {
    ...validFinalCompletionReviewerPayload(),
    squashCommitMessage: {
      subject: '  Scope 3: Persist semantic commit drafts  ',
      bullets: [
        '- Store project-facing squash summaries in completion state.',
        '2. Render the accepted draft in final completion artifacts.',
      ],
    },
  };
  assert.deepStrictEqual(parseFinalCompletionReviewerPayload(payload), {
    action: 'accept_complete',
    summary: 'All plan work landed.',
    rationale: 'Every scope is verified by the suite.',
    missingWork: null,
    squashCommitMessage: {
      subject: 'Persist semantic commit drafts',
      bullets: [
        'Store project-facing squash summaries in completion state.',
        'Render the accepted draft in final completion artifacts.',
      ],
    },
  });
});

test('parseFinalCompletionReviewerPayload repairs an invalid squash draft instead of rejecting it', () => {
  // A duplicated bullet fails validateReviewerSquashMessageDraft; the repair
  // path dedupes it and keeps the remaining unique bullets. Unlike the plain
  // validation path, the repair normalizer also strips trailing punctuation
  // from each line.
  const payload = {
    ...validFinalCompletionReviewerPayload(),
    squashCommitMessage: {
      subject: 'Persist semantic commit drafts',
      bullets: [
        'Store squash summaries in completion state.',
        'Store squash summaries in completion state.',
        'Render the accepted draft in artifacts.',
      ],
    },
  };
  assert.deepStrictEqual(parseFinalCompletionReviewerPayload(payload), {
    action: 'accept_complete',
    summary: 'All plan work landed.',
    rationale: 'Every scope is verified by the suite.',
    missingWork: null,
    squashCommitMessage: {
      subject: 'Persist semantic commit drafts',
      bullets: ['Store squash summaries in completion state', 'Render the accepted draft in artifacts'],
    },
  });
});

test('parseFinalCompletionReviewerPayload nulls malformed squash draft shapes instead of throwing', () => {
  // Nested squash-draft shape defects (non-array bullets, non-string subject,
  // absent fields, non-string bullet entries) fail validation, fail repair,
  // and land as squashCommitMessage: null — the verdict is still accepted.
  const malformedDrafts: unknown[] = [
    { subject: 'Persist semantic commit drafts', bullets: 'not-an-array' },
    { subject: 42, bullets: ['Store squash summaries in completion state.', 'Render the accepted draft in artifacts.'] },
    { bullets: ['Store squash summaries in completion state.', 'Render the accepted draft in artifacts.'] },
    { subject: 'Persist semantic commit drafts' },
    { subject: 'Persist semantic commit drafts', bullets: ['Store squash summaries in completion state.', 17] },
    {},
  ];
  for (const squashCommitMessage of malformedDrafts) {
    const payload = { ...validFinalCompletionReviewerPayload(), squashCommitMessage };
    assert.deepStrictEqual(parseFinalCompletionReviewerPayload(payload), {
      action: 'accept_complete',
      summary: 'All plan work landed.',
      rationale: 'Every scope is verified by the suite.',
      missingWork: null,
      squashCommitMessage: null,
    });
  }
});

test('parseFinalCompletionReviewerPayload nulls an unrepairable squash draft', () => {
  // A single-bullet draft fails validation and cannot be repaired to the
  // two-bullet minimum, so the verdict falls back to squashCommitMessage null.
  const payload = {
    ...validFinalCompletionReviewerPayload(),
    squashCommitMessage: {
      subject: 'Persist semantic commit drafts',
      bullets: ['Store squash summaries in completion state.'],
    },
  };
  assert.deepStrictEqual(parseFinalCompletionReviewerPayload(payload), {
    action: 'accept_complete',
    summary: 'All plan work landed.',
    rationale: 'Every scope is verified by the suite.',
    missingWork: null,
    squashCommitMessage: null,
  });
});
