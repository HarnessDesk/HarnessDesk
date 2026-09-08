import type { CodexAppServer, CodexProtocol } from '@harnessdesk/codex'

import { iconDataUri } from './icon-uri.js'
import type {
  ImportableConfig,
  McpAuth,
  McpServer,
  RuntimeCatalog,
  RuntimeExtensions,
  RuntimePlugin,
} from '@harnessdesk/protocol'

/**
 * Codex's extension plane — its plugin marketplaces, its app catalogue, and
 * its MCP servers — behind the protocol's `RuntimeExtensions`. HarnessDesk
 * renders what these report and drives Codex's own install and login; it runs
 * no registry of its own here. That is the whole point: 90+ plugins for the
 * cost of a view.
 *
 * Two Codex surfaces become one catalogue. `plugin/list` gives the installable
 * plugins with their marketplaces, install state and rich `interface`
 * metadata; `app/list` gives the connectable apps with reviews, categories and
 * screenshots. They are shown together because to a user they are one store.
 */
/** Codex's item type for another agent's transcripts. */
const isSessionImport = (kind: string): boolean => kind.toUpperCase() === 'SESSIONS'

export class CodexExtensions implements RuntimeExtensions {
  constructor(private readonly server: CodexAppServer) {}

  /**
   * The plugin marketplaces — the curated, on-disk plugins a Codex user
   * manages. Fast and few. The app/connector directory is thousands of
   * entries and is reached through `searchApps`, not listed here.
   */
  async catalog(cwd?: string): Promise<RuntimeCatalog> {
    const plugins = await this.server.request('plugin/list', cwd ? { cwds: [cwd] } : {})
    return {
      plugins: plugins.marketplaces.flatMap((marketplace) =>
        marketplace.plugins.map((plugin) => mapPlugin(plugin, marketplace.name)),
      ),
      marketplaces: plugins.marketplaces.map((marketplace) => marketplace.name),
      loadErrors: plugins.marketplaceLoadErrors.map((error) => ({
        source: error.marketplacePath,
        message: error.message,
      })),
      featured: plugins.featuredPluginIds,
    }
  }

  async searchApps(
    query: string,
    cursor?: string | null,
  ): Promise<{ apps: RuntimePlugin[]; nextCursor?: string | null }> {
    // app/list has no server-side query, so a page is fetched and filtered.
    // A page is 100; the directory is thousands, so this is a taste plus
    // "more", not the whole thing at once.
    const page = await this.server.request('app/list', { cursor: cursor ?? null, limit: 100 })
    const needle = query.trim().toLowerCase()
    const apps = page.data
      .filter((app) => needle.length === 0 || `${app.name} ${app.description ?? ''}`.toLowerCase().includes(needle))
      .map(mapApp)
    return { apps, nextCursor: page.nextCursor }
  }

  async install(marketplace: string, pluginName: string): Promise<void> {
    await this.server.request('plugin/install', { remoteMarketplaceName: marketplace, pluginName })
  }

  async uninstall(pluginId: string): Promise<void> {
    await this.server.request('plugin/uninstall', { pluginId })
  }

  /**
   * Codex has no "disable" call; enabling is installing and disabling is
   * uninstalling from the on-disk set. Modelled as one method so the interface
   * shows a single toggle.
   */
  async setEnabled(pluginId: string, enabled: boolean): Promise<void> {
    if (enabled) {
      const [marketplace, name] = splitId(pluginId)
      await this.server.request('plugin/install', {
        ...(marketplace ? { remoteMarketplaceName: marketplace } : {}),
        pluginName: name,
      })
    } else {
      await this.uninstall(pluginId)
    }
  }

  /**
   * What Codex offers to bring over from another agent — configuration:
   * AGENTS.md, skills, subagents, hooks, commands, MCP servers.
   *
   * Never conversations. Codex's detection includes a `SESSIONS` item that
   * copies another agent's transcripts in as Codex threads, and a user who
   * accepted it once found every Claude Code conversation listed twice,
   * under two agents and two names — Codex renames what it imports. A
   * conversation belongs to the agent that ran it; moving work to another
   * agent is what Hand off is for, and it says so in the transcript.
   */
  async detectImports(cwd?: string): Promise<readonly ImportableConfig[]> {
    try {
      const response = await this.server.request('externalAgentConfig/detect', {
        includeHome: true,
        ...(cwd ? { cwds: [cwd] } : {}),
      })
      return response.items
        .filter((item) => !isSessionImport(item.itemType))
        .map((item) => ({
          kind: item.itemType,
          label: item.description,
          token: item,
        }))
    } catch {
      return []
    }
  }

