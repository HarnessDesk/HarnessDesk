import type { LeadAcceptanceContract } from '@harnessdesk/protocol'

/** Supplied by the host: broker secrets never become portable-core state. */
export interface LeadJournalSecurity {
  readonly canaries?: readonly string[]
  readonly brokerReference?: (value: string, variable: string) => string | null
  readonly digestContract?: (contract: LeadAcceptanceContract) => string
}
/** Neither configuration can silently replace the other's canaries or callbacks. */
export const mergeLeadJournalSecurity = (storage: LeadJournalSecurity, core: LeadJournalSecurity): LeadJournalSecurity => {
  for (const key of ['brokerReference', 'digestContract'] as const) {
    if (storage[key] && core[key] && storage[key] !== core[key]) throw new Error('lead-journal-security-conflict')
  }
  return { canaries: [...new Set([...(storage.canaries ?? []), ...(core.canaries ?? [])])],
    brokerReference: core.brokerReference ?? storage.brokerReference, digestContract: core.digestContract ?? storage.digestContract }
}
const prose = new Set(['goal', 'title', 'description', 'summary', 'reason', 'text'])
const tokens = /\b(?:gh[pousr]_[A-Za-z0-9_]{8,}|github_pat_[A-Za-z0-9_]{8,}|sk-ant-[A-Za-z0-9_-]{8,}|sk_live_[A-Za-z0-9_]{8,}|xox[abpr]-[A-Za-z0-9-]{8,}|AKIA[A-Z0-9]{16}|eyJ[A-Za-z0-9_-]*\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+)\b/g
const headers = /\b(Cookie|Authorization|x-api-key):[ \t]*(?:(?:Bearer|Basic|Token)[ \t]+)?[^\s,;]+/gi
const assignments = /\b(api[_-]?key|access[_-]?token|token|secret|password)\s*=\s*(?:"[^"\r\n]*"|'[^'\r\n]*'|[^\s,;]+)/gi
const secretName = /^(?:[a-z0-9]+[_-])*(?:api[_-]?key|access[_-]?token|token|secret|password|cookie|authorization|bearer)$/i
const reference = /^broker:[A-Za-z0-9._:/-]{1,200}$/
const mask = (text: string) => text.replace(tokens, '[redacted]').replace(headers, '$1: [redacted]').replace(assignments, '$1=[redacted]')
export const prepareLeadJournalData = (value: unknown, security: LeadJournalSecurity = {}): unknown => {
  const checkCanary = (text: string): void => {
    if (security.canaries?.some(canary => canary.length > 0 && text.includes(canary))) throw new Error('lead-journal-canary')
  }
  // Scan the entire raw record before masking or minting even one broker reference.
  const scan = (item: unknown): void => {
    if (typeof item === 'string') checkCanary(item)
    else if (item !== null && typeof item === 'object') for (const [key, raw] of Object.entries(item)) { checkCanary(key); scan(raw) }
  }
  scan(value)
  const opaque = (text: string): string => {
    checkCanary(text)
    if (mask(text) !== text) throw new Error('lead-journal-credential-in-opaque-field')
    return text
  }
  const visit = (item: unknown, key = ''): unknown => {
    if (typeof item === 'string') return prose.has(key) ? mask(item) : opaque(item)
    if (Array.isArray(item)) return item.map(value => visit(value, key))
    if (item === null || typeof item !== 'object') return item
    const source = item as Record<string, unknown>
    const result: Record<string, unknown> = {}
    for (const [name, content] of Object.entries(source)) {
      opaque(name)
      if (name === 'variables' && content !== null && typeof content === 'object' && !Array.isArray(content)) {
        result[name] = Object.fromEntries(Object.entries(content).map(([variable, raw]) => {
          opaque(variable)
          if (typeof raw !== 'string') return [variable, visit(raw)]
          const secret = secretName.test(variable) || mask(raw) !== raw
          if (!secret || reference.test(raw)) return [variable, opaque(raw)]
          const broker = security.brokerReference?.(raw, variable)
          if (!broker || !reference.test(broker)) throw new Error('lead-journal-broker-reference-required')
          return [variable, opaque(broker)]
        }))
      } else result[name] = visit(content, name)
    }
    if (source.type === 'plan' && JSON.stringify(source.contract) !== JSON.stringify(result.contract)) {
      if (!security.digestContract) throw new Error('lead-journal-contract-digest-required')
      const contract = result.contract as LeadAcceptanceContract
      const digest = opaque(security.digestContract(contract))
      result.contract = { ...contract, digest }; result.contractDigest = digest
    }
    return result
  }
  return visit(value)
}
