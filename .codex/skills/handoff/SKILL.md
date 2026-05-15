---
name: handoff
description: Use when the user sends /handoff, asks to hand off the current task, or wants a resumable session record that preserves the active conversation goal. Capture the latest user intent, important user messages, decisions, constraints, progress, risks, blockers, current branch, changed files, commands, and next steps to repository-root HANDOFF.md. Use when the user sends /handoff resume to read HANDOFF.md first and continue the previous work from that saved state.
---

# Handoff

Use this skill to make the current repository work resumable across Codex sessions.

`HANDOFF.md` at the repository root is the single handoff artifact.

The active conversation goal is the highest-priority state. Git diff is supporting evidence, not the source of truth for what the next session should do.

## Trigger Modes

- `/handoff`, `$handoff`, `handoff`, `交接`, or a request to hand off current work: capture the current work state into `HANDOFF.md`.
- `/handoff resume`, `$handoff resume`, `handoff resume`, `恢复交接`, or a request to continue previous handoff work: read `HANDOFF.md` and continue from it.

## Capture Workflow

When capturing a handoff:

1. Capture the active conversation state first:
   - the user's current goal in concrete terms
   - the latest explicit user request
   - important user messages or constraints that shaped the work
   - decisions already made in the conversation
   - commitments made by the assistant that remain relevant
   - assumptions, open questions, and scope boundaries
2. Identify the repository root and current branch.
3. Gather current git state with:
   - `git rev-parse --show-toplevel`
   - `git branch --show-current`
   - `git status --short`
   - `git diff --name-status`
   - `git diff --stat`
   - `git log -5 --oneline --decorate`
4. Use local artifacts to cross-check completed work, in-progress work, decisions, blockers, and next step.
5. Read relevant working artifacts if they exist, such as `PLAN.md`, `PROGRESS.md`, `OUTPUT.md`, or `LINEAR.md`.
6. Write or replace `HANDOFF.md` at the repository root with the template below.
7. Keep the content concise and factual. Preserve the task goal and user intent even if the diff is small, incomplete, or unrelated.
8. Do not include large raw diffs. Summarize changed files and cite paths.
9. Do not run verification only for handoff capture. Record verification that already ran and any verification still needed.

Use `apply_patch` for manual edits to `HANDOFF.md` when available.

## HANDOFF.md Template

````markdown
# Handoff

## Snapshot

- Updated: <YYYY-MM-DD HH:mm:ss TZ>
- Repository: <absolute repo path>
- Branch: <current branch>
- Head: <short commit hash and subject if useful>

## Current Goal

<The active user goal in one or two concrete sentences.>

## Conversation Context

- Latest user request: <the newest explicit instruction from the user>
- Important user messages:
  - <short factual summary or short quote when wording matters>
- Constraints and preferences:
  - <task-specific constraints from the user or repository>
- Decisions already made:
  - <decision and reason>
- Assistant commitments:
  - <work promised or implied that still matters>

## Progress

- Completed:
  - <facts about work already done>
- In progress:
  - <current incomplete step>
- Next:
  - <the next concrete action another session should take>

## Changed Files

- `<path>`: <purpose/status>

## Commands And Verification

- `<command>`: <status/result>

## Risks And Blockers

- <risk, blocker, open decision, failing command, or branch concern>

## Git State

```text
<git status --short>
```

## Diff Summary

```text
<git diff --stat>
```

## Recent Commits

```text
<git log -5 --oneline --decorate>
```

## Resume Instructions

1. Read this file first.
2. Treat `Current Goal` and `Conversation Context` as the primary source of task intent.
3. Confirm the current branch matches `Branch`.
4. Inspect the changed files named above before editing them.
5. Continue with the `Next` item from `Progress`.
6. Preserve raw error messages from failed commands while debugging.
````

If a section has no data, write `None known` instead of leaving it empty.

## Resume Workflow

When resuming:

1. Read repository-root `HANDOFF.md` before planning or editing.
2. Restate the loaded `Current Goal`, latest user request, and next action in a short update before changing files.
3. Run:
   - `git branch --show-current`
   - `git status --short`
4. Compare the current branch with the saved `Branch`.
5. If the branch differs, state the saved branch and current branch. Avoid editing until the branch decision is clear unless the user's message explicitly permits continuing on the current branch.
6. Read the changed files and any task artifacts named in `HANDOFF.md`.
7. Continue the work from the saved `Next` item, validating against the current repository state and the saved conversation intent.

If `HANDOFF.md` is missing, say that no handoff file exists and ask for the current goal or a source artifact to resume from.

## Quality Bar

- The handoff must be useful to a fresh session without conversation history.
- Losing the user goal is the main failure mode. The handoff must make the goal, latest request, and next action unmistakable.
- Include task-specific constraints that affect the next action.
- Include unresolved risks and failed commands with enough raw detail to debug.
- Keep repository rules and user instructions in force; do not duplicate the full `AGENTS.md`.
- Update `HANDOFF.md` again before ending if the resumed session makes meaningful progress and the user asks for another handoff.
