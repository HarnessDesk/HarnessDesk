import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { createInterface } from 'node:readline'
import type { IosAction, IosFrame } from './ios-types.js'

export interface IosInputTransport {
  request(udid: string, action: IosAction, frame?: Pick<IosFrame, 'width' | 'height' | 'rotation'>, signal?: AbortSignal): Promise<Record<string, unknown>>
  dispose?(): void
}
interface Pending { resolve(value: Record<string, unknown>): void; reject(error: Error): void; timer: ReturnType<typeof setTimeout> }
const unavailable = 'iOS Simulator control requires Xcode; install and open Xcode, then select it in Settings › Locations › Command Line Tools.'
/** One owned child. A dead/replaced child's listeners can never settle a new child's request. */
export class IosHelper implements IosInputTransport {
  #child: ChildProcessWithoutNullStreams | null = null
  #pending = new Map<string, Pending>()
  #nextId = 0
  #queue: Promise<unknown> = Promise.resolve()
  #disposed = false
  constructor(private readonly options: { executable?: string; args?: readonly string[]; timeoutMs?: number } = {}) {}
  #stop(child: ChildProcessWithoutNullStreams, error: Error): void {
    if (this.#child !== child) return
    this.#child = null
    for (const pending of this.#pending.values()) { clearTimeout(pending.timer); pending.reject(error) }
    this.#pending.clear()
    child.stdin.destroy()
    child.kill('SIGTERM')
    const kill = setTimeout(() => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL') }, 250)
    kill.unref()
  }
  #ensure(): ChildProcessWithoutNullStreams {
    if (this.#child) return this.#child
    const executable = this.options.executable ?? fileURLToPath(new URL(`../native/darwin-${process.arch}/hd-ios-control`, import.meta.url))
    if (!existsSync(executable)) throw new Error(unavailable)
    const child = spawn(executable, [...(this.options.args ?? [])], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true })
    this.#child = child
    // Native diagnostics can contain machine paths; do not log them or input payloads.
    child.stderr.resume()
    child.once('error', () => this.#stop(child, new Error('The simulator input helper could not start.')))
    child.once('exit', () => this.#stop(child, new Error('The simulator input helper stopped.')))
    let buffered = 0
    child.stdout.on('data', (chunk: Buffer) => { buffered += chunk.length; if (buffered > 1024 * 1024) this.#stop(child, new Error('The simulator input helper reply exceeded its limit.')) })
    const lines = createInterface({ input: child.stdout })
    lines.on('line', (line) => {
      if (this.#child !== child) return
      buffered = 0
      try {
        const reply = JSON.parse(line) as { id?: unknown; protocolVersion?: unknown; result?: unknown; error?: { code?: unknown; message?: unknown } }
        if (reply.protocolVersion !== 1 || typeof reply.id !== 'string' || !this.#pending.has(reply.id)) throw new Error('The simulator helper reply does not match the input protocol.')
        if ((reply.result === undefined) === (reply.error === undefined)) throw new Error('The simulator helper reply must contain a result or an error.')
        if (reply.result !== undefined && (!reply.result || typeof reply.result !== 'object' || Array.isArray(reply.result))) throw new Error('The simulator helper reply result is malformed.')
        const pending = this.#pending.get(reply.id)!
        this.#pending.delete(reply.id); clearTimeout(pending.timer)
        if (reply.error) pending.reject(new Error(typeof reply.error.message === 'string' ? reply.error.message : 'The simulator input helper refused the operation.'))
        else pending.resolve(reply.result as Record<string, unknown>)
      } catch { this.#stop(child, new Error('The simulator helper reply is malformed or uses an incompatible protocol.')) }
    })
    return child
  }
  request(udid: string, action: IosAction, frame?: Pick<IosFrame, 'width' | 'height' | 'rotation'>, signal?: AbortSignal): Promise<Record<string, unknown>> {
    const work = this.#queue.catch(() => {}).then(() => this.#requestNow(udid, action, frame, signal))
    this.#queue = work.catch(() => {})
    return work
  }
  async #requestNow(udid: string, action: IosAction, frame?: Pick<IosFrame, 'width' | 'height' | 'rotation'>, signal?: AbortSignal): Promise<Record<string, unknown>> {
    if (this.#disposed) throw new Error('The simulator input helper was disposed.')
    signal?.throwIfAborted()
    const child = this.#ensure()
    const id = String(++this.#nextId)
    const cancel = () => this.#stop(child, new Error('The simulator invocation ended; the gesture was stopped.'))
    signal?.addEventListener('abort', cancel, { once: true })
    try { return await new Promise<Record<string, unknown>>((resolve, reject) => {
      const timer = setTimeout(() => this.#stop(child, new Error('The simulator input helper timed out; the gesture was stopped.')), this.options.timeoutMs ?? 20_000)
      this.#pending.set(id, { resolve, reject, timer })
      child.stdin.write(`${JSON.stringify({ protocolVersion: 1, id, udid, operation: 'interact', action, ...(frame ? { geometry: { width: frame.width, height: frame.height, rotation: frame.rotation } } : {}) })}\n`, (error) => { if (error) this.#stop(child, new Error('The simulator input helper connection closed.')) })
    }) } finally { signal?.removeEventListener('abort', cancel) }
  }
  dispose(): void { this.#disposed = true; if (this.#child) this.#stop(this.#child, new Error('The simulator input helper was disposed.')) }
}
