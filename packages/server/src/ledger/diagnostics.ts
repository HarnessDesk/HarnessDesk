/**
 * The ledger reads agent-owned files in the background, and its diagnostics
 * bundle is exportable. Keep the useful operation context while refusing to
 * turn a failed scan into a second copy of an agent's paths or database text.
 */

type Failure = 'missing' | 'access-denied' | 'not-a-directory' | 'not-a-file' | 'read-failed'

const failures = new Set<Failure>(['missing', 'access-denied', 'not-a-directory', 'not-a-file', 'read-failed'])
const corpusKinds = new Set(['codex', 'claude', 'gemini', 'qwen', 'opencode', 'cline'])

const failureOf = (details: Record<string, unknown> | undefined): Failure => {
  const recorded = details?.failure
  if (typeof recorded === 'string' && failures.has(recorded as Failure)) return recorded as Failure
  const error = details?.error
  const code = typeof error === 'object' && error !== null && typeof (error as { code?: unknown }).code === 'string'
    ? (error as { code: string }).code
    : ''
  if (code === 'ENOENT') return 'missing'
  if (code === 'EACCES' || code === 'EPERM') return 'access-denied'
  if (code === 'ENOTDIR') return 'not-a-directory'
  if (error instanceof Error && error.message === 'The database source is not a file.') return 'not-a-file'
  return 'read-failed'
}

const kindOf = (details: Record<string, unknown> | undefined): string =>
  typeof details?.kind === 'string' && corpusKinds.has(details.kind) ? details.kind : 'unknown'

const countOf = (details: Record<string, unknown> | undefined): number =>
  typeof details?.failures === 'number' && Number.isSafeInteger(details.failures) && details.failures > 0 ? details.failures : 1

/** A fixed, export-safe diagnostic shape for every ledger-owned background log. */
export const safeLedgerDiagnostic = (message: string, details?: Record<string, unknown>): Record<string, unknown> | undefined => {
  switch (message) {
    case 'a folder of transcripts could not be read, so the usage in it was not counted':
      return { operation: 'corpus-discovery', kind: kindOf(details), failures: countOf(details), failure: failureOf(details) }
    case 'a transcript could not be read':
      return { operation: 'transcript-read', kind: kindOf(details), failures: countOf(details), failure: failureOf(details) }
    case 'the model price catalogue could not be refreshed':
      return { operation: 'price-catalogue-refresh', failure: failureOf(details) }
    case 'the price overlay could not be read':
      return { operation: 'price-overlay-read', failure: failureOf(details) }
    case 'usage history was bucketed in another timezone; days may straddle':
      return { operation: 'timezone-bucketing' }
    default:
      return undefined
  }
}
