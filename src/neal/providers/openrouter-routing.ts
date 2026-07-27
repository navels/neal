/**
 * OpenRouter request routing for the OpenAI-compatible adapter
 * (`openai-compatible`).
 *
 * OpenRouter serves a single model slug from many independent backends whose
 * capabilities differ — some don't support structured outputs (`json_schema`)
 * at all, others are lower-fidelity quantizations. OpenRouter picks a backend
 * per request, so a slug that drove neal's loop yesterday can fail today with
 * no slug change: it just got routed to a backend that can't honor the
 * parameters neal sends. That is exactly the drift that broke the coder's
 * structured-output cells in the live smoke.
 *
 * `require_parameters: true` tells OpenRouter to only route to backends that
 * support every parameter in the request. Since neal's coder sends
 * `response_format: { type: 'json_schema' }`, this excludes the backends that
 * can't do structured output and keeps a slug's behavior stable across
 * requests — so when the compat whitelist says a slug works, it keeps working.
 *
 * It is applied as a default (no config knob) whenever the endpoint is
 * OpenRouter, and is a no-op for every other OpenAI-compatible endpoint, which
 * would reject or ignore the OpenRouter-specific `provider` field.
 */

const OPENROUTER_HOST = 'openrouter.ai';

export function isOpenRouterBaseUrl(baseUrl: string): boolean {
  let host: string;
  try {
    host = new URL(baseUrl).host.toLowerCase();
  } catch {
    return false;
  }
  return host === OPENROUTER_HOST || host.endsWith(`.${OPENROUTER_HOST}`);
}

// Add `provider.require_parameters: true` to a chat-completion request body,
// leaving an already-present `provider` block untouched (a caller that set its
// own routing wins). Anything that isn't a JSON object body passes through
// unchanged, so a non-chat request or an opaque body is never corrupted.
export function injectRequireParameters(init: RequestInit | undefined): RequestInit | undefined {
  if (!init || typeof init.body !== 'string') {
    return init;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(init.body);
  } catch {
    return init;
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return init;
  }
  const body = parsed as Record<string, unknown>;
  if ('provider' in body) {
    return init;
  }
  return { ...init, body: JSON.stringify({ ...body, provider: { require_parameters: true } }) };
}

/**
 * Wrap `inner` so requests to OpenRouter carry `provider.require_parameters:
 * true`. Returns `inner` unchanged for non-OpenRouter base URLs so no other
 * endpoint sees the OpenRouter-specific field.
 */
export function withOpenRouterRouting(
  baseUrl: string,
  inner: typeof globalThis.fetch,
): typeof globalThis.fetch {
  if (!isOpenRouterBaseUrl(baseUrl)) {
    return inner;
  }
  return (input, init) => inner(input, injectRequireParameters(init));
}
