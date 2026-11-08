import { spawnSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import { Worker } from 'node:worker_threads'
import { connect } from 'node:net'
const socketResult = (target: string | number) => new Promise<void>((resolve, reject) => {
  const socket = typeof target === 'string' ? connect(target) : connect(target, '127.0.0.1')
  socket.once('connect', () => { socket.destroy(); resolve() })
  socket.once('error', error => { socket.destroy(); reject(error) })
})
const send = (value: unknown) => { const body = Buffer.from(JSON.stringify(value)), head = Buffer.alloc(4); head.writeUInt32BE(body.length); process.stdout.write(Buffer.concat([head, body])) }
let buffer = Buffer.alloc(0)
process.stdin.on('data', async chunk => {
  buffer = Buffer.concat([buffer, Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)]); while (buffer.length >= 4 && buffer.length >= buffer.readUInt32BE() + 4) {
    const size = buffer.readUInt32BE(), message = JSON.parse(buffer.subarray(4, size + 4).toString()); buffer = buffer.subarray(size + 4)
    if (message.type === 'initialize') send({ version: 1, type: 'ready' })
    if (message.type === 'request') {
      if (message.input.system === 'permission-extended') {
        const result: Record<string, string> = {}
        for (const [name, operation] of Object.entries({
          write: () => writeFileSync('/tmp/lead-permission-must-not-write', ''),
          worker: () => new Worker('', { eval: true }),
          addon: () => process.dlopen({ exports: {} }, '/tmp/lead-permission-must-not-load.node'),
          unix: () => socketResult('/tmp/lead-permission-unrelated.sock'),
          tcp: () => socketResult(9),
        })) {
          try { await operation(); result[name] = 'escaped' }
          catch (error) { result[name] = (error as NodeJS.ErrnoException).code! }
        }
        send({ version: 1, type: 'response', id: message.id, result: { status: 'completed', text: JSON.stringify(result) } }); continue
      }
      let spawn = 'escaped', read = 'escaped'
      try { spawnSync(process.execPath, ['--version']) } catch (error) { spawn = (error as NodeJS.ErrnoException).code! }
      try { readFileSync('/etc/hosts') } catch (error) { read = (error as NodeJS.ErrnoException).code! }
      send({ version: 1, type: 'response', id: message.id, result: { status: 'completed', text: `spawn:${spawn};read:${read}` } })
    }
    if (message.type === 'shutdown') process.exit(0)
  }
})
