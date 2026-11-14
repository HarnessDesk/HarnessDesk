import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join } from 'node:path'

/**
 * What a signature cannot prove: that the bundle holds the app.
 *
 * 0.7.1 was signed, notarized, stapled and accepted by `spctl`, and opened to
 * "HarnessDesk is incomplete" — packaged without `pnpm build`, so it carried
 * no interface. These checks read the bundle itself.
 */
export const APP_INTERFACE = 'Contents/Resources/ui/index.html'

/** Shared with the packaged smoke: no binary execution, no signature inspection. */
export function verifyAppInterface(app, { exists = existsSync } = {}) {
  if (!exists(join(app, APP_INTERFACE))) {
    throw new Error(`the app carries no interface: ${APP_INTERFACE} is missing — it was packaged without \`pnpm build\`.`)
  }
}

const plistVersion = (plist) =>
  execFileSync('plutil', ['-extract', 'CFBundleShortVersionString', 'raw', '-o', '-', plist], { encoding: 'utf8' }).trim()

export function verifyAppVersion(app, expected, { readVersion = plistVersion } = {}) {
  let actual
  try { actual = readVersion(join(app, 'Contents/Info.plist')) }
  catch (error) { throw new Error('the app\'s Info.plist has no readable CFBundleShortVersionString.', { cause: error }) }
  if (actual !== expected) {
    throw new Error(`the app says it is version ${actual}, but packages/desktop/package.json says ${expected}.`)
  }
}

/** The release check: the interface is there and the bundle is the version being published. */
export function verifyAppContents(app, expected, options = {}) {
  verifyAppInterface(app, options)
  verifyAppVersion(app, expected, options)
}
