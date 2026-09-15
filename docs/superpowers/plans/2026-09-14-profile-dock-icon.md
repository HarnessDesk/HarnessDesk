# Profile Picture Dock Icon Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the selected global profile picture control the running macOS Dock icon, restore the default icon on reset, and reapply the choice after relaunch.

**Architecture:** Keep the existing profile id in host-backed preferences. Add one optional renderer-to-Electron capability, `setDockIcon(avatarId | null)`, and implement it in the main process with a validated avatar allowlist and packaged PNG resources. The browser build and non-macOS builds remain no-ops, while the current bundle icon remains the immutable default used for reset.

**Tech Stack:** React/TypeScript, Vitest, Electron 42, Node `node:test`, electron-builder, CDP.

## Global Constraints

- The preference is global to HarnessDesk; do not add image state to `WorkspaceEntry`, `WorkspaceRecord`, workspace rows, or folders.
- The renderer never uses Node or filesystem paths; it sends only a validated avatar id or `null` through the existing preload bridge.
- The main process owns native icon loading and calls `app.dock.setIcon()` only on macOS.
- The existing profile persistence remains authoritative; icon application is best effort and cannot block profile writes or startup.
- Public screenshots use the seeded fake-agent rig and placeholder identities only.
- Run focused tests during development and unpiped `pnpm verify` before the PR.

---

### Task 1: Define the testable Dock icon resource contract

**Files:**
- Create: `packages/desktop/electron/dock-icon.mjs`
- Test: `packages/desktop/electron/dock-icon.test.mjs`

**Interfaces:**
- Produces `AVATAR_IDS`, `avatarResourcePath(avatar, root)`, `defaultIconPath({ packaged, resourcesPath, here })`, and `createDockIconSetter({ platform, app, nativeImage, avatarRoot, defaultIcon })`.
- `createDockIconSetter` accepts an avatar id or `null`; valid ids load the matching PNG, `null` loads the default icon, malformed ids and unsupported platforms do nothing.

- [ ] **Step 1: Write the failing tests**

  Add `node:test` cases that assert:

  ```js
  test('maps every shipped avatar to its packaged PNG', () => {
    for (const avatar of AVATAR_IDS) assert.equal(avatarResourcePath(avatar, '/resources/avatars/128'), `/resources/avatars/128/${avatar}.png`)
  })

  test('rejects malformed ids and uses the default path for reset', () => {
    assert.equal(avatarResourcePath('../secret', '/resources/avatars/128'), null)
    assert.equal(avatarResourcePath('pirate', '/resources/avatars/128'), null)
    assert.equal(defaultIconPath({ packaged: true, resourcesPath: '/resources', here: '/dev/electron' }), '/resources/app.icns')
    assert.equal(defaultIconPath({ packaged: false, resourcesPath: '/resources', here: '/dev/electron' }), '/dev/build/icon.icns')
  })

  test('sets and resets a macOS Dock icon, but ignores other platforms', () => {
    const calls = []
    const nativeImage = { createFromPath: (path) => ({ path, isEmpty: () => false }) }
    const app = { dock: { setIcon: (image) => calls.push(image.path) } }
    const set = createDockIconSetter({ platform: 'darwin', app, nativeImage, avatarRoot: '/avatars', defaultIcon: '/default.icns' })
    set('wizard')
    set(null)
    assert.deepEqual(calls, ['/avatars/wizard.png', '/default.icns'])
    createDockIconSetter({ platform: 'linux', app, nativeImage, avatarRoot: '/avatars', defaultIcon: '/default.icns' })('wizard')
    assert.deepEqual(calls, ['/avatars/wizard.png', '/default.icns'])
  })
  ```

- [ ] **Step 2: Run the focused test and verify RED**

  Run `node --test packages/desktop/electron/dock-icon.test.mjs`.

  Expected: fail because `dock-icon.mjs` does not exist yet.

- [ ] **Step 3: Implement the minimal pure contract**

  Export the 23 ids from `packages/ui/src/lib/avatars.ts` as a duplicated shell allowlist, keep path construction inside the helper, return `null` for invalid ids, and make the setter no-op when `platform !== 'darwin'` or `nativeImage.createFromPath()` returns an empty image.

- [ ] **Step 4: Run the focused test and verify GREEN**

  Run `node --test packages/desktop/electron/dock-icon.test.mjs`.

  Expected: all Dock icon helper tests pass.

