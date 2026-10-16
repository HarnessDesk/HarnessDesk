import { isSafeSkillRelativePath } from './skill-paths.js'

const accepted = 'Use https://github.com/<owner>/<repo> or its /tree/<ref>/<path> URL.'

/** Shared by the host fetch and both halves of the install path. */
export function parseGithubSource(url: string, ref?: string, path?: string): { url: string; repo: string; ref: string; path: string } {
  // Match the original spelling: URL normalisation would erase ports and dot segments.
  if (/[?#\\\s\x00-\x1f\x7f]/.test(url)) throw new Error(accepted)
  const match = /^https:\/\/github\.com\/([A-Za-z0-9-]+)\/([A-Za-z0-9._-]+?)(?:\.git)?(?:\/tree\/([^/]+)(?:\/(.+))?)?$/.exec(url)
  if (!match || match[2] === '.' || match[2] === '..') throw new Error(accepted)
  const decode = (part: string): string => {
    try { return decodeURIComponent(part) } catch { throw new Error(accepted) }
  }
  const selectedRef = ref ?? (match[3] === undefined ? 'HEAD' : decode(match[3]))
  if (!selectedRef || selectedRef.startsWith('-') || /[\s:\\\x00-\x1f\x7f]/.test(selectedRef) || selectedRef.includes('..')) {
    throw new Error(`${accepted} The ref cannot start with '-' or contain whitespace, '..', ':', '\\' or control characters.`)
  }
  const selectedPath = path ?? decode(match[4] ?? '')
  if (selectedPath !== '' && (!isSafeSkillRelativePath(selectedPath) || /[\x00-\x1f\x7f]/.test(selectedPath) || selectedPath.split(/[/\\]/).some(part => part.toLowerCase() === '.git'))) {
    throw new Error(`${accepted} The path must stay inside the repository and have no .git segment or control characters.`)
  }
  const repo = `${match[1]}/${match[2]}`
  return { url: `https://github.com/${repo}`, repo, ref: selectedRef, path: selectedPath }
}
