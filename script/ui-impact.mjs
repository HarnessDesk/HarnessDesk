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

import { IMPORT, SOURCE, URL_IMPORT, blobSha, specHashes, specsReaching, suiteGraph, walk } from './ci-imports.mjs'

export const MAP_VERSION = 1
const UI_ROOTS = ['packages/ui/src', 'packages/ui/site-demo']
const CSS_IMPORT = /@import\s+(?:url\(\s*)?['"]([^'"\n]+)['"]/g

const TEST_FILE = /\.test\.[cm]?[jt]sx?$/

export const uiSource = path => UI_ROOTS.some(prefix => path.startsWith(`${prefix}/`))

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

// Who imports whom among the UI's files: scripts and stylesheets, by the path
// each is written under. A specifier that names nothing in the tree is left out;
// `ui-impact.test.mjs` checks that none of the UI's own does.
export function uiImporters(root, files = Object.keys(uiFiles(root))) {
  const importers = new Map()
  for (const path of files) {
    const extension = extname(path)
    if (!SOURCE.includes(extension) && extension !== '.css') continue
    const text = readFileSync(join(root, path), 'utf8')
    const specifiers = [...text.matchAll(IMPORT), ...text.matchAll(URL_IMPORT), ...(extension === '.css' ? text.matchAll(CSS_IMPORT) : [])].map(match => match[1])
    for (const specifier of specifiers) {
      const target = resolveUi(root, join(root, path), specifier)
      if (!target) continue
      const key = relative(root, target)
      if (key !== path) importers.set(key, new Set([...(importers.get(key) ?? []), path]))
    }
  }
  return importers
}

const compress = (indexes, total) => (total > 0 && indexes.length === total ? 'all' : indexes)
const expand = (value, total) => (value === 'all' ? Array.from({ length: total }, (_, index) => index) : value)

// One map from the records of every worker of every shard of a full run. A spec
// is in the map only if every test of it that was recorded passed: a spec that is
// missing, or was recorded in part, runs on every pull request until a clean run
// puts it back.
export function mergeRecords(root, records, { commit = '' } = {}) {
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
  const specs = [...seen].filter(([name, total]) => total.tests > 0 && total.unclean === 0 && name in hashes).map(([name]) => name).sort()
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
  return { version: MAP_VERSION, commit, specs, hashes: specs.map(name => hashes[name]), files }
}

// The modules that pick up other files by a pattern (`import.meta.glob`): adding or
// deleting a file the pattern matches changes what they load without a change to
// any importer, so such a change reaches the specs that ran them.
export function uiGlobbers(root, files = Object.keys(uiFiles(root))) {
  return files.filter(path => SOURCE.includes(extname(path)) && !TEST_FILE.test(path)
    && /import\.meta\.glob\s*[<(]/.test(readFileSync(join(root, path), 'utf8'))).sort()
}

// The map as it was saved, or null: anything that does not read as a map is no map.
export function readMap(file) {
  try {
    const map = JSON.parse(readFileSync(file, 'utf8'))
    const ok = map && map.version === MAP_VERSION && Array.isArray(map.specs) && Array.isArray(map.hashes)
      && map.hashes.length === map.specs.length && map.files && typeof map.files === 'object' && map.specs.length > 0
    return ok ? map : null
  } catch {
    return null
  }
}

// The specs a change to these files of the UI can reach, as `{ specs, reason }`
// with `specs: null` when it cannot be told and the whole suite should run.
//
// A file is reached by the specs in which some function of it ran. A file in which
// none ever ran (a stylesheet, a constant, a type, an image) is reached through
// whoever imports it, since that is where its values go. A file nobody imports that
// was loaded is reached by every spec that loaded it.
//
// The map was recorded on a commit of `main`, and a pull request is made against a
// later one. What `main` changed in between is read from the files of the base
// branch: a file that was changed there is treated as if this change had touched it
// too, and one that was added there, or removed, is not in the map's picture at all.
//
//   allSpecs    every spec there is now
//   specHash    the id of a spec as it is now (`specHashes`)
//   baseFiles   the UI's files on the branch the change is made against, as { path: blob }, or null
//   importers   who imports a file, among the UI's files
//   nodeSpecs   the specs that name a file from their own code (a constant they import)
//   exists      whether a file is there now
//   globbers    the modules that load files by a pattern (`uiGlobbers`)
export function impactedSpecs(map, paths, { allSpecs, specHash, baseFiles, importers, nodeSpecs = () => [], exists = () => true, globbers = () => [] }) {
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
    if (ran.length > 0) return ran
    const loaded = expand(entry.loaded, total)
    if (loaded.length === 0) return []
    const parents = importers(path)
    if (!parents || parents.size === 0) return loaded
    return [...parents].flatMap(parent => reaching(parent, visiting))
  }
  const reach = path => {
    for (const position of reaching(path, new Set())) selected.add(map.specs[position])
    for (const name of nodeSpecs(path)) selected.add(name)
  }
  const base = baseFiles()
  if (!base) return { specs: null, reason: 'the base branch cannot be read' }
  const changed = new Set(paths)
  for (const path of paths) {
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
  if (paths.some(path => base[path] === undefined || !exists(path))) {
    for (const globber of globbers()) {
      for (const position of reaching(globber, new Set())) selected.add(map.specs[position])
    }
  }
  return { specs: [...selected].sort(), reason: null }
}

// The UI's files on the branch a pull request is made against, with the version of each.
const filesAtBase = root => {
  try {
    const listing = execFileSync('git', ['ls-tree', '-r', '-z', 'HEAD^1', '--', ...UI_ROOTS], { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 64 * 1024 * 1024 })
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
// (`baseFiles` says otherwise to a caller that knows better).
export function impactPlan(root, paths, { map, baseFiles = () => filesAtBase(root) }) {
  const graph = suiteGraph(root)
  const hashes = specHashes(root, graph)
  const importers = uiImporters(root)
  return impactedSpecs(map, paths, {
    allSpecs: Object.keys(hashes),
    specHash: name => hashes[name],
    baseFiles,
    importers: path => importers.get(path),
    nodeSpecs: path => specsReaching(graph, [join(root, path)]).map(file => relative(graph.suite, file)),
    exists: path => existsSync(join(root, path)),
    globbers: () => uiGlobbers(root),
  })
}

function collect(paths) {
  return paths.flatMap(path => {
    if (!existsSync(path)) return []
    return statSync(path).isDirectory() ? walk(path) : [path]
  }).filter(file => /(?:^|\/)worker-[^/]*\.json$/.test(file))
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
    const records = collect(args).map(file => JSON.parse(readFileSync(file, 'utf8')))
    const map = mergeRecords(root, records, { commit })
    const all = Object.keys(specHashes(root)).length
    if (records.length === 0 || map.specs.length < all * minimum) {
      process.stderr.write(`ui-impact: ${map.specs.length} of ${all} specs recorded cleanly from ${records.length} files; not writing a map\n`)
      process.exit(2)
    }
    if (out) writeFileSync(out, `${JSON.stringify(map)}\n`)
    process.stderr.write(`ui-impact: ${map.specs.length} of ${all} specs, ${Object.keys(map.files).length} files\n`)
  } else if (command === 'select') {
    const mapFile = option('--map')
    const fresh = flag('--fresh')
    const map = mapFile ? readMap(mapFile) : null
    if (!map) {
      process.stderr.write('ui-impact: no map\n')
      process.exit(2)
    }
    const result = impactPlan(root, args, { map, ...(fresh ? { baseFiles: () => Object.fromEntries(Object.entries(map.files).map(([path, entry]) => [path, entry.blob])) } : {}) })
    const of = Object.keys(specHashes(root)).length
    process.stdout.write(`${JSON.stringify({ of, count: result.specs?.length ?? null, ...result })}\n`)
  } else {
    process.stderr.write('usage: ui-impact.mjs merge <dir>… --out <map> | select --map <map> [--fresh] <path>…\n')
    process.exit(2)
  }
}
