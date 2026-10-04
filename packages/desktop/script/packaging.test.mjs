import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { matchesGlob } from 'node:path'
import { test } from 'node:test'

import ts from '@typescript/typescript6'

import { TEMPLATE_BRIDGES } from '@harnessdesk/server'

/**
 * The packaged app's half of the template catalogue.
 *
 * `bridgeEntryOf()` finds a bridge as a sibling of the server package — in the
 * built app, `node_modules/@harnessdesk/<bridge>` — and a spawned Node child
 * cannot execute from inside an asar archive. So every bridge template needs
 * two things from this package.json: the bridge in the dependency graph, or
 * electron-builder never packs it at all, and an `asarUnpack` rule that turns
 * the archive entry back into real files.
 *
 * Nothing in a dev run exercises either condition — the workspace serves the
 * bridges as ordinary files — which is how a build shipped where Add agent
 * showed "This build of HarnessDesk does not carry the Claude Code bridge"
 * while every dev launch was green. This test is where the packaged layout is
 * pinned; `smoke-packaged.mjs` checks the built artifact itself.
 */

const manifest = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
const smoke = readFileSync(new URL('./smoke-packaged.mjs', import.meta.url), 'utf8')

test('every template bridge is a dependency of the app', () => {
  const dependencies = Object.keys(manifest.dependencies ?? {})
  for (const bridge of TEMPLATE_BRIDGES) {
    assert.ok(
      dependencies.includes(`@harnessdesk/${bridge}`),
      `@harnessdesk/${bridge} must be a dependency of @harnessdesk/desktop: ` +
        `electron-builder packs only the dependency graph, so without it the ` +
        `packaged catalogue reports the ${bridge} template as unavailable.`,
    )
  }
})

test('mcp-tools is a dependency of the app', () => {
  const dependencies = Object.keys(manifest.dependencies ?? {})
  assert.ok(
    dependencies.includes('@harnessdesk/mcp-tools'),
    '@harnessdesk/mcp-tools must be a dependency of @harnessdesk/desktop: ' +
      'electron-builder packs only the dependency graph, and toolBridgeEntry ' +
      'resolves mcp-tools/dist/src/main.js to spawn as the agent tool bridge.',
  )
})

test('node_modules is unpacked wholesale, so spawned children are real files', () => {
  assert.ok(
    manifest.build.asarUnpack.includes('**/node_modules/**'),
    'asarUnpack must carry **/node_modules/** — the bridges and mcp-tools are ' +
      'spawned as Node child processes, which cannot execute from inside ' +
      'app.asar, and claude-acp alone pulls ~100 transitive packages, so ' +
      'per-package globs would rot the first time a dependency moved.',
  )
})

