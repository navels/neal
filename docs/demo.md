# Demo recording

Use `asciinema` for public terminal demos when a recording is useful. It is an
optional recording tool, not a package dependency.

Record from a disposable repository or throwaway worktree, preferably under
`/tmp`, so the demo does not expose real project history, paths, or artifacts.

## What to show

The README doesn't ship an embedded recording. If you make one, show the part
that's actually worth watching: the planner/coder/reviewer loop with the coder
and reviewer on different vendors, and the findings and responses going back and
forth until the reviewer is satisfied. A single trivial one-scope plan running
to completion doesn't show any of that. Pick a small change with a real review
point in it, so the reviewer has something to catch and the coder has something
to respond to.

## Suggested script

Create a small demo plan in the disposable repository:

```bash
throwaway="$(mktemp -d /tmp/neal-demo.XXXXXX)"
recording_dir="$(mktemp -d /tmp/neal-demo-recording.XXXXXX)"
recording="$recording_dir/neal-demo.cast"
cd "$throwaway"
git init
printf '# Neal demo target\n' > README.md
git add README.md
git -c user.name='Neal Demo' -c user.email='neal-demo@example.invalid' commit -m 'Initial demo baseline'
mkdir -p tmp
$EDITOR tmp/DEMO_PLAN.md
```

Configure providers and run `neal check` before recording, or record those
steps only if the output is safe to share. Use current neal commands while
recording:

```bash
asciinema rec "$recording"
neal run tmp/DEMO_PLAN.md
neal status
exit
```

Keep the recording output outside the demo repository so it does not appear as
unrelated dirty work while neal starts the writer run.

If you specifically want to show recovery from a run that is waiting for
operator guidance, record that as a separate segment with the selected run id:

```bash
neal resume --run <run-id> --message "Continue with the smallest safe follow-up."
```

## Scrubbing checklist

Before sharing a recording, review the terminal output for local paths, private
project names, provider output, credentials, tokens, provider environment
variables, and `.neal/` artifact contents. Re-record from a clean disposable
repository if the output exposes anything sensitive.

This repository should commit recording instructions only, not `.cast` files or
generated terminal transcripts.
