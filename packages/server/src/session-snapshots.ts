import { readdir, rename, rm } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { Worker } from 'node:worker_threads'

const takeSnapshot = (file: string, destination: string): Promise<void> => new Promise((resolve, reject) => {
  const worker = new Worker(new URL('./session-snapshot-worker.js', import.meta.url), { workerData: { file, destination } })
  worker.once('error', reject)
  worker.once('exit', code => code === 0 ? resolve() : reject(new Error(`Conversation snapshot exited with ${code}`)))
})

/** Daily durable copies run on a worker, outside the transcript write path. */
export class DailySessionSnapshots {
  readonly #timer: ReturnType<typeof setInterval>
  #running: Promise<boolean> | null = null
  #closed = false
  constructor(private readonly file: string, private readonly options: {
    now?: () => number; take?: (destination: string) => Promise<void>; onError?: (error: unknown) => void
  } = {}) {
    this.#timer = setInterval(() => { this.schedule() }, 60 * 60 * 1000)
    this.#timer.unref()
  }

  schedule(): void {
    if (this.#closed || this.#running) return
    // The write's promise resolves before even the snapshot's directory read.
    setImmediate(() => { void this.runIfDue() }).unref()
  }

  runIfDue(): Promise<boolean> {
    if (this.#closed || this.#running) return Promise.resolve(false)
    this.#running = this.#run().finally(() => { this.#running = null })
    return this.#running
  }

  async #run(): Promise<boolean> {
    const day = new Date(this.options.now?.() ?? Date.now()).toISOString().slice(0, 10)
    const folder = dirname(this.file)
    const name = `sessions-${day}.sqlite`
    const destination = join(folder, name)
    const temporary = `${destination}.${process.pid}.tmp`
    try {
      const snapshots = (await readdir(folder)).filter(name => /^sessions-\d{4}-\d{2}-\d{2}\.sqlite$/.test(name)).sort()
      if (snapshots.some(existing => existing >= name)) return false
      await rm(temporary, { force: true })
      await (this.options.take?.(temporary) ?? takeSnapshot(this.file, temporary))
      await rename(temporary, destination)
      for (const old of [...snapshots, name].slice(0, -3)) await rm(join(folder, old))
      return true
    } catch (error) {
      this.options.onError?.(error)
      await rm(temporary, { force: true }).catch(() => {})
      return false
    }
  }

  async close(): Promise<void> {
    this.#closed = true
    clearInterval(this.#timer)
    await this.#running
  }
}
