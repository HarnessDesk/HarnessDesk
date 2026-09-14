import { describe, expect, it } from 'vitest'

import { isPathInside, shortPath } from './paths'

/**
 * The tilde rule, at its edges.
 *
 * It is shared with the write engine, which prints the same paths into the
 * `---`/`+++` labels of every diff it previews and files — so a boundary this
 * gets wrong is a boundary that leaks an absolute path into a backup nobody
 * looks at until they need it.
 */
describe('shortPath', () => {
  it('replaces the home directory, and nothing else', () => {
    expect(shortPath('/home/u/.claude/skills/x', '/home/u')).toBe('~/.claude/skills/x')
    expect(shortPath('/home/u', '/home/u')).toBe('~')
    expect(shortPath('/etc/hosts', '/home/u')).toBe('/etc/hosts')
  })

  it('does not match a sibling that merely starts with the same letters', () => {
    // `/home/user2` is not inside `/home/user`, and a prefix test without the
    // separator would have said it was.
    expect(shortPath('/home/user2/.claude', '/home/user')).toBe('/home/user2/.claude')
  })

  it('takes a home with a trailing slash, because an environment can carry one', () => {
    expect(shortPath('/home/u/.codex/skills', '/home/u/')).toBe('~/.codex/skills')
  })

  it('leaves the path alone when there is no usable home', () => {
    // A wrong tilde is worse than a long path: `/` as home would tilde every
    // absolute path on the machine.
    expect(shortPath('/home/u/.claude', undefined)).toBe('/home/u/.claude')
    expect(shortPath('/home/u/.claude', '')).toBe('/home/u/.claude')
    expect(shortPath('/home/u/.claude', '/')).toBe('/home/u/.claude')
    expect(shortPath('/home/u/.claude', null)).toBe('/home/u/.claude')
  })
})

describe('isPathInside', () => {
  it('identifies exact matches and child paths on POSIX', () => {
    expect(isPathInside('/code/repo', '/code/repo')).toBe(true)
    expect(isPathInside('/code/repo/src/index.ts', '/code/repo')).toBe(true)
    expect(isPathInside('/code/repo/sub/', '/code/repo')).toBe(true)
    expect(isPathInside('/code/repo/sub', '/code/repo/')).toBe(true)
  })

  it('refuses sibling paths with common prefixes on POSIX', () => {
    expect(isPathInside('/code/repo-2', '/code/repo')).toBe(false)
    expect(isPathInside('/code/repo_feature', '/code/repo')).toBe(false)
    expect(isPathInside('/code/other', '/code/repo')).toBe(false)
  })

  it('handles Windows child paths with backslashes and forward slashes', () => {
    expect(isPathInside('C:\\repo\\feature', 'C:\\repo')).toBe(true)
    expect(isPathInside('C:\\repo\\feature\\src', 'C:\\repo')).toBe(true)
    expect(isPathInside('C:/repo/feature', 'C:/repo')).toBe(true)
    expect(isPathInside('C:\\repo\\feature', 'C:/repo')).toBe(true)
    expect(isPathInside('C:/repo/feature', 'C:\\repo')).toBe(true)
  })

  it('handles Windows case-insensitivity on drive letter and directories', () => {
    expect(isPathInside('c:\\repo\\feature', 'C:\\repo')).toBe(true)
    expect(isPathInside('C:\\REPO\\FEATURE', 'c:\\repo')).toBe(true)
    expect(isPathInside('c:\\Repo\\Feature', 'C:\\repo\\feature')).toBe(true)
  })

  it('refuses sibling paths with common prefixes on Windows', () => {
    expect(isPathInside('C:\\repo2\\feature', 'C:\\repo')).toBe(false)
    expect(isPathInside('C:\\repo_other', 'C:\\repo')).toBe(false)
    expect(isPathInside('D:\\repo\\feature', 'C:\\repo')).toBe(false)
  })

  it('returns false when either path is empty or falsy', () => {
    expect(isPathInside('', '/code/repo')).toBe(false)
    expect(isPathInside('/code/repo', '')).toBe(false)
  })
})
