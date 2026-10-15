#!/usr/bin/env node
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { dirname, extname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { recordedSeconds, shardCount, specFiles } from './ci-browser-shards.mjs'
import { IMPORT, SOURCE, SPEC, resolveHelper, specsReaching, suiteGraph, uiPackages } from './ci-imports.mjs'
import { environmentAt, filesAtBase, impactPlan, readMap, uiExternalImports, uiSource } from './ui-impact.mjs'

export { uiPackages }

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
  /^script\/(?:ci-changes|ci-imports|ci-unit-tests|ui-impact)(?:\.test)?\.mjs$/, // Changes to the selection policy must exercise both suites.
  /^script\/ui-impact\//, // The recording build of the test runner is the policy's evidence.
  /^script\/copy-fixtures\.mjs$/, // build:node copies fake-agent/test fixtures.
  /^script\/prune-dist\.mjs$/, // build:node validates/prunes the compiled output.
  /^assets\//, // UI imports avatar/brand images; the native shell also reads these assets.
  /^script\/shots\/(?:audit|cast)\.mjs$/, // Browser specs and native smoke use the frame audit and its synthetic identities.
  /^script\/check-secrets\.mjs$/, // The shared frame audit imports its public-text checks.
  /^script\/lib\/desk\.mjs$/, // Imported by the frame audit; native smoke also uses it to launch the desk.
]

export const sharedInputs = paths => paths.filter(path => SHARED.some(pattern => pattern.test(path)))

// The recorded spec times only change how the specs are dealt to shards. The
// plan's own tests (`script/ci-browser-plan.test.mjs`, in the gates job) check the
// deal; no browser needs to open for it.
const DEAL_ONLY = /^e2e\/ui-system\/durations(?:\.pr)?\.json$/

const BROWSER = [
  ...SHARED,
  /^playwright\.ui-system\.config\.ts$/, // Defines the browser suite and its Vite preview server.
  /^script\/ci-browser-shards\.mjs$/, // Deals the specs to the shards: a change to it changes what each shard runs.
  /^script\/(?:ui-system-run|ci-server-split)(?:\.test)?\.mjs$/, // The runner and classifier decide which server each selected spec reads.
  /^e2e\/ui-system\//, // Browser specs, helpers and recorded metrics live in this test directory.
]

const NATIVE = [
  ...SHARED,
  /^packages\/[^/]+\//, // Real shell and renderer start the built host and adapters; all packages count.
  /^e2e\/ui-system\/native-smoke\.mjs$/, // Native smoke entry point, including relaunch/appearance checks.
  /^script\/shots\//, // Native smoke seeds and drives the isolated fake-agent rig.
  /^script\/lib\//, // Native launch helpers and temporary-directory cleanup.
]

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
  const graph = suiteGraph(root)
  const queue = []
  for (const path of changed) {
    if (DEAL_ONLY.test(path)) continue
    const file = join(root, path)
    if (!existsSync(file)) {
      if (SPEC.test(path)) continue
      return null
    }
    if (!SOURCE.includes(extname(file))) return null
    queue.push(file)
  }
  return specsReaching(graph, queue).map(file => relative(root, file)).sort()
}


// How the dark theme is made is not always in the lines of a diff: a declaration
// added inside an existing `body[data-hd-dark-theme]` block names neither word.
// So a stylesheet that says "dark" or "theme" anywhere, before or after the
// change, reads both themes, and so does everything under the foundation and the
// shared styles, whatever the diff says.
const THEME_PATH = /^packages\/ui\/src\/(?:design\/foundation\/|styles\/)/
// The UI's own build and compiler configuration decides how everything renders.
const UI_BUILD = /^packages\/ui\/(?!src\/|site-demo\/)/

