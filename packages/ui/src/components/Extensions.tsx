import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react'

import type { McpServer, RuntimeCatalog, RuntimePlugin } from '@harnessdesk/protocol'

import { openExternal } from '../lib/desktop'
import { shortPath } from '../lib/paths'
import { useRuntime, useSnapshot, useStore } from '../state/context'
import { AlertIcon, ExtensionIcon, PluginIcon, ServerIcon } from './Icons'
import { Btn, Chip, Note, PageHead, Row, Rows, Search, SectionHead } from '../design/primitives/Kit'
import { Tabs, TabsList, TabsTrigger } from '../design/ui'
import styles from './Settings.module.css'

/**
 * The backend's own extension plane, surfaced.
 *
 * HarnessDesk runs no registry here: it renders what the runtime reports and
 * drives the runtime's install and login. Two subsections — the plugin/app
 * store and the MCP servers — because they are two questions ("what can I add"
 * and "what tools are connected") a user asks separately. Everything is the
 * runtime's; the copy says so, and a marketplace that failed to load is shown
 * rather than silently missing.
 */
/** How many marketplace entries to show before asking. */
const PAGE = 12
/** How many failed marketplaces to show before asking: five pushed the tabs below the fold (#219). */
const FAILURES = 3

export const ExtensionsSection = () => {
  const store = useStore()
  const runtime = useRuntime()
  const snapshot = useSnapshot()
  const [catalog, setCatalog] = useState<RuntimeCatalog | null>(null)
  const [query, setQuery] = useState('')
  const [tab, setTab] = useState<'plugins' | 'apps' | 'mcp'>(
    runtime.capabilities.extensionStore ? 'plugins' : 'mcp',
  )
  const [shown, setShown] = useState(PAGE)
  const [failuresShown, setFailuresShown] = useState(FAILURES)

  const reload = useCallback(() => {
    void store.loadCatalog().then(setCatalog)
  }, [store])

  useEffect(reload, [reload, snapshot.workspace?.path])

  const { installed, available } = useMemo(() => {
    const all = catalog?.plugins ?? []
    const needle = query.trim().toLowerCase()
    const matched = needle
      ? all.filter((plugin) =>
          `${plugin.name} ${plugin.description ?? ''} ${(plugin.keywords ?? []).join(' ')}`
            .toLowerCase()
            .includes(needle),
        )
      : all
    // Featured first among the rest — the order a store shows.
    const featured = new Set(catalog?.featured ?? [])
    const sorted = [...matched].sort((a, b) => rank(a, featured) - rank(b, featured))
    return {
      installed: sorted.filter((plugin) => plugin.installed),
      available: sorted.filter((plugin) => !plugin.installed),
    }
  }, [catalog, query])

  const tabs: { id: typeof tab; label: string; icon: ReactNode }[] = [
    ...(runtime.capabilities.extensionStore
      ? [
          { id: 'plugins' as const, label: 'Plugins', icon: <PluginIcon size={13} /> },
          { id: 'apps' as const, label: 'Apps', icon: <ExtensionIcon size={13} /> },
        ]
      : []),
    ...(runtime.capabilities.mcp ? [{ id: 'mcp' as const, label: 'MCP servers', icon: <ServerIcon size={13} /> }] : []),
  ]

  return (
    <>
      <PageHead
        title="Extensions"
        blurb={`What ${runtime.presentation.name} can connect to: its plugins, apps and MCP servers.`}
      />

      {/* A row per marketplace that failed, each with its own words. One row
          counted them all and showed the first message, so with three
          failures two reasons were never seen (#105). */}
      {(catalog?.loadErrors.length ?? 0) > 0 && (
        <>
          <Rows>
            {catalog!.loadErrors.slice(0, failuresShown).map((error, index) => (
              <Row
                /* By position. The list is never sorted or filtered and no row
                   holds state, and two failures can share a source and a
                   message, which as a key made them one row to React (#219). */
                key={index}
                mark={<AlertIcon size={15} />}
                // Under the home folder as `~`, the way paths are shown elsewhere; in full it ran to three lines.
                title={`${shortPath(error.source, snapshot.home)} failed to load`}
                desc={error.message}
                control={<Chip state="broken" label="Failed" />}
              />
            ))}
          </Rows>
          {catalog!.loadErrors.length > failuresShown && (
            <Btn onClick={() => setFailuresShown(catalog!.loadErrors.length)}>
              Show {catalog!.loadErrors.length - failuresShown} more
            </Btn>
          )}
        </>
      )}

      {tabs.length > 1 && (
        <div className={styles.extTabs}>
          {/* Tabs, not `Segmented`. These switch which list is on screen, which
              is what a tab is; `Segmented` is `role="radiogroup"`, so a screen
              reader was announcing "What to show, radio button, 1 of 2" for a
              control that navigates. Same shape, correct semantics, and arrow
              keys now move between them. */}
          <Tabs value={tab} onValueChange={(next) => setTab(next as typeof tab)}>
            <TabsList aria-label="What to show">
              {tabs.map((entry) => (
                <TabsTrigger key={entry.id} value={entry.id}>
                  {entry.id === 'plugins' && installed.length > 0
                    ? `${entry.label} · ${installed.length}`
                    : entry.label}
                </TabsTrigger>
              ))}
            </TabsList>
          </Tabs>
        </div>
      )}

      {tab === 'plugins' && (
        <>
          <Search
            className={styles.pageSearch}
            value={query}
            placeholder="Search plugins"
            onChange={(next) => {
              setQuery(next)
              setShown(PAGE)
            }}
          />
          {catalog === null ? (
            <Note>Loading…</Note>
          ) : (
            <>
              <SectionHead name={`Installed · ${installed.length}`} />
              <Rows>
                {installed.length === 0 ? (
                  <Row title={query ? 'No installed plugin matches' : 'Nothing installed yet'} />
                ) : (
                  installed.map((plugin) => <PluginRow key={plugin.id} plugin={plugin} />)
                )}
              </Rows>
              <SectionHead name={`Available · ${available.length}`} />
              <Rows>
                {available.length === 0 ? (
                  <Row title="Nothing more to add" />
                ) : (
                  available.slice(0, shown).map((plugin) => (
                    <PluginRow key={plugin.id} plugin={plugin} />
                  ))
                )}
              </Rows>
              {available.length > shown && (
                <Btn onClick={() => setShown((count) => count + PAGE * 2)}>
                  Show {Math.min(PAGE * 2, available.length - shown)} more
                </Btn>
              )}
            </>
          )}
        </>
      )}

      {tab === 'apps' && <AppDirectory />}
      {tab === 'mcp' && <McpServers />}
    </>
  )
}

