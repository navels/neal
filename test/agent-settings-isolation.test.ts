/**
 * Tests for the compat agent-settings isolation flag
 * (src/neal/providers/agent-settings-isolation.ts): the process-level signal
 * that turns Codex/Claude config isolation on for the compat qualification
 * harness and leaves normal neal runs honoring the operator's config.
 */
import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';

import {
  agentSettingsIsolated,
  disableAgentSettingsIsolation,
  enableAgentSettingsIsolation,
} from '../src/neal/providers/agent-settings-isolation.js';

describe('agent settings isolation', () => {
  afterEach(() => {
    disableAgentSettingsIsolation();
  });

  it('is off by default (normal neal runs honor operator config)', () => {
    assert.equal(agentSettingsIsolated(), false);
  });

  it('reports isolated after enable and clears after disable', () => {
    enableAgentSettingsIsolation();
    assert.equal(agentSettingsIsolated(), true);
    disableAgentSettingsIsolation();
    assert.equal(agentSettingsIsolated(), false);
  });
});
