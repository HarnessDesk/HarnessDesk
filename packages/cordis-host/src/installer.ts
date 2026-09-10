import { execFile } from 'node:child_process'
import { cp, mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { isAbsolute, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { promisify } from 'node:util'

import type { PluginSource } from '@harnessdesk/protocol'

import type { HarnessPlugin } from './kernel.js'
import { pathWithin } from './permissions.js'
import {
  MANIFEST_FILENAME,
  ManifestError,
  isPluginId,
  parseManifest,
  type PluginPackage,
} from './manifest.js'

/**
 * Installing and loading plugins from disk and from npm.
 *
 * Installation copies into a directory HarnessDesk owns rather than loading from
 * wherever the user pointed. A plugin loaded in place would change under the app
 * whenever its source directory changed, which makes "what is installed" a
 * question with no stable answer.
 */

const run = promisify(execFile)

export const pluginsRoot = (): string =>
  process.env['HARNESSDESK_PLUGINS'] ??
  join(process.env['HARNESSDESK_HOME'] ?? join(homedir(), '.harnessdesk'), 'plugins')

export class InstallError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'InstallError'
  }
}

const readManifestAt = async (
  directory: string,
  source: PluginSource,
): Promise<PluginPackage> => {
  const path = join(directory, MANIFEST_FILENAME)
  let raw: string
  try {
    raw = await readFile(path, 'utf8')
  } catch {
    throw new InstallError(
      `No ${MANIFEST_FILENAME} in ${directory}. A HarnessDesk plugin needs one at its root.`,
    )
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch (error) {
    throw new ManifestError(path, `is not valid JSON — ${String(error)}`)
  }
  return parseManifest(parsed, { path, directory, source })
}

/**
 * Reads a plugin's manifest without installing or running anything.
 *
 * This is what the consent dialog is built from: the user sees what a plugin
 * asks for before any of its code is imported.
 */
export const inspect = async (specifier: string): Promise<PluginPackage> => {
  if (isLocalPath(specifier)) {
    const directory = resolve(specifier)
    return readManifestAt(directory, { kind: 'local', path: directory })
  }
  // An npm package has to be fetched before its manifest can be read; `npm pack`
  // downloads the tarball without running install scripts.
  const staging = join(pluginsRoot(), '.staging', sanitise(specifier))
  await fetchFromNpm(specifier, staging)
  return readManifestAt(staging, { kind: 'npm', specifier })
}

const isLocalPath = (specifier: string): boolean =>
  specifier.startsWith('.') || specifier.startsWith('/') || isAbsolute(specifier)

const sanitise = (value: string): string => value.replace(/[^a-zA-Z0-9._-]/g, '_')

/**
 * Fetches an npm package into a directory.
 *
 * `npm pack` then extract, rather than `npm install`: pack does not execute the
 * package's install scripts, so nothing from the registry runs before the user
 * has seen what it is asking for.
 */
const fetchFromNpm = async (specifier: string, target: string): Promise<void> => {
  await rm(target, { recursive: true, force: true })
  await mkdir(target, { recursive: true })
  try {
    const { stdout } = await run('npm', ['pack', specifier, '--silent', '--pack-destination', target], {
      timeout: 120_000,
    })
    const tarball = stdout.trim().split('\n').pop()
    if (!tarball) throw new InstallError(`npm pack produced nothing for ${specifier}`)
    await run('tar', ['-xzf', join(target, tarball), '-C', target, '--strip-components', '1'], {
      timeout: 120_000,
    })
    await rm(join(target, tarball), { force: true })
  } catch (error) {
    if (error instanceof InstallError) throw error
    throw new InstallError(`Could not fetch ${specifier} from npm: ${String(error)}`)
  }
}

export interface InstalledPlugin {
  readonly id: string
  readonly directory: string
  readonly source: PluginSource
}

/**
 * Installs a plugin into HarnessDesk's own plugin directory.
 *
 * Returns without loading it: installation and activation are separate so a
 * plugin can be installed, reviewed, and only then enabled.
 */
/** Where the installed copy remembers what it was installed from. */
const SOURCE_FILENAME = '.harnessdesk-source.json'

export const install = async (specifier: string): Promise<InstalledPlugin> => {
  const inspected = await inspect(specifier)
  const target = join(pluginsRoot(), inspected.manifest.id)

  if (resolve(inspected.directory) === resolve(target)) {
    throw new InstallError(
      `${inspected.manifest.id} is already the installed copy. Install from the ` +
        'directory you develop in, and "Update from source" will work from then on.',
    )
  }

  await rm(target, { recursive: true, force: true })
  await mkdir(target, { recursive: true })
  await cp(inspected.directory, target, { recursive: true })
  // The installed copy remembers its origin, so "Update from source" can
  // reinstall from where the developer actually edits — the copied
  // manifest's own idea of its source is this directory, which is useless.
  await writeFile(
    join(target, SOURCE_FILENAME),
    JSON.stringify(inspected.manifest.source ?? { kind: 'local', path: resolve(specifier) }),
  )

  // The staging copy has served its purpose.
  if (inspected.directory.includes(`${'.staging'}`)) {
    await rm(inspected.directory, { recursive: true, force: true })
  }

  return {
    id: inspected.manifest.id,
    directory: target,
    source: inspected.manifest.source ?? { kind: 'local', path: target },
  }
}

export const uninstall = async (id: string): Promise<void> => {
  const root = pluginsRoot()
  const target = resolve(join(root, id))
  /* Two ways an id takes more than the plugin it names, and the old guard —
     a bare `startsWith` with no separator between the two — admitted both.
     An id of "", "." or "demo/.." resolves to the plugins directory itself,
     and `rm` with `recursive` on that removes every installed plugin; an id
     of "../plugins-backup/x" lands beside it, which is a prefix of the root
     as a string and outside it as a path. */
  if (target === resolve(root)) {
    throw new InstallError(
      `Refusing to remove ${target}: that is the plugins directory itself, not an installed plugin`,
    )
  }
  if (!pathWithin(root, target)) {
    throw new InstallError(`Refusing to remove ${target}: outside the plugins directory`)
  }
  /* Containment is necessary and not sufficient: `sample/../other` stays inside
     the plugins root and still removes a plugin the caller did not name. An id
     is a single directory name — the manifest has always said so — so the
     traversal is refused on that ground. */
  if (!isPluginId(id)) {
    throw new InstallError(`Refusing to remove ${target}: "${id}" is not a plugin id`)
  }
  await rm(target, { recursive: true, force: true })
}

/**
 * Imports an installed plugin and pairs it with its manifest.
 *
 * The manifest governs, not the module: a plugin cannot widen its own
 * permissions by exporting a different manifest than the one on disk.
 */
export const loadInstalled = async (directory: string): Promise<HarnessPlugin> => {
  const info = await stat(directory).catch(() => null)
  if (!info?.isDirectory()) throw new InstallError(`${directory} is not an installed plugin`)

  const pkg = await readManifestAt(directory, await recordedSource(directory))
  const entry = resolve(directory, pkg.entry)
  if (!pathWithin(directory, entry)) {
    throw new InstallError(`${pkg.manifest.id} points outside its own directory`)
  }

  // Cache-busted: Node caches ES modules by URL, so a reinstalled plugin
  // would otherwise keep running its previous code — the exact opposite of
  // what "Update from source" promises a developer mid-edit.
  const module = (await import(`${pathToFileURL(entry).href}?v=${Date.now()}`)) as {
    default?: unknown
    plugin?: unknown
  }
  let plugin = module.plugin ?? module.default
  if (!plugin) {
    throw new InstallError(
      `${pkg.manifest.id} exports neither \`plugin\` nor a default export from ${pkg.entry}`,
    )
  }
  // Forgiveness over a trap: authors copying the in-repo built-in shape
  // export the whole { manifest, plugin } pair. The intent is unambiguous —
  // unwrap it, and let the manifest file stay the manifest.
  const wrapped = plugin as { plugin?: unknown; manifest?: unknown; apply?: unknown }
  if (wrapped.plugin && wrapped.manifest && !wrapped.apply) {
    plugin = wrapped.plugin
  }

  return { manifest: pkg.manifest, plugin }
}

/** One of the three origins whole: a record of the right kind with nothing in it is not one (review, round 1). */
const isPluginSource = (value: unknown): value is PluginSource => {
  if (typeof value !== 'object' || value === null) return false
  const source = value as { kind?: unknown; path?: unknown; specifier?: unknown }
  if (source.kind === 'builtin') return true
  if (source.kind === 'local') return typeof source.path === 'string' && source.path !== ''
  if (source.kind === 'npm') return typeof source.specifier === 'string' && source.specifier !== ''
  return false
}

/**
 * Where an installed copy came from, as `install()` wrote it down. One
 * installed before origins were recorded, or whose record is not one, knows
 * only itself.
 */
const recordedSource = async (directory: string): Promise<PluginSource> => {
  try {
    const recorded: unknown = JSON.parse(await readFile(join(directory, SOURCE_FILENAME), 'utf8'))
    if (isPluginSource(recorded)) return recorded
  } catch {
    // Installed before origins were recorded.
  }
  return { kind: 'local', path: directory }
}

/** Every plugin currently installed, whether or not it loads. */
export const listInstalled = async (): Promise<InstalledPlugin[]> => {
  const root = pluginsRoot()
  let entries
  try {
    entries = await readdir(root, { withFileTypes: true })
  } catch {
    return []
  }
  const out: InstalledPlugin[] = []
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name.startsWith('.')) continue
    const directory = join(root, entry.name)
    try {
      // The origin the install wrote down, as loading reads it: the copy's
      // own directory called every plugin a local one (#45).
      const source = await recordedSource(directory)
      const pkg = await readManifestAt(directory, source)
      out.push({ id: pkg.manifest.id, directory, source: pkg.manifest.source ?? source })
    } catch {
      // A directory without a readable manifest is not an installed plugin.
      // Listing it would only produce an entry nothing can act on.
    }
  }
  return out
}
