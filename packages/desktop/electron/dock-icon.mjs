import { join } from 'node:path'

/**
 * The desktop shell cannot import the renderer's Vite module, so this is the
 * one deliberately duplicated catalogue of profile pictures it may load.
 * Keeping the allowlist here means an IPC value can never become a path, and
 * `dock-icon.test.mjs` holds it to the renderer's table so the two lists cannot
 * drift into a face that draws on the seat and does nothing on the Dock.
 *
 * Two families, two folders: the house mark's colourways are rendered from the
 * brand vectors by `pnpm run icons`, the whales are cut from generated sheets
 * by `pnpm run avatars`.
 */
export const MARK_IDS = Object.freeze([
  'mark-paper',
  'mark-ink',
  'mark-steel',
  'mark-blueprint',
  'mark-blueline',
  'mark-plain',
])

export const WHALE_IDS = Object.freeze([
  'blue',
  'violet',
  'reviewer',
  'guardian',
  'builder',
  'scout',
  'lead',
  'astronaut',
  'ninja',
  'sprout',
  'party',
  'wizard',
  'samurai',
  'winter',
  'dj',
  'chef',
  'scientist',
  'pilot',
  'shinobi',
  'cowboy',
  'alien',
  'knight',
  'beach',
])

/** Every face, in the order the picker reads them. */
export const AVATAR_IDS = Object.freeze([...MARK_IDS, ...WHALE_IDS])

const MARKS = new Set(MARK_IDS)

const AVATARS = new Set(AVATAR_IDS)

/**
 * Resolves a shipped avatar id to a resource, or refuses it as an IPC value.
 * `roots` is one directory per family: `{ marks, whales }`.
 */
export const avatarResourcePath = (avatar, roots) =>
  typeof avatar === 'string' && AVATARS.has(avatar)
    ? join(MARKS.has(avatar) ? roots.marks : roots.whales, `${avatar}.png`)
    : null

/**
 * The file the app's own face is read back from — what goes on the Dock when a
 * profile picture is cleared.
 *
 * It cannot be the bundle's `icon.icns`, which is the same artwork and the
 * obvious candidate: `nativeImage` has no .icns decoder and hands back an empty
 * image, so a reset would be dropped by the guard below and the Dock would keep
 * the avatar. `pnpm run icons` renders the same vector to this PNG, beside the
 * shell's other assets so the path is one thing in development and packaged —
 * cut in the container macOS draws an app icon in, because an icon set here is
 * drawn as given rather than masked (`assets/brand/README.md`).
 */
export const DEFAULT_ICON_FILE = 'dockIcon.png'

/** The app's own face, in the shell's assets directory. */
export const defaultIconPath = (assetsDir) => join(assetsDir, DEFAULT_ICON_FILE)

/**
 * Creates the small native side effect behind the renderer's optional bridge.
 * The injected dependencies make the path and platform behavior testable
 * without importing Electron in a Node test.
 */
export const createDockIconSetter = ({
  platform,
  app,
  nativeImage,
  avatarRoots,
  defaultIcon,
}) => {
  return (avatar) => {
    if (platform !== 'darwin' || !app?.dock || typeof app.dock.setIcon !== 'function') return
    const path = avatar === null ? defaultIcon : avatarResourcePath(avatar, avatarRoots)
    if (!path) return
    const image = nativeImage.createFromPath(path)
    // Empty means the file is missing or in a format Chromium cannot decode —
    // and a Dock icon set from an empty image is a blank tile.
    if (image.isEmpty()) return
    app.dock.setIcon(image)
  }
}
