import type { FlowExecution } from '@harnessdesk/protocol'

import { sanitizeText } from './sanitize'

/**
 * Where a Run came from, as the run panel's provenance row says it: a trigger,
 * an MCP client by the name it stated (its version dropped, since the row
 * names who, not which build), or the person. Null when none of these is known.
 */
export const runOrigin = (run: Pick<FlowExecution, 'intake' | 'startedBy'>, goalOrigin: string | undefined): string | null => {
  if (run.intake) return `From trigger ${run.intake.trigger}`
  if (run.startedBy?.via === 'mcp') {
    const client = sanitizeText(run.startedBy.client).replace(/(?<=.)@[^@/]*$/, '').trim()
    return client ? `From an MCP client · ${client}` : 'From an MCP client'
  }
  return goalOrigin === 'person' ? 'Started by you' : null
}
