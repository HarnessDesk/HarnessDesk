/**
 * What may leave the machine in a diagnostics bundle, decided in one place.
 *
 * The bundle's promise is that it stays useful without carrying source,
 * transcripts, credentials or private paths — support needs the shape of the
 * failure, not the person's secrets or where they keep their work. Everything
 * string-shaped in the bundle goes through the redactor this module builds:
 * the log tail, and the runtime health sentences, which are spawn errors and
 * so love to quote full command paths.
 *
 * Aggressive on purpose: an over-redacted line still shows where the failure
 * was, while one leaked token is a rotation ceremony.
 */

/**
 * A redactor for this machine: `home` becomes `~`, every open workspace root
 * becomes `[workspace]`, and anything credential-shaped is struck whole.
 *
 * Workspace roots are replaced before the home directory so a project under
 * home reads `[workspace]/src/x.ts` rather than `~/clients/acme/src/x.ts` —
 * the folder a person keeps their work in is a private path wherever it is.
 * Longest root first, so a nested workspace is not half-replaced by its
 * parent.
 */
export const redactorFor = ({
  home,
  roots,
}: {
  readonly home: string
  readonly roots: readonly string[]
}): ((line: string) => string) => {
  const cleaned = [...new Set(roots.filter((root) => root.length > 1))].sort(
    (a, b) => b.length - a.length,
  )
  return (line) => {
    let out = line
      .replace(/\b(sk|ghp|gho|ghu|ghs|ghr|xoxb|xoxp)-[A-Za-z0-9_-]{8,}\b/g, '[redacted]')
      .replace(/\beyJ[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{8,}\b/g, '[redacted-jwt]')
      .replace(/("(?:password|token|secret|apiKey|api_key)"\s*:\s*")[^"]+(")/gi, '$1[redacted]$2')
    for (const root of cleaned) out = out.replaceAll(root, '[workspace]')
    return out.replaceAll(home, '~')
  }
}