test('the packaged smoke never opens the developer keychain', () => {
  assert.match(
    smoke,
    /['"]--use-mock-keychain['"]/,
    'the ad-hoc bundle gets a new Keychain identity on each build; the smoke ' +
      'must use Chromium\'s isolated mock keychain or app.ready can wait behind ' +
      'an OS prompt before the renderer and catalogue exist.',
  )
})

test('the packaged smoke awaits forced exit before removing isolated state', () => {
  assert.match(smoke, /child\.kill\('SIGKILL'\)\s*\n\s*await waitForExit\(3000\)/)
  assert.match(smoke, /maxRetries:\s*10/)
})

test('the built-in Agents are named in the server package manifest', () => {
  const server = JSON.parse(readFileSync(new URL('../../server/package.json', import.meta.url), 'utf8'))
  assert.ok(
    (server.files ?? []).includes('agents'),
    '@harnessdesk/server should list "agents" in its files, so the manifest says what the package holds. ' +
      'That alone is not why a packaged app carries the folder — the desktop build copies this whole ' +
      'workspace package regardless of "files", and unpacks it with asarUnpack; the two tests below pin ' +
      'the mechanism that actually ships it.',
  )
  assert.match(smoke, /agent\/list/, 'the packaged smoke asks the built app for its Agents')
})

/**
 * A file the desktop build must actually carry, unpacked, for the app to list even one built-in Agent:
 * the brief of the Agent every fixture and screenshot rig starts as.
 */
const AN_AGENT_FILE = 'node_modules/@harnessdesk/server/agents/code-reviewer/AGENT.md'

test('asarUnpack really covers the folder the Agents ship in', () => {
  const unpack = manifest.build.asarUnpack ?? []
  assert.ok(
    unpack.some((glob) => matchesGlob(AN_AGENT_FILE, glob)),
    `packages/desktop/package.json's build.asarUnpack must cover ${AN_AGENT_FILE}: the server package is ` +
      'copied into node_modules whole, but electron-builder still seals it inside app.asar unless asarUnpack ' +
      'pulls it back out, and neither a spawned Node child nor a person browsing the built app can read a ' +
      'path inside app.asar.',
  )
})

/**
 * The folders that brief sits in, down from the one every Agent shares. electron-builder filters folders as
 * well as files, and never descends into one its filter rejects — so a negated glob that names a folder, the
 * Agents' own for one, drops every brief beneath it without matching a single file.
 */
const AGENT_FOLDERS = [
  'node_modules/@harnessdesk/server/agents',
  'node_modules/@harnessdesk/server/agents/code-reviewer',
]

test('no negated build.files glob excludes an Agent brief, or a folder it ships in, from the packaged app', () => {
  const negated = (manifest.build.files ?? []).filter((glob) => glob.startsWith('!'))
  const excluding = negated.filter((glob) =>
    [...AGENT_FOLDERS, AN_AGENT_FILE].some((path) => matchesGlob(path, glob.slice(1))),
  )
  assert.deepEqual(
    excluding,
    [],
    `packages/desktop/package.json's build.files must not exclude ${AN_AGENT_FILE}, or a folder it sits in: ` +
      'a negated glob broad enough to catch either (for example "!**/*.md", or "!**/agents", since ' +
      'electron-builder never descends into a folder its filter rejects) drops every shipped Agent brief ' +
      'from the packaged app, whatever asarUnpack says about the folder around them.',
  )
})

/**
 * The command line the app carries.
 *
 * "Install command-line tool…" puts a launcher on the PATH that runs
 * `node_modules/@harnessdesk/cli/dist/src/bin.js` on the app's own runtime. For
 * that to work in a built app the command line has to be in the dependency
 * graph (electron-builder packs only the graph), unpacked beside the archive
 * (a program is not run from inside it), and complete: everything its source
 * imports at run time must be a production dependency, all the way down, or
 * the packaged command line dies on its first `import` while every dev run,
 * which has the whole workspace's devDependencies on disk, stays green.
 */
const BUNDLED_CLI = 'node_modules/@harnessdesk/cli/dist/src/bin.js'

const readManifest = (name) =>
  JSON.parse(readFileSync(new URL(`../../${name}/package.json`, import.meta.url), 'utf8'))

/**
 * The packages a package's sources import at run time, read as TypeScript reads
 * them: node builtins, its own files and type-only imports (which compile to
 * nothing) are left out.
 */
const importedPackages = (name) => {
  const found = new Set()
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = new URL(entry.name + (entry.isDirectory() ? '/' : ''), dir)
      if (entry.isDirectory()) walk(path)
      else if (/\.tsx?$/.test(entry.name)) {
        const file = ts.createSourceFile(entry.name, readFileSync(path, 'utf8'), ts.ScriptTarget.Latest, true)
        for (const statement of file.statements) {
          const isImport = ts.isImportDeclaration(statement)
          const isExport = ts.isExportDeclaration(statement) && statement.moduleSpecifier
          if (!isImport && !isExport) continue
          if (isImport) {
            const clause = statement.importClause
            const named = clause?.namedBindings
            const typeOnly =
              clause?.isTypeOnly === true ||
              (clause !== undefined &&
                clause.name === undefined &&
                named !== undefined &&
                ts.isNamedImports(named) &&
                named.elements.length > 0 &&
                named.elements.every((element) => element.isTypeOnly))
            if (typeOnly) continue
          } else if (statement.isTypeOnly) continue
          const specifier = statement.moduleSpecifier.text
          if (specifier.startsWith('.') || specifier.startsWith('node:')) continue
          const parts = specifier.split('/')
          found.add(specifier.startsWith('@') ? parts.slice(0, 2).join('/') : parts[0])
        }
      }
    }
  }
  walk(new URL(`../../${name}/src/`, import.meta.url))
  return [...found].sort()
}

