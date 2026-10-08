# Team shared composer implementation plan

**Goal:** Give a Team's multi-tile grid the approved shared composer, using the existing room delivery path and one draft across Chat and Side by side.

**Architecture:** `SideBySide` owns visibility and measured clearance. It accepts a composer render slot with the displayed session keys. `TeamRoomPane` supplies `RoomComposer`, limits its default audience to those keys, and retains the room's draft across destination changes. Chat continues to use its existing approval dock; grid approvals remain inside tiles.

**Constraints:** Follow the approved race-view design's composer section. No new wire method, real accounts, real desk, browser per tile, race setup or judge. Run affected UI tests, UI typecheck and strict design audit locally; leave full verification to CI. Publish inspected light/dark synthetic frames separately from the code branch. Open a PR without merging or dispatching the separately requested landing review.

1. [x] Add failing mounted tests for all displayed recipients, one/several mentions, draft and audience retention, and shared versus individual composer visibility.
2. [x] Add the grid composer slot using the design system's `ComposerDock` and `useComposerHeightVar`; reserve its measured height under bottom tiles.
3. [x] Reuse `RoomComposer` with an explicit default audience for the grid and a room-owned draft holder shared with Chat. Keep unavailable recipients visible with the host's reason, and report partial delivery through the existing channel.
4. [x] Run the affected tests, UI typecheck, strict audit and layering. Inspect the full diff and changed public text.
5. [x] Exercise real delivery, Chat's single row, responsive geometry, approvals and draft retention on a throwaway fake-agent rig. Capture and inspect both themes.

Publication: put the inspected frames on a separate branch and create/read back the PR with concise evidence. Leave review and landing to the separate requested phase.

Verification: 314 affected UI tests and five existing rig tests passed, as did UI typecheck, strict design audit, layering and the generated design reference check. The mounted fake-agent rig confirmed exact visible/mentioned recipients, queued copies, one Chat row, preserved drafts, approval keyboard isolation, and accessible answer buttons at a 520px window height. Review repairs cover unloaded recipients and delayed send errors across view changes. Full verification is left to GitHub CI as requested.

Commands: `pnpm --filter @harnessdesk/ui test src/components/RoomComposer.test.tsx src/components/SideBySide.test.tsx src/components/TeamRoomPane.test.tsx`; `pnpm --filter @harnessdesk/ui typecheck`; `node script/design-audit.mjs --strict`; `pnpm layering`.
