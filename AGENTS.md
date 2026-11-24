# ada-pane, Ada's side pane for Claude Code

A Claude Code mod: one hooks module draws a pane with four views (Session, Agent, Repo, You)
and records event metadata for hrn. README says what each view shows and how to install it.
`docs/pane-design.md` is the spec: layout, where each value comes from, privacy, cost, states
and tests. Read it before changing a view; don't reopen its decisions.

## Layout

| Path | Holds |
|---|---|
| `.claude-plugin/plugin.json` | The manifest: name, version, the `watch_address` option, the network list. |
| `.claude-plugin/marketplace.json` | Lets the repository be installed as its own marketplace. |
| `hooks/hooks.json` | Names the one hooks module. |
| `hooks/register.tsx` | All of the mod: state, parsers, formatters, pictures, event hooks, the pane. |
| `hooks/register.test.tsx` | Its tests, on the engine's kit (`claude-code/testing`). |
| `types/index.d.ts` | The state contract: `AdaState` and the value types the module imports. |
| `docs/pane-design.md` | The design spec. |
| `tsconfig.json` | Extends `.claude-plugin/types/tsconfig.json`, which the engine writes. |

## Checks

From the repository root, before a PR (`.claude/skills/check/SKILL.md`, `/check`):

```
claude plugin validate .
claude plugin test .
```

The repository has no CI workflow and no runner: these two are all that checks a change, and a
PR says so. The repository is public: a workflow, when one is added, runs on GitHub's runners,
never on a self-hosted one.

**Type-check.** The engine writes `.claude-plugin/types/` (its API, and the `tsconfig.json` ours
extends) into a folder once it has loaded the mod from there; git ignores it, so a fresh clone or
worktree has none. There `tsc -p .` reports errors that are not the code's and writes stray
`hooks/*.js`: delete them, never commit them. Type-check a scratch copy outside the repository
that has the folder, copied from a checkout the engine has loaded:
`npx -p typescript@5.9 tsc -p . --noEmit`. TypeScript 5.6 reports a TS2589 in the test file that
5.9 does not.

## Rules of this repository

- **Metadata only.** The recording (`claude-sessions/<session>.jsonl` in the hrn home) and the
  pane's state hold times, kinds, tool names, counts and token figures: never a prompt, an
  answer, a command or a tool's arguments. A new reading follows the spec's Privacy section and
  comes with a test that nothing new reaches the recording file.
- **This computer only.** The manifest's network list stays loopback, and the watch address is
  the one address fetched. Links are built from the repository's own remote, never from a tool's
  output or a web page.
- **The pane never gets in the session's way.** git and gh are run read-only, and hrn only
  through its own stats and runs commands, all with fixed arguments and a time limit; when one
  is missing, slow or failing, its section is left out without an error. A hook that observes passes the event on (`next(e)`) and returns its result
  unchanged; the `turn.step` hook streams and waits for none of its own state updates.
- **State has a contract.** A value kept in `$.state` is declared in `types/index.d.ts`. A change
  to `AdaState`'s fields moves the atom's `shape` tag and adds a test that state kept by the
  earlier build is read or reset.
- **Text from outside is checked or cleaned** before it is drawn or kept: names from hrn, git,
  gh and the model.
- **Desktop and terminal.** Pictures hold on a light and a dark theme (the session does not say
  which); the terminal gets the same tree without pictures. A view's states are tested on the
  desktop and on the terminal.
- **The spec and README move with the code**: a new reading, state or view updates
  `docs/pane-design.md`; what a person sees or installs updates README.
- Comments say why, in one line; no issue numbers, dates or history in code. Never name other
  products in code, docs, commits, PRs or issues.
- A version bump, a tag or a release is a maintainer's step; so are the licence (MIT, `LICENSE`)
  and an icon.

## Working rules

- **One worker per issue.** Before a branch, look at the issue for an open PR that closes it or
  a claim by someone else; if it is held, stop and say who holds it.
- **A branch delivers what it is for, nothing else**: one issue, a short name
  (`fix-stale-run-line`), one PR whose description lists the files it touches and why. It
  finishes everything its issue asks, with no refactors, renames or extras beyond it. Larger work
  is a feature branch: each piece's PR targets it under the rules below, and the feature branch
  reaches `main` through one PR reviewed for how the pieces fit.
- **Reviews and fixes.** Self-review, then get an independent review. Every defect, missing test,
  broken house rule or security hole in what the branch touches is fixed before the push,
  blocking or not, with the smallest change; one review round's fixes go in one commit, and the
  findings are written in the review on the PR, not in commits. Nits (wording, naming, style) are
  dropped, at most a line in the PR. Only a defect elsewhere on `main` (its own issue and branch)
  or a maintainer's choice becomes an issue; a follow-up branch files no follow-ups of its own.
- **Merge only what is tested.** Merge `main` in once before the final checks and review, or for
  a conflict. Then both checks pass, every added or changed behaviour has a test, the type-check
  is clean, the review's defects are fixed and a security read of the diff has nothing open, all
  on the head being merged. What could not be tested is said in the PR and waits for a
  maintainer. Merge through the PR only:
  `gh pr merge <n> --merge --delete-branch --match-head-commit <sha>`. Never `--auto` or
  `--admin`, never push to `main` (nothing on GitHub protects it; a plain `git push` from a
  checkout of `main` is on you), never force-push, never delete someone else's branch.
- **Commits**: the area first, lower case, then a plain sentence (`pane: show the stats' age while
  asking again`), one logical change per commit. No emoji and no AI attribution anywhere (no
  `Co-Authored-By`, `Assisted-by` or "Generated with" in commits, PR text, comments or docs). Use
  the repository's git identity: check `git config user.email` first.
- Tests first, seen failing. Files are LF (`.gitattributes`). Secrets are never read, printed or
  committed. Small diffs: don't restyle what you didn't change. Not sure? Ask, with one proposal.
