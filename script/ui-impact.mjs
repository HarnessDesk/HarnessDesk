#!/usr/bin/env node
// Which specs does a change to the UI reach? A pull request that edits one
// component should wait for the specs that render it, not for the whole suite.
//
// On a full run of the suite (`main`, a manual run) every spec also records which
// UI modules its page loaded and in which of them some function ran
// (`script/ui-impact/test.ts`). `merge` folds those records into one map. A pull
// request is planned against the latest map from `main`:
//
//   node script/ui-impact.mjs merge <dir>… --out ui-impact-map.json
//   node script/ui-impact.mjs select --map ui-impact-map.json --fresh <path>…
//
// The map is evidence and not a promise, so every doubt runs more: a file that
// has moved on since the map, a spec the map has not seen run in its present
// form, a map that does not read, all run the whole suite or the spec.
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { dirname, extname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { IMPORT, SOURCE, URL_IMPORT, blobSha, specHashes, specsNaming, specsReaching, suiteGraph, suiteTexts, uiPackages, unobservedSpecs, walk } from './ci-imports.mjs'

export const MAP_VERSION = 2
const UI_ROOTS = ['packages/ui/src', 'packages/ui/site-demo']
const CSS_IMPORT = /@import\s+(?:url\(\s*)?['"]([^'"\n]+)['"]/g
const CSS_URL = /url\(\s*['"]?(\.[^'")\s]+)['"]?\s*\)/g
const TEST_FILE = /\.test\.[cm]?[jt]sx?$/

// The files at the root of the repository that decide how the preview is built and run.
const ROOT_SETUP = /^(?:package\.json|pnpm-[\w.-]+|tsconfig[\w.-]*\.json|[\w-]+\.config\.[cm]?[jt]s|\.npmrc|\.node-version|\.nvmrc)$/

export const uiSource = path => UI_ROOTS.some(prefix => path.startsWith(`${prefix}/`))
const isScript = path => SOURCE.includes(extname(path))

// The file in the repository a module of the preview came from, or null for
// anything that is not the UI's own source: the dev server's own modules,
// dependencies, and the built output of other packages.
export function repoPath(pathname) {
  let decoded
  try {
    decoded = decodeURIComponent(pathname)
  } catch {
    return null
  }
  if (!decoded.startsWith('/') || decoded.includes('/node_modules/') || decoded.includes('/../')) return null
  const path = `packages/ui${decoded}`
  return uiSource(path) ? path : null
}

// Every file of the UI's own source, with the version of it that is on disk.
export function uiFiles(root) {
  const files = {}
  for (const prefix of UI_ROOTS) {
    const directory = join(root, prefix)
    if (!existsSync(directory)) continue
    for (const file of walk(directory)) files[relative(root, file)] = blobSha(readFileSync(file))
  }
  return files
}

const resolveUi = (root, file, specifier) => {
  const clean = specifier.replace(/[?#].*$/, '')
  const base = clean.startsWith('@/') ? join(root, 'packages/ui/src', clean.slice(2)) : clean.startsWith('.') ? resolve(dirname(file), clean) : null
  if (!base) return null
  return [base, ...SOURCE.map(ext => `${base}${ext}`), base.replace(/\.js$/, '.ts'), base.replace(/\.js$/, '.tsx'),
    ...SOURCE.map(ext => join(base, `index${ext}`))]
    .find(candidate => existsSync(candidate) && statSync(candidate).isFile()) ?? null
}

// Who imports whom among the UI's files: scripts and stylesheets, by the path each is
// written under, and the files a stylesheet names (`@import`, `url(...)`). A specifier
// that names nothing in the tree is left out; `ui-impact.test.mjs` checks that none of
// the UI's own does.
export function uiImporters(root, files = Object.keys(uiFiles(root))) {
  const importers = new Map()
  for (const path of files) {
    const extension = extname(path)
    if (!SOURCE.includes(extension) && extension !== '.css') continue
    const text = readFileSync(join(root, path), 'utf8')
    const specifiers = [...text.matchAll(IMPORT), ...text.matchAll(URL_IMPORT), ...(extension === '.css' ? [...text.matchAll(CSS_IMPORT), ...text.matchAll(CSS_URL)] : [])].map(match => match[1])
    for (const specifier of specifiers) {
      const target = resolveUi(root, join(root, path), specifier)
      if (!target) continue
      const key = relative(root, target)
      if (key !== path) importers.set(key, new Set([...(importers.get(key) ?? []), path]))
    }
  }
  return importers
}

// The files outside the UI's own source that its source imports (a constant shared with another package's
// source, a helper at the root): a change to one reaches the preview without being a file of the UI.
export function uiExternalImports(root) {
  const external = new Set()
  for (const [key, importers] of uiImporters(root)) {
    if (!uiSource(key) && !key.includes('node_modules/') && [...importers].some(importer => !TEST_FILE.test(importer))) external.add(key)
  }
  return external
}

// The files that are imported with a query (`./editor.css?raw`, `?url`, `?inline`) and who imports them, by the
// path of the file without the query. Vitest looks for a changed file under the id it was imported by, query
// included, so an edit to such a file reaches no test through it; the importers are the ones to ask about.
export function queriedImporters(root, files = Object.keys(uiFiles(root))) {
  const importers = new Map()
  for (const path of files) {
    if (!SOURCE.includes(extname(path))) continue
    for (const [, specifier] of readFileSync(join(root, path), 'utf8').matchAll(IMPORT)) {
      if (!/[?#]/.test(specifier)) continue
      const target = resolveUi(root, join(root, path), specifier)
      if (!target) continue
      const key = relative(root, target)
      importers.set(key, new Set([...(importers.get(key) ?? []), path]))
    }
  }
  return importers
}

// Whether a module hands data to the modules that import it, which they read when they run and not when
// this module's functions do: `export const LABEL = 'Ready'` changes what a component renders that never
// calls anything of the module's. Only a module whose every export is plainly a function (or a type) is
// free of it; re-exports, names exported apart from their declaration, class statics, parenthesised values
// and anything the scan cannot tell are data.
export function exportsData(text) {
  if (!/^export\b/m.test(text)) return true // a module with no export is there for what it does when it loads
  for (const match of text.matchAll(/^export\s+(?:const|let|var)\s+[\w$]+[^=\n]*=\s*(.*)$/gm)) {
    if (!functionLike(match[1])) return true
  }
  if (/^export\s+(?:\*|\{)/m.test(text)) return true // `export { a }`, `export * from`, `export { a } from`: a name, not a declaration
  if (/^export\s+default\s+(?!(?:async\s+)?(?:function|class)\b|\(|[A-Za-z_$][\w$]*\s*=>)/m.test(text)) return true
  if (/^export\s+(?:const\s+)?enum\b/m.test(text)) return true
  return /\bstatic\b/.test(text) && /^export\s+(?:default\s+)?class\b/m.test(text)
}

// Whether what follows `export const X =` on its line is a function: an arrow, a function, a class, a component
// wrapper. A parenthesis is a function's parameters when an arrow follows it or the line leaves it open
// (destructured parameters run over several lines), and a parenthesised value when it closes on the line.
function functionLike(initializer) {
  const start = initializer.replace(/^async\s+/, '')
  if (/^(?:function\b|class\b|<|[A-Za-z_$][\w$]*\s*=>|(?:React\.)?(?:forwardRef|memo|lazy)\b|cva\()/.test(start)) return true
  if (!start.startsWith('(')) return false
  if (/=>/.test(start)) return true
  return (start.match(/\(/g) ?? []).length > (start.match(/\)/g) ?? []).length
}

const compress = (indexes, total) => (total > 0 && indexes.length === total ? 'all' : indexes)
const expand = (value, total) => (value === 'all' ? Array.from({ length: total }, (_, index) => index) : value)

// The fingerprint of the setup a map was recorded in: the version, in a revision, of the browser and
// dev-server configuration, the dependencies, every file of the UI outside the source (its pages and
// configuration), the recording build and the workspace packages the preview loads (a file's blob, a
// folder's tree), by git.
export function environmentAt(root, revision = 'HEAD') {
  const git = args => {
    try {
      return execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 16 * 1024 * 1024 })
    } catch {
      return ''
    }
  }
  const children = (folder, keep) => git(['ls-tree', '-z', revision, folder === '' ? '.' : `${folder}/`]).split('\0')
    .flatMap(line => {
      const match = /^\d+ (?:blob|tree) ([0-9a-f]{40})\t(.+)$/s.exec(line)
      return match && keep(match[2].split('/').pop()) ? [[match[2], match[1]]] : []
    })
  const environment = {}
  for (const [path, version] of [
    ...children('', name => ROOT_SETUP.test(name)),
    ...children('packages/ui', name => !/^(?:src|site-demo|dist|node_modules|output)$/.test(name)),
    ...[...uiPackages(root)].filter(name => name !== 'ui').map(name => [`packages/${name}`, git(['rev-parse', '--verify', '--quiet', `${revision}:packages/${name}`]).trim()]),
    ...['script/ui-impact'].map(path => [path, git(['rev-parse', '--verify', '--quiet', `${revision}:${path}`]).trim()]),
  ]) environment[path] = version
  return environment
}

// One map from the records of every worker of every shard of a full run. A spec is
// in the map only if every test it has was recorded, and every one passed: a spec that
// is missing, or was recorded in part, or opens pages of its own that the recorder never
// sees, runs on every pull request until a clean run puts it back.
//
//   expected      how many tests each spec has (`playwright test --list`); without it no spec is complete
//   environment   the setup the run was made in (`environmentAt`)
export function mergeRecords(root, records, { commit = '', expected = null, environment = {}, unobserved = [] } = {}) {
  const seen = new Map()
  for (const record of records) {
    for (const [file, entry] of Object.entries(record)) {
      const name = file.replace(/^e2e\/ui-system\//, '')
      const total = seen.get(name) ?? { tests: 0, unclean: 0, loaded: new Set(), ran: new Set() }
      total.tests += entry.tests
      total.unclean += entry.unclean
      for (const key of entry.loaded) total.loaded.add(key)
      for (const key of entry.ran) total.ran.add(key)
      seen.set(name, total)
    }
  }
  const hashes = specHashes(root)
  const complete = (name, total) => total.tests > 0 && total.unclean === 0 && name in hashes && !unobserved.includes(name)
    && (expected === null || expected[name] === total.tests)
  const specs = [...seen].filter(([name, total]) => complete(name, total)).map(([name]) => name).sort()
  const files = Object.fromEntries(Object.entries(uiFiles(root)).map(([path, blob]) => [path, { blob, loaded: [], ran: [] }]))
  specs.forEach((name, index) => {
    const total = seen.get(name)
    for (const [kind, keys] of [['loaded', total.loaded], ['ran', total.ran]]) {
      for (const key of keys) {
        const path = repoPath(key)
        if (path && files[path] && files[path][kind].at(-1) !== index) files[path][kind].push(index)
      }
    }
  })
  for (const entry of Object.values(files)) {
    entry.loaded = compress(entry.loaded, specs.length)
    entry.ran = compress(entry.ran, specs.length)
  }
  return { version: MAP_VERSION, commit, environment, specs, hashes: specs.map(name => hashes[name]), files }
}

// The modules that pick up other files by a pattern (`import.meta.glob`): adding or
// deleting a file the pattern matches changes what they load without a change to
// any importer, so such a change reaches the specs that ran them.
export function uiGlobbers(root, files = Object.keys(uiFiles(root))) {
  return files.filter(path => isScript(path) && !TEST_FILE.test(path)
    && /import\.meta\.glob\s*[<(]/.test(readFileSync(join(root, path), 'utf8'))).sort()
}

// The map as it was saved, or null: anything that does not read as a map is no map.
export function readMap(file) {
  try {
    const map = JSON.parse(readFileSync(file, 'utf8'))
    const ok = map && map.version === MAP_VERSION && Array.isArray(map.specs) && Array.isArray(map.hashes)
      && map.hashes.length === map.specs.length && map.files && typeof map.files === 'object' && map.specs.length > 0
      && map.environment && typeof map.environment === 'object'
    return ok ? map : null
  } catch {
    return null
  }
}

// The specs a change to these files of the UI can reach, as `{ specs, reason }`
// with `specs: null` when it cannot be told and the whole suite should run.
//
// A file is reached by the specs in which some function of it ran. A module that
// also hands data to its importers (`exportsData`) is reached by the specs in which
// they ran. A script in which none ever ran that hands nothing on (a component no
// spec rendered) is reached by none; a stylesheet, an image, a font, or a script of
// constants is reached through whoever imports it, since that is where its
// values go; so is one that only the browser's bundler can have taken in
// (a stylesheet another one `@import`s has no script of its own). A script nobody
// loaded is reached by no one.
//
// The map was recorded on a commit of `main`, and a pull request is made against a
// later one. What `main` changed in between is read from the files of the base
// branch: a file that was changed there is treated as if this change had touched it
// too, one that was added there, or removed, is not in the map's picture at all, and
// a change to the setup the map was recorded in ends the map.
//
//   allSpecs         every spec there is now
//   specHash         the id of a spec as it is now (`specHashes`)
//   baseFiles        the UI's files on the branch the change is made against, as { path: blob }, or null
//   baseEnvironment  the setup on that branch (`environmentAt`), or null
//   importers        who imports a file, among the UI's files
//   nodeSpecs        the specs that name a file from their own code (a constant they import, a data file they read)
//   exists           whether a file is there now
//   globbers         the modules that load files by a pattern (`uiGlobbers`)
//   dataExports      whether a module hands data to its importers (`exportsData` of its text)
//   globalSheet      whether a stylesheet is not scoped to one module (a plain .css, or a :global selector)
export function impactedSpecs(map, paths, { allSpecs, specHash, baseFiles, baseEnvironment = () => map.environment, importers, nodeSpecs = () => [], exists = () => true, globbers = () => [], dataExports = () => false, globalSheet = () => false }) {
  const total = map.specs.length
  const selected = new Set()
  const index = new Map(map.specs.map((name, position) => [name, position]))
  for (const name of allSpecs) {
    const position = index.get(name)
    if (position === undefined || map.hashes[position] !== specHash(name)) selected.add(name)
  }
  const reaching = (path, visiting) => {
    const entry = map.files[path]
    if (!entry || visiting.has(path)) return []
    visiting.add(path)
    const ran = expand(entry.ran, total)
    const loaded = expand(entry.loaded, total)
    // A test of the UI's units never ran in a browser: it is no importer to ask.
    const parents = new Set([...(importers(path) ?? [])].filter(parent => !TEST_FILE.test(parent)))
    const viaParents = () => [...parents].flatMap(parent => reaching(parent, visiting))
    if (ran.length > 0) return dataExports(path) ? [...ran, ...viaParents()] : ran
    // A script in which nothing ran and that hands nothing on (a component no spec rendered) is reached by no one.
    if (isScript(path) && (loaded.length === 0 || !dataExports(path))) return []
    // A sheet that is not scoped to a module of its own reaches everything that loaded it, wherever it was taken in.
    if (!isScript(path) && globalSheet(path)) return loadedAnywhere(path, new Set())
    if (parents.size === 0) return loaded
    return viaParents()
  }
  const loadedAnywhere = (path, visiting) => {
    const entry = map.files[path]
    if (!entry || visiting.has(path)) return []
    visiting.add(path)
    const own = expand(entry.loaded, total)
    if (own.length > 0) return own
    return [...(importers(path) ?? [])].filter(parent => !TEST_FILE.test(parent)).flatMap(parent => loadedAnywhere(parent, visiting))
  }
  const reach = path => {
    for (const position of reaching(path, new Set())) selected.add(map.specs[position])
    for (const name of nodeSpecs(path)) selected.add(name)
  }
  const environment = baseEnvironment()
  if (!environment) return { specs: null, reason: 'the setup of the base branch cannot be read' }
  for (const [path, version] of Object.entries(map.environment)) {
    if (environment[path] !== version) return { specs: null, reason: `${path} has changed on the base branch since the map was recorded` }
  }
  const base = baseFiles()
  if (!base) return { specs: null, reason: 'the base branch cannot be read' }
  const changed = new Set(paths)
  for (const path of paths) {
    if (TEST_FILE.test(path)) continue
    const entry = map.files[path]
    if (entry === undefined && base[path] !== undefined) return { specs: null, reason: `${path} is on the base branch but not in the map` }
    if (entry !== undefined && entry.blob !== base[path]) return { specs: null, reason: `${path} has changed on the base branch since the map was recorded` }
    reach(path)
  }
  // What `main` changed since the map was recorded.
  for (const [path, blob] of Object.entries(base)) {
    if (changed.has(path) || TEST_FILE.test(path)) continue
    const entry = map.files[path]
    if (!entry) return { specs: null, reason: `${path} was added to the base branch since the map was recorded` }
    if (entry.blob !== blob) reach(path)
  }
  for (const [path, entry] of Object.entries(map.files)) {
    if (base[path] === undefined && !changed.has(path) && !TEST_FILE.test(path) && expand(entry.loaded, total).length > 0) {
      return { specs: null, reason: `${path} was removed from the base branch since the map was recorded` }
    }
  }
  // Adding or deleting a file changes what a module that loads files by a pattern sees.
  if (paths.some(path => !TEST_FILE.test(path) && (base[path] === undefined || !exists(path)))) {
    for (const globber of globbers()) {
      for (const position of reaching(globber, new Set())) selected.add(map.specs[position])
    }
  }
  return { specs: [...selected].sort(), reason: null }
}

// The UI's files on the branch a pull request is made against, with the version of each.
export const filesAtBase = (root, revision = 'HEAD^1') => {
  try {
    const listing = execFileSync('git', ['ls-tree', '-r', '-z', revision, '--', ...UI_ROOTS], { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 64 * 1024 * 1024 })
    const files = {}
    for (const entry of listing.split('\0')) {
      const match = /^\d+ blob ([0-9a-f]{40})\t(.+)$/s.exec(entry)
      if (match) files[match[2]] = match[1]
    }
    return Object.keys(files).length > 0 ? files : null
  } catch {
    return null
  }
}

// `impactedSpecs` for a repository on disk, with a pull request's base as git has it
// (`baseFiles` and `baseEnvironment` say otherwise to a caller that knows better).
export function impactPlan(root, paths, { map, baseFiles = () => filesAtBase(root), baseEnvironment = () => environmentAt(root, 'HEAD^1') }) {
  const graph = suiteGraph(root)
  const texts = suiteTexts(graph)
  const hashes = specHashes(root, graph)
  const importers = uiImporters(root)
  return impactedSpecs(map, paths, {
    allSpecs: Object.keys(hashes),
    specHash: name => hashes[name],
    baseFiles,
    baseEnvironment,
    importers: path => importers.get(path),
    nodeSpecs: path => [...new Set([
      ...specsReaching(graph, [join(root, path)]).map(file => relative(graph.suite, file)),
      ...specsNaming(graph, path, texts),
    ])],
    exists: path => existsSync(join(root, path)),
    globbers: () => uiGlobbers(root),
    dataExports: path => {
      const file = join(root, path)
      return !existsSync(file) || (isScript(path) && exportsData(readFileSync(file, 'utf8')))
    },
    globalSheet: path => {
      const file = join(root, path)
      return path.endsWith('.css') && (!existsSync(file) || !path.endsWith('.module.css') || /:global\b/.test(readFileSync(file, 'utf8')))
    },
  })
}

// How many tests each spec has, from the JSON of `playwright test --list --reporter=json`.
export function expectedCounts(listings) {
  const counts = {}
  const walkSuite = (suite, file) => {
    for (const spec of suite.specs ?? []) counts[file] = (counts[file] ?? 0) + (spec.tests ?? []).length
    for (const child of suite.suites ?? []) walkSuite(child, file)
  }
  for (const listing of listings) {
    for (const suite of listing.suites ?? []) walkSuite(suite, suite.file.replace(/^e2e\/ui-system\//, ''))
  }
  return counts
}

function collect(paths, pattern) {
  return paths.flatMap(path => {
    if (!existsSync(path)) return []
    return statSync(path).isDirectory() ? walk(path) : [path]
  }).filter(file => pattern.test(file))
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const root = fileURLToPath(new URL('../', import.meta.url))
  const [command, ...args] = process.argv.slice(2)
  const option = name => {
    const at = args.indexOf(name)
    return at === -1 ? undefined : args.splice(at, 2)[1]
  }
  const flag = name => {
    const at = args.indexOf(name)
    if (at === -1) return false
    args.splice(at, 1)
    return true
  }
  if (command === 'merge') {
    const out = option('--out')
    const commit = option('--commit') ?? ''
    const minimum = Number(option('--minimum') ?? 0.9)
    const records = collect(args, /(?:^|\/)worker-[^/]*\.json$/).map(file => JSON.parse(readFileSync(file, 'utf8')))
    // A listing is the JSON on standard output; whatever a package manager printed before it is not part of it.
    const listings = collect(args, /(?:^|\/)expected-[^/]*\.json$/).map(file => {
      const text = readFileSync(file, 'utf8')
      return JSON.parse(text.slice(Math.max(0, text.indexOf('{'))))
    })
    const graph = suiteGraph(root)
    const unobserved = unobservedSpecs(root, graph)
    const map = mergeRecords(root, records, { commit, expected: listings.length > 0 ? expectedCounts(listings) : {}, environment: environmentAt(root), unobserved })
    const all = Object.keys(specHashes(root, graph)).length
    if (records.length === 0 || listings.length === 0 || map.specs.length < (all - unobserved.length) * minimum) {
      process.stderr.write(`ui-impact: ${map.specs.length} of ${all} specs recorded completely from ${records.length} records and ${listings.length} listings; not writing a map\n`)
      process.exit(2)
    }
    if (out) writeFileSync(out, `${JSON.stringify(map)}\n`)
    process.stderr.write(`ui-impact: ${map.specs.length} of ${all} specs (${unobserved.length} open pages of their own and always run), ${Object.keys(map.files).length} files\n`)
  } else if (command === 'select') {
    const mapFile = option('--map')
    const fresh = flag('--fresh')
    const map = mapFile ? readMap(mapFile) : null
    if (!map) {
      process.stderr.write('ui-impact: no map\n')
      process.exit(2)
    }
    const result = impactPlan(root, args, { map, ...(fresh ? { baseFiles: () => Object.fromEntries(Object.entries(map.files).map(([path, entry]) => [path, entry.blob])), baseEnvironment: () => map.environment } : {}) })
    const of = Object.keys(specHashes(root)).length
    process.stdout.write(`${JSON.stringify({ of, count: result.specs?.length ?? null, ...result })}\n`)
  } else {
    process.stderr.write('usage: ui-impact.mjs merge <dir>… --out <map> | select --map <map> [--fresh] <path>…\n')
    process.exit(2)
  }
}
