# Draft Plan

This is an intentionally rough draft for validating `forge --plan`.

We want a small safe change in the testing fixture area:

- add a helper that builds a review headline from a title and finding count
- export it from the testing-fixture index
- add a short usage example somewhere under `notes/testing`

Constraints:

- stay inside `src/testing-fixture/**` and `notes/testing/**`
- do not touch the real forge runtime

The final plan should be explicit enough for `forge --execute`.
