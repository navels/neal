import { NealProviderError, type ProviderEventSink, type ProviderId, type ProviderRole, type StructuredJsonProtocolSpec } from '../providers/types.js';

export type StructuredJsonSource = 'neal-json-block' | 'raw-json';

export type StructuredJsonExtractionErrorKind =
  | 'missing_control_block'
  | 'multiple_control_blocks'
  | 'non_final_control_block'
  | 'malformed_json';

export type StructuredJsonValidationErrorKind = StructuredJsonExtractionErrorKind | 'schema_invalid';

export type StructuredJsonExtractionSuccess = {
  ok: true;
  source: StructuredJsonSource;
  prose: string;
  rawJson: string;
  payload: unknown;
};

export type StructuredJsonExtractionFailure = {
  ok: false;
  errorKind: StructuredJsonExtractionErrorKind;
  errorSummary: string;
  prose: string;
  rawJson: string | null;
};

export type StructuredJsonExtractionResult = StructuredJsonExtractionSuccess | StructuredJsonExtractionFailure;

export type StructuredJsonValidationSuccess<TStructured> = StructuredJsonExtractionSuccess & {
  structured: TStructured;
};

export type StructuredJsonValidationFailure = {
  ok: false;
  phase: 'extraction' | 'validation';
  errorKind: StructuredJsonValidationErrorKind;
  errorSummary: string;
  extraction: StructuredJsonExtractionResult;
};

export type StructuredJsonValidationResult<TStructured> =
  | StructuredJsonValidationSuccess<TStructured>
  | StructuredJsonValidationFailure;

export type StructuredJsonRepairCallArgs = {
  prompt: string;
  attemptNumber: number;
  attemptLimit: number;
};

export type StructuredJsonRepairCallResult = string | {
  assistantText: string;
  sessionHandle?: string | null;
};

export type StructuredJsonRepairAttempt<TStructured> = {
  attemptNumber: number;
  sessionHandle: string | null;
  result: StructuredJsonValidationResult<TStructured>;
};

export type StructuredJsonRepairLoopSuccess<TStructured> = {
  ok: true;
  attemptNumber: number;
  sessionHandle: string | null;
  result: StructuredJsonValidationSuccess<TStructured>;
  attempts: StructuredJsonRepairAttempt<TStructured>[];
};

export type StructuredJsonRepairLoopFailure<TStructured> = {
  ok: false;
  attempts: StructuredJsonRepairAttempt<TStructured>[];
  lastFailure: StructuredJsonValidationFailure;
};

export type StructuredJsonRepairLoopResult<TStructured> =
  | StructuredJsonRepairLoopSuccess<TStructured>
  | StructuredJsonRepairLoopFailure<TStructured>;

export type BuildStructuredJsonRepairPromptArgs = {
  originalAssistantText: string;
  invalidJson?: string | null;
  extractionErrorSummary?: string | null;
  validationErrorSummary?: string | null;
  schemaLabel: string;
  schema: Record<string, unknown> | string;
  attemptNumber: number;
  attemptLimit: number;
};

export type RunStructuredJsonRepairLoopArgs<TStructured> = {
  originalAssistantText: string;
  initialFailure: StructuredJsonValidationFailure;
  schemaLabel: string;
  schema: Record<string, unknown> | string;
  attemptLimit: number;
  validator: (payload: unknown) => TStructured;
  callRepair: (args: StructuredJsonRepairCallArgs) => Promise<StructuredJsonRepairCallResult>;
};

export type StructuredJsonProtocolTurnResult = {
  assistantText: string;
  sessionHandle: string | null;
};

export type RunStructuredJsonProtocolArgs<TStructured> = {
  provider: ProviderId;
  role: ProviderRole;
  label: string;
  protocol: StructuredJsonProtocolSpec<TStructured>;
  prompt: string;
  events?: ProviderEventSink;
  initialSessionHandle?: string | null;
  runInitial: (prompt: string) => Promise<StructuredJsonProtocolTurnResult>;
  runRepair: (prompt: string, attemptNumber: number) => Promise<StructuredJsonProtocolTurnResult>;
  createProviderError?: (args: {
    message: string;
    kind: 'structured_output_missing' | 'structured_output_invalid';
    sessionHandle: string | null;
    cause: unknown;
  }) => Error;
};

