/**
 * Tests for the OpenRouter request-routing default
 * (src/neal/providers/openrouter-routing.ts): base-URL detection, the
 * `provider.require_parameters` body injection, and the fetch wrapper that
 * applies it only on OpenRouter. Hermetic: no network, the wrapped fetch is a
 * stub that records the RequestInit it receives.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  injectRequireParameters,
  isOpenRouterBaseUrl,
  withOpenRouterRouting,
} from '../src/neal/providers/openrouter-routing.js';

describe('isOpenRouterBaseUrl', () => {
  it('matches openrouter.ai and its subdomains', () => {
    assert.equal(isOpenRouterBaseUrl('https://openrouter.ai/api/v1'), true);
    assert.equal(isOpenRouterBaseUrl('https://api.openrouter.ai/v1'), true);
    assert.equal(isOpenRouterBaseUrl('HTTPS://OpenRouter.AI/api/v1'), true);
  });

  it('rejects other hosts, look-alikes, and non-URLs', () => {
    assert.equal(isOpenRouterBaseUrl('https://api.openai.com/v1'), false);
    // A different domain that merely ends in the same letters must not match.
    assert.equal(isOpenRouterBaseUrl('https://notopenrouter.ai/v1'), false);
    assert.equal(isOpenRouterBaseUrl('not a url'), false);
    assert.equal(isOpenRouterBaseUrl(''), false);
  });
});

describe('injectRequireParameters', () => {
  it('adds provider.require_parameters to a JSON object body, preserving fields', () => {
    const init = { method: 'POST', body: JSON.stringify({ model: 'x', messages: [{ role: 'user' }] }) };
    const out = injectRequireParameters(init);
    const body = JSON.parse(out?.body as string);
    assert.deepEqual(body.provider, { require_parameters: true });
    assert.equal(body.model, 'x');
    assert.deepEqual(body.messages, [{ role: 'user' }]);
    // The original init is not mutated in place.
    assert.equal(JSON.parse(init.body).provider, undefined);
  });

  it('leaves an existing provider block untouched (caller routing wins)', () => {
    const existing = { only: ['deepseek'], allow_fallbacks: false };
    const init = { body: JSON.stringify({ model: 'x', provider: existing }) };
    const out = injectRequireParameters(init);
    assert.deepEqual(JSON.parse(out?.body as string).provider, existing);
  });

  it('passes through non-string, unparseable, and non-object bodies unchanged', () => {
    const noBody = { method: 'GET' } as RequestInit;
    assert.equal(injectRequireParameters(noBody), noBody);
    const bad = { body: 'not json{' };
    assert.equal(injectRequireParameters(bad), bad);
    const arr = { body: JSON.stringify([1, 2, 3]) };
    assert.equal(injectRequireParameters(arr), arr);
    assert.equal(injectRequireParameters(undefined), undefined);
  });
});

describe('withOpenRouterRouting', () => {
  it('injects on OpenRouter and forwards to the inner fetch', async () => {
    const seen: Array<RequestInit | undefined> = [];
    const inner = (async (_input: unknown, init?: RequestInit) => {
      seen.push(init);
      return new Response('{}');
    }) as unknown as typeof globalThis.fetch;

    const wrapped = withOpenRouterRouting('https://openrouter.ai/api/v1', inner);
    await wrapped('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST',
      body: JSON.stringify({ model: 'x', messages: [] }),
    });

    assert.equal(seen.length, 1);
    assert.deepEqual(JSON.parse(seen[0]?.body as string).provider, { require_parameters: true });
  });

  it('returns the inner fetch unchanged for non-OpenRouter endpoints', () => {
    const inner = (async () => new Response('{}')) as unknown as typeof globalThis.fetch;
    assert.equal(withOpenRouterRouting('https://api.openai.com/v1', inner), inner);
  });
});
