# ada-pane

Ada's side pane for Claude Code. It opens at session start and on `/ada`, with four views:
Session (context, plan limit, turn time, a strip of tool calls, the working tree and one
suggested action), Agent (how a turn runs: the loop between the model and the tools drawn live,
each model request of the turn, what the model read from the cache, what fills the context,
helpers, and tasks handed to hrn; it works without hrn), Repo (the branch, its pull request and
checks through `gh`, links, and, with
an hrn that answers per repository, what was delivered here, its hrn runs and the week's top
repositories) and You (`hrn bot stats`). In the terminal, the Repo view also links to a running
`hrn watch`, at the address in the mod's `watch_address` option (default `127.0.0.1:8089`).
The layout is specified in [docs/pane-design.md](docs/pane-design.md).

The JSON form folds new runs into the game ledger before it answers, so the numbers stay current
(hrn built from harness main at or after `8c26cd99`; an older hrn shows the ledger as last folded).

It records event metadata only (time, session, kind, tool name, ok or error; never prompt or
command text) to `~/.hrn/claude-sessions/<session>.jsonl` (or under `HRN_HOME`), rotating files
at 1 MiB. What the Agent view shows stays in the session and is written nowhere: tool names,
counts and token figures, never a prompt, an answer or a tool's arguments.

## Install

At the prompt of a terminal session:

```
/plugin install ada-pane --marketplace cristiangirlea/ada-pane
```

Answer `y` to add the marketplace, then pick a scope (user is first).

From a shell:

```
claude plugin install ada-pane --marketplace cristiangirlea/ada-pane
```

In the desktop app, where `/plugin` does not run: click + next to the prompt box, then Plugins,
Add marketplace with `cristiangirlea/ada-pane`, then Add plugin.

This repository is private: installing needs read access on GitHub and a git credential for
github.com on the machine (an SSH key, or `gh auth login` then `gh auth setup-git`).

## Develop

```
claude plugin validate .
claude plugin test .
```

Run from the folder with `claude --plugin-dir <folder>`, or name it in `CLAUDE_CODE_PLUGIN_DIRS`.
