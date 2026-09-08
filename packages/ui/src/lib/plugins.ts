import type { PluginInstance } from '@harnessdesk/protocol'

/**
 * Which plugins the interface should treat as real.
 *
 * A plugin that shipped as an example and was installed from there, and later
 * became part of the app, leaves a copy on disk claiming the same id. The host
 * switches that copy off — two live copies would hand an agent the same tool
 * twice under two namespaces — but it is still in the roster, and a roster
 * with two rows called "Browser" is not a state anybody can reason about.
 *
 * The split lives here rather than in the plugins page, because three places
 * count plugins — the sidebar, the settings nav and the page itself — and
 * three separate filters is how they end up disagreeing.
 */

const builtinIds = (plugins: readonly PluginInstance[]): ReadonlySet<string> =>
  new Set(
    plugins
      .filter((plugin) => plugin.identity.source.kind === 'builtin')
      .map((plugin) => plugin.identity.id),
  )

/** An installed copy of something the app now ships itself. */
export const isSuperseded = (
  plugin: PluginInstance,
  plugins: readonly PluginInstance[],
): boolean =>
  plugin.identity.source.kind !== 'builtin' && builtinIds(plugins).has(plugin.identity.id)

/** Everything that actually contributes something. What every count means. */
export const livePlugins = (plugins: readonly PluginInstance[]): readonly PluginInstance[] => {
  const builtin = builtinIds(plugins)
  return plugins.filter(
    (plugin) => plugin.identity.source.kind === 'builtin' || !builtin.has(plugin.identity.id),
  )
}

/** The copies the app has taken over, set aside rather than hidden. */
export const supersededPlugins = (
  plugins: readonly PluginInstance[],
): readonly PluginInstance[] => {
  const builtin = builtinIds(plugins)
  return plugins.filter(
    (plugin) => plugin.identity.source.kind !== 'builtin' && builtin.has(plugin.identity.id),
  )
}
