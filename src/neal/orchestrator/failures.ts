import { CoderRoundError, ReviewerRoundError } from '../agents.js';

export function isCoderTimeoutError(error: CoderRoundError) {
  return /\btimed out after\b/i.test(error.message);
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
