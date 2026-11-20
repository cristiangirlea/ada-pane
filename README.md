# ada-pane

Ada's side pane for Claude Code. It opens at session start and on `/ada`, with three views:
Session (context, plan limit, turn time, a strip of tool calls, the working tree and one
suggested action), Repo (the branch, its pull request and checks through `gh`, links, and, with
an hrn that answers per repository, what was delivered here, its hrn runs and the week's top
repositories) and You (`hrn bot stats`). In the terminal, the Repo view also links to a running
`hrn watch`, at the address in the mod's `watch_address` option (default `127.0.0.1:8089`). The layout is specified in [docs/pane-design.md](docs/pane-design.md).

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
