#!/usr/bin/env node
// Selection belongs to the planners. This runner gives the selected specs the
// same servers locally and on CI, and keeps diagnostics from both runs.
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { performance } from 'node:perf_hooks'
import { fileURLToPath } from 'node:url'

import { E2E_PAGES } from './ci-imports.mjs'
import { splitServerSpecs } from './ci-server-split.mjs'

const recordingConfig = 'script/ui-impact/tsconfig.json'
export const hasE2EBuild = root => E2E_PAGES.every(page => existsSync(join(root, 'packages/ui/dist-e2e', page)))

// `…/guides-standard.spec.ts#a,b` runs that spec's units `a` and `b` only (script/ui-impact.mjs): the
// spec file is what Playwright is given, and the units travel to the spec as `UI_SYSTEM_UNITS`.
export function narrowedSpecs(entries) {
  const files = [], units = {}
  for (const entry of entries) {
    const at = entry.indexOf('#')
    const file = at === -1 ? entry : entry.slice(0, at)
    if (!files.includes(file)) files.push(file)
    if (at !== -1) units[file.replace(/^e2e\/ui-system\//, '')] = entry.slice(at + 1).split(',').filter(Boolean)
  }
  // A spec also named whole runs whole.
  for (const entry of entries) if (!entry.includes('#')) delete units[entry.replace(/^e2e\/ui-system\//, '')]
  return { files, units }
}

export function planRun(root, { specs: entries, args = [], devOnly = false, env = process.env, hasBuild = hasE2EBuild(root) }) {
  const { files: specs, units } = narrowedSpecs(entries)
  const recording = env.RECORD === 'true' || Boolean(env.UI_IMPACT_DIR) || args.some(arg => arg.includes(recordingConfig))
  // The runner owns empty-group handling. A single group must retain the
  // usual failure on an empty deal, even if this flag was supplied by hand.
  const forwarded = args.filter(arg => arg !== '--pass-with-no-tests')
  if (recording) {
    const config = args.find(arg => arg.startsWith('--tsconfig='))?.slice('--tsconfig='.length)
      ?? (args.includes('--tsconfig') ? args[args.indexOf('--tsconfig') + 1] : null)
    if (config && config !== recordingConfig) throw new Error(`Recording requires --tsconfig ${recordingConfig}`)
    if (!config) forwarded.push('--tsconfig', recordingConfig)
  }
  const split = devOnly || recording ? { static: [], dev: [...specs] } : splitServerSpecs(root, specs)
  // Only the workflow's downloaded artifact opts into UI_SYSTEM_PAGES=prebuilt.
  // CI=true also occurs on laptops and says nothing about build freshness.
  const prebuilt = env.UI_SYSTEM_PAGES === 'prebuilt'
  const allowEmpty = split.static.length > 0 && split.dev.length > 0
  const filtered = forwarded.some(arg => /^(?:--grep|--grep-invert|-g|-G|--last-failed|--shard|--only-changed|--test-list|--test-list-invert)(?:=|$)/.test(arg))
  const error = split.static.length > 0 && prebuilt && !hasBuild
    ? 'Missing or incomplete e2e artifact with UI_SYSTEM_PAGES=prebuilt; the download must supply it (pnpm run build:node then pnpm run build:e2e).'
    : null
  return {
    split,
    build: split.static.length > 0 && !prebuilt ? [['run', 'build:node'], ['run', 'build:e2e']] : [],
    error,
    groups: Object.entries(split).filter(([, files]) => files.length).map(([server, files]) => ({
      server, args: ['test:ui-system', ...files, ...(allowEmpty ? ['--pass-with-no-tests'] : []), ...forwarded],
      ...(allowEmpty || filtered ? { listArgs: ['--silent', 'test:ui-system', ...files, ...forwarded, '--pass-with-no-tests', '--list', '--reporter=list'] } : {}),
      env: { UI_SYSTEM_SERVER: server, UI_SYSTEM_REPORT_GROUP: server, ...(Object.keys(units).length ? { UI_SYSTEM_UNITS: JSON.stringify(units) } : {}) },
    })),
  }
}

const execute = (root, args, env, { capture = false } = {}) => new Promise(done => {
  const child = spawn('pnpm', args, { cwd: root, env: { ...process.env, ...env }, stdio: capture ? ['inherit', 'pipe', 'inherit'] : 'inherit' })
  let stdout = ''
  if (capture) child.stdout.on('data', chunk => { stdout += chunk })
  child.on('error', error => {
    console.error(error.message)
    done(capture ? { code: 1, stdout } : 1)
  })
  child.on('close', code => done(capture ? { code: code ?? 1, stdout } : code ?? 1))
})

export async function runPlan(root, plan, { execute: run = (args, env, options) => execute(root, args, env, options), log = console.log } = {}) {
  log(`Browser specs: ${plan.split.static.length} static, ${plan.split.dev.length} dev`)
  let failed = Boolean(plan.error)
  let buildFailed = Boolean(plan.error)
  let matched = 0
  if (plan.error) log(plan.error)
  for (const args of plan.build) {
    const started = performance.now()
    const code = await run(args, {})
    log(`${args.at(-1)}: ${((performance.now() - started) / 1000).toFixed(1)}s (exit ${code})`)
    if (code !== 0) {
      failed = true
      buildFailed = true
      break
    }
  }
  for (const group of plan.groups) {
    if (group.server === 'static' && buildFailed) {
      log('static: 0.0s (failed: build unavailable)')
      continue
    }
    const started = performance.now()
    if (group.listArgs) {
      // List each group's actual selection: --shard and --last-failed depend
      // on that group, so a listing of their union could hide two empty runs.
      const listing = await run(group.listArgs, group.env, { capture: true })
      const count = [...(listing.stdout ?? '').matchAll(/^Total: (\d+) tests? in \d+ files?\s*$/gm)].at(-1)?.[1]
      if (listing.code !== 0 || count == null) {
        log(`${group.server}: could not read the selected test count`)
        failed = true
      } else matched += Number(count)
    }
    const code = await run(group.args, group.env)
    log(`${group.server}: ${((performance.now() - started) / 1000).toFixed(1)}s (exit ${code})`)
    failed ||= code !== 0
  }
  if (plan.groups.some(group => group.listArgs) && matched === 0) {
    log('No tests matched in the selected specs.')
    failed = true
  }
  return failed ? 1 : 0
}

async function main() {
  const specs = [], args = []
  let list = false, devOnly = false
  // A grep value can itself end in .spec.ts. Keep option values with their
  // option, and allow -- to forward an arbitrary remaining argument list.
  const values = new Set(['--grep', '-g', '--grep-invert', '-G', '--project', '--config', '-c', '--tsconfig', '--workers', '-j',
    '--output', '--reporter', '--retries', '--repeat-each', '--timeout', '--global-timeout', '--max-failures', '--shard', '--test-list', '--test-list-invert', '--last-failed-file'])
  const argv = process.argv.slice(2)
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index]
    if (arg === '--list') list = true
    else if (arg === '--dev-only') devOnly = true
    else if (arg === '--') {
      args.push(...argv.slice(index + 1))
      break
    } else if (values.has(arg)) {
      if (argv[index + 1] == null) throw new Error(`${arg} requires a value`)
      args.push(arg, argv[++index])
    }
    else if (/\.spec\.[cm]?[jt]sx?(?:#[\w,-]+)?$/.test(arg) && !arg.startsWith('-')) specs.push(arg)
    else args.push(arg)
  }
  if (!specs.length) throw new Error('usage: node script/ui-system-run.mjs [--list] [--dev-only] <spec paths…> [Playwright arguments…]')
  const root = fileURLToPath(new URL('../', import.meta.url))
  const plan = planRun(root, { specs, args, devOnly })
  if (list) {
    console.log(JSON.stringify(plan, null, 2))
    return 0
  }
  return runPlan(root, plan)
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { process.exitCode = await main() }
  catch (error) {
    console.error(error.message)
    process.exitCode = 1
  }
}
