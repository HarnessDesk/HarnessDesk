// What a file loads, read without running anything: the imports of the browser
// suite and of the UI. `ci-changes.mjs` plans a pull request with them and
// `ui-impact.mjs` records and reads the map of what each spec ran.
// Both run before dependencies are installed, so this module uses only builtins.
import { createHash } from 'node:crypto'
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { basename, dirname, extname, isAbsolute, join, relative, resolve } from 'node:path'

export const SOURCE = ['.ts', '.tsx', '.mts', '.cts', '.mjs', '.cjs', '.js', '.jsx']
export const IMPORT = /(?:\bfrom\s*|\bimport\s*(?:\(\s*)?|\brequire\s*\(\s*)['"]([^'"\n]+)['"]/g
// A file named by `new URL('./helper', import.meta.url)` is loaded at run time, by a child process or a worker.
export const URL_IMPORT = /new\s+URL\(\s*['"](\.[^'"\n]*)['"]\s*,\s*import\.meta\.url\s*\)/g
export const SPEC = /\.spec\.[cm]?[jt]sx?$/

// Consume strings whole before looking for comment markers: URLs and template
// contents can contain // or /* as data. Keep offsets and line breaks intact.
const withoutComments = text => text.replace(/'((?:\\[\s\S]|[^'\\\r\n])*)'|"((?:\\[\s\S]|[^"\\\r\n])*)"|`((?:\\[\s\S]|[^`\\])*)`|\/\/[^\r\n]*|\/\*[\s\S]*?\*\//g,
  token => token.startsWith('//') || token.startsWith('/*') ? token.replace(/[^\r\n]/g, ' ') : token)

export const walk = directory => readdirSync(directory, { withFileTypes: true }).flatMap(entry =>
  entry.isDirectory() ? walk(join(directory, entry.name)) : [join(directory, entry.name)])

// The git blob id of some content: what `git hash-object` prints, so a map can
// say which version of a file it saw without asking git.
export const blobSha = content => {
  const body = Buffer.isBuffer(content) ? content : Buffer.from(content)
  return createHash('sha1').update(`blob ${body.length}\0`).update(body).digest('hex')
}

