import { CoderRoundError, ReviewerRoundError } from '../agents.js';

// Shared, durable blocked reason for a reviewer content-safety refusal
// (`content_refused`). Defined once so the wording cannot drift across the
// three reviewer-phase catch sites that route it to a terminal blocked landing.
export const REVIEWER_CONTENT_REFUSED_BLOCK_REASON =
  'The reviewer refused this content on content-safety grounds. The change ' +
  'under review may read as security-adjacent. Switch the reviewer to a ' +
  'different provider, rephrase the scope, or seek provider authorization, ' +
  'then re-run.';

export function isCoderTimeoutError(error: CoderRoundError) {
  return (
    error.kind === 'timeout' ||
    error.kind === 'no_progress_timeout' ||
    /\btimed out after\b/i.test(error.message)
  );
}

export function isCoderResumeHistoryError(error: CoderRoundError) {
  // Any provider that classifies a resume attempt as session_unavailable
  // (codex: dropped threads; openai-compatible: a missing, corrupt, or
  // model-mismatched session mirror) is saying the stored handle cannot be
  // used. Without the fresh-session retry the handle stays persisted and
  // every resume fails the same way. The message checks remain for codex
  // errors that predate kind classification in persisted failure state.
  if (error.kind === 'session_unavailable') {
    return true;
  }
  const text = error.message.toLowerCase();
  return (
    text.includes('property_name_above_max_length') ||
    text.includes('orphan function call output') ||
    text.includes('failed to record rollout items')
  );
}

export function isCoderFreshSessionRetryableError(error: CoderRoundError) {
  return isCoderTimeoutError(error) || isCoderResumeHistoryError(error);
}

export function isTransientApiFailureMessage(message: string, subtype?: string | null) {
  const text = `${subtype ?? ''} ${message}`.toLowerCase();
  return (
    text.includes('api_error') ||
    text.includes('api error') ||
    text.includes('internal server error') ||
    text.includes('overloaded') ||
    text.includes('rate limit') ||
    text.includes('temporar') ||
    text.includes('try again')
  );
}

export function shouldNotifyFailure(error: CoderRoundError | ReviewerRoundError) {
  if (error instanceof CoderRoundError) {
    return isCoderTimeoutError(error) || isTransientApiFailureMessage(error.message);
  }

  return isTransientApiFailureMessage(error.message, error.subtype ?? undefined);
}
