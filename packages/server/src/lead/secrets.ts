import { leadDataContainsCredential } from '@harnessdesk/lead'
/** Scan structured prose as well as JSON-escaped strings. Refusals never carry input. */
export const leadContainsSecret = (value: unknown, key?: string): boolean => {
  if (typeof value === 'string') {
    if (leadDataContainsCredential(value, key ? [key] : []) || /sk-ant-[A-Za-z0-9_-]+/.test(value)) return true
    try { const decoded: unknown = JSON.parse(value); return decoded !== value && leadContainsSecret(decoded, key) }
    catch { return false }
  }
  return !!value && typeof value === 'object' && Object.entries(value).some(([name, child]) => leadContainsSecret(name, key) || leadContainsSecret(child, key))
}
