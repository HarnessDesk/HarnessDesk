import type { JsonSchema, PluginPermissions, PluginSource } from '@harnessdesk/protocol'

import type { PluginManifest } from './kernel.js'

/**
 * Reading a plugin manifest off disk.
 *
 * Manifests come from outside the repository, so every field is validated rather
 * than trusted. The rule that matters most: an unreadable or malformed
 * permissions block resolves to **no** permissions, never to the defaults —
 * a plugin must not gain reach by shipping a broken manifest.
 */

export class ManifestError extends Error {
  constructor(
    readonly path: string,
    message: string,
  ) {
    super(`${path}: ${message}`)
    this.name = 'ManifestError'
  }
}

/** The file a plugin directory is identified by. */
export const MANIFEST_FILENAME = 'harnessdesk.plugin.json'

export interface PluginPackage {
  readonly manifest: PluginManifest
  /** Module specifier to import, resolved against the plugin directory. */
  readonly entry: string
  readonly directory: string
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const asStringArray = (value: unknown): string[] =>
  Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === 'string') : []

/**
 * Reads the permissions a manifest requests.
 *
 * Every field defaults to denied. A manifest that omits a section is asking for
 * nothing from it, and a manifest whose section is the wrong shape is treated the
 * same way — being generous with a malformed grant is how permission systems
 * become decorative.
 */
export const readPermissions = (value: unknown): PluginPermissions => {
  const source = isRecord(value) ? value : {}
  const workspace = isRecord(source['workspace']) ? source['workspace'] : {}
  const network = isRecord(source['network']) ? source['network'] : {}
  const agents = isRecord(source['agents']) ? source['agents'] : {}
  const ui = isRecord(source['ui']) ? source['ui'] : {}

  return {
    workspace: {
      read: workspace['read'] === true,
      write: workspace['write'] === true,
    },
    shell: source['shell'] === true,
    network: { hosts: asStringArray(network['hosts']) },
    agents: { invoke: agents['invoke'] === true },
    ui: { contribute: ui['contribute'] === true },
    browser: source['browser'] === true,
    ios: source['ios'] === true,
    android: source['android'] === true,
    editor: source['editor'] === true,
    team: source['team'] === true,
    forge: source['forge'] === true,
    secrets: asStringArray(source['secrets']),
  }
}

/** A plugin id has to be safe as a directory name and as a tool namespace. */
const ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,62}$/

/**
 * Whether a string is a plugin id.
 *
 * Exported because `uninstall` needs the same answer: an id is a single
 * directory name, so anything carrying a separator or a dot segment is not one,
 * however the path it builds happens to resolve.
 */
export const isPluginId = (value: string): boolean => ID_PATTERN.test(value)

export const parseManifest = (
  raw: unknown,
  context: { path: string; directory: string; source: PluginSource },
): PluginPackage => {
  if (!isRecord(raw)) throw new ManifestError(context.path, 'the manifest must be an object')

  const id = raw['id']
  if (typeof id !== 'string' || !ID_PATTERN.test(id)) {
    throw new ManifestError(
      context.path,
      'id must be lowercase letters, digits, and hyphens, and start with a letter or digit',
    )
  }

  const name = typeof raw['name'] === 'string' && raw['name'].trim() ? raw['name'] : id
  const entry = typeof raw['main'] === 'string' ? raw['main'] : './index.js'
  // The entry must stay inside the plugin directory: a manifest pointing at
  // `../../something` would let an install reach code it does not own.
  if (entry.includes('..')) {
    throw new ManifestError(context.path, 'main must not escape the plugin directory')
  }

  const manifest: PluginManifest = {
    id,
    name,
    ...(typeof raw['description'] === 'string' ? { description: raw['description'] } : {}),
    ...(typeof raw['version'] === 'string' ? { version: raw['version'] } : {}),
    source: context.source,
    permissions: readPermissions(raw['permissions']),
    ...(isRecord(raw['configSchema'])
      ? { configSchema: raw['configSchema'] as JsonSchema }
      : {}),
  }

  return { manifest, entry, directory: context.directory }
}

/**
 * A human-readable summary of what a manifest is asking for.
 *
 * Re-exported, not defined here. The renderer's Plugins page renders the same
 * list and may not import this package — `script/check-layering.mjs` keeps the
 * extension plane away from the window — so the one implementation lives in
 * `@harnessdesk/protocol`, which both sides may speak. #288 is what the second
 * copy had already drifted into.
 */
export { describePermissions } from '@harnessdesk/protocol'
