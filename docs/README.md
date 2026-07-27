# Docs

These are the current product and implementation references. Historical plans
don't belong here.

- [architecture.md](architecture.md): how neal is built (**start here**)
- [providers.md](providers.md): provider capabilities, permissions, and adapter contracts
- [compatible-models.md](compatible-models.md): dated `neal compat` results
- [compat.md](compat.md): the model-compatibility smoke test and PASS/FAIL contract
- [plan-format.md](plan-format.md): executable plan shapes and selected-plan Git behavior
- [troubleshooting.md](troubleshooting.md): common setup, run, lock, and squash failures
- [automation.md](automation.md): exit codes, status JSON, and harness behavior
- [storage.md](storage.md): project-local `.neal/` storage and artifact classes
- [state-machine.md](state-machine.md): persisted run and queue state invariants
- [review-convergence.md](review-convergence.md): plan-review finding classes, debt, and convergence
- [prompt-specs.md](prompt-specs.md): prompt-spec inventory and ownership boundaries
- [prompt-evals.md](prompt-evals.md): prompt versioning and reviewer-recall evals
- [adjudicator-inventory.md](adjudicator-inventory.md): shared coder/reviewer loop inventory
- [maintenance.md](maintenance.md): dependency updates and versioning
- [release.md](release.md): manual release process and SDK-update policy
- [demo.md](demo.md): safe `asciinema` recording workflow
- [../examples/issue-triage-js/README.md](../examples/issue-triage-js/README.md):
  dependency-free local example and optional live neal run

The public README owns the user-facing workflow. Keep these docs focused on
contracts that help maintain or extend neal.
