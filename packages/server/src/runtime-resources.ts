import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const exec = promisify(execFile)

/** RSS is resident memory, not unique physical memory: shared pages may count twice. */
export function resourcesFromProcessTable(table: string, roots: readonly number[]): { processes: number; residentBytes: number } {
  const rows = new Map<number, { parent: number; bytes: number }>()
  for (const line of table.trim().split('\n').filter(Boolean)) {
    const match = /^\s*(\d+)\s+(\d+)\s+(\d+)\s*$/.exec(line)
    if (!match) throw new Error('Could not read the process table.')
    rows.set(Number(match[1]), { parent: Number(match[2]), bytes: Number(match[3]) * 1024 })
  }
  const owned = new Set(roots.filter((pid) => rows.has(pid)))
  const children = new Map<number, number[]>()
  for (const [pid, row] of rows) {
    const siblings = children.get(row.parent) ?? []
    siblings.push(pid)
    children.set(row.parent, siblings)
  }
  const pending = [...owned]
  for (let i = 0; i < pending.length; i++) {
    for (const pid of children.get(pending[i]!) ?? []) {
      if (owned.has(pid)) continue
      owned.add(pid)
      pending.push(pid)
    }
  }
  return { processes: owned.size, residentBytes: [...owned].reduce((sum, pid) => sum + rows.get(pid)!.bytes, 0) }
}

/** One bounded snapshot for the entire desk; never reads command lines or starts an agent. */
export async function readProcessTable(): Promise<string> {
  const { stdout } = await exec('ps', ['-axo', 'pid=,ppid=,rss='], { timeout: 2_000, maxBuffer: 4 * 1024 * 1024 })
  return stdout
}
