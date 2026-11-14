import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { beforePack as prepareLead, LEAD_NODE_DIR } from './fetch-lead-node.mjs'
import { LEAD_NODE } from '../electron/lead-runtime.mjs'
import { buildIosControl } from '../../../script/build-ios-control.mjs'

const DESKTOP_DIR = fileURLToPath(new URL('..', import.meta.url))

/**
 * Refuse to pack when an `extraResources` source is missing or empty.
 *
 * electron-builder skips a missing `from` without a word, which is how 0.7.1
 * was signed, notarized and published without `Contents/Resources/ui`: the
 * build ran `pnpm install` but not `pnpm build`, so `packages/ui/dist` did not
 * exist, and the app opened to "HarnessDesk is incomplete". The interface is
 * held to more than a non-empty folder, its `index.html`, because that is the
 * file the app serves first; an entry with a `filter` must hold at least one
 * of the literal paths that filter names.
 *
 * Returns the resolved sources it checked; throws one error naming every
 * entry at fault.
 */
export const checkExtraResources = ({ entries, arch, base = DESKTOP_DIR, fs = { existsSync, readdirSync, statSync } }) => {
  const problems = [], checked = []
  for (const entry of entries ?? []) {
    const from = typeof entry === 'string' ? entry : entry?.from
    if (typeof from !== 'string' || from === '') { problems.push(`an extraResources entry has no "from": ${JSON.stringify(entry)}`); continue }
    const source = resolve(base, from.replaceAll('${arch}', arch))
    checked.push(source)
    if (!fs.existsSync(source)) { problems.push(`"${from}" (${source}) does not exist`); continue }
    if (!fs.statSync(source).isDirectory()) continue
    if (fs.readdirSync(source).length === 0) { problems.push(`"${from}" (${source}) is an empty directory`); continue }
    // A filter can match nothing in a folder that is not empty, and that too is
    // skipped without a word. Its literal paths are what the entry exists to
    // ship, so at least one of them must be there; glob and negated patterns
    // cannot be checked without electron-builder's matcher and are left to it.
    const literal = (Array.isArray(entry?.filter) ? entry.filter : typeof entry?.filter === 'string' ? [entry.filter] : [])
      .filter((pattern) => typeof pattern === 'string' && pattern !== '' && !pattern.startsWith('!') && !/[*?[\]{}]/.test(pattern))
    if (literal.length > 0 && !literal.some((path) => fs.existsSync(join(source, path)))) {
      problems.push(`"${from}" (${source}) holds none of its filter's files: ${literal.join(', ')}`)
    }
  }
  const ui = resolve(base, '../ui/dist/index.html')
  if (!fs.existsSync(ui)) {
    problems.push(`the interface is not built: ${ui} is missing — run \`pnpm build\` from the repository root (\`build:node\` alone does not build the UI)`)
  }
  if (problems.length > 0) {
    throw new Error(`Refusing to pack ${arch}: electron-builder would silently leave these resources out of the app.\n  - ${problems.join('\n  - ')}`)
  }
  return checked
}

/** Both nested executables must exist before electron-builder copies and signs resources. */
export const beforePack = async (context) => {
  const arch = { 1: 'x64', 3: 'arm64' }[context.arch]
  if (context.electronPlatformName !== 'darwin' || !arch) throw new Error('Native iOS packaging requires a supported macOS architecture.')
  await buildIosControl({ arch, required: true })
  // Offline verification runs must never cause the existing Lead fetch hook to download a binary.
  if (process.env['HARNESSDESK_NO_DOWNLOADS'] === '1') {
    const folder=join(LEAD_NODE_DIR,arch), stamp=join(folder,'.verified')
    if (!existsSync(join(folder,'bin/node')) || !existsSync(stamp) || readFileSync(stamp,'utf8') !== `${LEAD_NODE.version} ${LEAD_NODE.sha256[arch]}\n`) throw new Error('Offline packaging requires the already verified Lead runtime cache; downloads are disabled.')
  }
  await prepareLead(context)
  // Last, so the Lead runtime and the iOS helper prepared above count as present.
  const manifest = JSON.parse(readFileSync(join(DESKTOP_DIR, 'package.json'), 'utf8'))
  checkExtraResources({ entries: manifest.build?.extraResources, arch })
}
