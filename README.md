# ada-pane

Ada's side pane for Claude Code. It opens at session start and on `/ada`, shows
`hrn bot stats --json` (refreshed every minute), counts prompts and tool calls, and reacts to
each one.

The JSON form folds new runs into the game ledger before it answers, so the numbers stay current
(hrn built from harness main at or after `8c26cd99`; an older hrn shows the ledger as last folded).

It records event metadata only (time, session, kind, tool name, ok or error; never prompt or
command text) to `~/.hrn/claude-sessions/<session>.jsonl` (or under `HRN_HOME`), rotating files
at 1 MiB.

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
