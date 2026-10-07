#!/usr/bin/env node
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { dirname, extname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

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

const BROWSER = [
  ...SHARED,
  /^playwright\.ui-system\.config\.ts$/, // Defines the browser suite and its Vite preview server.
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
    const imports = source.matchAll(/(?:\bfrom\s*|\bimport\s*(?:\(\s*)?|\brequire\s*\(\s*)['"]([^'"\n]+)['"]/g)
    for (const [, specifier] of imports) {
      const path = specifier.startsWith('.') ? relative(root, resolve(dirname(file), specifier)) : specifier
      const pkg = path.match(/^(?:packages\/|@harnessdesk\/)([^/]+)/)?.[1]
      if (pkg && !inputs.has(pkg)) return true
      if (specifier.startsWith('.') && !pkg) {
        const base = resolve(dirname(file), specifier)
        const extensions = ['.ts', '.tsx', '.mts', '.cts', '.mjs', '.cjs', '.js', '.jsx']
        const extension = extname(base)
        const helper = [base, ...extensions.map(ext => `${base}${ext}`),
          base.replace(/\.js$/, '.ts'), base.replace(/\.mjs$/, '.mts'), base.replace(/\.cjs$/, '.cts'),
          ...extensions.map(ext => join(base, `index${ext}`))]
          .find(candidate => existsSync(candidate) && extensions.includes(extname(candidate)))
        if (!helper) {
          if (extension && !extensions.includes(extension)) continue
          throw new Error(`Cannot resolve suite import: ${specifier}`)
        }
        if (readsOutside(helper, seen)) return true
      }
    }
    return false
  }
  return files(suite).filter(file => /\.spec\.[cm]?[jt]sx?$/.test(file) && readsOutside(file))
    .map(file => relative(root, file)).sort()
}

// NUL delimiters keep spaces/newlines literal; --no-renames includes both
// paths of a moved input. Unreadable/empty/malformed paths run everything.
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const root = fileURLToPath(new URL('../', import.meta.url))
  const inputs = uiPackages(root)
  const specs = serverSpecs(root, inputs)
  let decision = { browser: 'all', native: true }
  if (process.env.GITHUB_EVENT_NAME === 'pull_request') {
    try {
      const raw = readFileSync(process.argv[2], 'utf8')
      const paths = raw.endsWith('\0') ? raw.slice(0, -1).split('\0') : []
      if (paths.length > 0 && paths.every(path => path.length > 0 && !path.startsWith('/') && !path.split('/').includes('..'))) {
        const uiInput = path => BROWSER.some(pattern => pattern.test(path)) || inputs.has(path.match(/^packages\/([^/]+)\//)?.[1])
        decision = {
          browser: paths.some(uiInput) ? 'all' : paths.some(path => /^packages\/(?!desktop\/)[^/]+\//.test(path)) ? 'server' : 'none',
          native: paths.some(path => NATIVE.some(pattern => pattern.test(path))),
        }
      }
    } catch {
      // A failed diff leaves no readable list. Non-PR events run everything.
    }
  }
  process.stdout.write(`browser=${decision.browser}\nnative=${decision.native}\nserver_specs=${JSON.stringify(specs)}\n`)
}
