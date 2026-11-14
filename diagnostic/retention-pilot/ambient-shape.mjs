import { lstatSync, readdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

// Fixed labels only: neither path names nor directory entries are printed.
const known = [
  ['codex_sessions', '.codex/sessions'], ['codex_archived', '.codex/archived_sessions'],
  ['codex_auth', '.codex/auth.json'], ['codex_config', '.codex/config.toml'], ['codex_history', '.codex/history.jsonl'],
  ['claude', '.claude'], ['cursor', '.cursor'], ['gh', '.config/gh'], ['ssh', '.ssh'], ['aws', '.aws'],
  ['netrc', '.netrc'], ['git_credentials', '.git-credentials'], ['gemini', '.gemini'], ['qwen', '.qwen'],
  ['cursor_storage', 'Library/Application Support/Cursor/User/globalStorage'], ['opencode_data', '.local/share/opencode'],
  ['opencode_config', '.config/opencode'], ['cline', '.cline'], ['openclaw', '.openclaw'], ['hermes', '.hermes'],
  ['codebuddy', '.codebuddy'], ['kimi', '.kimi'], ['pi', '.pi'], ['grok', '.grok'], ['copilot', '.copilot'],
  ['dsh', '.dsh'], ['devin', '.devin'], ['gcloud', '.config/gcloud'],
]

export const inspectPaths = (root, paths = known) => paths.map(([label, relative]) => {
  try {
    const target = join(root, relative)
    const stat = lstatSync(target)
    const directory = stat.isDirectory(), symlink = stat.isSymbolicLink()
    let entryCount = null, readable = true
    if (directory) {
      try { entryCount = readdirSync(target).length } catch { readable = false }
    }
    return { label, exists: true, directory, symlink, entryCount, readable }
  } catch (error) {
    if (error?.code === 'ENOENT') return { label, exists: false, directory: false, symlink: false, entryCount: null, readable: true }
    return { label, exists: null, directory: null, symlink: null, entryCount: null, readable: false }
  }
})

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const rows = inspectPaths(homedir())
  console.log(JSON.stringify(rows))
  if (rows.some(row => row.exists !== false || !row.readable)) process.exitCode = 1
}
