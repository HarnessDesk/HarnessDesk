// Names the Electron bundle that `electron .` runs out of after the app.
//
//   node script/brand-dev-electron.mjs
//
// In development the process lives inside node_modules' own Electron.app, and macOS
// takes the Dock tooltip, the ⌘-Tab switcher and the app menu from that bundle's
// Info.plist — all of which say "Electron" until this runs. The packaged app never has
// the problem: electron-builder writes productName and build/icon.icns into its bundle.
//
// The edit is idempotent and a `pnpm install` that re-extracts dist/ undoes it, so
// `pnpm start` and `pnpm dev` run this first. LaunchServices caches bundle metadata, so
// the new name only reaches the Dock after `lsregister -f`.
//
// The bundle's ad-hoc signature is left alone on purpose: re-signing it would drop the
// JIT entitlements Electron's binary carries, and macOS launches the edited bundle as
// it is.
import { execFileSync } from 'node:child_process'
import { copyFileSync, existsSync, readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join, resolve } from 'node:path'

const name = 'HarnessDesk'
const root = resolve(import.meta.dirname, '..')
const icns = join(root, 'packages/desktop/build/icon.icns')

if (process.platform !== 'darwin') process.exit(0)

const require = createRequire(join(root, 'packages/desktop/package.json'))
let bundle
try {
  bundle = join(dirname(require.resolve('electron/package.json')), 'dist/Electron.app')
} catch {
  process.exit(0) // No Electron installed: nothing to brand, and nothing to run either.
}
if (!existsSync(bundle)) process.exit(0)

const plist = join(bundle, 'Contents/Info.plist')
const plistBuddy = (...args) => execFileSync('/usr/libexec/PlistBuddy', [...args, plist], { encoding: 'utf8' }).trim()

const bundleIcns = join(bundle, 'Contents/Resources/electron.icns')
const named = plistBuddy('-c', 'Print :CFBundleName') === name
const iconed = existsSync(icns) && existsSync(bundleIcns) && readFileSync(icns).equals(readFileSync(bundleIcns))
if (named && iconed) process.exit(0)

if (!named) plistBuddy('-c', `Set :CFBundleName ${name}`, '-c', `Set :CFBundleDisplayName ${name}`)
if (!iconed && existsSync(icns)) copyFileSync(icns, bundleIcns)

execFileSync(
  '/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister',
  ['-f', bundle],
)
console.log(`branded the development Electron bundle as ${name}`)
