# PR 748 UI regression repair evidence

Source repair: `1b0840921c3768e3d1de93656c30f046bcadfd88`.

- `original`: original UI at `9f2d6dec`, built and captured with the same synthetic screenshot driver.
- `broken`: PR head `b8962d50`, reproducing overlapping rows and blank menus.
- `repaired`: real macOS arm64 packaged app, 1440x900 CSS pixels at 2x, light and dark.
- `flow`: real packaged app's flow setup dialog, scrolled to the dry-run report. No flow is started by these frames.
- `native`: real Electron run with scripted fake Codex, 1024x768 CSS pixels at 2x. Includes runtime Extensions, terminal, and the native About window. The marketplace failure banner is a deliberate fake-agent fixture, not a live marketplace request. `report.json` records successful relaunch/theme/native-token checks.

All frames use isolated application homes, disposable Electron profiles, synthetic repositories, scripted fake agents, and placeholder identities or the project's public demo persona. User-supplied real-desktop screenshots are not uploaded. Each published image was inspected, in addition to the screenshot harness's text/account privacy check. The test fixture's generated paths are normalized by its existing screenshot policy.

Reproduction tools are committed with the repair: `script/shots/shoot.mjs`, `script/shots/seed.mjs`, and `e2e/ui-system/native-smoke.mjs`. Use `HD_SHOTS_EXECUTABLE` to point the screenshot harness at the built package; `--assert-layout` checks Settings row containment, effective menu opacity and horizontal sidebar overflow. Browser regression tests run with `pnpm test:ui-system`.

Main destinations: desk/new session, conversation, Dashboard, Git, code editor, Board, room, Browser, Profile, General, Appearance, Notifications, Keyboard shortcuts, Workspaces, Archive, Agents, Models, Skills and commands, Library, Plugins, Permissions, browser preferences, flow setup, Extensions, terminal, and About. Model-menu comparisons supplement the page gallery.

This is visual and interaction evidence for the stated surfaces, not a claim of exhaustive data-state coverage, vendor authentication, real-agent execution, or a VoiceOver session.
