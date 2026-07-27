import type { ResidualReviewDebtItem, ReviewFinding } from './types.js';

function isResidualReviewDebtFinding(
  finding: ReviewFinding,
): finding is ReviewFinding & { status: ResidualReviewDebtItem['status'] } {
  return finding.severity === 'non_blocking' && (finding.status === 'open' || finding.status === 'deferred');
}

export function toResidualReviewDebt(findings: ReviewFinding[]): ResidualReviewDebtItem[] {
  return findings
    .filter(isResidualReviewDebtFinding)
    .map((finding) => ({
      id: finding.id,
      canonicalId: finding.canonicalId,
      status: finding.status,
      files: [...finding.files],
      claim: finding.claim,
      evidence: finding.evidence ?? null,
      requiredAction: finding.requiredAction,
      coderDisposition: finding.coderDisposition,
      coderCommit: finding.coderCommit,
    }));
}

// Plan-review debt is a canonical-keyed *projection* of the current findings,
// never an accumulator: for each canonicalId whose latest-round finding is a
// deferred verification-hardening finding, emit exactly one debt item (latest
// round wins). A canonical that later reopens (its latest finding goes back to
// open) or is fixed/rejected simply drops out of the projection, so the debt
// lifecycle is automatic — no stale or duplicate entries and no removal rule.
export function toPlanReviewDebt(findings: ReviewFinding[]): ResidualReviewDebtItem[] {
  const latestByCanonical = new Map<string, ReviewFinding>();
  for (const finding of findings) {
    const existing = latestByCanonical.get(finding.canonicalId);
    if (!existing || finding.round >= existing.round) {
      latestByCanonical.set(finding.canonicalId, finding);
    }
  }

  return [...latestByCanonical.values()]
    .filter((finding) => finding.status === 'deferred' && finding.findingClass === 'verification_hardening')
    .map((finding) => ({
      id: finding.id,
      canonicalId: finding.canonicalId,
      status: 'deferred' as const,
      files: [...finding.files],
      claim: finding.claim,
      evidence: finding.evidence ?? null,
      requiredAction: finding.requiredAction,
      coderDisposition: finding.coderDisposition,
      coderCommit: finding.coderCommit,
      findingClass: finding.findingClass,
      originRound: finding.round,
    }));
}