const rank = (plugin: RuntimePlugin, featured: ReadonlySet<string>): number =>
  plugin.installed ? 0 : featured.has(plugin.id) ? 1 : 2

const PluginRow = ({ plugin }: { plugin: RuntimePlugin }) => {
  const store = useStore()
  const [busy, setBusy] = useState(false)
  const [logoBroken, setLogoBroken] = useState(false)

  const toggle = async (): Promise<void> => {
    setBusy(true)
    try {
      await store.setRuntimePluginInstalled(
        plugin.marketplace ?? '',
        plugin.name,
        plugin.id,
        !plugin.installed,
      )
      await store.loadCatalog()
    } finally {
      setBusy(false)
    }
  }

  return (
    <Row
      mark={
        // Always a `data:` URI inlined from the installed package — the adapter
        // drops catalogue URLs, because this renderer loads no remote images.
        // `onError` stays for the one case left: a logo file that will not decode.
        plugin.logoUrl && !logoBroken ? (
          <img
            src={plugin.logoUrl}
            alt=""
            width={20}
            height={20}
            style={{ borderRadius: 5 }}
            onError={() => setLogoBroken(true)}
          />
        ) : plugin.brandColor ? (
          // No logo but an accent: the listing's own colour under its
          // initial, the way the runtime's store draws it.
          <span className={styles.skillTile} style={{ background: plugin.brandColor }}>
            {plugin.name.charAt(0).toUpperCase()}
          </span>
        ) : // No logo and no accent: the glyph. Most catalogue rows land here,
        // because a listing's mark lives on the catalogue's own host.
        plugin.external ? (
          <ExtensionIcon size={15} />
        ) : (
          <PluginIcon size={15} />
        )
      }
      title={
        <>
          {plugin.name}
          {plugin.category && <span className={styles.inlineBadge}>{plugin.category}</span>}
        </>
      }
      desc={
        <>
          {plugin.description}
          {plugin.developer ? `${plugin.description ? ' · ' : ''}by ${plugin.developer}` : ''}
        </>
      }
      control={
        plugin.external ? (
          <Btn
            small
            disabled={!plugin.installUrl}
            onClick={() => plugin.installUrl && openExternal(plugin.installUrl)}
          >
            {plugin.installed ? 'Connected' : 'Connect'}
          </Btn>
        ) : (
          <>
            {/* Installed and yet it will not run. The runtime reports both
                facts and this row drew only the first, so a plugin an
                administrator had turned off — or one this plan does not
                include — sat here reading "Installed" beside nine that
                worked. Nothing to press: none of the agents this app drives
                offers a verb that turns one back on, so the honest control
                is a word, and the removal button beside it. */}
            {plugin.installed && !plugin.enabled && (
              <Chip state="broken" label={plugin.disabledReason ?? 'off'} />
            )}
            <Btn
              small
              {...(plugin.installed ? { variant: 'quiet' as const } : {})}
              disabled={busy}
              onClick={() => void toggle()}
            >
              {busy ? '…' : plugin.installed ? 'Installed' : 'Install'}
            </Btn>
          </>
        )
      }
    />
  )
}

