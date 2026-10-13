/** Only local file references with an explicit, positive line number. */
export interface FileLink { readonly path: string; readonly line: number }
export const fileLink = (href: string): FileLink | null => {
  let value: string
  try {
    if (/^file:/i.test(href)) {
      const url = new URL(href)
      if (url.host && url.host !== 'localhost') return null
      value = decodeURIComponent(url.pathname) + decodeURIComponent(url.hash)
    } else value = decodeURIComponent(href)
  } catch { return null }
  const match = /^(.*?)(?::([1-9]\d*)|#L([1-9]\d*))$/.exec(value)
  if (!match) return null
  const path = match[1]!, line = Number(match[2] ?? match[3])
  if (!Number.isSafeInteger(line) || !path || /[\u0000-\u001f<>\\?#:]/.test(path) || path.startsWith('//') || !(/[/.]/.test(path) || /^(?:Makefile|Dockerfile|Containerfile|GNUmakefile|README|LICENSE|NOTICE|AGENTS)$/i.test(path))) return null
  return { path, line }
}
/** A relative link follows the owning checkout, never the browser URL. */
export const filePathInRoot = (path: string, root: string): string | null => {
  const cleanRoot = root.replace(/\/$/, '')
  const parts: string[] = []
  for (const part of (path.startsWith('/') ? path : `${cleanRoot}/${path}`).split('/')) {
    if (!part || part === '.') continue
    if (part === '..') parts.pop()
    else parts.push(part)
  }
  const absolute = `/${parts.join('/')}`
  return absolute.startsWith(`${cleanRoot}/`) ? absolute : null
}
