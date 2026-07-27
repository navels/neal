// This file exercises notify behavior through its own fixture scripts; the
// suite-wide NEAL_NOTIFY_BIN= kill switch (pnpm test script) must not shadow
// them. Fixture repo configs pin notify_bin, so this stays hermetic.
delete process.env.NEAL_NOTIFY_BIN;