- [ ] **Step 5: Commit the isolated helper**

  Run `git add packages/desktop/electron/dock-icon.mjs packages/desktop/electron/dock-icon.test.mjs && git commit -m "test: define Dock icon resource contract"`.

### Task 2: Wire the optional renderer capability and profile synchronization

**Files:**
- Modify: `packages/ui/src/lib/desktop.ts`
- Modify: `packages/ui/src/state/store.ts`
- Test: `packages/ui/src/state/store.profile.test.ts`

**Interfaces:**
- Adds `DesktopBridge.setDockIcon?(avatar: string | null): void` and `setDockIcon(avatar: string | null): void`.
- `AppStore.setProfile()` calls the helper only when the effective avatar changes.
- `AppStore.loadPreferences()` calls the helper after applying the loaded profile so relaunch restores the Dock icon.

- [ ] **Step 1: Extend the existing profile tests with failing bridge assertions**

  Install a `window.harnessdesk.setDockIcon` spy in `beforeEach`, then add:

  ```ts
  it('syncs avatar changes and reset with the optional desktop Dock bridge', () => {
    store.setProfile({ avatar: 'wizard' })
    store.setProfile({ name: 'Jane' })
    store.setProfile({ avatar: null })
    expect(setDockIcon).toHaveBeenCalledWith('wizard')
    expect(setDockIcon).toHaveBeenLastCalledWith(null)
    expect(setDockIcon).toHaveBeenCalledTimes(2)
  })

  it('reapplies a stored avatar when preferences load', async () => {
    answers['app/state/get'] = { profile: { avatar: 'dj' } }
    await store.loadPreferences()
    expect(setDockIcon).toHaveBeenLastCalledWith('dj')
  })
  ```

- [ ] **Step 2: Run the profile test and verify RED**

  Run `pnpm vitest run packages/ui/src/state/store.profile.test.ts`.

  Expected: fail because the desktop bridge has no Dock method and the store does not synchronize it.

- [ ] **Step 3: Implement the minimal bridge/store wiring**

  Import `setDockIcon` beside `openExternal`. In `setProfile`, compare the previous effective avatar with the new profile and call the helper only when they differ. In `loadPreferences`, call the helper after `this.#patch({ ... profile ... })` using `profile.avatar` or `null`.

- [ ] **Step 4: Run the profile test and verify GREEN**

  Run `pnpm vitest run packages/ui/src/state/store.profile.test.ts`.

  Expected: all existing profile tests and the new bridge assertions pass.

- [ ] **Step 5: Commit the renderer synchronization**

  Run `git add packages/ui/src/lib/desktop.ts packages/ui/src/state/store.ts packages/ui/src/state/store.profile.test.ts && git commit -m "feat: sync profile picture with Dock icon"`.

### Task 3: Add the Electron bridge, packaging, and channel coverage

**Files:**
- Modify: `packages/desktop/electron/preload.cjs`
- Modify: `packages/desktop/electron/main.mjs`
- Modify: `packages/desktop/package.json`
- Modify: `packages/desktop/electron/ipc-channels.test.mjs`

**Interfaces:**
- Preload exposes `setDockIcon(avatar)` and sends `harnessdesk:set-dock-icon` only for `null` or a bounded string.
- Main registers `ipcMain.on('harnessdesk:set-dock-icon', ...)`, delegates to the tested setter, and reapplies no state itself beyond the renderer’s startup sync.
- electron-builder copies `assets/avatars/128/*.png` to the packaged `avatars/128` resource directory.

- [ ] **Step 1: Extend the IPC contract test first**

  Add `harnessdesk:set-dock-icon` to the expected channel assertions and assert that `main.mjs` contains the handler. Run `node --test packages/desktop/electron/ipc-channels.test.mjs` and verify RED until both preload and main speak the channel.

- [ ] **Step 2: Implement preload validation**

  Add:

  ```js
  setDockIcon: (avatar) => {
    if (avatar === null || (typeof avatar === 'string' && avatar.length <= 32)) {
      ipcRenderer.send('harnessdesk:set-dock-icon', avatar)
    }
  },
  ```

- [ ] **Step 3: Implement main-process resource wiring**

  Import the helper, derive development and packaged resource roots, create one setter, and register:

  ```js
  ipcMain.on('harnessdesk:set-dock-icon', (_event, avatar) => setDockIcon(avatar))
  ```

  Use `app.dock.setIcon()` only when the helper has produced a non-empty native image. Restore `app.icns` in packaged builds and `packages/desktop/build/icon.icns` in development.

