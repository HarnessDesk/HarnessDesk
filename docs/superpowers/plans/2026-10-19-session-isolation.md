# Session isolation implementation plan

**Goal:** Independent development sessions own their checkout, branch, PR and browser, and Team rows expose working context actions.

**Architecture:** Reuse managed worktree allocation on first send, retaining explicit Local choices and non-Git chats. Bind browser identity to runtime/session rather than checkout. Reuse canonical Team actions for sidebar menus. Existing mixed checkouts remain untouched.

**Constraints:** Use the existing protocol and host boundaries; no real account fixtures or public desktop frames; regression tests first; no push or merge in this task.

## Tasks

- [x] Browser isolation: test two sessions in the same checkout, then give every session a stable opaque browser profile shared by its tools and UI. Preserve restoration and lane release safeguards; validate desktop partition admission and two-profile storage isolation.
- [x] Team context menu: reproduce the missing right-click handler in SessionTree tests, then reuse the Team's canonical Rename, Run again, Wrap and Stop actions, with their existing eligibility rules and dialogs.
- [x] Development isolation: test first-send allocation, distinct branches, explicit Local, non-Git folders and failed-start retry. Default ordinary project drafts to a new managed checkout while retaining the user's explicit place choice. Protect publication from an unrelated branch/PR.
- [x] Integration: inspect all diffs; run focused Node/UI/desktop tests and typechecks, layering/design gates and check:push --fast. Capture synthetic light/dark UI proof and inspect it. Report checks and remaining limits accurately.

## Verification

- UI: 672 files, 8,402 tests passed, including first-send worktree allocation and browser promotion.
- Browser/host Node regression run: 114 passed; final desktop browser/IPC run: 21 passed. Worktree, forge, protocol and session-index regressions also passed in the focused integration runs.
- `pnpm check:push --fast` passed (75.8 seconds), including build, typecheck and selected static gates. Broad Node, browser and native suites left to CI by this mode are not passing evidence.
- Independent reviews passed after repairs. Synthetic light/dark frames cover the default worktree choice and Team context menu; no real desk frames are published.
- Native Electron cookie probing was blocked at macOS sandbox startup, so native cookie persistence end-to-end remains unverified. The running installed app and existing mixed checkouts were left untouched. No push or merge was performed.
