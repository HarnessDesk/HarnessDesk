import type { CeilingLevel } from './evidence.js'

/** Effects required by HarnessDesk's built-in plugin tools, keyed by plugin id and tool name. */
export const DESK_TOOL_CEILINGS: Readonly<Record<string, Readonly<Record<string, CeilingLevel>>>> = {
  git: {
    git_status: 'read', git_diff: 'read', git_log: 'read', pr_view: 'read', pr_checks: 'read', issue_view: 'read',
    pr_review: 'publish', pr_comment: 'publish', issue_comment: 'publish',
    pr_create: 'publish', pr_update: 'publish', pr_merge: 'merge',
  },
  files: { read_file: 'read', list_directory: 'read' },
  search: { search_text: 'read', find_files: 'read' },
  todo: { todo_write: 'edit', todo_read: 'read' },
  team: {
    list_intents: 'read', add_intent: 'edit', claim_work: 'read', claim_next: 'read', await_work: 'read',
    await_member: 'read', check_conflicts: 'edit', complete_claim: 'read', commit_work: 'edit', run_check: 'read',
    release_claim: 'read', get_context: 'read', get_team_status: 'read', agent_message: 'edit', notify_person: 'edit',
    review_candidates: 'read', record_review: 'read', raise_finding: 'read', repair_finding: 'read',
    decide_finding: 'read', list_findings: 'read',
  },
  checkpoint: { create_checkpoint: 'edit', list_checkpoints: 'read' },
  web: { fetch_url: 'read' },
  tests: { run_tests: 'edit' },
  browser: {
    browser_open: 'edit', browser_screenshot: 'read', browser_read_page: 'read', browser_click: 'edit',
    browser_pointer: 'edit', browser_key: 'edit', browser_type: 'edit', browser_fill: 'edit', browser_page: 'edit',
    browser_console: 'read', browser_network: 'read', browser_evaluate: 'edit', browser_cdp: 'edit', browser_close: 'edit',
  },
  simulator: {
    ios_devices: 'read', ios_boot: 'edit', ios_install: 'edit', ios_launch: 'edit', ios_screenshot: 'read',
    ios_tap: 'edit', ios_open_url: 'edit', ios_terminate: 'edit',
  },
  android: {
    android_devices: 'read', android_install: 'edit', android_launch: 'edit', android_screenshot: 'read',
    android_tap: 'edit', android_key: 'edit', android_text: 'edit', android_logcat: 'read',
  },
}