  async importConfigs(items: readonly ImportableConfig[]): Promise<void> {
    // The offer no longer lists them, and a caller that asks anyway is
    // refused rather than quietly obeyed: this one is not undoable from here.
    const conversations = items.filter((item) => isSessionImport(item.kind))
    if (conversations.length > 0) {
      throw new Error(
        'Conversations are not imported between agents. Each stays with the agent that ran it; use Hand off to carry work across.',
      )
    }
    if (items.length === 0) return
    await this.server.request('externalAgentConfig/import', {
      migrationItems: items.map((item) => item.token as CodexProtocol.v2.ExternalAgentConfigMigrationItem),
    })
  }

  async mcpServers(cwd?: string): Promise<readonly McpServer[]> {
    const response = await this.server.request('mcpServerStatus/list', {
      detail: 'toolsAndAuthOnly',
      ...(cwd ? { threadId: null } : {}),
    })
    return response.data.map((server) => ({
      name: server.name,
      tools: Object.keys(server.tools),
      resources: server.resources.length,
      auth: mapAuth(server.authStatus),
    }))
  }

  async mcpLogin(name: string): Promise<string> {
    const response = await this.server.request('mcpServer/oauth/login', { name })
    return response.authorizationUrl
  }

  async reloadMcp(): Promise<void> {
    await this.server.request('config/mcpServer/reload', undefined)
  }
}

/** A plugin id is `name@marketplace`; the marketplace half is needed to reinstall. */
const splitId = (id: string): [string | null, string] => {
  const at = id.lastIndexOf('@')
  return at === -1 ? [null, id] : [id.slice(at + 1), id.slice(0, at)]
}

const mapPlugin = (plugin: CodexProtocol.v2.PluginSummary, marketplace: string): RuntimePlugin => ({
  id: plugin.id,
  name: plugin.interface?.displayName ?? plugin.name,
  ...(plugin.interface?.shortDescription ? { description: plugin.interface.shortDescription } : {}),
  ...(plugin.interface?.category ? { category: plugin.interface.category } : {}),
  ...(plugin.interface?.developerName ? { developer: plugin.interface.developerName } : {}),
  // An installed plugin's icon is a local file inside the package, inlined so
  // first-party rows are not the only ones without their mark.
  //
  // `interface.logoUrl` — the catalogue's own URL, on files.openai.com — is
  // deliberately not read. The renderer allows `img-src 'self' data: blob:`
  // and nothing else (see `packages/server/src/server.ts`), so a remote URL
  // here never renders; it only fails into the row's fallback one paint later.
  // Carrying it would hide that rule inside an onError handler, and the local
  // catalogue holds ~6.7k such URLs across hosts the app does not choose.
  logoUrl: iconDataUri(plugin.interface?.logo),
  brandColor: plugin.interface?.brandColor ?? null,
  screenshotUrls: plugin.interface?.screenshotUrls ?? [],
  keywords: plugin.keywords,
  marketplace,
  installed: plugin.installed,
  enabled: plugin.enabled,
})

const mapApp = (app: CodexProtocol.v2.AppInfo): RuntimePlugin => ({
  id: app.id,
  name: app.name,
  ...(app.description ? { description: app.description } : {}),
  ...(app.appMetadata?.categories?.[0] ? { category: app.appMetadata.categories[0] } : {}),
  ...(app.appMetadata?.developer ? { developer: app.appMetadata.developer } : {}),
  // No logo: an app-directory listing is not installed, so its only icon is a
  // remote URL, which the renderer's CSP forbids. These rows wear the
  // extension glyph rather than a broken image.
  screenshotUrls: (app.appMetadata?.screenshots ?? []).flatMap((shot) => (shot.url ? [shot.url] : [])),
  installed: app.isEnabled,
  enabled: app.isEnabled,
  external: true,
  installUrl: app.installUrl,
})

const mapAuth = (status: CodexProtocol.v2.McpAuthStatus): McpAuth => {
  switch (status) {
    case 'oAuth':
      return 'oauth'
    case 'bearerToken':
      return 'token'
    case 'notLoggedIn':
      return 'needsLogin'
    default:
      return 'none'
  }
}
