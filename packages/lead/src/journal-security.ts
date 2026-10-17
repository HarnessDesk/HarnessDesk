import type { LeadAcceptanceContract } from '@harnessdesk/protocol'

/** Supplied by the host: broker secrets never become portable-core state. */
export interface LeadJournalSecurity {
  readonly canaries?: readonly string[]
  readonly brokerReference?: (value: string, variable: string) => string | null
  readonly digestContract?: (contract: LeadAcceptanceContract) => string
}
const prose = new Set(['goal', 'title', 'description', 'summary', 'reason', 'text'])
const tokens = /\b(?:gh[pousr]_[A-Za-z0-9_]{8,}|github_pat_[A-Za-z0-9_]{8,}|sk-ant-[A-Za-z0-9_-]{8,}|sk_live_[A-Za-z0-9_]{8,}|xox[abpr]-[A-Za-z0-9-]{8,}|AKIA[A-Z0-9]{16}|eyJ[A-Za-z0-9_-]*\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+)\b/g
const headers = /\b(Cookie|Authorization|x-api-key):[^\r\n]*/gi
const assignments = /\b(api[_-]?key|access[_-]?token|token|secret|password)\s*=\s*(?:"[^"\r\n]*"|'[^'\r\n]*'|[^\s,;]+)/gi
const mask = (text: string) => text.replace(tokens, '[redacted]').replace(headers, '$1: [redacted]').replace(assignments, '$1=[redacted]')
export const prepareLeadJournalData = (value: unknown, security: LeadJournalSecurity = {}): unknown => {
  const visit = (item: unknown, key = ''): unknown => {
    if (typeof item === 'string') {
      if (security.canaries?.some(canary => canary.length > 0 && item.includes(canary))) throw new Error('lead-journal-canary')
      return prose.has(key) ? mask(item) : item
    }
    if (Array.isArray(item)) return item.map(value => visit(value, key))
    if (item === null || typeof item !== 'object') return item
    const source = item as Record<string, unknown>
    const result: Record<string, unknown> = {}
    for (const [name, content] of Object.entries(source)) {
      if (security.canaries?.some(canary => canary.length > 0 && name.includes(canary))) throw new Error('lead-journal-canary')
      if (name === 'variables' && content !== null && typeof content === 'object' && !Array.isArray(content)) {
        result[name] = Object.fromEntries(Object.entries(content).map(([variable, raw]) => {
          if (security.canaries?.some(canary => canary.length > 0 && variable.includes(canary))) throw new Error('lead-journal-canary')
          if (typeof raw !== 'string') return [variable, visit(raw)]
          const secret = /api[_-]?key|token|secret|password/i.test(variable) || mask(raw) !== raw || security.canaries?.some(canary => canary.length > 0 && raw.includes(canary))
          if (!secret || /^broker:[A-Za-z0-9._:/-]{1,200}$/.test(raw)) return [variable, visit(raw)]
          const reference = security.brokerReference?.(raw, variable)
          if (!reference || !/^broker:[A-Za-z0-9._:/-]{1,200}$/.test(reference)) throw new Error('lead-journal-broker-reference-required')
          return [variable, visit(reference)]
        }))
      } else result[name] = visit(content, name)
    }
    if (source.type === 'plan' && JSON.stringify(source.contract) !== JSON.stringify(result.contract)) {
      if (!security.digestContract) throw new Error('lead-journal-contract-digest-required')
      const contract = result.contract as LeadAcceptanceContract
      const digest = security.digestContract(contract)
      result.contract = { ...contract, digest }; result.contractDigest = digest
    }
    return result
  }
  return visit(value)
}
