// PRIVATE DRAFT. The caller must supply the existing fenced hosted-runner environment.
import { open, realpath } from 'node:fs/promises'
import { join, relative, isAbsolute } from 'node:path'
import { seedFlow } from './seed-flow.mjs'

try {
  const [source, taskRootArg, deskHome, project] = process.argv.slice(2)
  if (!source || !taskRootArg || !deskHome || !project || process.argv.length !== 6) throw Error('arguments')
  const taskRoot = await realpath(taskRootArg)
  if (process.env.HARNESSDESK_HOME !== deskHome || process.env.CODEX_HOME !== join(taskRoot, 'codex') ||
      process.env.HARNESSDESK_LEAD !== '0' || process.env.HARNESSDESK_PHONE_LINK !== '0' ||
      process.env.HARNESSDESK_NO_UPDATE_CHECK !== '1' || process.env.GIT_ALLOW_PROTOCOL !== 'file') throw Error('environment')
  for (const path of [deskHome, project]) {
    const rel = relative(taskRoot, await realpath(path))
    if (!rel || rel === '..' || rel.startsWith('../') || isAbsolute(rel)) throw Error('ownership')
  }
  const data = await seedFlow({ source, taskRoot, deskHome, project })
  const handle = await open(join(taskRoot, 'flow-seed-receipt.json'), 'wx', 0o600)
  try { await handle.writeFile(JSON.stringify(data)); await handle.sync() } finally { await handle.close() }
} catch {
  // The owned controller records a fixed phase and exit code only.
  process.exitCode = 1
}