export type RunStructuredJsonProtocolResult<TStructured> = {
  sessionHandle: string | null;
  structured: TStructured;
};

type NealJsonBlock = {
  start: number;
  end: number;
  rawJson: string;
};

const SUMMARY_MAX_LENGTH = 800;
const ORIGINAL_RESPONSE_MAX_LENGTH = 12000;
const NEAL_JSON_OPENING_FENCE_PATTERN = /^[ \t]*```[ \t]*neal-json[ \t]*$/;
const CLOSING_FENCE_PATTERN = /^[ \t]*```[ \t]*$/;

export function buildStructuredJsonPrompt(
  basePrompt: string,
  protocol: StructuredJsonProtocolSpec<unknown>,
) {
  const schemaDescription = typeof protocol.schema === 'string' ? protocol.schema : JSON.stringify(protocol.schema, null, 2);
  const allowProseBeforeBlock = protocol.allowProseBeforeBlock ?? true;
  const lines = [
    basePrompt.trimEnd(),
    '',
    'Neal structured control protocol:',
    `- Protocol: ${protocol.protocol}`,
    `- Schema label: ${protocol.schemaLabel}`,
    allowProseBeforeBlock
      ? '- You may include concise useful prose before the control payload.'
      : '- Do not include prose outside the control payload.',
    '- End your response with exactly one final fenced ```neal-json JSON block.',
    '- No non-whitespace content may appear after the closing fence.',
    '- The fenced JSON must be a single JSON object that satisfies this schema or schema summary:',
    fence(schemaDescription, 'json'),
  ];
  if (protocol.responseShapeHint?.trim()) {
    lines.push('', 'Response shape guidance:', protocol.responseShapeHint.trim());
  }
  if (protocol.examplePayload !== undefined) {
    lines.push('', 'Example control payload:', fence(JSON.stringify(protocol.examplePayload, null, 2), 'json'));
  }
  return lines.join('\n');
}

// Base-prompt output-format phrasings that contradict the neal-json transport
// contract appended by buildStructuredJsonPrompt (which requires a final fenced
// ```neal-json block, optionally preceded by prose). A structured-JSON base
// prompt must not carry its own "no fences / no prose outside the JSON object"
// instruction, because that flatly contradicts the transport for whichever
// provider renders it. This mirrors the assertNoReadPromptInstructionText /
// NO_READ_PROMPT_FORBIDDEN_MARKERS precedent in
// src/neal/context/inline-review-context.ts: a shared marker list plus a
// render-time guard, so a reintroduced contradiction throws at build time
// instead of silently shipping. The markers are chosen so they never match the
// transport wrapper's own lines above (no bare 'fence'/'fenced' marker).
export const CONFLICTING_OUTPUT_FORMAT_MARKERS: readonly string[] = [
  'do not include markdown fences',
  'markdown fences or prose outside',
  'outside the JSON object',
];

// Implementation-side guard for builder-owned static output-format instruction
// text in structured-JSON base prompts. Call it only on Neal-authored
// instruction lines (never on dynamic content such as JSON.stringify segments
// or coder-authored summaries, which may legitimately mention these phrases).
export function assertNoConflictingOutputFormatInstruction(text: string, label: string) {
  const lowered = text.toLowerCase();
  const violations = CONFLICTING_OUTPUT_FORMAT_MARKERS.filter((marker) => lowered.includes(marker.toLowerCase()));
  if (violations.length > 0) {
    throw new Error(
      `${label} produced a structured-JSON base prompt with output-format instructions that conflict with the neal-json transport contract: ${violations.join(', ')}`,
    );
  }
}

// Single guarded-assembly seam for structured-JSON base-prompt output-format
// lines: asserts the assembled lines carry no transport-conflicting phrasing,
// then returns a defensive copy. Base-prompt builders funnel their
// output-format instructions through this so a reintroduced contradiction
// throws at render, and tests can inject a marker through this one unit.
export function guardStructuredJsonOutputFormatLines(lines: readonly string[], label: string): string[] {
  assertNoConflictingOutputFormatInstruction(lines.join('\n'), label);
  return [...lines];
}

