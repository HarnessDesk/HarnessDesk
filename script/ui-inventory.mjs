#!/usr/bin/env node

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { repositoryFiles } from './lib/repository-files.mjs'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const output = path.join(root, 'docs/ui-system-migration-ledger.json')
const STARTING_COMMIT = '9f2d6dec1d8e7534c83a4c8d23d7b7d280fb3422'

const VISUAL_EXTENSIONS = new Set(['.css', '.html', '.jsx', '.svg', '.tsx'])
const SCRIPT_EXTENSIONS = new Set(['.js', '.mjs', '.ts'])
const EMBEDDED_VISUAL = /(?:innerHTML|outerHTML|createElement|createRoot|\.render\s*\(|<\/?(?:button|dialog|div|form|html|input|select|span|style|svg|textarea)\b)/
const TEST_PATH = /(?:^|\/)(?:__tests__|test|tests)\/|\.(?:spec|test)\.[cm]?[jt]sx?$/
const FIXTURE_PATH = /(?:^|\/)(?:fixtures?|examples?|showcase)\//

const record = (scope, owner, disposition, evidence) => ({ scope, owner, disposition, evidence })

export const classifyUiFile = (file) => {
  if (TEST_PATH.test(file)) return record('test', 'verification', 'verified-boundary', 'covered by the repository test gates')
  if (FIXTURE_PATH.test(file)) return record('fixture', 'catalog-fixture', 'verified-boundary', 'isolated deterministic fixture or example')
  if (/^(?:assets|packages\/ui\/src\/assets)\/brand\//.test(file)) return record('asset', 'brand-asset', 'specialized-boundary', 'brand artwork through the icon facade')
  if (/^docs\/(?:diagrams|images)\//.test(file)) return record('asset', 'documentation-asset', 'specialized-boundary', 'documentation-only rendered asset')
  if (/^script\//.test(file)) return record('tooling', 'ui-tooling', 'verified-boundary', 'generator or structural verification tool')
  if (/^packages\/ui\/src\/design\/(?:catalog|explorer)\//.test(file) || file === 'packages/ui/design.html') {
    return record('catalog', 'catalog', 'verified-boundary', 'registered live design.html implementation')
  }
  // Production ownership is intentionally not inferred from a directory.
  // The checked-in ledger is the explicit per-file authority. A newly added
  // screen, primitive, native asset, or embedded surface therefore lands as
  // pending until its owner, boundary and evidence are deliberately recorded.
  return record('production', 'unclassified', 'pending', 'new visual source requires an explicit owner and boundary')
}

const isVisual = (file, source) => {
  const extension = path.extname(file)
  if (VISUAL_EXTENSIONS.has(extension)) return true
  return SCRIPT_EXTENSIONS.has(extension) && EMBEDDED_VISUAL.test(source)
}

export const buildInventory = ({ files, read, overrides = {} }) => {
  const entries = []
  for (const file of [...files].sort()) {
    const source = read(file)
    if (!isVisual(file, source)) continue
    entries.push({ path: file, ...classifyUiFile(file), ...(overrides[file] ?? {}) })
  }
  const unresolved = entries
    .filter((entry) => entry.scope === 'production' && entry.disposition === 'pending')
    .map((entry) => entry.path)
  const summary = entries.reduce((counts, entry) => {
    counts.total += 1
    counts.byScope[entry.scope] = (counts.byScope[entry.scope] ?? 0) + 1
    counts.byDisposition[entry.disposition] = (counts.byDisposition[entry.disposition] ?? 0) + 1
    return counts
  }, { total: 0, byScope: {}, byDisposition: {} })
  return { version: 1, startingCommit: STARTING_COMMIT, entries, unresolved, summary }
}

const isMain = process.argv[1] != null && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)

if (isMain) {
  const files = repositoryFiles(root)
  const priorEntries = fs.existsSync(output)
    ? JSON.parse(fs.readFileSync(output, 'utf8')).entries ?? []
    : []
  const overrides = Object.fromEntries(priorEntries.map(({ path: file, ...entry }) => [file, entry]))
  const inventory = buildInventory({
    files,
    read: (file) => fs.readFileSync(path.join(root, file), 'utf8'),
    overrides,
  })
  const text = `${JSON.stringify(inventory, null, 2)}\n`
  if (process.argv.includes('--check')) {
    if (!fs.existsSync(output) || fs.readFileSync(output, 'utf8') !== text) {
      console.error('UI migration ledger is stale. Run: node script/ui-inventory.mjs')
      process.exit(1)
    }
    if (inventory.unresolved.length > 0) {
      console.error(`${inventory.unresolved.length} production UI files lack a terminal disposition.`)
      process.exit(1)
    }
    console.log(`${inventory.entries.length} UI-producing files have terminal dispositions.`)
  } else {
    fs.writeFileSync(output, text)
    console.log(`wrote ${path.relative(root, output)} (${inventory.entries.length} entries, ${inventory.unresolved.length} unresolved)`)
  }
}
