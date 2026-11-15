import { accessSync, constants, lstatSync } from 'node:fs'
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
    const entryCount = null
    let readable = true
    if (directory) {
      try { accessSync(target, constants.R_OK | constants.X_OK) } catch { readable = false }
    }
    return { label, exists: true, directory, symlink, entryCount, readable }
  } catch (error) {
    if (error?.code === 'ENOENT') return { label, exists: false, directory: false, symlink: false, entryCount: null, readable: true }
    return { label, exists: null, directory: null, symlink: null, entryCount: null, readable: false }
  }
})

// The hosted runner may create an unrelated readable SSH directory. No entry is opened or listed.
export const allowed = row => row.exists === false && row.readable ||
  row.label === 'ssh' && row.exists === true && row.directory === true && row.symlink === false && row.readable

export const SSH_SHIM = '#!/bin/sh\nexit 1\n'

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const rows = inspectPaths(homedir())
  console.log(JSON.stringify(rows))
  if (rows.some(row => !allowed(row))) process.exitCode = 1
}