export function extractStructuredJsonPayload(assistantText: string): StructuredJsonExtractionResult {
  const blocks = findNealJsonBlocks(assistantText);

  if (blocks.length > 1) {
    return {
      ok: false,
      errorKind: 'multiple_control_blocks',
      errorSummary: `Expected exactly one final neal-json control block, but found ${blocks.length}.`,
      prose: assistantText.trim(),
      rawJson: null,
    };
  }

  if (blocks.length === 1) {
    const block = blocks[0];
    const trailing = assistantText.slice(block.end);
    const prose = assistantText.slice(0, block.start).trim();
    if (trailing.trim().length > 0) {
      return {
        ok: false,
        errorKind: 'non_final_control_block',
        errorSummary: 'The neal-json control block must be the final non-whitespace content.',
        prose,
        rawJson: block.rawJson,
      };
    }

    return parseExtractedJson({
      source: 'neal-json-block',
      prose,
      rawJson: block.rawJson,
      malformedSummaryPrefix: 'The neal-json control block contained malformed JSON',
    });
  }

  const trimmed = assistantText.trim();
  if (!looksLikeRawJsonObject(trimmed)) {
    return {
      ok: false,
      errorKind: 'missing_control_block',
      errorSummary: 'Expected a final neal-json control block or a raw whole-response JSON object.',
      prose: trimmed,
      rawJson: null,
    };
  }

  // Compatibility tolerance for pre-migration/local mocks that return only a
  // JSON object. The prompt contract still asks providers for a final
  // fenced neal-json block, and docs should describe raw JSON as tolerated,
  // not preferred.
  return parseExtractedJson({
    source: 'raw-json',
    prose: '',
    rawJson: trimmed,
    malformedSummaryPrefix: 'The raw JSON response was invalid',
  });
}

export function validateStructuredJsonPayload<TStructured>(
  assistantText: string,
  validator: (payload: unknown) => TStructured,
): StructuredJsonValidationResult<TStructured> {
  const extraction = extractStructuredJsonPayload(assistantText);
  if (!extraction.ok) {
    return {
      ok: false,
      phase: 'extraction',
      errorKind: extraction.errorKind,
      errorSummary: extraction.errorSummary,
      extraction,
    };
  }

  try {
    return {
      ...extraction,
      structured: validator(extraction.payload),
    };
  } catch (error) {
    return {
      ok: false,
      phase: 'validation',
      errorKind: 'schema_invalid',
      errorSummary: `Extracted JSON failed schema validation: ${summarizeError(error)}`,
      extraction,
    };
  }
}

export function buildStructuredJsonRepairPrompt(args: BuildStructuredJsonRepairPromptArgs) {
  const issueSummaries = [
    args.extractionErrorSummary ? `Extraction or parse issue: ${args.extractionErrorSummary}` : null,
    args.validationErrorSummary ? `Validation issue: ${args.validationErrorSummary}` : null,
  ].filter((line): line is string => line !== null);
  const schemaDescription = typeof args.schema === 'string' ? args.schema : JSON.stringify(args.schema, null, 2);
  const invalidJsonSection =
    args.invalidJson === undefined || args.invalidJson === null
      ? 'No JSON payload was extracted.'
      : fence(args.invalidJson, 'json');

  return [
    `You are repairing a Neal structured control payload for schema "${args.schemaLabel}".`,
    `Repair attempt ${args.attemptNumber} of ${args.attemptLimit}.`,
    '',
    'Preserve the original control decision and substantive meaning. Do not inspect the repository, run tools, request more context, or invent new implementation or review work.',
    'Return only a valid repaired response: either raw whole-response JSON object, or prose followed by exactly one final fenced ```neal-json control block. No content may appear after the closing fence.',
    '',
    'The JSON object must satisfy this schema or schema summary:',
    fence(schemaDescription, 'json'),
    '',
    'Repair issue summary:',
    issueSummaries.length > 0 ? issueSummaries.join('\n') : 'The previous response did not produce a valid structured JSON payload.',
    '',
    'Extracted invalid JSON, if any:',
    invalidJsonSection,
    '',
    'Original assistant response:',
    fence(truncateForPrompt(args.originalAssistantText), 'text'),
  ].join('\n');
}

