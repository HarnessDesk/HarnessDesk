import { bareToolName, type ToolCallItem } from '@harnessdesk/protocol'

/** Board mechanics read as actions; the exact identifier stays inside the opened tool row. */
const BOARD_TITLES: Readonly<Record<string, string>> = {
  list_intents: 'Read the task list', add_intent: 'Add a task',
  claim_work: 'Pick up a task', claim_next: 'Pick up the next task',
  check_conflicts: 'Check who is editing these files', complete_claim: 'Finish the task',
  commit_work: 'Save the changes in Git', release_claim: 'Return the task',
  get_context: 'Read the previous result', get_team_status: 'See what the team is doing',
  await_work: 'Wait for a task', await_member: 'Wait for another agent',
  review_candidates: 'Read the changes to review', record_review: 'Save the review',
  raise_finding: 'Report a problem', repair_finding: 'Report a fix',
  decide_finding: 'Check a reported fix', list_findings: 'Read the reported problems',
  run_check: 'Run the check',
}

export const transcriptToolTitle = (item: ToolCallItem): string | null => {
  const board = item.source.kind === 'mcp' ? item.source.server === 'harnessdesk'
    : item.source.kind === 'dynamic' && (item.source.namespace === 'hd_team' || item.source.namespace === 'team')
  return board ? BOARD_TITLES[bareToolName(item.tool).replace(/^team_/, '')] ?? null : null
}
