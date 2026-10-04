/**
 * One key per repository, whatever the remote's spelling:
 * git@github.com-alias:owner/repo.git and https://github.com/owner/repo
 * are the same project.
 *
 * It is `host/owner/name`, lower case, and it has no credentials in it: a
 * remote may carry a token in its userinfo, and the key is what the host sends
 * to the interface and what the session list groups by, so the URL itself
 * never has to travel. Two clones of one repository are two folders and one
 * key. Host-supplied keys are read with `normalizedRepoKey`. A remote that
 * is only a path on this machine has no key: it names no host and no owner.
 */
export const repoKey = (originUrl: string | null | undefined): string | null => {
  if (!originUrl) return null
  const trimmed = originUrl.trim().replace(/\/+$/, '').replace(/\.git$/i, '').replace(/\/+$/, '')
  if (trimmed === '') return null
  // A path on this machine is not an address: nothing else could clone from it, so it is no repository's identity.
  if (/^(?:[a-z]:[\\/]|[\\/.~])/i.test(trimmed) || /^file:/i.test(trimmed)) return null
  // A transport spelling must never fall through to the SCP grammar, even
  // when its slashes are missing. Only a URL with an authority names a host.
  if (/^(?:https?|ssh|git|git\+ssh|ftps?):/i.test(trimmed) || /^[a-z][a-z\d+.-]*:\/\//i.test(trimmed)) {
    if (!/^[a-z][a-z\d+.-]*:\/\//i.test(trimmed)) return null
    try {
      const url = new URL(trimmed)
      const host = url.protocol === 'ssh:' || url.protocol === 'git+ssh:'
        ? hostOf(url.hostname)
        : url.hostname
      return normalizedRepoKey(`${host}${url.pathname}`)
    } catch {
      return null
    }
  }
  // scp-like: [user@]host[-alias]:owner/repo. Its path is relative and
  // cannot carry another authority or URL suffix.
  const scp = /^(?:[^\s@/:]+@)?([a-z\d.-]+):([^/].*)$/i.exec(trimmed)
  if (scp) return normalizedRepoKey(`${hostOf(scp[1] ?? '')}/${scp[2] ?? ''}`)
  // Dotted host-qualified keys remain readable for recorded values. A bare
  // single-label path is ambiguous with a relative local origin here.
  return /^[a-z\d-]+(?:\.[a-z\d-]+)+\//i.test(trimmed) ? normalizedRepoKey(trimmed) : null
}

/** Validate the host's already-normalized identity, including single-label hosts. */
export const normalizedRepoKey = (key: string | null | undefined): string | null =>
  key && /^[a-z\d-]+(?:\.[a-z\d-]+)*\/[^\s@:?#[\]\\]+$/i.test(key) ? key.toLowerCase() : null

/** 'github.com-work' (an SSH config alias) is still github.com. */
const hostOf = (host: string): string => {
  const lower = host.toLowerCase()
  const lastDot = lower.lastIndexOf('.')
  if (lastDot === -1) return lower
  const lastLabel = lower.slice(lastDot + 1)
  if (lastLabel.startsWith('xn--')) return lower
  const alias = lastLabel.indexOf('-')
  return alias === -1 ? lower : `${lower.slice(0, lastDot + 1)}${lastLabel.slice(0, alias)}`
}
