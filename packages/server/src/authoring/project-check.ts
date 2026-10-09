import { lstat, readFile } from 'node:fs/promises'
import { join } from 'node:path'

const MANIFEST_LIMIT = 1024 * 1024
type Manager = 'npm' | 'pnpm' | 'yarn' | 'bun'

const fileHere = async (root: string, name: string): Promise<boolean> => {
  try { return (await lstat(join(root, name))).isFile() } catch { return false }
}

/** Read a declared test, never execute it. An unreadable or undeclared test earns no suggestion. */
export async function projectCheckCommand(root: string): Promise<string | null> {
  let manifest: Record<string, unknown>
  try {
    const path = join(root, 'package.json')
    const stat = await lstat(path)
    if (!stat.isFile() || stat.size > MANIFEST_LIMIT) return null
    const text = await readFile(path, 'utf8')
    if (Buffer.byteLength(text) > MANIFEST_LIMIT) return null
    const value: unknown = JSON.parse(text)
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null
    manifest = value as Record<string, unknown>
  } catch { return null }
  const scripts = manifest['scripts']
  if (!scripts || typeof scripts !== 'object' || Array.isArray(scripts)) return null
  const test = (scripts as Record<string, unknown>)['test']
  if (typeof test !== 'string' || !test.trim()) return null
  let manager: Manager = 'npm'
  if (typeof manifest['packageManager'] === 'string') {
    const declared = /^(npm|pnpm|yarn|bun)@\S+$/.exec(manifest['packageManager'])?.[1] as Manager | undefined
    if (!declared) return null
    manager = declared
  } else {
    const locks = await Promise.all([
      fileHere(root, 'pnpm-lock.yaml'), fileHere(root, 'yarn.lock'),
      fileHere(root, 'bun.lock'), fileHere(root, 'bun.lockb'),
      fileHere(root, 'package-lock.json'), fileHere(root, 'npm-shrinkwrap.json'),
    ])
    const declared = [...new Set(locks.flatMap((found, index) => found ? [(['pnpm', 'yarn', 'bun', 'bun', 'npm', 'npm'] as const)[index]!] : []))]
    if (declared.length > 1) return null
    manager = declared[0] ?? 'npm'
  }
  return manager === 'bun' ? 'bun run test' : `${manager} test`
}
