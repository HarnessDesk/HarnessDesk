# Reveal Searched Sessions in the Sidebar

## Goal

Opening a session selected from Command Palette or history search must make the
session discoverable in the sidebar, reveal its project and session row, mark it
active, and scroll that row into view.

## Context

Search can return sessions that are outside the initially loaded history page.
`AppStore.openSession` reads and resumes those sessions, but the sidebar's
`SessionTree` groups only `snapshot.history`, so the opened session can be
absent. Even when the summary is already present, its project can be collapsed,
hidden below the five-row preview, or placed below the closed `Other projects`
section.

## Design

### Store boundary

After `session/read` succeeds, `openSession` will ensure the read session has a
lightweight `SessionSummary` in `snapshot.history`. The insertion is keyed by
the existing runtime-plus-session identity, preserves an existing summary when
one is already present, and keeps the list ordered by `updatedAt`. The summary
conversion will reuse the same display facts as live-session rows: id, runtime,
title, preview, cwd, status, timestamps, git metadata, and archived state.

This keeps search and the sidebar independent: search continues to return
session summaries, while opening a session makes the store's canonical history
projection complete.

### Tree reveal boundary

`SessionTree` will derive the active session's project root from its grouped
history. When the active session changes, it will:

1. remove that root from the persisted collapsed-project preference;
2. open `Other projects` if the root is in the far section;
3. expand the project's local five-row preview when the active session is beyond
   the preview limit.

The existing row-level `data-active` marker and `scrollIntoView({ block:
"nearest" })` remain the final focus behavior. Reveal state is view behavior;
persisted project folding remains a user preference and is changed only when
needed to expose the active session.

### Error handling

If `session/read` fails, no history row or reveal state is added. Existing
resume, folder-gone, held-session, and notice behavior remains unchanged.

### Testing

Store tests will prove a searched session absent from history becomes a
deduplicated history row after opening, and a pre-existing summary is not
duplicated. `SessionTree` tests will prove collapsed projects, the `Other
projects` fold, and the five-row preview are opened for the active session.
Existing active styling and scrolling will remain covered by the row behavior.

### Verification

Run focused UI tests, the full `pnpm verify` gate, and a real packaged/dev app
flow: search for a session not on the first history page, open it, and inspect
the sidebar for project expansion, active styling, and scroll position. Capture
an anonymized screenshot using the repository's screenshot branch workflow.
