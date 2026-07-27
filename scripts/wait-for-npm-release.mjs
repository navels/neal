const packageName = '@navels/neal';
const version = process.env.RELEASE_VERSION ?? '';
const timeoutMs = Number(process.env.RELEASE_WAIT_TIMEOUT_MS ?? 60 * 60 * 1000);
const pollMs = Number(process.env.RELEASE_WAIT_POLL_MS ?? 15 * 1000);
const startedAt = Date.now();

if (!version) {
  throw new Error('RELEASE_VERSION is required.');
}

async function isPublished() {
  const response = await fetch(
    `https://registry.npmjs.org/${encodeURIComponent(packageName)}/${encodeURIComponent(version)}`,
  );
  if (response.ok) {
    return true;
  }
  if (response.status === 404) {
    return false;
  }
  throw new Error(`Unable to check npm publication state: HTTP ${response.status}.`);
}

while (!(await isPublished())) {
  if (Date.now() - startedAt >= timeoutMs) {
    throw new Error(
      `${packageName}@${version} was not approved before the wait timed out. Approve the npm stage, then rerun this workflow with dry_run=false.`,
    );
  }

  console.log(`Waiting for npm approval of ${packageName}@${version}...`);
  await new Promise((resolve) => setTimeout(resolve, pollMs));
}

console.log(`${packageName}@${version} is public on npm.`);
