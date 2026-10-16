import { isAbsolute } from 'node:path'

/**
 * Whether a string could ever be one path segment: never empty, never a
 * climb (`.` or `..`), and never carrying a separator or a NUL a filesystem
 * would refuse outright. Exported so a caller with its own length policy —
 * a skill or MCP server's name here, an Agent backup's path segment in
 * `agent-files.ts` — states that policy as one extra check on top of this,
 * rather than a second near-identical rule that quietly disagrees with this
 * one at an edge nobody is looking at.
 */
export const isSafePathSegment = (name: string): boolean =>
  name !== '' && name !== '.' && name !== '..' && !name.includes('/') && !name.includes('\\') && !name.includes('\0')

/** A name is a path segment, short enough for a skill or MCP server's own name. */
export const validSkillName = (name: string): boolean => isSafePathSegment(name) && name.length <= 128

/**
 * A skill bundle relative path must stay strictly inside the bundle: no
 * traversal or `.` segments, no empty segments, no NUL, no absolute paths
 * (POSIX or Windows), no drive letters (C:), and no UNC prefixes
 * (\\server\share). A bundle may be authored on either platform, so both
 * `/` and `\` are read as separators — the one difference from
 * `isSafePathSegment`'s own callers, which is why this splits on both before
 * handing each piece to that same one rule, rather than folding its own
 * near-copy of it back in.
 */
export const isSafeSkillRelativePath = (relative: string): boolean => {
  if (isAbsolute(relative) || /^[A-Za-z]:[\\/]/.test(relative) || relative.startsWith('\\\\') || relative.startsWith('//')) {
    return false
  }
  return relative.split(/[/\\]/).every(isSafePathSegment)
}