const textAtBase = (root, path, revision = 'HEAD^1') => {
  try {
    return execFileSync('git', ['show', `${revision}:${path}`], { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 64 * 1024 * 1024 })
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

// CI's grep pipeline, in the same order: changed lines, without diff headers,
// mentioning either word in any case. The workflow's pipeline is held by a test.
export const themeDiff = diff => diff.split('\n').some(line => /^[+-]/.test(line)
  && !/^(\+\+\+|---)/.test(line) && /dark|theme/i.test(line))

// Text that goes into a line of the step's outputs: a file name can hold a newline, and a newline
// in an output is a second output.
const oneLine = text => String(text).replace(/[\u0000-\u001f\u007f]+/g, ' ')

// What the browser job runs for this change, and how it is sized. A pull request
// that only touches the suite runs the specs it can reach, all of their tests.
// One that touches the UI's own source runs the specs in which that source ran,
// when there is a map of that (`impact`); without one, or when the map cannot
// speak for a file, it runs every spec. Either way it reads the geometry contracts
// in the light theme only, unless the diff itself is about themes (`themeTouched`):
// `main` and a manual run read both everywhere, and run every spec. See
// `playwright.ui-system.config.ts` for what the pull-request matrix leaves out.
export function browserPlan(root, { browser, inputs, serverInputs, event, themeTouched, request, baseText = textAtBase, impact = null }) {
  const all = specFiles(root).map(spec => `e2e/ui-system/${spec}`)
  let selected = null
  let basis = ''
  const suiteInputs = inputs.filter(path => path.startsWith('e2e/ui-system/'))
  const uiInputs = inputs.filter(path => !path.startsWith('e2e/ui-system/'))
  if (browser === 'all' && event === 'pull_request' && inputs.length > 0 && uiInputs.every(uiSource) && (uiInputs.length === 0 || impact)) {
    const reached = suiteInputs.length > 0 ? affectedSpecs(root, suiteInputs) : []
    const touched = uiInputs.length > 0 ? impactPlan(root, uiInputs, impact) : { specs: [] }
    if (uiInputs.length > 0 && touched.specs === null) basis = oneLine(touched.reason)
    if (reached && touched.specs) {
      selected = [...new Set([...reached, ...touched.specs.map(spec => `e2e/ui-system/${spec}`), ...(serverInputs ? serverSpecs(root, uiPackages(root)) : [])])].sort()
      if (uiInputs.length > 0) basis = `the specs that ran the changed UI source (map of ${(impact.map.commit || 'main').slice(0, 9)})`
    }
  }
  if (browser === 'all' && selected && selected.length === 0) browser = 'none'
  // Anything that can change how every page renders reads both themes: a shared
  // build input, the browser configuration that decides the matrix, the CI that
  // runs it, and any edit to the suite itself (its author wrote a test to see it
  // run, in the theme it names).
  const broad = inputs.some(path => SHARED.some(pattern => pattern.test(path)) || UI_BUILD.test(path) || path.startsWith('e2e/ui-system/') || /^playwright\.ui-system\.config\.ts$|^script\/ci-browser-shards\.mjs$/.test(path))
  const matrix = request === 'pr' || request === 'full'
    ? request
    : event === 'pull_request' && inputs.length > 0 && !themeTouched && !broad && !themeInputs(root, inputs, baseText) ? 'pr' : 'full'
  const specs = selected ?? all
  const count = browser === 'all'
    ? shardCount(specs.map(spec => spec.slice('e2e/ui-system/'.length)), recordedSeconds(root, matrix))
    : 0
  return {
    browser, matrix, count,
    // A run of the whole suite in both themes records what each spec ran, to plan the pull requests after it.
    record: browser === 'all' && matrix === 'full' && selected === null,
    specs: selected ? JSON.stringify(selected) : 'all',
    shards: JSON.stringify(Array.from({ length: Math.max(1, count) }, (_, index) => index + 1)),
    summary: browser === 'all'
      ? `Browser suite: ${selected ? `${selected.length} of ${all.length} specs` : `all ${all.length} specs`}, ${matrix === 'pr' ? 'pull-request' : 'full'} theme matrix, ${count} shard${count === 1 ? '' : 's'}.${basis ? ` ${selected ? 'Selected by' : 'Not narrowed:'} ${basis}.` : ''}`
      : `Browser suite: ${browser === 'server' ? 'server-facing specs only' : 'not needed for this change'}.`,
  }
}

// CI's merge commit names its base as HEAD^1. A local caller can name its merge
// base instead, so theme and impact-map freshness answer for the same change.
export function planChange(root, { event, paths, themeTouched = false, request = '', map = null, baseRevision = 'HEAD^1' }) {
  const inputs = uiPackages(root)
  const specs = serverSpecs(root, inputs)
  let decision = { browser: 'all', native: true }
  let browserInputs = []
  let serverInputs = false
  if (event === 'pull_request' && paths) {
    try {
      // A name with a control character in it is not one to plan from: run everything.
      if (paths.length > 0 && paths.every(path => path.length > 0 && !path.startsWith('/') && !path.split('/').includes('..') && !/[\u0000-\u001f\u007f]/.test(path))) {
        const external = uiExternalImports(root)
        const uiInput = path => !DEAL_ONLY.test(path) && (BROWSER.some(pattern => pattern.test(path)) || inputs.has(path.match(/^packages\/([^/]+)\//)?.[1]) || external.has(path))
        browserInputs = paths.filter(uiInput)
        serverInputs = paths.some(path => /^packages\/(?!desktop\/)[^/]+\//.test(path) && !inputs.has(path.match(/^packages\/([^/]+)\//)?.[1]))
        decision = {
          browser: browserInputs.length > 0 ? 'all' : serverInputs ? 'server' : 'none',
          native: paths.some(path => NATIVE.some(pattern => pattern.test(path))),
        }
      }
    } catch {
      // An unreadable input graph keeps the conservative decision, as an unreadable diff does.
    }
  }
  const plan = browserPlan(root, {
    browser: decision.browser, inputs: browserInputs, serverInputs, event,
    themeTouched, request, baseText: (root, path) => textAtBase(root, path, baseRevision),
    impact: map ? { map, baseFiles: () => filesAtBase(root, baseRevision), baseEnvironment: () => environmentAt(root, baseRevision) } : null,
  })
  return {
    browser: plan.browser, native: decision.native, server_specs: JSON.stringify(specs),
    browser_specs: plan.specs, matrix: plan.matrix, shard_count: plan.count, shards: plan.shards,
    record: plan.record, summary: plan.summary,
  }
}

// NUL delimiters keep spaces/newlines literal; --no-renames includes both
// paths of a moved input. Unreadable/empty/malformed paths run everything.
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const root = fileURLToPath(new URL('../', import.meta.url))
  let paths = null
  try {
    const raw = readFileSync(process.argv[2], 'utf8')
    paths = raw.endsWith('\0') ? raw.slice(0, -1).split('\0') : []
  } catch {
    // A failed diff leaves no readable list. Non-PR events run everything.
  }
  const mapFile = process.env.UI_IMPACT_MAP
  const plan = planChange(root, {
    event: process.env.GITHUB_EVENT_NAME, paths,
    themeTouched: process.env.UI_THEME_TOUCHED === 'true',
    request: process.env.UI_SYSTEM_MATRIX_REQUEST ?? '', map: mapFile ? readMap(mapFile) : null,
  })
  process.stdout.write([
    `browser=${plan.browser}`, `native=${plan.native}`, `server_specs=${plan.server_specs}`,
    `browser_specs=${plan.browser_specs}`, `matrix=${plan.matrix}`, `shard_count=${plan.shard_count}`, `shards=${plan.shards}`, `record=${plan.record}`,
    `summary=${plan.summary}`, '',
  ].join('\n'))
}