export async function runStructuredJsonProtocol<TStructured>(
  args: RunStructuredJsonProtocolArgs<TStructured>,
): Promise<RunStructuredJsonProtocolResult<TStructured>> {
  const wrappedPrompt = buildStructuredJsonPrompt(args.prompt, args.protocol);
  const initial = await args.runInitial(wrappedPrompt);
  const initialSessionHandle = initial.sessionHandle ?? args.initialSessionHandle ?? null;
  await emitStructuredJsonExtractionStarted({
    ...args,
    assistantText: initial.assistantText,
    sessionHandle: initialSessionHandle,
    attemptNumber: 0,
  });
  const initialValidation = validateStructuredJsonPayload(initial.assistantText, args.protocol.validator);
  if (initialValidation.ok) {
    await emitStructuredOutputReceived({
      ...args,
      validation: initialValidation,
      assistantTextLength: initial.assistantText.length,
      sessionHandle: initialSessionHandle,
      attemptNumber: 0,
    });
    return {
      sessionHandle: initialSessionHandle,
      structured: initialValidation.structured,
    };
  }

  await emitStructuredJsonFailure({
    ...args,
    failure: initialValidation,
    assistantTextLength: initial.assistantText.length,
    sessionHandle: initialSessionHandle,
    attemptNumber: 0,
  });

  let repairResult: StructuredJsonRepairLoopResult<TStructured>;
  try {
    repairResult = await runStructuredJsonRepairLoop({
      originalAssistantText: initial.assistantText,
      initialFailure: initialValidation,
      schemaLabel: args.protocol.schemaLabel,
      schema: args.protocol.schema,
      attemptLimit: args.protocol.repairAttemptLimit,
      validator: args.protocol.validator,
      callRepair: async ({ prompt, attemptNumber, attemptLimit }) => {
        await emitStructuredJsonRepairStarted({
          ...args,
          assistantTextLength: initial.assistantText.length,
          sessionHandle: initialSessionHandle,
          attemptNumber,
          attemptLimit,
        });
        return args.runRepair(prompt, attemptNumber);
      },
    });
  } catch (error) {
    await emitStructuredJsonRepairFailed({
      ...args,
      failure: initialValidation,
      assistantTextLength: initial.assistantText.length,
      sessionHandle: initialSessionHandle,
      attemptNumber: 0,
      message: 'Structured JSON repair failed before producing a valid Neal payload.',
      cause: error,
    });
    throw error;
  }

  for (const attempt of repairResult.attempts) {
    if (!attempt.result.ok) {
      await emitStructuredJsonFailure({
        ...args,
        failure: attempt.result,
        assistantTextLength: initial.assistantText.length,
        sessionHandle: initialSessionHandle ?? attempt.sessionHandle,
        attemptNumber: attempt.attemptNumber,
        repairSessionHandle: attempt.sessionHandle,
      });
    }
  }

  if (repairResult.ok) {
    const returnedSessionHandle = initialSessionHandle ?? repairResult.sessionHandle;
    await emitStructuredJsonRepairSucceeded({
      ...args,
      validation: repairResult.result,
      assistantTextLength: initial.assistantText.length,
      sessionHandle: returnedSessionHandle,
      attemptNumber: repairResult.attemptNumber,
      repairSessionHandle: repairResult.sessionHandle,
    });
    await emitStructuredOutputReceived({
      ...args,
      validation: repairResult.result,
      assistantTextLength: initial.assistantText.length,
      sessionHandle: returnedSessionHandle,
      attemptNumber: repairResult.attemptNumber,
      repairSessionHandle: repairResult.sessionHandle,
    });
    return {
      sessionHandle: returnedSessionHandle,
      structured: repairResult.result.structured,
    };
  }

  await emitStructuredJsonRepairFailed({
    ...args,
    failure: repairResult.lastFailure,
    assistantTextLength: initial.assistantText.length,
    sessionHandle: initialSessionHandle,
    attemptNumber: repairResult.attempts.at(-1)?.attemptNumber ?? args.protocol.repairAttemptLimit,
    repairSessionHandle: repairResult.attempts.at(-1)?.sessionHandle ?? null,
    message: 'Structured JSON repair attempts were exhausted.',
  });

  throw buildStructuredJsonProviderError(args, {
    message: `Neal structured control payload remained invalid after ${args.protocol.repairAttemptLimit} repair attempt(s): ${repairResult.lastFailure.errorSummary}`,
    kind: 'structured_output_invalid',
    sessionHandle: initialSessionHandle,
    cause: repairResult.lastFailure,
  });
}

