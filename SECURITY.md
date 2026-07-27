# Security

neal is a local planner/coder/reviewer loop that delegates work to
provider-owned agent runtimes on your machine. Here's neal's trust model so you
can run it safely, and how to report a suspected vulnerability.

## Trust Model

neal assigns providers to roles, and the roles have very different privilege
levels. Understand this boundary before pointing neal at a sensitive repository
or an untrusted model.

### Coder role: full local privileges

The coder role (and the planner, which inherits the coder provider by default)
executes shell commands and writes files with the **invoking user's
privileges** in the working directory. neal does not add its own sandbox around
these providers:

- The Claude coder runs with `permissionMode: bypassPermissions`.
- The Codex coder runs with `approvalPolicy: never` and
  `sandboxMode: danger-full-access`.
- The `openai-compatible` coder drives a neal-owned agentic loop whose `run` tool
  is unsandboxed shell.

Treat any provider acting in the coder or planner role as capable of running
arbitrary commands and modifying anything the current user can reach, unless you
have added external sandboxing yourself.

### Reviewer role: read-only

The reviewer role is **read-only**, enforced in two layers:

- **Declared capability.** Every provider definition must declare its reviewer
  (structured-advisor) capability with `write:false, shell:false`. The registry
  validates this at every provider resolution, so a writable reviewer
  definition cannot be handed out.
- **Adapter wiring.** Each adapter enforces the declaration mechanically:
  - The Codex reviewer runs under `sandboxMode: read-only`, which Codex
    enforces with an OS-level sandbox (Seatbelt on macOS, Landlock on Linux),
    the strongest guarantee of the three.
  - The Claude reviewer is limited to the `Read`, `Grep`, and `Glob` tools at
    the SDK level. No write or shell tool exists in the reviewer session.
  - The `openai-compatible` reviewer is bound to a neal-owned read-only toolset
    (`read_file`, `list_dir`, `grep`, and a read-only `git_diff` over a commit
    range). Write and shell tools are absent from that toolset by construction.

Both layers are pinned by tests, including a registry-driven conformance test
(`test/reviewer-readonly-conformance.test.ts`) that fails if a provider is
registered without read-only wiring verification. Apart from the OS-sandboxed
Codex reviewer, enforcement is process-level (SDK and tool wiring), not an
external sandbox, so it is only as strong as the adapter and the runtime under
it.

**Read-only is not read-jailed.** Only the `openai-compatible` reviewer restricts
*reads* to the repository (path-jailed, with symlink resolution). The Claude
and Codex reviewers can read anything the invoking user can read (including
files outside the repository such as `~/.ssh` or cloud credentials), and file
contents they read are sent to the provider's API. On sensitive machines,
follow the conservative guidance in the README
[Safety Notes](README.md#safety-notes): run neal in a disposable checkout,
branch, worktree, container, or VM.

**`neal review` drafts with the coder.** The read-only `neal review` command
judges findings with the read-only reviewer adapter, but the agent that
*drafts* candidate findings runs on the coder provider with coder privileges.
neal verifies after every drafting call that the worktree and neal's own run
state are byte-unchanged and fails the review otherwise: detection, not
prevention. See [docs/providers.md](docs/providers.md) for the exact guarantee
split.

### Untrusted or unknown models

Running an unknown or untrusted model in the coder role (for example via
`neal compat` against an arbitrary OpenAI-compatible / OpenRouter slug on the
`openai-compatible` provider) grants that model **coder-level unsandboxed shell
access** in the working directory. Run untrusted models inside a container or
disposable sandbox. Do not point a coder-role untrusted model at a repository or
machine you care about.

See [docs/providers.md](docs/providers.md) for the per-provider permission
boundaries, capability checks, and adapter contracts.

## Reporting a Vulnerability

Please report suspected vulnerabilities **privately**, not in public issues. Use
the GitHub repository's Security Advisories "Report a vulnerability" flow so the
report stays confidential until a fix is available.
