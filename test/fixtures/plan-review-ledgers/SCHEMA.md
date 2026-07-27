# Plan-review ledger replay fixtures

Versioned, checked-in ledgers that let plan-review convergence policy be pinned by
replaying a recorded (or authored) negotiation through the real disposition core.
Committed fixtures are the **sole** runtime source: no test reads
`tmp/ratchet-corpus/` (see `.neal/PLAN.md`, "Replay corpus").

The replay driver (`test/helpers/plan-review-ledger.ts`) routes each round
through `synthesizePlanReviewRoundFromFindings` — the same pure round-synthesis
core that backs `runPlanReviewPhase`'s `synthesizePlanReviewRound` — so any drift
in the runtime gating/disposition policy is caught here. It supplies findings
carrying the recorded `canonicalId` and does **not** recompute canonical
signatures, so a fixture exercises the disposition/gating policy, not
`findCanonicalId`. The driver duplicates none of that policy.

## Format (`schemaVersion: 1`)

```jsonc
{
  "schemaVersion": 1,
  "label": "issue-16-run2",          // human label for the ledger
  "source": "…/REVIEW.md",           // optional provenance note (not read at runtime)
  "description": "…",                 // optional human note
  "roundLimit": 20,                   // roundLimit at the decision site
                                      //   (state.maxRounds for top-level plan review)
  "derivedPlanReview": false,          // optional, default false (top-level plan review)
  "rounds": [
    {
      "round": 1,                      // 1-based, contiguous
      "reviewerFindings": [
        {
          "canonicalId": "C1",        // recorded canonical id; trusted verbatim
          "severity": "blocking",     // 'blocking' | 'non_blocking'
          "findingClass": "…",        // optional; added in Scope 2
                                      //   ('plan_correctness' | 'verification_hardening')
          "classRationale": "…",      // optional documentary note explaining the
                                      //   assigned class; ignored by the loader
          "files": ["…"],             // recorded finding files
          "claimDigest": "…"           // one-line digest of the finding claim
        }
      ],
      "coderDispositions": [
        { "canonicalId": "C1", "decision": "fixed" } // 'fixed' | 'rejected' | 'deferred'
      ]
    }
  ]
}
```

## Replay semantics

For each round in order, the driver:

1. Applies the **prior** round's `coderDispositions` to the accumulated findings,
   following the runtime response-eligibility contract: `runPlanningResponsePhase`
   presents only that round's mode-matching open findings to the coder and applies
   each returned disposition **only** to a finding in that presented `openFindings`
   set (a response `id` outside it is a no-op). These fixtures replay the required
   `coder_plan_response` path, whose presented set is the open **blocking**
   findings, so the driver mirrors it with `isOpenBlockingFinding`. Each such
   eligible finding on that canonical is set to `mapDecisionToStatus(decision)`, so
   a round's fixes take effect before the next round's review. A disposition
   recorded against a finding that arrival-time debt conversion already flipped to
   `deferred` (banked as plan-review debt), or against any other non-presented
   finding, is **ignored** — it was never presented, so it stays banked exactly as
   the runtime now leaves it.
2. Builds the round's `reviewerFindings` as new `open` findings
   (`id` = `R{round}-F{index}`, `canonicalId` taken verbatim).
3. Passes those findings and the accumulated prior findings to
   `synthesizePlanReviewRoundFromFindings`, which computes the open sets, stall,
   and reopen signals and resolves the disposition. The review-stuck window is
   resolved once from `cwd` at the boundary (like `runPlanReviewPhase`).

The driver returns the per-round `planningSignal` sequence, the per-round
open-blocking-canonical counts, the per-round plan-review debt projections
(`planReviewDebtByRound`), and the debt projected from the final merged findings
(`finalPlanReviewDebt`), which the fixture's expectations pin.

Once a `findingClass` is recorded, the disposition policy becomes class- and
novelty-aware (Scope 3+): past `plan_review_debt_round_threshold` (default 3), a
first-occurrence `verification_hardening` finding that is the only kind of open
blocking finding lands the round accepted-with-debt (`planningSignal`
`accept_plan`/`accept_derived_plan`) and converts to `deferred` plan-review debt
instead of forcing another round. A `plan_correctness` finding, a repeat
occurrence of an existing canonical, or a below-threshold round always forces a
revision. An absent `findingClass` is fail-safe round-forcing.
