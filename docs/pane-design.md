# Ada's pane: design spec

Status: built. Slices 1, 2 and 4 are in this repository; slice 3 is two hrn additions in
harness (issues 966 and 967), and the Repo view's hrn sections appear once an hrn built with
them is installed. `Watch` is not built (see Links). This replaces the first redesign's layout (bordered cards, three views) and adds session,
repository and delivery readings.

## Why

The pane shows game figures a developer looks at once a day, in boxes, and nothing they need
while working. A pane earns its place beside the chat when a glance answers a question the
developer has right now:

1. **Session:** how full is the context, how much of my plan is left, did anything fail?
2. **Repository:** where does this branch stand (changes, tests, pull request, CI), and what
   has been delivered here?
3. **You:** level, week, streak, today's exercise.

## What was checked (2026-11-20)

| Question | Finding |
|---|---|
| Can delivery be shown per repository? | Yes. Every entry in hrn's game ledger carries `repo` (`owner/name`), `track`, `kind`, `xp` and `at`. 4,999 entries read in 15 ms. |
| What do the entries say? | Kinds: run inside its ceiling, review clean, script reused, routed run passed or failed, bug squashed, first use, badge. Enough for "what was delivered here", not only XP. |
| Is the ledger clean? | No. 1,002 repo names, most of them eval run folders and bare folder names. Only `owner/name` entries are real repositories; the pane matches the session's remote and ignores the rest. |
| Do runs know their repository? | Yes. A run record has `repo`, `branch`, `backend`, and a result with status, duration, tokens and tool calls. |
| Why is `hrn bot stats` slow (harness#963)? | Not the ledger: that reads in milliseconds. The time goes elsewhere (the familiarity walk is the lead). |
| Can the pane link out? | Yes. `Link` draws on every surface: an anchor on desktop, a terminal hyperlink otherwise. On a remote surface (desktop, vscode and mobile all are) only `https:` links are followed, so loopback links are terminal only. |
| What does the session give? | Context tokens and window, plan limits with reset times, cost, the repository's root, remote and name, turn durations, every tool call. |
| What does it not give? | The theme (pictures must hold on light and dark), the branch (asked from git), pull requests (asked from gh). |

## Who it is for

A developer in a Claude Code session, glancing for one or two seconds. Every figure is
readable without a legend.

## Layout

One column, about 300 to 400 px wide on desktop. No bordered cards: a section is a small
caption, its content, and space.

### Header (all views)

| Part | Session | Repo | You |
|---|---|---|---|
| Ring, 46 px | Ada inside a ring filled to the context percentage | Ada inside a ring filled to this repository's share of the week's delivery | The level number inside a ring filled towards the next level |
| Title | What Ada says (at most 40 characters) | The repository's name | `Level 9` |
| Under it | Last tool and how long ago | Branch | `4,240 XP, 760 to level 10` |
| Right | Chip: Working, Failed, Done | Chip: CI passing, failing, running | Age of the stats |

### View switch

Three buttons: `Session`, `Repo`, `You`; the current one `primary`. The choice is kept in
`$.store`. Session is the default. Outside a git repository there is no `Repo` button.

### Session view

1. **Three figures in a row**, each a caption, a large tabular number and one line under it:
   - Context: `43%`, `86k of 200k`. Warning colour from 70%, error from 85%.
   - Plan limit: the highest `percentUsed` of the rate limits, and `resets 3 d`. With no
     limits but a cost: `Cost`, `$1.20`.
   - Last turn: `2:14`, `9 tool calls`. While a turn runs: the running time.
2. **Tool calls, newest right.** One bar per call, the last 40. Height by duration on a
   square-root scale, colour by result. Under it:
   `38 calls, 2 failed. Slowest: Bash, 3 m 12 s`.
3. **Working tree**, one line: branch, `3 files changed`, and `tests passed 4 min ago` with
   `edited since` when a file was written after them.
4. **One action**, the most useful now, in this order:
   - a tool call failed last: `Ask why it failed`
   - context at 70% or more: `Compact now` (fills `/compact`)
   - tests ran, then files were edited: `Run the tests again`
   - otherwise none.

### Repo view

1. **This branch**
   - `3 files changed, 2 ahead, 0 behind`
   - Pull request, when the branch has one: `#12 Pane look`, review state, and its checks as
     dots (passed, failed, running) with `5 of 6 passed`. The title is a link to it.
   - Issue, when the branch is claimed for one: `#1`, a link.
2. **Delivered here**
   - This week: delivery XP in this repository as a large number, and its share of the
     week's total as a bar (`545 of 1,820 this week`).
   - A 35-day strip of delivery in this repository (one bar a day, height by XP).
   - What it was made of, three counts at most: `41 runs inside their ceiling`,
     `6 clean reviews`, `2 bugs squashed`.
3. **Runs here** (hrn runs whose `repo` is this one)
   - Running now: one line each, backend and how long, at most three.
   - Last five finished: a dot for the result, backend, duration, how long ago.
4. **Links**, one row: `Repository`, `Pull requests`, `Actions`, and `Watch` (hrn watch's
   page, when it is running, not on a remote surface). `Watch` is not built: hrn records no
   address of a running watch, and the port is the person's choice, so the pane cannot tell
   whether or where one runs.
5. **Top repositories this week**, last and small: the five with the most delivery XP, this
   one marked. This is the "across projects" reading; a project that groups several
   repositories is in "To decide".

### You view

1. **This week**: two bars, Delivery and Practice, with their XP.
2. **Practice**: the 35-day grid, beside it the streak as a large number and `4 of 35 days`.
3. **Today's exercise**: its kind, a chip (`Waiting` or `Done`), and `Open it` while waiting.
4. **Badges**: chips. No section when there are none.

`Refresh` is a plain button beside the age text in the header.

## Where each value comes from

| Value | Source | Kept |
|---|---|---|
| Context, plan limit, cost | `$.session.usage` | read while drawing |
| Turn time | `turn.complete` `durationMs`; running time from `turn.start` and `$.clock` (`prompt.submit` also fires for a command that answers itself and a dropped prompt, which start no turn) | state |
| Tool bars | `tool.call`: tool name, start, end, ok or failed | last 40, state |
| Branch, changed, ahead, behind | `git --no-optional-locks status --porcelain=v2 --branch` in the session's own directory (`$.session.repo().root` is the main checkout's in a worktree) | state |
| Tests | a `Bash` call whose command starts a known runner (`go test`, `npm test`, `vitest`, `pytest`, `cargo test`, `claude plugin test`), and its result | runner name, result, time |
| Edited since | a later `Edit` or `Write` call | flag |
| Pull request, checks, review | `gh pr view --json number,title,state,reviewDecision,statusCheckRollup,closingIssuesReferences` (links are built from the remote, so `url` is not asked for) | state, 2 minutes |
| Claimed issue | the pull request's closing issues; before one exists, none shown | state |
| Delivery here, strip, counts, top repositories | hrn, per repository (see below) | `$.store`, with age |
| Runs here | hrn, per repository (see below) | state; every 30 seconds while a run is live and the Repo view is on screen |
| Links | built from `$.session.repo.remote`; only `https://github.com/` remotes get links | none |
| Game figures | `hrn bot stats --json` | `$.store`, with age |

