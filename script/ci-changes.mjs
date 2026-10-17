#!/usr/bin/env node
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { dirname, extname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { plan as deal, recordedSeconds, shardCount, specFiles } from './ci-browser-shards.mjs'
import { IMPORT, SOURCE, SPEC, repositoryGraph, resolveHelper, specsReaching, uiPackages } from './ci-imports.mjs'
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

const EXECUTION_CONFIG = /^(?:\.github\/workflows\/ci\.yml|playwright\.ui-system\.config\.ts)$/
// Source in the UI itself can use recorded reach. These other inputs affect
// the preview as a whole, even when one spec also reads their text directly.
const globalInput = (path, packages, external) => !path.startsWith('e2e/ui-system/') && !uiSource(path)
  && (BROWSER.some(pattern => pattern.test(path)) || packages.has(path.match(/^packages\/([^/]+)\//)?.[1]) || external.has(path))

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
// every spec that reads a changed file, directly or through other helpers.
// Null when the change cannot be traced: an unnamed data file, or a deleted
// helper with no remaining references.
export function affectedSpecs(root, changed, graph = repositoryGraph(root)) {
  const queue = []
  for (const path of changed) {
    if (DEAL_ONLY.test(path)) continue
    const file = join(root, path)
    if (!existsSync(file)) {
      if (graph.importers.has(file)) { queue.push(file); continue }
      if (SPEC.test(path)) continue
      return null
    }
    if (specsReaching(graph, [file]).length > 0) queue.push(file)
    else if (SOURCE.includes(extname(file))) queue.push(file)
    else return null
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

// Ordinary PRs spend at most four shards on inferred coverage. Edited specs are
// mandatory even if they alone exceed the time budget; they still use four runners.
export const PR_MAX_SHARDS = 4
export const PR_SHARD_SECONDS = 1000
export const ciTier = ({ event, headBranch = '', refName = '', labels = [] }) => {
  if (event === 'push' && refName === 'development') return 'bounded'
  return event !== 'pull_request' || headBranch === 'development' || headBranch.startsWith('batch/') || labels.includes('full-ci') ? 'full' : 'bounded'
}

function boundedSpecs(root, candidates, inputs, impact, graph, rotationKey = null) {
  const all = new Set(specFiles(root).map(spec => `e2e/ui-system/${spec}`))
  const mandatory = [...new Set([
    ...inputs.filter(path => SPEC.test(path) && all.has(path)),
    ...inputs.flatMap(path => specsReaching(graph, [join(root, path)]).map(file => relative(root, file)).filter(spec => all.has(spec))),
  ])]
  const seconds = recordedSeconds(root, 'pr')
  const specNames = specs => specs.map(spec => spec.slice('e2e/ui-system/'.length))
  const fits = specs => Math.max(...deal(specNames(specs), seconds, PR_MAX_SHARDS).map(shard => shard.load)) <= PR_SHARD_SECONDS
  // A spec reached by a small group of inputs is more specific than one reached
  // only by a shared stylesheet. Use the selector itself, including helper imports.
  const specificity = new Map()
  for (const path of fits(candidates) ? [] : inputs) {
    let reached = specsReaching(graph, [join(root, path)]).map(file => relative(root, file))
    if (path.startsWith('e2e/ui-system/')) reached = affectedSpecs(root, [path], graph)
    else if (impact && uiSource(path)) {
      const specs = impactPlan(root, [path], { ...impact, rankingOnly: true }).specs
      if (specs) reached.push(...specs.map(spec => `e2e/ui-system/${spec}`))
    }
    if (reached) reached = [...new Set(reached)]
    if (reached) for (const spec of reached) specificity.set(spec, Math.min(specificity.get(spec) ?? Infinity, reached.length))
  }
  const selected = [...new Set(mandatory)].sort()
  const overBudget = !fits(selected)
  const deferred = []
  const ordered = [...candidates].sort()
  const offset = rotationKey === null || ordered.length === 0 ? 0 : createHash('sha256').update(rotationKey).digest().readUInt32BE(0) % ordered.length
  const rotated = [...ordered.slice(offset), ...ordered.slice(0, offset)]
  const rank = new Map(rotated.map((spec, index) => [spec, index]))
  for (const spec of rotated.sort((a, b) => (specificity.get(a) ?? Infinity) - (specificity.get(b) ?? Infinity) || rank.get(a) - rank.get(b))) {
    if (selected.includes(spec)) continue
    if (fits([...selected, spec])) selected.push(spec)
    else deferred.push(spec)
  }
  let count = shardCount(specNames(selected), seconds, { target: PR_SHARD_SECONDS, max: PR_MAX_SHARDS })
  while (count < PR_MAX_SHARDS && count < selected.length && Math.max(...deal(specNames(selected), seconds, count).map(shard => shard.load)) > PR_SHARD_SECONDS) count++
  return { selected: selected.sort(), deferred: deferred.sort(), count, overBudget }
}

export function browserPlan(root, { browser, inputs, serverInputs, event, refName = '', tier = ciTier({ event, refName }), impact = null, unknownChange = false, unknownReason = 'change range unavailable', graph = null, packages = null, external = null, sha = '', before = '' }) {
  const all = specFiles(root).map(spec => `e2e/ui-system/${spec}`)
  let selected = null
  let basis = unknownChange ? `${unknownReason}; running every browser spec` : ''
  let resolvable = false
  let globals = []
  let executionConfig = false
  if (browser === 'all' && tier === 'bounded' && !unknownChange && inputs.length > 0) {
    graph ??= repositoryGraph(root)
    const readers = path => specsReaching(graph, [join(root, path)]).map(file => relative(root, file)).filter(spec => all.includes(spec))
    // Shot files belong to browser coverage only through actual readers.
    inputs = inputs.filter(path => !path.startsWith('script/shots/') || readers(path).length > 0)
    packages ??= uiPackages(root)
    external ??= uiExternalImports(root)
    globals = inputs.filter(path => globalInput(path, packages, external))
    executionConfig = inputs.some(path => EXECUTION_CONFIG.test(path))
    const suiteInputs = inputs.filter(path => path.startsWith('e2e/ui-system/'))
    const uiInputs = inputs.filter(path => !path.startsWith('e2e/ui-system/') && uiSource(path))
    const otherInputs = inputs.filter(path => !path.startsWith('e2e/ui-system/') && !uiSource(path))
    const reached = affectedSpecs(root, suiteInputs, graph)
    const readSpecs = inputs.flatMap(readers)
    const otherResolved = globals.length === 0 && otherInputs.every(path => readers(path).length > 0)
    const touched = uiInputs.length > 0 && impact ? impactPlan(root, uiInputs, impact) : { specs: uiInputs.length ? null : [] }
    // An unresolvable suite/read input cannot be sampled. Other inputs with an
    // available map can still use its per-file reach to rank a conservative cap.
    resolvable = reached !== null
    if (touched.specs === null) basis = oneLine(touched.reason ?? 'no impact map available')
    if (reached && touched.specs && otherResolved) {
      selected = [...new Set([...reached, ...readSpecs, ...touched.specs.map(spec => `e2e/ui-system/${spec}`), ...(serverInputs ? serverSpecs(root, uiPackages(root)) : [])])].sort()
      if (uiInputs.length > 0) basis = `the specs that ran the changed UI source (map of ${(impact.map.commit || 'main').slice(0, 9)})`
    }
    if (impact && selected === null && resolvable) {
      const environment = impact.baseEnvironment?.() ?? impact.map.environment
      if (Object.entries(impact.map.environment).some(([path, blob]) => environment?.[path] !== blob)) {
        basis = `map environment differs; ranking recorded reach before filling the cap${basis ? `; ${basis}` : ''}`
      }
    }
    if (globals.length > 0) basis = `global input ${globals.map(oneLine).join(', ')}${basis ? `; ${basis}` : ''}`
    if (executionConfig) basis = `suite execution configuration ${inputs.filter(path => EXECUTION_CONFIG.test(path)).map(oneLine).join(', ')}; running every browser spec`
  }
  if (browser === 'all' && selected && selected.length === 0) browser = 'none'
  const matrix = tier === 'bounded' ? 'pr' : 'full'
  // Global inputs keep the cap without needing a map. Unknown ranges, missing
  // maps needed for UI reach, and unresolved suite reads still run uncapped.
  const unnarrowedDevelopment = event === 'push' && refName === 'development' && selected === null && !((impact || globals.length > 0) && resolvable)
  if (unnarrowedDevelopment && !basis) basis = 'no usable impact selection; running every browser spec'
  const bounded = tier === 'bounded' && browser === 'all' && !unknownChange && !unnarrowedDevelopment && !executionConfig ? boundedSpecs(root, selected ?? all, inputs, impact, graph ?? repositoryGraph(root), globals.length > 0 ? sha || before : null) : null
  if (bounded && (selected !== null || bounded.deferred.length > 0)) selected = bounded.selected
  const count = browser === 'all'
    ? bounded?.count ?? shardCount(all.map(spec => spec.slice('e2e/ui-system/'.length)), recordedSeconds(root, matrix))
    : 0
  return {
    browser, matrix, count, tier, deferred: bounded?.deferred ?? [],
    // A run of the whole suite in both themes records what each spec ran, to plan the pull requests after it.
    record: browser === 'all' && matrix === 'full' && selected === null,
    specs: selected ? JSON.stringify(selected) : 'all',
    shards: JSON.stringify(Array.from({ length: Math.max(1, count) }, (_, index) => index + 1)),
    summary: `CI tier: ${tier}. ` + (browser === 'all'
      ? `Browser suite: ${selected ? `${selected.length} of ${all.length} specs` : `all ${all.length} specs`}, ${matrix === 'pr' ? 'pull-request' : 'full'} theme matrix, ${count} shard${count === 1 ? '' : 's'}.${basis ? ` ${basis.includes('map of') ? 'Selected by' : 'Not narrowed:'} ${basis}.` : ''}`
      : `Browser suite: ${browser === 'server' ? 'server-facing specs only' : 'not needed for this change'}.`) + (bounded?.overBudget ? ' Mandatory edited or reader specs exceed the planned time budget; all still run.' : '') + (bounded?.deferred.length ? ` Deferred to full tier (${bounded.deferred.length}): ${bounded.deferred.map(oneLine).join(', ')}.` : ''),
  }
}

export function changePlanner(root) {
  const packages = uiPackages(root)
  const graph = repositoryGraph(root)
  const prepared = { packages, graph, specs: serverSpecs(root, packages), external: uiExternalImports(root) }
  return options => planChange(root, options, prepared)
}

// CI's merge commit names its base as HEAD^1. A local caller can name its merge
// base instead, so theme and impact-map freshness answer for the same change.
export function planChange(root, { event, paths, headBranch = '', refName = '', labels = [], map = null, baseRevision = 'HEAD^1', sha = '', before = '' }, prepared = null) {
  const tier = ciTier({ event, headBranch, refName, labels })
  const knownPaths = paths?.length > 0 && paths.every(path => path.length > 0 && !path.startsWith('/') && !path.split('/').includes('..') && !/[\u0000-\u001f\u007f]/.test(path))
  const inputs = prepared?.packages ?? uiPackages(root)
  const specs = prepared?.specs ?? serverSpecs(root, inputs)
  let graph = prepared?.graph
  let external = prepared?.external
  let decision = { browser: 'all', native: true }
  let browserInputs = []
  let serverInputs = false
  let unknownChange = event === 'push' && refName === 'development' && !knownPaths
  let unknownReason
  if (tier === 'bounded' && paths) {
    try {
      // A name with a control character in it is not one to plan from: run everything.
      if (knownPaths) {
        graph ??= repositoryGraph(root)
        external ??= uiExternalImports(root)
        const uiInput = path => !DEAL_ONLY.test(path) && (!path.startsWith('script/shots/') || specsReaching(graph, [join(root, path)]).length > 0)
          && (BROWSER.some(pattern => pattern.test(path)) || inputs.has(path.match(/^packages\/([^/]+)\//)?.[1]) || external.has(path) || graph.importers.has(join(root, path)))
        browserInputs = paths.filter(uiInput)
        serverInputs = paths.some(path => /^packages\/(?!desktop\/)[^/]+\//.test(path) && !inputs.has(path.match(/^packages\/([^/]+)\//)?.[1]))
        decision = {
          browser: browserInputs.length > 0 ? 'all' : serverInputs ? 'server' : 'none',
          native: paths.some(path => NATIVE.some(pattern => pattern.test(path))),
        }
      }
    } catch {
      // An unreadable input graph keeps the conservative decision, as an unreadable diff does.
      unknownChange = event === 'push' && refName === 'development'
      unknownReason = 'input graph unavailable'
    }
  }
  const plan = browserPlan(root, {
    browser: decision.browser, inputs: browserInputs, serverInputs, event, refName, tier, unknownChange, unknownReason, graph, packages: inputs, external, sha, before: before || baseRevision,
    impact: map ? { map, baseFiles: () => filesAtBase(root, baseRevision), baseEnvironment: () => environmentAt(root, baseRevision) } : null,
  })
  return {
    browser: plan.browser, native: decision.native, server_specs: JSON.stringify(specs),
    browser_specs: plan.specs, matrix: plan.matrix, shard_count: plan.count, shards: plan.shards,
    record: plan.record, tier, summary: plan.summary,
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
    // A failed diff leaves no readable list. Development runs every browser spec.
  }
  const mapFile = process.env.UI_IMPACT_MAP
  const developmentPush = process.env.GITHUB_EVENT_NAME === 'push' && process.env.CI_REF_NAME === 'development'
  const plan = planChange(root, {
    event: process.env.GITHUB_EVENT_NAME, paths,
    headBranch: process.env.CI_HEAD_BRANCH ?? '', refName: process.env.CI_REF_NAME ?? '', labels: JSON.parse(process.env.CI_LABELS || '[]'),
    map: mapFile ? readMap(mapFile) : null,
    baseRevision: developmentPush ? process.env.CI_BEFORE || 'HEAD^1' : 'HEAD^1',
    sha: process.env.GITHUB_SHA ?? '', before: process.env.CI_BEFORE ?? '',
  })
  // Ordinary PRs defer integration to the full tier. Development pushes keep
  // the shared bounded browser selection; native smoke remains full-tier only.
  if (developmentPush) {
    plan.native = false
    plan.summary += ' Development push: selected from the pushed change. Native smoke runs in the full tier.'
  } else if (plan.tier === 'bounded') {
    const localSpecs = plan.browser === 'all'
      ? plan.browser_specs === 'all' ? specFiles(root).map(spec => `e2e/ui-system/${spec}`) : JSON.parse(plan.browser_specs)
      : plan.browser === 'server' ? JSON.parse(plan.server_specs) : []
    Object.assign(plan, {
      browser: 'none', native: false, browser_specs: '[]', shard_count: 0, shards: '[1]', record: false,
      summary: 'CI tier: bounded. Core CI only. Browser suite and native smoke run in the full tier (batch/ or full-ci). '
        + `Local check-push specs: ${localSpecs.length ? localSpecs.map(oneLine).join(', ') : 'none'}.`,
    })
  }
  process.stdout.write([
    `browser=${plan.browser}`, `native=${plan.native}`, `server_specs=${plan.server_specs}`,
    `browser_specs=${plan.browser_specs}`, `matrix=${plan.matrix}`, `shard_count=${plan.shard_count}`, `shards=${plan.shards}`, `record=${plan.record}`,
    `tier=${plan.tier}`, `summary=${plan.summary}`, '',
  ].join('\n'))
}
