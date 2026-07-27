import test from 'node:test';
import assert from 'node:assert/strict';
import { access, chmod, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { notify } from '../src/notifier.js';
import { clearConfigCache, getNotifyBin } from '../src/neal/config.js';

process.env.HOME = join(tmpdir(), 'neal-test-home-notifier');
// The suite-wide NEAL_NOTIFY_BIN= (set by the pnpm test script) would shadow
// the config-resolution behavior this file exercises; clear it and rely on
// the HOME isolation above for hermeticity.
delete process.env.NEAL_NOTIFY_BIN;
clearConfigCache();

test('notify is disabled unless notify_bin is configured', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'neal-notify-unconfigured-'));
  clearConfigCache(cwd);

  assert.equal(getNotifyBin(cwd), null);
  await notify('complete', 'No notification helper is configured.', cwd);

  clearConfigCache(cwd);
});

test('notify ignores missing local notification helpers', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'neal-notify-missing-'));
  await writeFile(join(cwd, 'neal.yml'), 'neal:\n  notify_bin: /definitely/missing/neal-notify\n', 'utf8');
  clearConfigCache(cwd);

  await notify('complete', 'This should not fail the run.', cwd);

  clearConfigCache(cwd);
});

test('notify invokes configured local notification helper when present', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'neal-notify-present-'));
  const logPath = join(cwd, 'notify.log');
  const scriptPath = join(cwd, 'notify.sh');
  await writeFile(
    scriptPath,
    `#!/bin/sh\nprintf '%s\\n' "$1" >> "${logPath}"\n`,
    'utf8',
  );
  await chmod(scriptPath, 0o755);
  await writeFile(join(cwd, 'neal.yml'), `neal:\n  notify_bin: ${scriptPath}\n`, 'utf8');
  clearConfigCache(cwd);

  await notify('complete', '[neal] PLAN.md: plan complete', cwd);

  assert.equal(await readFile(logPath, 'utf8'), '[neal] PLAN.md: plan complete\n');
  clearConfigCache(cwd);
});

test('a defined-but-empty NEAL_NOTIFY_BIN disables notifications over any config', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'neal-notify-env-disabled-'));
  await writeFile(join(cwd, 'neal.yml'), 'neal:\n  notify_bin: /should/never/run\n', 'utf8');
  clearConfigCache(cwd);

  assert.equal(getNotifyBin(cwd, { NEAL_NOTIFY_BIN: '' }), null);
  assert.equal(getNotifyBin(cwd, { NEAL_NOTIFY_BIN: '   ' }), null);
  clearConfigCache(cwd);
});

test('a non-empty NEAL_NOTIFY_BIN overrides the configured helper', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'neal-notify-env-override-'));
  await writeFile(join(cwd, 'neal.yml'), 'neal:\n  notify_bin: /configured/helper\n', 'utf8');
  clearConfigCache(cwd);

  assert.equal(getNotifyBin(cwd, { NEAL_NOTIFY_BIN: '/env/helper' }), '/env/helper');
  assert.equal(getNotifyBin(cwd, {}), '/configured/helper');
  clearConfigCache(cwd);
});

test('notify passes messages as argv without shell interpretation', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'neal-notify-argv-'));
  const logPath = join(cwd, 'notify.log');
  const markerPath = join(cwd, 'shell-interpreted');
  const scriptPath = join(cwd, 'notify.sh');
  await writeFile(
    scriptPath,
    `#!/bin/sh\nprintf '%s\\n' "$#" > "${logPath}"\nprintf '%s\\n' "$1" >> "${logPath}"\n`,
    'utf8',
  );
  await chmod(scriptPath, 0o755);
  await writeFile(join(cwd, 'neal.yml'), `neal:\n  notify_bin: ${scriptPath}\n`, 'utf8');
  clearConfigCache(cwd);

  const message = `literal; touch ${markerPath}`;
  await notify('complete', message, cwd);

  assert.equal(await readFile(logPath, 'utf8'), `1\n${message}\n`);
  assert.equal(await access(markerPath).then(() => true, () => false), false);
  clearConfigCache(cwd);
});