export async function runStructuredJsonRepairLoop<TStructured>(
  args: RunStructuredJsonRepairLoopArgs<TStructured>,
): Promise<StructuredJsonRepairLoopResult<TStructured>> {
  if (!Number.isSafeInteger(args.attemptLimit) || args.attemptLimit < 1) {
    throw new Error('Structured JSON repair attemptLimit must be a positive safe integer.');
  }

  const attempts: StructuredJsonRepairAttempt<TStructured>[] = [];
  let lastFailure = args.initialFailure;

  for (let attemptNumber = 1; attemptNumber <= args.attemptLimit; attemptNumber += 1) {
    const prompt = buildStructuredJsonRepairPrompt({
      originalAssistantText: args.originalAssistantText,
      invalidJson: getInvalidJson(lastFailure),
      extractionErrorSummary: lastFailure.phase === 'extraction' ? lastFailure.errorSummary : null,
      validationErrorSummary: lastFailure.phase === 'validation' ? lastFailure.errorSummary : null,
      schemaLabel: args.schemaLabel,
      schema: args.schema,
      attemptNumber,
      attemptLimit: args.attemptLimit,
    });
    const repairResponse = normalizeRepairCallResult(
      await args.callRepair({
        prompt,
        attemptNumber,
        attemptLimit: args.attemptLimit,
      }),
    );
    const result = validateStructuredJsonPayload(repairResponse.assistantText, args.validator);
    const attempt = {
      attemptNumber,
      sessionHandle: repairResponse.sessionHandle,
      result,
    };
    attempts.push(attempt);

    if (result.ok) {
      return {
        ok: true,
        attemptNumber,
        sessionHandle: repairResponse.sessionHandle,
        result,
        attempts,
      };
    }

    lastFailure = result;
  }

  return {
    ok: false,
    attempts,
    lastFailure,
  };
}

function buildStructuredJsonProviderError<TStructured>(
  args: RunStructuredJsonProtocolArgs<TStructured>,
  errorArgs: {
    message: string;
    kind: 'structured_output_missing' | 'structured_output_invalid';
    sessionHandle: string | null;
    cause: unknown;
  },
) {
  if (args.createProviderError) {
    return args.createProviderError(errorArgs);
  }

  return new NealProviderError({
    message: errorArgs.message,
    provider: args.provider,
    role: args.role,
    sessionHandle: errorArgs.sessionHandle,
    kind: errorArgs.kind,
    retryable: false,
    cause: errorArgs.cause,
  });
}

async function emitStructuredJsonExtractionStarted<TStructured>(
  args: RunStructuredJsonProtocolArgs<TStructured> & {
    assistantText: string;
    sessionHandle: string | null;
    attemptNumber: number;
    repairSessionHandle?: string | null;
  },
) {
  await emitStructuredJsonEvent(args.events, {
    type: 'tool_progress',
    provider: args.provider,
    role: args.role,
    label: args.label,
    sessionHandle: args.sessionHandle,
    toolName: 'structured_json_extraction_started',
    message: 'Extracting Neal structured control payload.',
    providerData: buildStructuredJsonProtocolProviderData(args),
  });
}

async function emitStructuredJsonFailure<TStructured>(
  args: RunStructuredJsonProtocolArgs<TStructured> & {
    failure: StructuredJsonValidationFailure;
    assistantTextLength: number;
    sessionHandle: string | null;
    attemptNumber: number;
    repairSessionHandle?: string | null;
  },
) {
  await emitStructuredJsonEvent(args.events, {
    type: 'tool_progress',
    provider: args.provider,
    role: args.role,
    label: args.label,
    sessionHandle: args.sessionHandle,
    toolName: args.failure.phase === 'validation'
      ? 'structured_json_validation_failed'
      : 'structured_json_extraction_failed',
    message: args.failure.phase === 'validation'
      ? 'Neal structured control payload failed validation.'
      : 'Neal structured control payload could not be extracted or parsed.',
    isError: true,
    providerData: buildStructuredJsonProtocolProviderData(args),
  });
}

