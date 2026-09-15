import { join } from 'node:path'

/**
 * The desktop shell cannot import the renderer's Vite module, so this is the
 * one deliberately duplicated catalogue of profile pictures it may load.
 * Keeping the allowlist here means an IPC value can never become a path.
 */
export const AVATAR_IDS = Object.freeze([
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

const AVATARS = new Set(AVATAR_IDS)

/** Resolves a shipped avatar id to a resource, or refuses it as an IPC value. */
export const avatarResourcePath = (avatar, root) =>
  typeof avatar === 'string' && AVATARS.has(avatar) ? join(root, `${avatar}.png`) : null

/** The immutable bundle icon used in development and by a packaged app. */
export const defaultIconPath = ({ packaged, resourcesPath, here }) =>
  packaged ? join(resourcesPath, 'icon.icns') : join(here, '../build/icon.icns')

/**
 * Creates the small native side effect behind the renderer's optional bridge.
 * The injected dependencies make the path and platform behavior testable
 * without importing Electron in a Node test.
 */
export const createDockIconSetter = ({
  platform,
  app,
  nativeImage,
  avatarRoot,
  defaultIcon,
}) => {
  return (avatar) => {
    if (platform !== 'darwin' || !app?.dock || typeof app.dock.setIcon !== 'function') return
    const path = avatar === null ? defaultIcon : avatarResourcePath(avatar, avatarRoot)
    if (!path) return
    const image = nativeImage.createFromPath(path)
    if (image.isEmpty()) return
    app.dock.setIcon(image)
  }
}
