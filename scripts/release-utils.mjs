const provenancePredicateType = 'https://slsa.dev/provenance/v1';

// npm's read replicas lag a publish: for a short window after a staged package
// goes public, the version and its attestations can still read as 404. The
// finalize step runs immediately after approval, so it polls through that
// window instead of failing the release.
export const REGISTRY_PROPAGATION_TIMEOUT_MS = 5 * 60_000;
export const REGISTRY_PROPAGATION_INTERVAL_MS = 10_000;

function fail(message) {
  throw new Error(message);
}

// A 404 from the registry right after publish means "not propagated yet". Any
// other failure (auth, provenance mismatch, signature mismatch) is real and must
// not be retried.
export function isRegistryPropagationError(error) {
  return /\b(?:E404|404)\b/.test(String(error?.message ?? ''));
}

export async function retryWhilePropagating(label, attempt, options = {}) {
  const timeoutMs = options.timeoutMs ?? REGISTRY_PROPAGATION_TIMEOUT_MS;
  const intervalMs = options.intervalMs ?? REGISTRY_PROPAGATION_INTERVAL_MS;
  const now = options.now ?? (() => Date.now());
  const sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  const log = options.log ?? ((message) => console.log(message));
  const deadline = now() + timeoutMs;

  for (let attemptNumber = 1; ; attemptNumber += 1) {
    try {
      return await attempt();
    } catch (error) {
      if (!isRegistryPropagationError(error) || now() >= deadline) {
        throw error;
      }
      log(`${label} is not visible in the npm registry yet (attempt ${attemptNumber}); retrying in ${Math.round(intervalMs / 1000)}s.`);
      await sleep(intervalMs);
    }
  }
}

export function getChangelogSection(markdown, version) {
  const heading = `## [${version}]`;
  const lines = markdown.split(/\r?\n/);
  const start = lines.findIndex((line) => line === heading || line.startsWith(`${heading} - `));

  if (start === -1) {
    fail(`CHANGELOG.md is missing a ${heading} section.`);
  }

  const endOffset = lines.slice(start + 1).findIndex((line) => /^## \[[^\]]+\]/.test(line));
  const end = endOffset === -1 ? lines.length : start + 1 + endOffset;
  const body = lines.slice(start + 1, end).join('\n').trim();

  if (!body) {
    fail(`CHANGELOG.md section ${heading} is empty.`);
  }

  return body;
}

export function parseProvenanceStatement(attestationResponse) {
  const attestation = attestationResponse?.attestations?.find(
    (candidate) => candidate?.predicateType === provenancePredicateType,
  );
  const encodedPayload = attestation?.bundle?.dsseEnvelope?.payload;

  if (typeof encodedPayload !== 'string' || !encodedPayload) {
    fail(`npm attestation response has no ${provenancePredicateType} payload.`);
  }

  let statement;
  try {
    statement = JSON.parse(Buffer.from(encodedPayload, 'base64').toString('utf8'));
  } catch (error) {
    fail(`npm provenance payload is not valid JSON: ${error.message}`);
  }

  if (statement?.predicateType !== provenancePredicateType) {
    fail(`npm provenance payload has unexpected predicate type ${String(statement?.predicateType)}.`);
  }

  return statement;
}

export function assertReleaseProvenance(statement, expected) {
  const workflow = statement?.predicate?.buildDefinition?.externalParameters?.workflow;
  const dependencies = statement?.predicate?.buildDefinition?.resolvedDependencies;
  const commit = Array.isArray(dependencies)
    ? dependencies.find((dependency) => typeof dependency?.digest?.gitCommit === 'string')?.digest.gitCommit
    : undefined;
  const subjectNames = Array.isArray(statement?.subject)
    ? statement.subject.map((subject) => {
        try {
          return decodeURIComponent(subject?.name);
        } catch {
          return subject?.name;
        }
      })
    : [];
  const expectedSubject = `pkg:npm/${expected.packageName}@${expected.version}`;

  const checks = [
    [subjectNames.includes(expectedSubject), `package subject ${expectedSubject}`],
    [workflow?.repository === expected.repository, `repository ${expected.repository}`],
    [workflow?.path === expected.workflowPath, `workflow path ${expected.workflowPath}`],
    [workflow?.ref === expected.ref, `workflow ref ${expected.ref}`],
    [commit === expected.commit, `commit ${expected.commit}`],
  ];

  const failed = checks.find(([matches]) => !matches);
  if (failed) {
    fail(`npm provenance does not match expected ${failed[1]}.`);
  }
}

export function parseRemoteTagTarget(output, tagName) {
  const lines = output.trim().split(/\r?\n/).filter(Boolean);
  const peeledSuffix = `refs/tags/${tagName}^{}`;
  const directSuffix = `refs/tags/${tagName}`;
  const peeled = lines.find((line) => line.endsWith(peeledSuffix));
  const direct = lines.find((line) => line.endsWith(directSuffix));
  const match = peeled ?? direct;

  return match?.split(/\s+/)[0] ?? null;
}

export function assertReleaseStateAllowed({ dryRun, npmPublished, tagExists, version }) {
  if (!dryRun) {
    return;
  }
  if (npmPublished) {
    fail(`npm package @navels/neal@${version} already exists.`);
  }
  if (tagExists) {
    fail(`Remote tag v${version} already exists on origin.`);
  }
}
