#!/usr/bin/env node
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { basename, dirname, extname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { recordedSeconds, shardCount, specFiles } from './ci-browser-shards.mjs'

// Shared inputs are written once and included in both job lists below.
const SHARED = [
  /^package\.json$/, // Root scripts and tool dependencies define both installs/builds.
  /^pnpm-lock\.yaml$/, // Both jobs install this exact dependency graph.
  /^pnpm-workspace\.yaml$/, // Defines the workspace packages both jobs resolve.
  /^\.node-version$/, // Root runtime/tool configuration.
  /^\.(?:npmrc|pnpmfile\.cjs)$/, // Package-manager configuration can change either install.
  /^tsconfig(?:\.[^/]*)?\.json$/, // Root solution and compiler options used by build:node.
  /^(?:vite|vitest|playwright|eslint|prettier|babel|postcss|tailwind)\.config\.[^/]+$/, // Root tool configuration.
  /^\.github\/workflows\/ci\.yml$/, // Changes to CI must exercise the whole new workflow.
  /^script\/ci-changes(?:\.test)?\.mjs$/, // Changes to the selection policy must exercise both suites.
  /^script\/copy-fixtures\.mjs$/, // build:node copies fake-agent/test fixtures.
  /^script\/prune-dist\.mjs$/, // build:node validates/prunes the compiled output.
  /^assets\//, // UI imports avatar/brand images; the native shell also reads these assets.
  /^script\/shots\/(?:audit|cast)\.mjs$/, // Browser specs and native smoke use the frame audit and its synthetic identities.
  /^script\/check-secrets\.mjs$/, // The shared frame audit imports its public-text checks.
  /^script\/lib\/desk\.mjs$/, // Imported by the frame audit; native smoke also uses it to launch the desk.
]

// The recorded spec times only change how the specs are dealt to shards. The
// plan's own tests (`script/ci-browser-plan.test.mjs`, in the gates job) check the
// deal; no browser needs to open for it.
const DEAL_ONLY = /^e2e\/ui-system\/durations(?:\.pr)?\.json$/

const BROWSER = [
  ...SHARED,
  /^playwright\.ui-system\.config\.ts$/, // Defines the browser suite and its Vite preview server.
  /^script\/ci-browser-shards\.mjs$/, // Deals the specs to the shards: a change to it changes what each shard runs.
  /^e2e\/ui-system\//, // Browser specs, helpers and recorded metrics live in this test directory.
]

const NATIVE = [
  ...SHARED,
  /^packages\/[^/]+\//, // Real shell and renderer start the built host and adapters; all packages count.
  /^e2e\/ui-system\/native-smoke\.mjs$/, // Native smoke entry point, including relaunch/appearance checks.
  /^script\/shots\//, // Native smoke seeds and drives the isolated fake-agent rig.
  /^script\/lib\//, // Native launch helpers and temporary-directory cleanup.
]

// Resolve the UI's transitive workspace inputs from manifests, so adding a
// workspace dependency cannot silently leave it outside full browser coverage.
export function uiPackages(root) {
  const manifests = new Map(readdirSync(join(root, 'packages'), { withFileTypes: true })
    .filter(entry => entry.isDirectory())
    .map(entry => {
      const manifest = JSON.parse(readFileSync(join(root, 'packages', entry.name, 'package.json'), 'utf8'))
      return [manifest.name, { directory: entry.name, manifest }]
    }))
  const inputs = new Set()
  const visit = name => {
    const entry = manifests.get(name)
    if (!entry) throw new Error(`Unknown workspace input: ${name}`)
    if (inputs.has(entry.directory)) return
    inputs.add(entry.directory)
    const dependencies = { ...entry.manifest.dependencies, ...entry.manifest.devDependencies, ...entry.manifest.optionalDependencies }
    for (const [dependency, version] of Object.entries(dependencies)) {
      if (String(version).startsWith('workspace:')) visit(dependency)
    }
  }
  visit('@harnessdesk/ui')
  return inputs
}

const SOURCE = ['.ts', '.tsx', '.mts', '.cts', '.mjs', '.cjs', '.js', '.jsx']
const IMPORT = /(?:\bfrom\s*|\bimport\s*(?:\(\s*)?|\brequire\s*\(\s*)['"]([^'"\n]+)['"]/g

// The source file a relative import names, or null for an asset (`./frame.png`).
// A source file that is not there is an error and not a skip: a selection that
// quietly lost an edge would run too little.
const resolveHelper = (file, specifier) => {
  const base = resolve(dirname(file), specifier)
  const extension = extname(base)
  const helper = [base, ...SOURCE.map(ext => `${base}${ext}`),
    base.replace(/\.js$/, '.ts'), base.replace(/\.mjs$/, '.mts'), base.replace(/\.cjs$/, '.cts'),
    ...SOURCE.map(ext => join(base, `index${ext}`))]
    .find(candidate => existsSync(candidate) && SOURCE.includes(extname(candidate)))
  if (helper) return helper
  if (extension && !SOURCE.includes(extension)) return null
  throw new Error(`Cannot resolve suite import: ${specifier}`)
}

const URL_IMPORT = /new\s+URL\(\s*['"](\.[^'"\n]*)['"]\s*,\s*import\.meta\.url\s*\)/g

// The source file a path names, or null: unlike an import, a URL may name a folder or a data file.
const findSource = (file, specifier) => {
  const base = resolve(dirname(file), specifier)
  return [base, ...SOURCE.map(ext => `${base}${ext}`)].find(candidate => existsSync(candidate) && statSync(candidate).isFile() && SOURCE.includes(extname(candidate))) ?? null
}

const mentions = (text, helper) => {
  const stem = basename(helper, extname(helper))
  return stem.length >= 4 && new RegExp(`(?<![\\w-])${stem.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![\\w-])`).test(text)
}

// Literal static/dynamic imports and re-exports, including those in local
// helpers. Over-selection (for example an import in a comment) is harmless;
// no manual spec list can become stale when a spec starts reading host code.
export function serverSpecs(root, inputs) {
  const suite = join(root, 'e2e/ui-system')
  const files = directory => readdirSync(directory, { withFileTypes: true }).flatMap(entry =>
    entry.isDirectory() ? files(join(directory, entry.name)) : [join(directory, entry.name)])
  const readsOutside = (file, seen = new Set()) => {
    if (seen.has(file)) return false
    seen.add(file)
    const source = readFileSync(file, 'utf8')
    for (const [, specifier] of source.matchAll(IMPORT)) {
      const path = specifier.startsWith('.') ? relative(root, resolve(dirname(file), specifier)) : specifier
      const pkg = path.match(/^(?:packages\/|@harnessdesk\/)([^/]+)/)?.[1]
      if (pkg && !inputs.has(pkg)) return true
      if (specifier.startsWith('.') && !pkg) {
        const helper = resolveHelper(file, specifier)
        if (helper && readsOutside(helper, seen)) return true
      }
    }
    return false
  }
  return files(suite).filter(file => /\.spec\.[cm]?[jt]sx?$/.test(file) && readsOutside(file))
    .map(file => relative(root, file)).sort()
}

// The specs a change to files of the suite can reach: a changed spec itself, and
// every spec that imports a changed helper, directly or through other helpers.
// Null when the change cannot be traced to specs, and the caller runs them all:
// a data file a spec reads at run time, or a helper that was deleted and so has
// no importers left to find.
export function affectedSpecs(root, changed) {
  const suite = join(root, 'e2e/ui-system')
  const files = directory => readdirSync(directory, { withFileTypes: true }).flatMap(entry =>
    entry.isDirectory() ? files(join(directory, entry.name)) : [join(directory, entry.name)])
  const importers = new Map()
  const edge = (helper, file) => importers.set(helper, new Set([...(importers.get(helper) ?? []), file]))
  const sources = files(suite).filter(file => SOURCE.includes(extname(file)))
  const helpers = sources.filter(file => !/\.spec\.[cm]?[jt]sx?$/.test(file))
  for (const file of sources) {
    const text = readFileSync(file, 'utf8')
    for (const [, specifier] of text.matchAll(IMPORT)) {
      if (!specifier.startsWith('.')) continue
      const helper = resolveHelper(file, specifier)
      if (helper) edge(helper, file)
    }
    // A file named by `new URL('./helper', import.meta.url)` is loaded at run time, by a child process or a worker.
    for (const [, specifier] of text.matchAll(URL_IMPORT)) {
      const helper = findSource(file, specifier)
      if (helper) edge(helper, file)
    }
    // A file that names a helper any other way (a path built by hand, a name in a string) is taken to use it:
    // a scan that missed an edge would run too little, one that found a stray edge runs a spec too many.
    for (const helper of helpers) {
      if (helper !== file && mentions(text, helper)) edge(helper, file)
    }
  }
  const queue = []
  for (const path of changed) {
    if (DEAL_ONLY.test(path)) continue
    const file = join(root, path)
    if (!existsSync(file)) {
      if (/\.spec\.[cm]?[jt]sx?$/.test(path)) continue
      return null
    }
    if (!SOURCE.includes(extname(file))) return null
    queue.push(file)
  }
  const reached = new Set()
  while (queue.length > 0) {
    const file = queue.pop()
    if (reached.has(file)) continue
    reached.add(file)
    queue.push(...(importers.get(file) ?? []))
  }
  return [...reached].filter(file => /\.spec\.[cm]?[jt]sx?$/.test(file) && file.startsWith(`${suite}/`))
    .map(file => relative(root, file)).sort()
}

// How the dark theme is made is not always in the lines of a diff: a declaration
// added inside an existing `body[data-hd-dark-theme]` block names neither word.
// So a stylesheet that says "dark" or "theme" anywhere, before or after the
// change, reads both themes, and so does everything under the foundation and the
// shared styles, whatever the diff says.
const THEME_PATH = /^packages\/ui\/src\/(?:design\/foundation\/|styles\/)/
// The UI's own build and compiler configuration decides how everything renders.
const UI_BUILD = /^packages\/ui\/(?!src\/|site-demo\/)/

const textAtBase = (root, path) => {
  try {
    return execFileSync('git', ['show', `HEAD^1:${path}`], { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 64 * 1024 * 1024 })
  } catch {
    return null
  }
}

export function themeInputs(root, inputs, baseText = textAtBase) {
  const says = text => text !== null && text !== undefined && /dark|theme/i.test(text)
  return inputs.some(path => THEME_PATH.test(path)
    || (path.startsWith('packages/ui/') && path.endsWith('.css')
      && (says(existsSync(join(root, path)) ? readFileSync(join(root, path), 'utf8') : null) || says(baseText(root, path)))))
}

// What the browser job runs for this change, and how it is sized. A pull request
// that only touches the suite runs the specs it can reach, all of their tests;
// a pull request that touches the UI runs every spec, but reads the geometry
// contracts in the light theme only, unless the diff itself is about themes
// (`themeTouched`): `main` and a manual run read both everywhere. See
// `playwright.ui-system.config.ts` for what the pull-request matrix leaves out.
export function browserPlan(root, { browser, inputs, serverInputs, event, themeTouched, request, baseText = textAtBase }) {
  const all = specFiles(root).map(spec => `e2e/ui-system/${spec}`)
  let selected = null
  if (browser === 'all' && event === 'pull_request' && inputs.length > 0 && inputs.every(path => path.startsWith('e2e/ui-system/'))) {
    const reached = affectedSpecs(root, inputs)
    if (reached) selected = [...new Set([...reached, ...(serverInputs ? serverSpecs(root, uiPackages(root)) : [])])].sort()
  }
  if (browser === 'all' && selected && selected.length === 0) browser = 'none'
  // Anything that can change how every page renders reads both themes: a shared
  // build input, the browser configuration that decides the matrix, the CI that
  // runs it, and any edit to the suite itself (its author wrote a test to see it
  // run, in the theme it names).
  const broad = inputs.some(path => SHARED.some(pattern => pattern.test(path)) || UI_BUILD.test(path) || path.startsWith('e2e/ui-system/') || /^playwright\.ui-system\.config\.ts$|^script\/ci-browser-shards\.mjs$/.test(path))
  const matrix = request === 'pr' || request === 'full'
    ? request
    : event === 'pull_request' && inputs.length > 0 && selected === null && !themeTouched && !broad && !themeInputs(root, inputs, baseText) ? 'pr' : 'full'
  const specs = selected ?? all
  const count = browser === 'all'
    ? shardCount(specs.map(spec => spec.slice('e2e/ui-system/'.length)), recordedSeconds(root, matrix))
    : 0
  return {
    browser, matrix, count,
    specs: selected ? JSON.stringify(selected) : 'all',
    shards: JSON.stringify(Array.from({ length: Math.max(1, count) }, (_, index) => index + 1)),
    summary: browser === 'all'
      ? `Browser suite: ${selected ? `${selected.length} of ${all.length} specs` : `all ${all.length} specs`}, ${matrix === 'pr' ? 'pull-request' : 'full'} theme matrix, ${count} shard${count === 1 ? '' : 's'}.`
      : `Browser suite: ${browser === 'server' ? 'server-facing specs only' : 'not needed for this change'}.`,
  }
}

// NUL delimiters keep spaces/newlines literal; --no-renames includes both
// paths of a moved input. Unreadable/empty/malformed paths run everything.
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const root = fileURLToPath(new URL('../', import.meta.url))
  const inputs = uiPackages(root)
  const specs = serverSpecs(root, inputs)
  const event = process.env.GITHUB_EVENT_NAME
  let decision = { browser: 'all', native: true }
  let browserInputs = []
  let serverInputs = false
  if (event === 'pull_request') {
    try {
      const raw = readFileSync(process.argv[2], 'utf8')
      const paths = raw.endsWith('\0') ? raw.slice(0, -1).split('\0') : []
      if (paths.length > 0 && paths.every(path => path.length > 0 && !path.startsWith('/') && !path.split('/').includes('..'))) {
        const uiInput = path => !DEAL_ONLY.test(path) && (BROWSER.some(pattern => pattern.test(path)) || inputs.has(path.match(/^packages\/([^/]+)\//)?.[1]))
        browserInputs = paths.filter(uiInput)
        serverInputs = paths.some(path => /^packages\/(?!desktop\/)[^/]+\//.test(path))
        decision = {
          browser: browserInputs.length > 0 ? 'all' : serverInputs ? 'server' : 'none',
          native: paths.some(path => NATIVE.some(pattern => pattern.test(path))),
        }
      }
    } catch {
      // A failed diff leaves no readable list. Non-PR events run everything.
    }
  }
  const plan = browserPlan(root, {
    browser: decision.browser, inputs: browserInputs, serverInputs, event,
    themeTouched: process.env.UI_THEME_TOUCHED === 'true',
    request: process.env.UI_SYSTEM_MATRIX_REQUEST ?? '',
  })
  process.stdout.write([
    `browser=${plan.browser}`, `native=${decision.native}`, `server_specs=${JSON.stringify(specs)}`,
    `browser_specs=${plan.specs}`, `matrix=${plan.matrix}`, `shard_count=${plan.count}`, `shards=${plan.shards}`,
    `summary=${plan.summary}`, '',
  ].join('\n'))
}