### What hrn has to give first

The per-repository figures exist in hrn's files but hrn has no command that returns them.
The pane asks hrn; it does not read hrn's files, whose layout is hrn's to change.

Two additions to harness, one issue each, both small:

1. `hrn bot stats --json --repo OWNER/NAME`: adds `repo: {week, days[35], kinds{}, share}`
   and `top: [{repo, week}]` (five entries, `owner/name` repositories only), and skips the
   familiarity walk so it answers in well under a second. This also removes the pane's
   minute-long wait (harness#963).
2. `hrn runs --json --repo OWNER/NAME -n N`: id, backend, status, started, duration.

Until both are installed the Repo view shows "This branch" and "Links" and leaves the two
hrn sections out, without an error.

## Privacy

- Recording to `~/.hrn/claude-sessions` does not change: event metadata only.
- New readings live in the session's state and are never written to a file. The test check
  looks at a command's first words to name the runner and keeps the runner's name only.
- Links are built from the repository's own remote; nothing from a tool's output or a web
  page becomes a link.
- `gh` and `git` are called read-only, with fixed arguments.

## Cost

- `git status`: after a turn ends and after a file-writing call, at most once in 10 seconds,
  3 second limit.
- `gh pr view`: when the Repo view opens and after a turn ends while it is open, at most once
  in 2 minutes, 8 second limit. Never while another view is shown.
- hrn's per-repository answers: as `gh`, plus runs every 30 seconds while a run is live.
- No timer redraws the pane while idle. A running turn ticks once a second.
- Any of these failing hides its section; the pane shows no error for it.

## Colour and type

- One accent, Ada's scarlet, for her and the header ring only. The rest is the theme's text
  colours plus success, warning and error.
- Pictures use mid-tone fills that hold on light and dark; the unfilled part of a ring, strip
  or grid is a grey at half opacity.
- Numbers are mono and tabular. Captions are caption size and dim. Bold for the title only.
- Sentence case everywhere.

## Terminal

No pictures there. The same tree with: rings as percentages, strips as block characters
(`▁▃▂▇`, failed ones in the error colour), check dots as `●`, the day grid as rows of `■`
and `·`. Links work as terminal hyperlinks.

## States

| State | Shown |
|---|---|
| No tool call yet | Figures row; strip replaced by `No tool calls yet` |
| Not a git repository | No working-tree line, no Repo view |
| Remote is not on GitHub | Repo view without pull request and links |
| `gh` missing or not signed in | Repo view without the pull request, one dim line saying which |
| Branch has no pull request | `No pull request yet` |
| hrn without `--repo` | Repo view without "Delivered here" and "Runs here" |
| Nothing delivered here yet | `Nothing delivered here yet` |
| Usage not known yet | `–` in the tile, no ring fill |
| Stats never read | You view: `Reading your stats` |
| Game off, or hrn not installed | You view says which in one line; the other views work |

## Tests

- Each formatter: percentages, token counts, durations, reset times, the square-root scale,
  the 40-call window, share of the week.
- Parsing: `git status --porcelain=v2 --branch` (clean, changed, ahead and behind, detached,
  not a repository); `gh pr view` (no pull request, mixed checks, no checks); hrn's two new
  answers, and an older hrn that refuses the flag.
- Links: only for a GitHub remote, in both `https` and `git@` spelling; none on a remote
  surface for loopback.
- Runner detection, including a command that only mentions a runner in an argument.
- Which action is shown, for each rule and their order.
- Every state above draws without an error, on desktop and on the terminal.
- State written by earlier builds (`ada-2`, `ada-3`) is read or reset.
- Nothing new reaches the recording file.

## Order of work

| Slice | Where | Holds |
|---|---|---|
| 1 | ada-pane | New layout, Session view, You view, working-tree line |
| 2 | ada-pane | Repo view: this branch, pull request and checks, links |
| 3 | harness | `hrn bot stats --repo` (fast), `hrn runs --json --repo` |
| 4 | ada-pane | Repo view: delivered here, runs here, top repositories |

Slices 1 and 2 need nothing outside this repository. Slice 4 waits for an installed hrn
built from slice 3.

## To decide

1. **A project of several repositories** (for example the AdaNext ones as one figure).
   Proposed: not now. Top repositories covers the comparison; a project needs a list
   someone keeps, and hrn should own it, not the pane.
2. **`Compact now`** as an action, or only the warning colour. Proposed: the action.
3. **Cost in dollars.** Proposed: only when the session reports a cost and no plan limits.
4. **The pane reading hrn's ledger file itself**, to have "Delivered here" without waiting
   for slice 3. Proposed: no; it ties the pane to a file layout hrn may change.