/**
 * The app/connector directory, searched rather than listed: it is thousands of
 * entries, and each connects on the runtime's side (a link out), so this is a
 * find-and-connect surface, not an install list.
 */
const AppDirectory = () => {
  const store = useStore()
  const runtime = useRuntime()
  const [query, setQuery] = useState('')
  const [apps, setApps] = useState<readonly RuntimePlugin[] | null>(null)

  useEffect(() => {
    let cancelled = false
    const timer = window.setTimeout(() => {
      void store.searchApps(query).then((result) => {
        if (!cancelled) setApps(result.apps)
      })
    }, 200)
    return () => {
      cancelled = true
      window.clearTimeout(timer)
    }
  }, [query, store])

  if (!runtime.capabilities.extensionStore) return null

  return (
    <>
      <SectionHead name="Connect an app" />
      <Note>Connecting happens in {runtime.presentation.name}; HarnessDesk opens the link.</Note>
      <Search
        className={styles.pageSearch}
        value={query}
        placeholder="Search apps to connect"
        onChange={setQuery}
      />
      <Rows>
        {apps === null ? (
          <Row title="Type to search" />
        ) : apps.length === 0 ? (
          <Row title="No apps match" />
        ) : (
          apps.slice(0, 20).map((app) => <PluginRow key={app.id} plugin={app} />)
        )}
      </Rows>
    </>
  )
}

/** MCP servers the runtime has configured — the tools the agent can call. */
const McpServers = () => {
  const store = useStore()
  const runtime = useRuntime()
  const snapshot = useSnapshot()
  const [servers, setServers] = useState<readonly McpServer[] | null>(null)

  const reload = useCallback(() => {
    void store.loadMcpServers().then(setServers)
  }, [store])

  useEffect(reload, [reload, snapshot.workspace?.path])

  if (!runtime.capabilities.mcp) return null

  return (
    <>
      <SectionHead
        name={`MCP servers${servers && servers.length > 0 ? ` · ${servers.length}` : ''}`}
        action={
          <Btn
            variant="outline"
            small
            onClick={() => {
              void store.reloadMcp().then(reload)
            }}
          >
            Reload
          </Btn>
        }
      />
      <Note>
        Configured in {runtime.presentation.name}
        {runtime.presentation.configLocation ? `, in ${runtime.presentation.configLocation}` : ''}.
      </Note>
      <Rows>
        {servers === null ? (
          <Row title="Loading…" />
        ) : servers.length === 0 ? (
          <Row title="None configured" />
        ) : (
          servers.map((server) => (
            <Row
              key={server.name}
              mark={<ServerIcon size={15} />}
              title={server.name}
              desc={`${server.tools.length} tool${server.tools.length === 1 ? '' : 's'}${
                server.resources > 0 ? ` · ${server.resources} resources` : ''
              }`}
              control={
                server.auth === 'needsLogin' ? (
                  <Btn small variant="primary" onClick={() => void store.mcpLogin(server.name)}>
                    Sign in
                  </Btn>
                ) : (
                  <Chip
                    state={server.auth === 'none' ? 'available' : 'ready'}
                    label={
                      server.auth === 'none'
                        ? 'Ready'
                        : server.auth === 'token'
                          ? 'Authorised'
                          : server.auth === 'oauth'
                            ? 'Signed in'
                            : server.auth
                    }
                  />
                )
              }
            />
          ))
        )}
      </Rows>
    </>
  )
}
