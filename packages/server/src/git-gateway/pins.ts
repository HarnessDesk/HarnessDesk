import { randomUUID } from 'node:crypto'
import { mkdir, open, readFile, realpath, rename, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { validateRepository, type GitRequester } from './record.js'

interface Pin { readonly root: string; readonly repository: string; readonly by: GitRequester; readonly at: number }
/** A project destination is host state; remotes in a checkout are never consulted. */
export class GitPins {
  #tail: Promise<unknown> = Promise.resolve()
  readonly #path: string
  constructor(private readonly stateDirectory: string) { this.#path = join(stateDirectory, 'git-pins.json') }
  async #root(root: string): Promise<string> {
    try { return await realpath(root) }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return resolve(root); throw error }
  }
  async #read(): Promise<Pin[]> {
    try { return JSON.parse(await readFile(this.#path, 'utf8')) as Pin[] }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []; throw error }
  }
  async pinned(root: string): Promise<string | null> {
    await this.#tail
    const key = await this.#root(root), pin = (await this.#read()).find(row => row.root === key)
    if (pin) validateRepository(pin.repository)
    return pin?.repository ?? null
  }
  pin(root: string, repository: string, by: GitRequester): Promise<void> {
    const result = this.#tail.then(async () => {
      validateRepository(repository)
      const key = await this.#root(root), rows = await this.#read(), previous = rows.find(row => row.root === key)
      if (previous) { if (previous.repository !== repository) throw new Error('git-gateway-repository-already-pinned'); return }
      rows.push({ root: key, repository, by, at: Date.now() })
      await mkdir(this.stateDirectory, { recursive: true, mode: 0o700 })
      const temporary = `${this.#path}.${randomUUID()}.tmp`
      await writeFile(temporary, `${JSON.stringify(rows)}\n`, { mode: 0o600 })
      const file = await open(temporary, 'r')
      try { await file.sync() } finally { await file.close() }
      await rename(temporary, this.#path)
      const directory = await open(this.stateDirectory, 'r')
      try { await directory.sync() } finally { await directory.close() }
    })
    this.#tail = result.catch(() => {}); return result
  }
}
