import type { CodexProtocol } from '@harnessdesk/codex'
import type {
  CapabilityRegistry,
  ContributionId,
  ScopeQuery,
  ToolContribution,
  ToolResult,
} from '@harnessdesk/protocol'

/**
 * Projecting plugin contributions into Codex.
 *
 * This is the whole reason no Codex fork is required. `codex app-server`
 * accepts client-provided tools on `thread/start` and calls back with an
 * `item/tool/call` server request, so a Cordis plugin's tool becomes a tool the
 * model can call without anything Cordis-shaped crossing into the runtime.
 *
 * Nothing here imports Cordis; it reads the neutral `CapabilityRegistry`.
 */

type DynamicToolSpec = CodexProtocol.v2.DynamicToolSpec
type DynamicToolNamespaceTool = CodexProtocol.v2.DynamicToolNamespaceTool
type DynamicToolCallParams = CodexProtocol.v2.DynamicToolCallParams
type DynamicToolCallResponse = CodexProtocol.v2.DynamicToolCallResponse

/**
 * Codex namespaces and names must survive a round trip, so the projection keeps
 * the map that turns (namespace, tool) back into the contribution that produced
 * it. Names are sanitised because a plugin id is freer than a tool name is.
 */
export class ToolProjection {
  #byKey = new Map<string, ContributionId>()
  #revision = new Map<string, number>()

  /** Rebuilds the projection for a scope and returns what Codex should be told. */
  build(registry: CapabilityRegistry, scope: ScopeQuery): DynamicToolSpec[] {
    this.#byKey.clear()
    this.#revision.clear()
    // 0.149.0 replaced the flat `{ namespace, name }` spec with a tagged union:
    // a namespace is now one spec carrying its tools, so the projection groups
    // rather than emitting one entry per tool.
    const namespaces = new Map<string, { origin: string; tools: DynamicToolNamespaceTool[] }>()

    for (const tool of registry.list('tool', scope)) {
      const namespace = `${NAMESPACE_PREFIX}${sanitise(tool.namespace)}`
      const name = sanitise(tool.name)
      const key = `${namespace}/${name}`
      if (this.#byKey.has(key)) {
        // Two plugins claiming the same namespaced name would be ambiguous on
        // the way back; first registration wins and the clash is visible in the
        // plugin list rather than silently shadowing.
        continue
      }
      this.#byKey.set(key, tool.id)
      this.#revision.set(key, tool.revision)
      let group = namespaces.get(namespace)
      if (!group) {
        group = { origin: tool.namespace, tools: [] }
        namespaces.set(namespace, group)
      }
      group.tools.push({
        type: 'function',
        name,
        description: describe(tool),
        // Codex takes the schema as opaque JSON and validates it itself.
        inputSchema: tool.inputSchema as unknown as DynamicToolNamespaceTool['inputSchema'],
      })
    }

    return [...namespaces].map(([name, group]) => ({
      type: 'namespace',
      name,
      description: `Tools contributed by the ${group.origin} plugin.`,
      tools: group.tools,
    }))
  }

  resolve(params: DynamicToolCallParams): ContributionId | undefined {
    return this.#byKey.get(`${params.namespace ?? ''}/${params.tool}`)
  }

  /**
   * Resolves against the registry as it is NOW, by name, not by the id
   * pinned at thread/start. Contribution ids are positional and reissued
   * when a plugin reloads (a workspace switch is enough), so a pinned id can
   * silently point at a different tool — the live run that exposed this had
   * `browser_open` executing `find_in_page`. Names survive a reload; ids do
   * not.
   */
  static resolveLive(
    registry: CapabilityRegistry,
    scope: ScopeQuery,
    params: DynamicToolCallParams,
  ): ContributionId | undefined {
    for (const tool of registry.list('tool', scope)) {
      const namespace = `${NAMESPACE_PREFIX}${sanitise(tool.namespace)}`
      if (namespace === (params.namespace ?? '') && sanitise(tool.name) === params.tool) {
        return tool.id
      }
    }
    return undefined
  }

  get size(): number {
    return this.#byKey.size
  }
}

/**
 * Every plugin namespace is prefixed, because Codex reserves some for its own
 * Responses tools — `web`, `computer`, `container` and `browser` on 0.149.0 —
 * and refuses `thread/start` outright on a collision. The reserved set is not
 * discoverable and grows with releases, so a blocklist would rot; a prefix
 * cannot collide with anything Codex names. The built-in `web` plugin was the
 * one that hit this: with it loaded, no session could start at all.
 */
export const NAMESPACE_PREFIX = 'hd_'

/**
 * Codex tool names travel in the model's context, so they must be terse and
 * predictable. Instance ids carry a `#n` suffix that has no business there.
 */
const sanitise = (value: string): string =>
  value
    .replace(/#\d+$/, '')
    .replace(/[^a-zA-Z0-9_-]/g, '_')
    .slice(0, 60) || 'plugin'

const describe = (tool: ToolContribution): string =>
  tool.requiresApproval
    ? `${tool.description} (asks for confirmation before running)`
    : tool.description

export const toCodexToolResponse = (result: ToolResult): DynamicToolCallResponse => {
  if (!result.ok) {
    return { contentItems: [{ type: 'inputText', text: result.error }], success: false }
  }
  const contentItems = result.content.map((part) =>
    part.type === 'text'
      ? ({ type: 'inputText', text: part.text } as const)
      : ({ type: 'inputImage', imageUrl: part.url } as const),
  )
  return {
    // Codex expects at least one content item; an empty result is still a result.
    contentItems: contentItems.length > 0 ? contentItems : [{ type: 'inputText', text: '' }],
    success: true,
  }
}

/**
 * Folds context contributions into the turn's input.
 *
 * Context is deliberately not modelled as a tool: the agent should not have to
 * decide to call something in order to know the conventions of the repository
 * it is working in.
 */
/**
 * Whether a block's label is one this adapter prepends itself: a context
 * provider's that is not a chip, which `contextPreamble` puts in front of a
 * message. A conversation isn't called by what the adapter added to it
 * (review of #231).
 */
export const automaticContext = (registry: CapabilityRegistry | null | undefined): ((label: string) => boolean) => {
  const labels = new Set((registry?.list('context', {}) ?? []).filter((entry) => !entry.chip).map((entry) => entry.label))
  return (label) => labels.has(label)
}

export const contextPreamble = (
  entries: readonly { label: string; text: string }[],
): string | null => {
  if (entries.length === 0) return null
  return entries
    .map((entry) => `<context source=${JSON.stringify(entry.label)}>\n${entry.text}\n</context>`)
    .join('\n\n')
}