test('the command line is a dependency of the app', () => {
  assert.ok(
    Object.keys(manifest.dependencies ?? {}).includes('@harnessdesk/cli'),
    '@harnessdesk/cli must be a dependency of @harnessdesk/desktop: electron-builder packs only ' +
      'the dependency graph, and the launcher that "Install command-line tool…" writes runs ' +
      `${BUNDLED_CLI} on the app's own runtime.`,
  )
  assert.equal(readManifest('cli').bin?.harnessdesk, './dist/src/bin.js', 'the bin the launcher runs is dist/src/bin.js')
})

test('everything the bundled command line imports at run time is a production dependency, all the way down', () => {
  for (const name of ['cli', 'client', 'protocol']) {
    const dependencies = Object.keys(readManifest(name).dependencies ?? {})
    for (const imported of importedPackages(name)) {
      assert.ok(
        dependencies.includes(imported),
        `packages/${name}/src imports ${imported}, which is not in its "dependencies": the packaged ` +
          'command line would fail on its first import, because the app packs production dependencies only.',
      )
    }
  }
  // The chain the app's own dependency reaches the command line's imports through.
  assert.ok(Object.keys(readManifest('cli').dependencies).includes('@harnessdesk/client'))
  assert.ok(Object.keys(readManifest('client').dependencies).includes('@harnessdesk/protocol'))
  assert.ok(Object.keys(readManifest('client').dependencies).includes('ws'))
})

test('the bundled command line is unpacked beside the archive and no negated build.files glob drops it', () => {
  assert.ok(
    (manifest.build.asarUnpack ?? []).some((glob) => matchesGlob(BUNDLED_CLI, glob)),
    `asarUnpack must cover ${BUNDLED_CLI}: the launcher runs it as a program, and a program cannot be run from inside app.asar.`,
  )
  const negated = (manifest.build.files ?? []).filter((glob) => glob.startsWith('!'))
  const folders = [
    'node_modules/@harnessdesk/cli',
    'node_modules/@harnessdesk/cli/dist',
    'node_modules/@harnessdesk/cli/dist/src',
    BUNDLED_CLI,
    'node_modules/@harnessdesk/client/dist/src/index.js',
    'node_modules/@harnessdesk/client/dist/src/node.js',
    'node_modules/@harnessdesk/client/dist/src/views/index.js',
    'node_modules/@harnessdesk/protocol/dist/src/index.js',
  ]
  assert.deepEqual(
    negated.filter((glob) => folders.some((path) => matchesGlob(path, glob.slice(1)))),
    [],
    "build.files must not exclude the command line or the library it runs on from the packaged app: a negated glob that names a folder drops everything beneath it.",
  )
})

test('the packaged smoke runs the bundled command line on the app’s own runtime, against its own throwaway desk', () => {
  assert.match(smoke, /ELECTRON_RUN_AS_NODE/, 'the way the launcher runs it')
  assert.match(smoke, /@harnessdesk\/cli\/dist\/src\/bin\.js/, 'the file the launcher runs')
  assert.match(smoke, /HARNESSDESK_CLIENT_DIR/, 'a door directory of its own, never the shared one')
  assert.match(smoke, /'status',\s*'--json'/, 'a read that needs a live desk')
})