// The source file a relative import names, or null for an asset (`./frame.png`).
// A source file that is not there is an error and not a skip: a selection that
// quietly lost an edge would run too little.
export const resolveHelper = (file, specifier) => {
  const base = resolve(dirname(file), specifier)
  const extension = extname(base)
  // A spec may import a compiled host fixture. Planning runs before the build,
  // so read its source, even when an old dist happens to be present locally.
  const source = base.replace(/(\/packages\/[^/]+)\/dist\//, '$1/')
  const compiledSource = source === base ? [] : [source.replace(/\.js$/, '.ts'), source.replace(/\.mjs$/, '.mts'), source.replace(/\.cjs$/, '.cts')]
  const helper = [...compiledSource, base, ...SOURCE.map(ext => `${base}${ext}`),
    base.replace(/\.js$/, '.ts'), base.replace(/\.mjs$/, '.mts'), base.replace(/\.cjs$/, '.cts'),
    ...SOURCE.map(ext => join(base, `index${ext}`))]
    .find(candidate => existsSync(candidate) && SOURCE.includes(extname(candidate)))
  if (helper) return helper
  if (extension && !SOURCE.includes(extension)) return null
  // Build output is not in a checkout that has not built (the jobs that plan a run do not): it is no file of the suite to follow.
  if (/(?:^|\/)dist\//.test(specifier)) return null
  throw new Error(`Cannot resolve suite import: ${specifier}`)
}

// The source file a path names, or null: unlike an import, a URL may name a folder or a data file.
export const findSource = (file, specifier) => {
  const base = resolve(dirname(file), specifier)
  return [base, ...SOURCE.map(ext => `${base}${ext}`)]
    .find(candidate => existsSync(candidate) && statSync(candidate).isFile() && SOURCE.includes(extname(candidate))) ?? null
}

// The file a URL names, whatever it is: a data file a spec reads is as much a part of it as a helper it imports.
export const findFile = (file, specifier) => {
  const target = resolve(dirname(file), specifier)
  return existsSync(target) && statSync(target).isFile() ? target : null
}

// Whether a file names a helper any way at all: a path built by hand, a name in a
// string. A scan that missed an edge would run too little, one that found a stray
// edge runs a spec too many.
export const mentions = (text, helper) => {
  const stem = basename(helper, extname(helper))
  return stem.length >= 4 && new RegExp(`(?<![\\w-])${stem.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![\\w-])`).test(text)
}

// Who loads whom inside the browser suite, in both directions. A spec, or a helper
// a spec loads, can also name a file outside the suite (`script/shots/audit.mjs`,
// a constant of the UI): that file is a leaf here, and the specs that name it are
// its importers.
export function suiteGraph(root) {
  const suite = join(root, 'e2e/ui-system')
  const sources = walk(suite).filter(file => SOURCE.includes(extname(file)))
  const helpers = sources.filter(file => !SPEC.test(file))
  const importers = new Map()
  const forward = new Map()
  const edge = (helper, file) => {
    importers.set(helper, new Set([...(importers.get(helper) ?? []), file]))
    forward.set(file, new Set([...(forward.get(file) ?? []), helper]))
  }
  for (const file of sources) {
    const text = withoutComments(readFileSync(file, 'utf8'))
    for (const [, specifier] of text.matchAll(IMPORT)) {
      if (!specifier.startsWith('.')) continue
      const helper = resolveHelper(file, specifier)
      if (helper) edge(helper, file)
    }
    for (const [, specifier] of text.matchAll(URL_IMPORT)) {
      const helper = findFile(file, specifier)
      if (helper) edge(helper, file)
    }
    for (const helper of helpers) {
      if (helper !== file && mentions(text, helper)) edge(helper, file)
    }
  }
  return { suite, sources, importers, forward }
}

// Literal file reads are dependency edges too. Keep this scan dependency-free:
// CI plans before install. The gate independently checks these edges with the TS parser.
export function repositoryGraph(root, graph = suiteGraph(root)) {
  root = resolve(root)
  const importers = new Map([...graph.importers].map(([file, parents]) => [file, new Set(parents)]))
  const queue = graph.sources.filter(file => specsReaching(graph, [file]).length > 0)
  const seen = new Set()
  while (queue.length > 0) {
    const file = queue.pop()
    if (seen.has(file)) continue
    seen.add(file)
    const text = withoutComments(readFileSync(file, 'utf8'))
    const add = target => {
      if (!target || !target.startsWith(`${root}/`)) return
      importers.set(target, new Set([...(importers.get(target) ?? []), file]))
      if (existsSync(target) && SOURCE.includes(extname(target)) && !relative(root, target).startsWith('packages/')) queue.push(target)
    }
    for (const [, specifier] of text.matchAll(IMPORT)) {
      if (specifier.startsWith('.')) add(resolveHelper(file, specifier))
    }
    // URL expressions can sit inside generated executable templates, where
    // nested quotes prevent the ordinary literal scan from seeing the path.
    for (const [, specifier] of text.matchAll(URL_IMPORT)) add(findFile(file, specifier))
    // Also sees literals used in URLs, child-process arguments and source-text reads.
    for (const match of text.matchAll(/(['"`])([^'"`\\\n]+)\1/g)) {
      const literal = match[2]
      if (literal.startsWith('.')) add(findFile(file, literal) ?? (extname(literal) ? resolve(dirname(file), literal) : null))
      else if (!isAbsolute(literal) && (literal.includes('/') || /(?:readFile|readFileSync)\s*\(\s*$/.test(text.slice(0, match.index)))) {
        add(findFile(join(root, 'entry'), `./${literal}`) ?? (/^(?:docs|script|packages|e2e|assets)\//.test(literal) ? resolve(root, literal) : null))
      }
    }
  }
  return { ...graph, importers }
}

// A spec and everything it loads, as one id: the same id on a later run means
// the spec would do the same thing.
export function specHashes(root, graph = suiteGraph(root)) {
  const closure = spec => {
    const seen = new Set()
    const queue = [spec]
    while (queue.length > 0) {
      const file = queue.pop()
      if (seen.has(file)) continue
      seen.add(file)
      if (file.startsWith(`${graph.suite}/`)) queue.push(...(graph.forward.get(file) ?? []))
    }
    return [...seen]
  }
  return Object.fromEntries(graph.sources.filter(file => SPEC.test(file)).map(spec => {
    const hash = createHash('sha1')
    for (const file of closure(spec).map(file => relative(root, file)).sort()) {
      hash.update(`${file}\0${blobSha(readFileSync(join(root, file)))}\n`)
    }
    return [relative(graph.suite, spec), hash.digest('hex')]
  }))
}

// The specs that load any of these files, directly or through other helpers.
export function specsReaching(graph, files) {
  const reached = new Set()
  const queue = [...files]
  while (queue.length > 0) {
    const file = queue.pop()
    if (reached.has(file)) continue
    reached.add(file)
    queue.push(...(graph.importers.get(file) ?? []))
  }
  return [...reached].filter(file => SPEC.test(file) && file.startsWith(`${graph.suite}/`))
}

// The text of every source file of the suite, by path.
export function suiteTexts(graph) {
  return new Map(graph.sources.map(file => [file, readFileSync(file, 'utf8')]))
}

// The specs that name a data file (a `.json` they read, a stylesheet they parse) anywhere in their own
// text or a helper's, by the file's name: a spec that reads one by a path built by hand has no import
// to follow, and the name is all that ties it to the file.
export function specsNaming(graph, path, texts = suiteTexts(graph)) {
  const name = basename(path)
  if (SOURCE.includes(extname(path)) || name.length < 6) return []
  const naming = [...texts].filter(([, text]) => text.includes(name)).map(([file]) => file)
  return specsReaching(graph, naming).map(file => relative(graph.suite, file))
}

// Specs whose tests open pages of their own, which the recorder never sees (it watches the page a test is
// given): they cannot be planned from a record, so they always run.
export function unobservedSpecs(root, graph = suiteGraph(root)) {
  const opens = /\.new(?:Page|Context)\s*\(|\.launch\s*\(|waitForEvent\(\s*['"](?:popup|page)['"]|\.on(?:ce)?\(\s*['"](?:popup|page)['"]/
  const holding = graph.sources.filter(file => opens.test(readFileSync(file, 'utf8')))
  return specsReaching(graph, holding).map(file => relative(graph.suite, file)).sort()
}

// These are the build's entry pages. Query strings vary the fixture, not the
// route. Source URLs and source-response rewrites still belong to Vite's dev server.
export const E2E_PAGES = ['preview.html', 'design.html', 'narrow-overlay.html', 'runtime-copy-repair.html', 'src/preview/tile-page.html']

// The workspace packages the UI is built from, resolved from the manifests, so adding a
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
