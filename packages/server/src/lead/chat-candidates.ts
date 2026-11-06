import { createHash } from 'node:crypto'
import type { AgentRuntime, LeadChatCandidate, RateLimits } from '@harnessdesk/protocol'
import { scrub } from '../phone-redact.js'

const READ_DEADLINE_MS = 2000
const within = async <T>(read: () => Promise<T>, timeoutMs: number): Promise<T | null> => {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([Promise.resolve().then(read).catch(() => null),
      new Promise<null>(resolve => { timer = setTimeout(() => resolve(null), timeoutMs) })])
  } finally { clearTimeout(timer) }
}

/** Read-through only: never starts a runtime or shadows its account/configuration. */
export const leadChatCandidates = async (runtimes: readonly AgentRuntime[], exclude: string | undefined,
  latest: ReadonlyMap<string, RateLimits>, timeoutMs = READ_DEADLINE_MS): Promise<readonly (LeadChatCandidate & { readonly agent: string })[]> => {
  const source = exclude?.slice(0, exclude.indexOf(':'))
  const choices = await Promise.all(runtimes.filter(runtime => runtime.info.id !== source).slice(0, 8).map(async runtime => {
    const info = runtime.info
    if (!info.capabilities.resume || !info.capabilities.listHistory) return null
    const [account, freshLimits] = await Promise.all([within(() => runtime.getAccount(), timeoutMs), within(() => runtime.getRateLimits(), timeoutMs)])
    const limits = freshLimits ?? latest.get(info.id)
    if (info.capabilities.account && (!account || account.unchecked || !account.accounts.length) || limits?.reached) return null
    const name = scrub(info.presentation.name, 80)
    if (!name) return null
    return { key: `agent-${createHash('sha256').update(info.id).digest('hex').slice(0, 16)}`, name, agent: String(info.id) }
  }))
  return choices.filter((one): one is NonNullable<typeof one> => one !== null)
}

/** A missing provider clock is a bounded backoff, never an unbounded read. */
export const readLeadChatLimits = (runtime: AgentRuntime, timeoutMs = READ_DEADLINE_MS): Promise<RateLimits | null> =>
  within(() => runtime.getRateLimits(), timeoutMs)