- [ ] **Step 4: Package the avatar resources**

  Add an `extraResources` entry mapping `../../assets/avatars/128` to `avatars/128`, preserving the existing UI resource entry.

- [ ] **Step 5: Run desktop tests and verify GREEN**

  Run `pnpm --filter @harnessdesk/desktop test`.

  Expected: all desktop tests, including channel parity and packaging checks, pass.

- [ ] **Step 6: Commit the Electron bridge**

  Run `git add packages/desktop/electron/preload.cjs packages/desktop/electron/main.mjs packages/desktop/package.json packages/desktop/electron/ipc-channels.test.mjs && git commit -m "feat: apply profile picture to macOS Dock"`.

### Task 4: Run repository verification and review the implementation

**Files:**
- Modify only if verification exposes a real defect in the implementation.

- [ ] **Step 1: Run targeted tests and type checks**

  Run:

  ```bash
  node --test packages/desktop/electron/dock-icon.test.mjs packages/desktop/electron/ipc-channels.test.mjs
  pnpm vitest run packages/ui/src/state/store.profile.test.ts
  pnpm --filter @harnessdesk/desktop test
  ```

- [ ] **Step 2: Run the full unpiped verification gate**

  Run `pnpm verify` without piping its output. Record the exit status and every failing command if it fails.

- [ ] **Step 3: Inspect the final diff and public-data boundary**

  Run `git status --short`, `git diff origin/main...HEAD --check`, and inspect every changed file. Confirm no real account, handle, home path, screenshot, or unrelated dirty file is included.

- [ ] **Step 4: Request an independent code review**

  Review the implementation against issue #670, the design spec, and the exact base/head diff before acceptance testing. Fix all critical or important findings and rerun the affected tests.

### Task 5: Verify through the real app and publish a sanitized screenshot

**Files:**
- Create only temporary local artifacts under `output/` or the screenshot rig’s ignored directories.
- Modify the `screenshots` branch only for the final public screenshot asset if the repository’s existing workflow requires it.

- [ ] **Step 1: Stage the public fake-agent desk**

  Run `node script/shots/seed.mjs --clean` with the default fake data. Do not use a real `HARNESSDESK_HOME` or real checkout in a published frame.

- [ ] **Step 2: Launch the desktop build with CDP**

  Use the repository’s `script/lib/desk.mjs` launcher or the packaged smoke path with an isolated `HARNESSDESK_HOME`, then inspect the page through CDP. Navigate by accessible labels to Settings → HarnessDesk → Picture.

- [ ] **Step 3: Verify icon selection and reset**

  Choose the `Wizard` picture and capture CDP evidence that the preload/main path received `wizard` and called the macOS Dock setter. Click `Reset to default` and capture evidence that `null` restored the default icon. Relaunch the same isolated app and verify the stored `wizard` choice is applied during startup.

- [ ] **Step 4: Capture the feature screenshot**

  Capture a public-safe PNG showing the Settings → HarnessDesk → Picture page with the selected picture. Run the screenshot audit and visually inspect the frame before any publication.

- [ ] **Step 5: Publish screenshot through the `screenshots` branch**

  Add only the sanitized feature screenshot to the existing screenshot branch workflow, push that branch if needed for the PR asset, and verify the rendered raw asset URL. Do not add real-desk frames or account data.

- [ ] **Step 6: Create the PR with an evidence-backed description**

  Push `codex/issue-670-dock-icon`, then create the PR against `main` with:

  ```text
  feat: sync profile picture with macOS Dock icon

  Closes #670

  ## What changed
  - sync the selected global profile picture to the running macOS Dock icon
  - restore the default HarnessDesk icon on profile reset
  - reapply the stored choice after relaunch
  - package avatar resources and keep browser/non-macOS builds safe

  ## Verification
  - `pnpm verify`
  - focused desktop and profile tests
  - real Electron/CDP flow: select picture, reset, relaunch

  ## Screenshot
  Include the verified Markdown link to the sanitized PNG committed on the `screenshots` branch.
  ```

- [ ] **Step 7: Read back the published PR**

  Verify the PR title, body, changed files, screenshot rendering, CI checks, and head SHA. Report the PR URL and exact verification evidence.