async function emitStructuredJsonRepairStarted<TStructured>(
  args: RunStructuredJsonProtocolArgs<TStructured> & {
    assistantTextLength: number;
    sessionHandle: string | null;
    attemptNumber: number;
    attemptLimit: number;
  },
) {
  await emitStructuredJsonEvent(args.events, {
    type: 'tool_progress',
    provider: args.provider,
    role: args.role,
    label: args.label,
    sessionHandle: args.sessionHandle,
    toolName: 'structured_json_repair_started',
    message: `Repairing Neal structured control payload (${args.attemptNumber}/${args.attemptLimit}).`,
    providerData: {
      ...buildStructuredJsonProtocolProviderData(args),
      attemptLimit: args.attemptLimit,
    },
  });
}

async function emitStructuredJsonRepairSucceeded<TStructured>(
  args: RunStructuredJsonProtocolArgs<TStructured> & {
    validation: StructuredJsonValidationSuccess<TStructured>;
    assistantTextLength: number;
    sessionHandle: string | null;
    attemptNumber: number;
    repairSessionHandle?: string | null;
  },
) {
  await emitStructuredJsonEvent(args.events, {
    type: 'tool_progress',
    provider: args.provider,
    role: args.role,
    label: args.label,
    sessionHandle: args.sessionHandle,
    toolName: 'structured_json_repair_succeeded',
    message: 'Structured JSON repair produced a valid Neal payload.',
    providerData: buildStructuredJsonProtocolProviderData(args),
  });
}

async function emitStructuredJsonRepairFailed<TStructured>(
  args: RunStructuredJsonProtocolArgs<TStructured> & {
    failure: StructuredJsonValidationFailure;
    assistantTextLength: number;
    sessionHandle: string | null;
    attemptNumber: number;
    repairSessionHandle?: string | null;
    message: string;
    cause?: unknown;
  },
) {
  await emitStructuredJsonEvent(args.events, {
    type: 'tool_progress',
    provider: args.provider,
    role: args.role,
    label: args.label,
    sessionHandle: args.sessionHandle,
    toolName: 'structured_json_repair_failed',
    message: args.message,
    isError: true,
    providerData: {
      ...buildStructuredJsonProtocolProviderData(args),
      ...(args.cause instanceof Error ? { errorMessage: args.cause.message } : {}),
    },
  });
}

async function emitStructuredOutputReceived<TStructured>(
  args: RunStructuredJsonProtocolArgs<TStructured> & {
    validation: StructuredJsonValidationSuccess<TStructured>;
    assistantTextLength: number;
    sessionHandle: string | null;
    attemptNumber: number;
    repairSessionHandle?: string | null;
  },
) {
  await emitStructuredJsonEvent(args.events, {
    type: 'structured_output_received',
    provider: args.provider,
    role: args.role,
    label: args.label,
    sessionHandle: args.sessionHandle,
    providerData: buildStructuredJsonProtocolProviderData(args),
  });
}

async function emitStructuredJsonEvent(
  events: ProviderEventSink | undefined,
  event: Parameters<ProviderEventSink>[0],
) {
  await events?.(event);
}

function buildStructuredJsonProtocolProviderData<TStructured>(
  args: RunStructuredJsonProtocolArgs<TStructured> & {
    assistantText?: string;
    assistantTextLength?: number;
    attemptNumber: number;
    failure?: StructuredJsonValidationFailure;
    validation?: StructuredJsonValidationSuccess<TStructured>;
    repairSessionHandle?: string | null;
  },
) {
  return {
    protocol: args.protocol.protocol,
    schemaLabel: args.protocol.schemaLabel,
    attemptNumber: args.attemptNumber,
    repairAttemptLimit: args.protocol.repairAttemptLimit,
    assistantTextLength: args.assistantTextLength ?? args.assistantText?.length ?? 0,
    extractedJsonLength: args.validation?.rawJson.length ?? args.failure?.extraction.rawJson?.length ?? 0,
    ...(args.validation ? { source: args.validation.source } : {}),
    ...(args.failure?.phase === 'extraction' ? { parseErrorSummary: args.failure.errorSummary } : {}),
    ...(args.failure?.phase === 'validation' ? { validationErrorSummary: args.failure.errorSummary } : {}),
    ...(args.initialSessionHandle !== undefined ? { originalSessionHandle: args.initialSessionHandle } : {}),
    ...(args.repairSessionHandle !== undefined ? { repairSessionHandle: args.repairSessionHandle } : {}),
  };
}

