# Codex Instructions

This repository was originally developed with Claude Code and keeps important project context in `CLAUDE.md` files.

At the start of each new Codex task, read these files before making changes:

1. `./CLAUDE.md`
2. `./groups/global/CLAUDE.md` if it exists

Then read the most relevant group-specific context file for the task when applicable:

- `./groups/main/CLAUDE.md` for core app, setup, container, scheduler, IPC, or general repository work
- `./groups/<group>/CLAUDE.md` when the task is clearly scoped to that specific group

Do not bulk-read every `groups/*/CLAUDE.md` file unless the task genuinely spans multiple groups.

Treat the Claude files as project instructions and working context in addition to the normal code inspection you would do for any task.
