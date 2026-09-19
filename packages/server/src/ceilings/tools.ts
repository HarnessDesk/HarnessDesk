import type { CeilingLevel, PluginInstance, ToolContribution } from '@harnessdesk/protocol'

/**
 * The ceiling each tool that ships with the desk needs.
 *
 * Keyed by plugin and then tool name: an installed plugin may use any tool
 * name, and must be judged by its own grants rather than borrowing a shipped
 * tool's placement.
 */
export const DESK_TOOLS: Readonly<Record<string, Readonly<Record<string, CeilingLevel>>>> = {
  git: {
    git_status: 'read',
    git_diff: 'read',
    git_log: 'read',
    pr_view: 'read',
    pr_checks: 'read',
    issue_view: 'read',
    pr_review: 'read',
    pr_comment: 'read',
    issue_comment: 'read',
    pr_create: 'publish',
    pr_update: 'publish',
    pr_merge: 'merge',
  },
  files: { read_file: 'read', list_directory: 'read' },
  search: { search_text: 'read', find_files: 'read' },
  todo: { todo_write: 'read', todo_read: 'read' },
  team: {
    list_intents: 'read',
    add_intent: 'read',
    claim_work: 'read',
    claim_next: 'read',
    await_work: 'read',
    check_conflicts: 'read',
    complete_claim: 'read',
    release_claim: 'read',
    get_context: 'read',
    get_team_status: 'read',
    agent_message: 'read',
  },
  checkpoint: { create_checkpoint: 'edit', list_checkpoints: 'read' },
  web: { fetch_url: 'read' },
  tests: { run_tests: 'edit' },
  browser: Object.fromEntries(
    [
      'browser_open',
      'browser_screenshot',
      'browser_read_page',
      'browser_click',
      'browser_pointer',
      'browser_key',
      'browser_type',
      'browser_fill',
      'browser_page',
      'browser_console',
      'browser_network',
      'browser_evaluate',
      'browser_cdp',
      'browser_close',
    ].map((name) => [name, 'read' as const]),
  ),
  simulator: Object.fromEntries(
    ['ios_devices', 'ios_boot', 'ios_install', 'ios_launch', 'ios_screenshot', 'ios_tap', 'ios_open_url', 'ios_terminate'].map(
      (name) => [name, 'read' as const],
    ),
  ),
  android: Object.fromEntries(
    [
      'android_devices',
      'android_install',
      'android_launch',
      'android_screenshot',
      'android_tap',
      'android_key',
      'android_text',
      'android_logcat',
    ].map((name) => [name, 'read' as const]),
  ),
}

/** What a desk tool above read does, in the words its refusal uses. */
export const TOOL_ACTIONS: Readonly<Record<string, string>> = {
  pr_create: 'opening a pull request',
  pr_update: 'changing a pull request',
  pr_merge: 'merging a pull request',
  run_tests: 'running the tests',
  create_checkpoint: 'taking a checkpoint',
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
