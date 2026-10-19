# Session isolation implementation plan

**Goal:** Independent development sessions own their checkout, branch, PR and browser, and Team rows expose working context actions.

**Architecture:** Reuse managed worktree allocation on first send, retaining explicit Local choices and non-Git chats. Bind browser identity to runtime/session rather than checkout. Reuse canonical Team actions for sidebar menus. Existing mixed checkouts remain untouched.

**Constraints:** Use the existing protocol and host boundaries; no real account fixtures or public desktop frames; regression tests first; no push or merge in this task.

## Tasks

- [ ] Browser isolation: test two sessions in the same checkout, then give every session a stable opaque browser profile shared by its tools and UI. Preserve restoration and lane release safeguards; validate desktop partition admission and two-profile storage isolation.
- [ ] Team context menu: reproduce the missing right-click handler in SessionTree tests, then reuse the Team's canonical Rename, Run again, Wrap and Stop actions, with their existing eligibility rules and dialogs.
- [ ] Development isolation: test first-send allocation, distinct branches, explicit Local, non-Git folders and failed-start retry. Default ordinary project drafts to a new managed checkout while retaining the user's explicit place choice. Protect publication from an unrelated branch/PR.
- [ ] Integration: inspect all diffs; run focused Node/UI/desktop tests and typechecks, layering/design gates and check:push --fast. Capture synthetic light/dark UI proof and inspect it. Report checks and remaining limits accurately.
