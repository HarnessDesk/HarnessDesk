import { DESK_TOOL_CEILINGS, type CeilingLevel, type PluginInstance, type ToolContribution } from '@harnessdesk/protocol'

/** Server-facing name for the shared policy table used by the Claude bridge too. */
export const DESK_TOOLS = DESK_TOOL_CEILINGS

/**
 * The desk tools that put words on a forge where other people read them. A
 * Seat reviewing in a blind round that has not closed may call none of them —
 * nor may a conversation it delegated to — whatever its ceiling: its
 * findings are posted with the round, together, once every reviewer has
 * finished. A ceiling says what a Seat may ever do; this says what it may not
 * do yet.
 */
export const EMBARGOED_TOOLS: Readonly<Record<string, readonly string[]>> = {
  git: ['pr_review', 'pr_comment', 'issue_comment'],
}

/** Whether a tool is one a blind round's embargo holds back: only a shipped plugin's, by its own identity. */
export const publishesToForge = (tool: Pick<ToolContribution, 'name'>, plugin: PluginInstance | undefined): boolean =>
  plugin?.identity.source.kind === 'builtin' && (EMBARGOED_TOOLS[plugin.identity.id]?.includes(tool.name) ?? false)

/** What a desk tool above read does, in the words its refusal uses. */
export const TOOL_WORDS: Readonly<Record<string, { readonly doing: string; readonly ask: string }>> = {
  pr_create: { doing: 'opening a pull request', ask: 'open a pull request' },
  pr_update: { doing: 'changing a pull request', ask: 'change a pull request' },
  pr_merge: { doing: 'merging a pull request', ask: 'merge a pull request' },
  run_tests: { doing: 'running the tests', ask: 'run the tests' },
  create_checkpoint: { doing: 'taking a checkpoint', ask: 'take a checkpoint' },
}

/**
 * The ceiling a tool needs. Unknown shipped tools fail closed at merge;
 * installed tools are placed from the powers their manifest was granted.
 */
export const toolCeiling = (tool: Pick<ToolContribution, 'name'>, plugin: PluginInstance | undefined): CeilingLevel => {
  if (!plugin) return 'merge'
  if (plugin.identity.source.kind === 'builtin') {
    const placed = DESK_TOOLS[plugin.identity.id]
    return (placed && Object.hasOwn(placed, tool.name) ? placed[tool.name] : undefined) ?? 'merge'
  }
  const granted = plugin.permissions
  if (granted.shell || granted.forge || granted.network.hosts.length > 0 || granted.agents.invoke) return 'merge'
  if (granted.workspace.write || granted.editor) return 'edit'
  return 'read'
}