function findNealJsonBlocks(assistantText: string): NealJsonBlock[] {
  const blocks: NealJsonBlock[] = [];
  const lines = splitLinesWithOffsets(assistantText);

  for (let index = 0; index < lines.length; index += 1) {
    const openingLine = lines[index];
    if (!NEAL_JSON_OPENING_FENCE_PATTERN.test(openingLine.text)) {
      continue;
    }

    for (let closingIndex = index + 1; closingIndex < lines.length; closingIndex += 1) {
      const closingLine = lines[closingIndex];
      if (!CLOSING_FENCE_PATTERN.test(closingLine.text)) {
        continue;
      }

      blocks.push({
        start: openingLine.start,
        end: closingLine.end,
        rawJson: stripSingleTrailingLineBreak(assistantText.slice(openingLine.end, closingLine.start)),
      });
      index = closingIndex;
      break;
    }
  }

  return blocks;
}

function splitLinesWithOffsets(text: string) {
  const lines: Array<{ text: string; start: number; end: number }> = [];
  let start = 0;

  while (start < text.length) {
    const newlineIndex = text.indexOf('\n', start);
    const end = newlineIndex === -1 ? text.length : newlineIndex + 1;
    const rawLine = text.slice(start, end);
    const textWithoutLineBreak = rawLine.replace(/\r?\n$/, '');
    lines.push({
      text: textWithoutLineBreak,
      start,
      end,
    });
    start = end;
  }

  return lines;
}

function stripSingleTrailingLineBreak(value: string) {
  return value.replace(/\r?\n$/, '');
}

function parseExtractedJson(args: {
  source: StructuredJsonSource;
  prose: string;
  rawJson: string;
  malformedSummaryPrefix: string;
}): StructuredJsonExtractionResult {
  try {
    const payload = JSON.parse(args.rawJson) as unknown;
    if (!isJsonObject(payload)) {
      return {
        ok: false,
        errorKind: 'malformed_json',
        errorSummary: `${args.malformedSummaryPrefix}: expected a single JSON object.`,
        prose: args.prose,
        rawJson: args.rawJson,
      };
    }

    return {
      ok: true,
      source: args.source,
      prose: args.prose,
      rawJson: args.rawJson,
      payload,
    };
  } catch (error) {
    return {
      ok: false,
      errorKind: 'malformed_json',
      errorSummary: `${args.malformedSummaryPrefix}: ${summarizeError(error)}`,
      prose: args.prose,
      rawJson: args.rawJson,
    };
  }
}

function looksLikeRawJsonObject(trimmed: string) {
  return trimmed.startsWith('{') || trimmed.startsWith('[');
}

function isJsonObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function normalizeRepairCallResult(result: StructuredJsonRepairCallResult) {
  if (typeof result === 'string') {
    return {
      assistantText: result,
      sessionHandle: null,
    };
  }

  return {
    assistantText: result.assistantText,
    sessionHandle: result.sessionHandle ?? null,
  };
}

function getInvalidJson(failure: StructuredJsonValidationFailure) {
  return failure.extraction.rawJson;
}

function summarizeError(error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  return limitOneLine(message, SUMMARY_MAX_LENGTH);
}

function limitOneLine(value: string, maxLength: number) {
  const oneLine = value.replace(/\s+/g, ' ').trim();
  if (oneLine.length <= maxLength) {
    return oneLine;
  }

  return `${oneLine.slice(0, maxLength - 1)}…`;
}

function truncateForPrompt(value: string) {
  if (value.length <= ORIGINAL_RESPONSE_MAX_LENGTH) {
    return value;
  }

  return `${value.slice(0, ORIGINAL_RESPONSE_MAX_LENGTH)}\n[truncated ${value.length - ORIGINAL_RESPONSE_MAX_LENGTH} byte(s)]`;
}

function fence(value: string, language: string) {
  return `\`\`\`${language}\n${value}\n\`\`\``;
}
