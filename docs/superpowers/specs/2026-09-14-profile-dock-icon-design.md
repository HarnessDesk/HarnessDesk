# Profile Picture Dock Icon Design

## Goal

Selecting a picture in Settings → HarnessDesk → Picture also changes the
running macOS Dock/app icon. The preference is global to HarnessDesk, not tied
to a workspace or folder. Resetting the profile restores the default
HarnessDesk Dock icon.

## Scope and boundaries

- The existing profile preference remains the source of truth and continues to
  store only the avatar id, not image bytes or filesystem paths.
- The renderer sends the selected shipped avatar id across the existing
  Electron bridge. Browser and standalone-host builds continue to operate
  without a native icon side effect.
- The Electron main process validates the id against the shipped avatar
  catalogue, resolves the packaged PNG, and calls `app.dock.setIcon()` on
  macOS. Invalid ids and non-macOS calls are ignored safely.
- The profile is reapplied during startup after preferences load, so a custom
  Dock icon returns after relaunch. The bundle's on-disk icon remains the
  default product icon; the runtime Dock icon is the mutable surface.
- Avatar PNGs are included in the desktop package as runtime resources. The
  default icon is restored from the app's normal bundle icon rather than from
  an avatar asset.

## Data flow

1. `AppStore.setProfile()` applies the existing profile patch locally and
   persists it through `app/state/set`.
2. When the resulting avatar differs, the store calls an optional
   `setDockIcon(avatarId | null)` helper from `lib/desktop`.
3. The preload bridge validates the transport shape and sends the
   `harnessdesk:set-dock-icon` channel.
4. Electron main validates the allowlisted avatar id, loads the corresponding
   packaged PNG through `nativeImage`, and updates `app.dock`. `null` restores
   the default bundle icon.
5. `loadPreferences()` applies the stored profile and synchronizes the
   current icon once the profile is known.

The icon update is best effort and independent of preference persistence: a
missing resource or unsupported platform must not prevent the profile from
being saved or the renderer from starting.

## Testing

- Add a pure avatar-to-resource/default mapping test covering every supported
  avatar, reset, malformed ids, and non-macOS behavior.
- Extend the Electron bridge channel contract test so preload and main agree
  on the new channel.
- Add store tests proving avatar changes and reset invoke the optional bridge,
  while name-only changes do not alter the Dock icon.
- Run focused tests, the desktop/UI build and the repository verification gate.
- Launch the real Electron app with an isolated `HARNESSDESK_HOME`, navigate
  to the profile picture picker, choose a non-default face, and verify through
  Electron/CDP that the Dock icon update path receives the selected avatar and
  that Reset to default restores the default path. Also verify the persisted
  choice is reapplied after a relaunch.

## Acceptance criteria

- Choosing any shipped picture changes the running macOS Dock icon.
- Reset to default changes it back to the HarnessDesk mark.
- The selected picture survives relaunch because the existing profile
  preference remains persisted.
- No workspace record, workspace row, or per-folder icon state is introduced.
- Standalone browser builds and non-macOS Electron builds remain safe no-ops.
- No real account data, paths, or screenshots leave the local machine.
