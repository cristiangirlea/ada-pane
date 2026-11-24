---
name: check
description: Run the mod's checks (validate the manifest and module, then run the tests) before a PR
---
Run the steps in order from the repository root and stop at the first failure. Report each
step's result in one line; on a failure, show the error text and fix it before re-running.

```bash
claude plugin validate .
claude plugin test .
```

- `validate` passes on exit 0. Four notes are known and left alone: no marketplace description,
  `CLAUDE.md` at the root (it is for work on this repository, not context the mod ships), and
  the plugin directory's notes on a missing LICENSE and a missing icon, which are a
  maintainer's choices. Any other warning comes from the change: fix it.
- `test` runs every `*.test.ts` and `*.test.tsx` under the folder and exits 1 when a test fails. Report the
  pass and fail counts from its last lines.

Before a PR, merge `origin/main` into the branch first, so both steps run on what will land.

The type-check is not a step here: a fresh clone or worktree lacks the folder it needs, and
`tsc -p .` there writes stray `hooks/*.js`. AGENTS.md says how to run it on a scratch copy; say
in the PR whether it was run.

The repository has no CI, so this is all that checks a change. This skill does not merge:
merging is through the PR, under AGENTS.md's conditions.
