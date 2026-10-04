/**
 * One key per repository, whatever the remote's spelling:
 * git@github.com-alias:owner/repo.git and https://github.com/owner/repo
 * are the same project.
 *
 * It is `host/owner/name`, lower case, and it has no credentials in it: a
 * remote may carry a token in its userinfo, and the key is what the host sends
 * to the interface and what the session list groups by, so the URL itself
 * never has to travel. Two clones of one repository are two folders and one
 * key, and a key read again is the same key. A remote that is only a path on
 * this machine has no key: it names no host and no owner.
 */
export const repoKey = (originUrl: string | null | undefined): string | null => {
  if (!originUrl) return null
  const trimmed = originUrl.trim().replace(/\/+$/, '').replace(/\.git$/i, '').replace(/\/+$/, '')
  if (trimmed === '') return null
  // A path on this machine is not an address: nothing else could clone from it, so it is no repository's identity.
  if (/^(?:[a-z]:[\\/]|[\\/.~])/i.test(trimmed) || /^file:/i.test(trimmed)) return null
  // scp-like: [user@]host[-alias]:owner/repo
  const scp = /^(?:[^@/]+@)?([^:/]+):(.+)$/.exec(trimmed)
  if (scp && !/^[a-z]+:\/\//i.test(trimmed)) {
    return `${hostOf(scp[1] ?? '')}/${scp[2]?.toLowerCase() ?? ''}`
  }
  try {
    const url = new URL(trimmed)
    return url.hostname && url.pathname !== '/' ? `${hostOf(url.hostname)}${url.pathname.toLowerCase()}` : null
  } catch {
    // A host-qualified key may be read back, but an invalid URL or a relative
    // local origin must never become an identity (or carry its userinfo).
    return /^[a-z0-9-]+(?:\.[a-z0-9-]+)+\/[^\s@:?#[\]\\]+$/i.test(trimmed) ? trimmed.toLowerCase() : null
  }
}

/** 'github.com-work' (an SSH config alias) is still github.com. */
const hostOf = (host: string): string => host.toLowerCase().replace(/^([^.]+\.[^.]+)-.*$/, '$1')
