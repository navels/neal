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
