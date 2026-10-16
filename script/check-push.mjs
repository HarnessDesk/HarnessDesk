#!/usr/bin/env node
// The change, rather than the checkout, decides the work. CI owns the selection;
// this runner only puts a local budget around it. Nothing here installs or fetches.
//
// --plan (also --dry-run) prints { base, mergeBase, paths, notes, ci: { change, unit },
// steps: [{ name, status: 'run' | 'skipped', command, args, env, needs, reason }] }.
// A skipped step has a reason; env, needs and the gate group are optional.
import { execFileSync, spawn } from 'node:child_process'
import { copyFileSync, existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { createRequire } from 'node:module'
import { homedir, tmpdir } from 'node:os'
import { dirname, join, relative, resolve } from 'node:path'
import { performance } from 'node:perf_hooks'
import { fileURLToPath } from 'node:url'

import { planChange, sharedInputs, themeDiff } from './ci-changes.mjs'
import { recordedSeconds } from './ci-browser-shards.mjs'
import { IMPORT, SPEC, uiPackages } from './ci-imports.mjs'
import { unitPlan } from './ci-unit-tests.mjs'
import { readMap } from './ui-impact.mjs'
import { ciCommands } from './check-verify-drift.mjs'

const gate = (file, paths, scope, args = []) => ({
  name: file, command: 'node', args: [`script/${file}.mjs`, ...args], scope,
  paths: [...paths, new RegExp(`^script/${file}\\.mjs$`), /^script\/lib\//],
})
const packages = /^packages\//
const ui = /^packages\/ui\//
const designScripts = /^script\/(?:design-(?:audit|doc|tokens|sections|usage)|ui-(?:architecture|catalog))\.mjs$/

// Each row names everything the gate reads, including its helpers. Broad rows
// are deliberate: removing a path can break a document that still names it.
export const GATES = [
  gate('check-layering', [packages], 'package source and boundaries'),
  gate('check-half-applied-fixes', [packages], 'package source'),
  gate('check-secrets', [/./], 'every publishable changed file'),
  gate('check-reachable', [/^packages\/(?:protocol|ui|desktop|client|cli)\//], 'wire declarations and their callers'),
  gate('check-claims', [packages, /^script\/recorded-claims\.json$/], 'recorded claims and the tests they name'),
  gate('check-doc-paths', [/./], 'documents and the paths they name'),
  gate('check-notices', [/^THIRD_PARTY_NOTICES\.md$/, /^licenses\//, /^packages\/[^/]+\/package\.json$/, /^package\.json$/, /^pnpm-lock\.yaml$/], 'licences and dependency manifests'),
  gate('check-design-tokens', [/^packages\/ui\/src\/(?:design\/|styles\/)/, /^packages\/desktop\/electron\/assets\/about-foundation\.css$/, /^script\/design-tokens\.mjs$/], 'token sources and snapshots'),
  gate('design-audit', [ui, designScripts], 'UI source, audit policy and baseline', ['--strict']),
  gate('check-ui-system', [ui, /^script\/ui-(?:architecture|catalog)\.mjs$/, /^script\/ui-catalog-surfaces\.json$/], 'UI source and catalogue policy'),
  gate('check-interface-drift', [ui, /^script\/design-tokens\.mjs$/], 'UI source and token resolution'),
  gate('check-alignment-census', [/^packages\/ui\/src\/design\/alignment-census\.json$/, /^e2e\/ui-system\/alignment-census\.spec\.ts$/], 'the census table and its spec'),
  gate('design-doc', [/^packages\/ui\/src\/design\//, /^packages\/ui\/src\/styles\//, /^docs\/design-system\.md$/, designScripts], 'design source and generated reference', ['--check']),
  gate('cli-doc', [/^packages\/cli\//, /^docs\/cli\.md$/], 'CLI source and generated reference', ['--check']),
  gate('check-verify-drift', [/^script\/verify\.mjs$/, /^\.github\/workflows\/ci\.yml$/], 'the full gate and workflow commands'),
  gate('check-verify-steps', [/^(?:AGENTS|CONTRIBUTING)\.md$/, /^script\/verify\.mjs$/], 'the full gate and its two descriptions'),
]

// The Gates job also installs, builds and runs every script test. These are
// accounted for, but the local command neither installs nor runs broad suites.
export const LEFT_TO_CI = {
  'pnpm install --frozen-lockfile': 'CI installs the frozen dependency graph; this command uses the local install and never accesses the network.',
  'pnpm run build': 'CI builds every target; locally only a needed incremental Node build runs.',
  'node --test script/*.test.mjs': 'CI runs all script tests; locally changed scripts and the shared planners select their tests.',
}

export function workflowJob(yaml, name) {
  const body = yaml.match(new RegExp(`^  ${name}:\\s*\\n([\\s\\S]*?)(?=^  [\\w-]+:|$(?![\\s\\S]))`, 'm'))?.[1]
  if (!body) throw new Error(`Cannot read CI job: ${name}`)
  return body
}

const git = (root, args) => execFileSync('git', args, {
  cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 64 * 1024 * 1024,
})
const nulPaths = text => text.split('\0').filter(Boolean)
export function readChange(root, base = 'origin/main') {
  let mergeBase
  let baseCommit
  try {
    baseCommit = git(root, ['rev-parse', '--verify', '--end-of-options', `${base}^{commit}`]).trim()
    mergeBase = git(root, ['merge-base', baseCommit, 'HEAD']).trim()
  } catch {
    const error = new Error(`Cannot read base ref ${JSON.stringify(base)} or its merge base with HEAD. Make the ref available locally, or use --base <ref>; no fetch was attempted.`)
    error.exitCode = 2
    throw error
  }
  // How far the base has moved on since this branch left it: CI merges the branch into the base as it is then.
  const behind = Number(git(root, ['rev-list', '--count', `${mergeBase}..${baseCommit}`]).trim())
  const dirty = nulPaths(git(root, ['status', '--porcelain', '-z', '--no-renames', '--untracked-files=all'])).map(entry => entry.slice(3))
  const untracked = nulPaths(git(root, ['ls-files', '--others', '--exclude-standard', '-z']))
  const paths = [...new Set([...nulPaths(git(root, ['diff', '--no-renames', '--name-only', '-z', mergeBase, '--'])), ...untracked])].sort()
  let themeTouched = themeDiff(git(root, ['diff', '--no-renames', '-U0', mergeBase, '--', 'packages/ui']))
  // An untracked UI file is an addition too; it has no git diff yet.
  if (!themeTouched) themeTouched = untracked.some(path => path.startsWith('packages/ui/')
    && themeDiff(readFileSync(join(root, path), 'utf8').split('\n').map(line => `+${line}`).join('\n')))
  return { base, mergeBase, paths, themeTouched, behind, dirty }
}

const files = directory => !existsSync(directory) ? [] : readdirSync(directory, { withFileTypes: true })
  .flatMap(entry => entry.isDirectory() ? files(join(directory, entry.name)) : [join(directory, entry.name)])
const manifests = root => readdirSync(join(root, 'packages'), { withFileTypes: true })
  .filter(entry => entry.isDirectory() && existsSync(join(root, 'packages', entry.name, 'package.json')))
  .map(entry => ({ directory: entry.name, ...JSON.parse(readFileSync(join(root, 'packages', entry.name, 'package.json'), 'utf8')) }))
const globPattern = glob => new RegExp(`^${glob.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replaceAll('*', '.*')}$`)
const workflow = root => readFileSync(join(root, '.github/workflows/ci.yml'), 'utf8')

function packageTests(root, paths) {
  const entries = manifests(root)
  const changed = new Set(paths.filter(path => /^packages\/[^/]+\/(?:src|test)\//.test(path)).map(path => path.split('/')[1]))
  const reached = new Set(changed)
  // Dependants, including test-only workspace dependencies, to the end of the chain.
  let grew = true
  while (grew) {
    grew = false
    for (const entry of entries) {
      const dependencies = { ...entry.dependencies, ...entry.devDependencies, ...entry.optionalDependencies }
      if (!reached.has(entry.directory) && entries.some(dependency => reached.has(dependency.directory)
        && String(dependencies[dependency.name] ?? '').startsWith('workspace:'))) {
        reached.add(entry.directory)
        grew = true
      }
    }
  }
  const exclusions = ciCommands(workflowJob(workflow(root), 'node-e2e'))
    .filter(step => step.command === 'node' && step.args.includes('--test'))
    .flatMap(step => step.args.filter(arg => arg.startsWith('packages/') && arg.endsWith('.test.js'))).map(globPattern)
  return { changed, tests: entries.filter(entry => reached.has(entry.directory) && existsSync(join(root, 'packages', entry.directory, 'tsconfig.json')))
    .map(entry => {
      const base = join(root, 'packages', entry.directory)
      const sources = [...files(join(base, 'test')), ...files(join(base, 'src/test'))].filter(file => /\.test\.ts$/.test(file))
      const tests = sources.map(file => `packages/${entry.directory}/dist/test/${relative(file.includes(`${join(base, 'src/test')}/`) ? join(base, 'src/test') : join(base, 'test'), file).replace(/\.ts$/, '.js')}`)
        .filter(file => !exclusions.some(pattern => pattern.test(file))).sort()
      return { name: entry.directory, direct: changed.has(entry.directory), files: tests }
    }).filter(entry => entry.files.length > 0) }
}

const PLANNERS = ['ci-changes', 'ci-unit-tests', 'ci-unit-shards', 'ui-impact', 'ci-imports', 'ci-browser-plan', 'ci-browser-shards']
function scriptTests(root, paths) {
  const dependencies = new Set()
  const visit = file => {
    if (dependencies.has(file) || !existsSync(join(root, file))) return
    dependencies.add(file)
    for (const [, specifier] of readFileSync(join(root, file), 'utf8').matchAll(IMPORT)) {
      if (specifier.startsWith('.') && specifier.endsWith('.mjs')) visit(relative(root, resolve(root, dirname(file), specifier)))
    }
  }
  for (const name of PLANNERS) visit(`script/${name}.mjs`)
  const selected = paths.filter(path => /^script\/[^/]+(?:\.test)?\.mjs$/.test(path))
    .map(path => path.endsWith('.test.mjs') ? path : path.replace(/\.mjs$/, '.test.mjs'))
  // The workflow, the browser configuration, the recorded times and the contributor guide are read by those tests.
  const read = /^(?:\.github\/workflows\/ci\.yml|playwright\.ui-system\.config\.ts|e2e\/ui-system\/durations(?:\.pr)?\.json|script\/ci-unit-durations\.json|CONTRIBUTING\.md|package\.json)$/
  // `ci-planners.test.mjs` is the guard that these files need nothing installed (CI plans before the install),
  // so it follows the same trigger: a bare import added anywhere in their closure must fail here, not in CI.
  if (paths.some(path => dependencies.has(path) || read.test(path))) selected.push(...PLANNERS.map(name => `script/${name}.test.mjs`), 'script/ci-planners.test.mjs')
  // Discovery, unique substring filters and shell-safe names depend on the UI
  // config and test inventory. Check paths alone so additions/deletions count.
  if (paths.some(path => /^packages\/ui\/(?:vitest[^/]*\.ts|package\.json|src\/.+\.test\.tsx?)$/.test(path))) selected.push('script/ci-unit-shards.test.mjs')
  // A test that names a changed file by its name tests something that reads it: a gate's parser, a workflow, a manifest.
  // Over-selecting costs seconds; the gates' own tests are the ones a changed script is most likely to break.
  const named = paths.filter(path => !/\.test\.mjs$/.test(path) && /^(?:script\/.+|package\.json|\.github\/workflows\/.+|(?:AGENTS|CONTRIBUTING)\.md|playwright\.ui-system\.config\.ts|e2e\/ui-system\/durations(?:\.pr)?\.json)$/.test(path))
    .map(path => path.split('/').pop()).filter(name => name.length >= 6)
  if (named.length) {
    for (const file of readdirSync(join(root, 'script')).filter(file => /\.test\.mjs$/.test(file))) {
      const text = readFileSync(join(root, 'script', file), 'utf8')
      if (named.some(name => text.includes(name))) selected.push(`script/${file}`)
    }
  }
  return [...new Set(selected)].filter(path => existsSync(join(root, path))).sort()
}

// Read the installed browser's metadata, without loading its runtime or starting
// a browser. Merely having an older Chromium in the cache is not an install.
export function chromiumInstalled(root, env = process.env) {
  try {
    const require = createRequire(join(root, 'package.json'))
    const testRequire = createRequire(require.resolve('@playwright/test/package.json'))
    const browserRequire = createRequire(testRequire.resolve('playwright/package.json'))
    const core = dirname(browserRequire.resolve('playwright-core/package.json'))
    const browsers = JSON.parse(readFileSync(join(core, 'browsers.json'), 'utf8')).browsers
    const platform = process.platform === 'darwin' ? `mac${process.arch === 'arm64' ? '-arm64' : ''}` : process.platform
    const cache = env.PLAYWRIGHT_BROWSERS_PATH === '0' ? join(core, '.local-browsers')
      : env.PLAYWRIGHT_BROWSERS_PATH ? resolve(root, env.PLAYWRIGHT_BROWSERS_PATH)
        : process.platform === 'darwin' ? join(homedir(), 'Library/Caches/ms-playwright')
          : process.platform === 'win32' ? join(env.LOCALAPPDATA || join(homedir(), 'AppData/Local'), 'ms-playwright')
            : join(env.XDG_CACHE_HOME || join(homedir(), '.cache'), 'ms-playwright')
    return ['chromium', 'chromium-headless-shell'].every(name => {
      const browser = browsers.find(browser => browser.name === name)
      if (!browser) return false
      const revision = browser.revisionOverrides?.[platform] ?? browser.revision
      return files(join(cache, `${name.replaceAll('-', '_')}-${revision}`))
        .some(file => /^(?:(?:chrome|chrome-headless-shell|headless_shell|Chromium)(?:\.exe)?|.+ for Testing)$/.test(file.split(/[\\/]/).pop()))
    })
  } catch {
    return false
  }
}

export function createPlan(root, { paths, base = 'origin/main', mergeBase = null, themeTouched = false, request = '', map = null, fast = false, chromium, behind = 0, dirty = [] } = {}) {
  const change = planChange(root, { event: 'pull_request', paths, themeTouched, request, map, ...(mergeBase ? { baseRevision: mergeBase } : {}) })
  const unit = unitPlan(root, { event: 'pull_request', paths })
  // A change to a shared input (the lockfile, a root script, the workflow) is the one most likely to break CI, so
  // the cheap checks that read it still run; what only CI can do (install, the full matrix) is named in the notes.
  const shared = sharedInputs(paths).filter(path => !path.startsWith('script/'))
  const notes = [
    ...(dirty.length ? [`${dirty.length} path${dirty.length === 1 ? ' is' : 's are'} not committed (${dirty.slice(0, 3).join(', ')}${dirty.length > 3 ? ', …' : ''}): these checks read your files, which are not what a push sends. Commit first for an answer about the commit.`] : []),
    `Checked against the merge base${behind ? `; ${base} has ${behind} newer commit${behind === 1 ? '' : 's'}` : ''}. CI checks your branch merged into the base as it is then${behind ? ': merge it in to see the same tree' : ''}.`,
    ...(shared.length ? [`Shared inputs changed (${shared.join(', ')}): CI installs the full graph; its browser tier determines the selection and themes. The checks below that read them still run.`] : []),
  ]
  const leave = paths.length === 0 ? 'No changed files; CI remains the full gate.' : ''
  const steps = []
  const add = (name, command, args, reason = '', extra = {}) => {
    const skip = leave || reason
    const step = { name, status: skip ? 'skipped' : 'run', command, args, ...extra, ...(skip ? { reason: skip } : {}) }
    steps.push(step)
    return step
  }
  const gates = GATES.map(gate => add(gate.name, gate.command, gate.args,
    paths.some(path => gate.paths.some(pattern => pattern.test(path))) ? '' : `No change to ${gate.scope}.`, { group: 'gate' }))
  for (const name of ['check-interface-drift', 'check-alignment-census']) {
    const step = gates.find(step => step.name === name)
    if (mergeBase) step.args = [...step.args, '--base', mergeBase, ...(name === 'check-alignment-census' ? ['--since', mergeBase] : [])]
  }
  const inputs = uiPackages(root)
  // The UI reads its workspace packages through their build output, as it does in CI after `pnpm run build`.
  const typecheck = add('UI typecheck', 'pnpm', ['--filter', '@harnessdesk/ui', 'run', 'typecheck'],
    paths.some(path => inputs.has(path.match(/^packages\/([^/]+)\//)?.[1])) ? '' : 'No UI package or transitive workspace input changed.')
  const related = add('UI unit tests', 'pnpm', ['--filter', '@harnessdesk/ui', 'exec', 'vitest', 'related', '--run', ...unit.files],
    unit.mode === 'related' ? '' : unit.mode === 'all' ? `${unit.summary} CI will run the full unit suite; it exceeds the local budget.` : unit.summary)
  const scripts = scriptTests(root, paths)
  add('Script tests', 'node', ['--test', ...scripts], scripts.length ? '' : 'No changed script has a test, and no shared planner input changed.')
  const node = packageTests(root, paths)
  const totalTests = node.tests.reduce((count, entry) => count + entry.files.length, 0)
  const nodeReason = fast ? '--fast leaves Node-package tests to CI.' : node.changed.size === 0 ? 'No package source changed.' : ''
  const selected = node.tests.filter(entry => entry.direct || totalTests <= 60)
  const cli = gates.find(step => step.name === 'cli-doc')
  const direct = paths.filter(path => path.startsWith('e2e/ui-system/') && SPEC.test(path) && existsSync(join(root, path)))
  const reached = change.browser === 'server' ? JSON.parse(change.server_specs)
    : change.browser === 'all' && change.browser_specs !== 'all' ? JSON.parse(change.browser_specs) : []
  const seconds = recordedSeconds(root, change.matrix)
  const duration = reached.reduce((sum, path) => sum + (seconds[path.slice('e2e/ui-system/'.length)] ?? Infinity), 0)
  const small = reached.length <= 6 && duration <= 600
  const browserFiles = [...new Set([...direct, ...(small ? reached : [])])].sort()
  const browserReason = fast ? '--fast leaves browser specs to CI.'
    : browserFiles.length === 0 ? 'No edited spec or bounded reached set to run.'
      : !(chromium ?? chromiumInstalled(root)) ? 'Chromium is not installed for this checkout; run pnpm exec playwright install chromium separately. CI runs these specs.' : ''
  const consumers = [cli, typecheck, related]
  const build = add('Node build', 'pnpm', ['run', 'build:node'],
    // The specs import compiled host fixtures; CI builds before it runs them, and so does this.
    consumers.some(step => step.status === 'run') || !browserReason || (!nodeReason && selected.length) ? '' : nodeReason || 'No selected step reads a Node build.')
  for (const step of consumers) if (step.status === 'run') step.needs = [build.name]
  for (const entry of node.tests) {
    const reason = nodeReason || (!entry.direct && totalTests > 60 ? `${totalTests} test files across changed packages and dependants exceed the local limit of 60; CI runs dependent tests.` : '')
    const retention = entry.files.filter(file => file === 'packages/server/dist/test/host-retention.test.js')
    const ordinary = entry.files.filter(file => !retention.includes(file))
    if (ordinary.length) add(`Node tests: ${entry.name}`, 'node', ['--test', '--test-timeout=120000', ...ordinary], reason, { needs: [build.name] })
    // Match CI and verify: this real-Flow measurement must not compete with
    // hundreds of server fixtures for its unchanged workload deadline.
    if (retention.length) add(`Node tests: ${entry.name} retention`, 'node', ['--test', '--test-timeout=120000', ...retention], reason, { needs: [build.name] })
  }
  if (node.tests.length === 0) add('Node-package tests', 'node', [], nodeReason || 'No changed package or dependant has compiled Node tests.')
  add('Node end-to-end tests', 'node', [], 'CI runs the separate Node end-to-end files; their wider deadlines exceed the local budget.')

  add('Remaining browser specs', 'pnpm', [], `${change.summary} ${change.browser_specs === 'all' && change.browser === 'all'
    ? `${map ? 'The map cannot narrow this change.' : 'No readable impact map was supplied.'} CI runs all specs; locally only edited specs run.`
    : !small ? `${reached.length} reached specs / ${Number.isFinite(duration) ? duration : 'unknown'} recorded seconds exceed the local limit of 6 specs / 600 seconds; CI runs the remainder.`
      : 'Every eligible reached spec is selected locally.'}`)
  add('Browser specs', 'node', browserFiles.length ? ['script/ui-system-run.mjs', ...browserFiles] : [], browserReason,
    { env: { UI_SYSTEM_MATRIX: change.matrix, PLAYWRIGHT_UI_SYSTEM_WORKERS: '1' }, ...(browserReason ? {} : { needs: [build.name] }) })
  // One worker is the default here (a laptop is shared); CI runs two at once, which can expose a spec that only passes alone.
  if (!browserReason) notes.push('Browser specs run one worker at a time here; CI runs two in parallel.')
  add('Native smoke', 'pnpm', ['test:ui-system:native'], change.native ? 'CI runs native smoke on the real shell; it exceeds the local budget.' : 'CI does not need native smoke for this change.')
  return { base, mergeBase, paths, notes, ci: { change, unit }, steps }
}

const quote = text => /^[\w./@=:+-]+$/.test(text) ? text : `'${text.replaceAll("'", "'\\''")}'`
const commandText = step => [...Object.entries(step.env ?? {}).map(([name, value]) => `${name}=${quote(value)}`), step.command, ...step.args.map(quote)].join(' ')

// Untracked paths are staged with an unrelated HEAD blob in a disposable index.
// Gates may enumerate its paths only: no gate may read index bytes. The working
// file at each path is the content under review, not the borrowed blob.
function gateIndex(root) {
  const additions = nulPaths(git(root, ['ls-files', '--others', '--exclude-standard', '-z']))
  if (!additions.length) return { env: {}, dispose() {} }
  // Gates that enumerate tracked paths must see tomorrow's additions too. A
  // disposable copy of the index gives them those names while they read the
  // actual working files. Reuse an existing blob: no object or real index is written.
  const directory = mkdtempSync(join(tmpdir(), 'check-push-index-'))
  const index = join(directory, 'index')
  const env = { GIT_INDEX_FILE: index }
  try {
    copyFileSync(resolve(root, git(root, ['rev-parse', '--git-path', 'index']).trim()), index)
    const blob = git(root, ['ls-tree', '-r', 'HEAD']).match(/^\d+ blob ([a-f0-9]{40})\t/m)?.[1]
    if (!blob) throw new Error('Cannot prepare the gate index: HEAD has no file blobs.')
    execFileSync('git', ['update-index', '-z', '--index-info'], {
      cwd: root, env: { ...process.env, ...env }, stdio: ['pipe', 'pipe', 'pipe'],
      input: additions.map(path => `100644 ${blob}\t${path}\0`).join(''),
    })
    return { env, dispose: () => rmSync(directory, { recursive: true, force: true }) }
  } catch (error) {
    rmSync(directory, { recursive: true, force: true })
    throw error
  }
}

export async function runPlan(root, plan) {
  const started = performance.now()
  const results = new Map()
  for (const step of plan.steps) console.log(step.status === 'run' ? `Selected: ${commandText(step)}` : `Skipped ${step.name}: ${step.reason}`)
  const index = plan.steps.some(step => step.group === 'gate' && step.status === 'run') ? gateIndex(root) : { env: {}, dispose() {} }
  const run = async step => {
    if (step.status === 'skipped') {
      results.set(step.name, { status: 'skipped', reason: step.reason })
      return
    }
    const missing = step.needs?.find(name => results.get(name)?.status !== 'passed')
    if (missing) {
      results.set(step.name, { status: 'skipped', reason: `${missing} did not pass; its output cannot be trusted.` })
      return
    }
    const before = performance.now()
    const passed = await new Promise(resolve => {
      const child = spawn(step.command === 'node' ? process.execPath : step.command, step.args, { cwd: root, env: { ...process.env, ...(step.group === 'gate' ? index.env : {}), ...step.env }, stdio: 'inherit' })
      child.on('error', error => { console.error(`${step.name}: ${error.message}`); resolve(false) })
      child.on('close', code => resolve(code === 0))
    })
    results.set(step.name, { status: passed ? 'passed' : 'failed', seconds: (performance.now() - before) / 1000 })
  }
  // Cheap gates share four slots. Anything consuming a build runs after it.
  const gates = plan.steps.filter(step => step.group === 'gate' && !step.needs)
  let next = 0
  try {
    await Promise.all(Array.from({ length: 4 }, async () => {
      while (next < gates.length) await run(gates[next++])
    }))
    const rest = plan.steps.filter(step => !gates.includes(step))
    const build = rest.find(step => step.name === 'Node build')
    if (build) await run(build)
    for (const step of rest) if (step !== build) await run(step)
  } finally {
    index.dispose()
  }
  console.table(plan.steps.map(step => ({ step: step.name, status: results.get(step.name).status,
    seconds: results.get(step.name).seconds?.toFixed(1) ?? `skipped: ${results.get(step.name).reason}` })))
  console.log(`Total: ${((performance.now() - started) / 1000).toFixed(1)} seconds. Skipped work is not passing evidence.`)
  return [...results.values()].some(result => result.status === 'failed') ? 1 : 0
}

async function main() {
  const options = { base: 'origin/main' }
  const args = process.argv.slice(2)
  for (let index = 0; index < args.length; index++) {
    const arg = args[index]
    if (arg === '--plan' || arg === '--dry-run') options.plan = true
    else if (arg === '--fast') options.fast = true
    else if (arg === '--base' || arg === '--map') {
      if (!args[index + 1] || args[index + 1].startsWith('--')) {
        console.error(`${arg} requires a value`)
        return 2
      }
      options[arg.slice(2)] = args[++index]
    } else {
      console.error('usage: pnpm check:push [--base <ref>] [--map <file>] [--plan | --dry-run] [--fast]')
      return 2
    }
  }
  const root = git(process.cwd(), ['rev-parse', '--show-toplevel']).trim()
  const input = readChange(root, options.base)
  const mapFile = options.map ?? process.env.UI_IMPACT_MAP
  const plan = createPlan(root, { ...input, fast: options.fast, request: process.env.UI_SYSTEM_MATRIX_REQUEST ?? '', map: mapFile ? readMap(resolve(mapFile)) : null })
  if (options.plan) {
    console.log(JSON.stringify(plan, null, 2))
    return 0
  }
  console.log(`Change against ${input.base} (merge base ${input.mergeBase.slice(0, 9)}): ${input.paths.length} paths\n${plan.ci.change.summary}\n${plan.ci.unit.summary}${plan.notes.map(note => `\n${note}`).join('')}`)
  return runPlan(root, plan)
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    process.exitCode = await main()
  } catch (error) {
    console.error(error.exitCode ? error.message : 'check:push could not plan or run the change: ' + error.message)
    process.exitCode = error.exitCode ?? 1
  }
}
