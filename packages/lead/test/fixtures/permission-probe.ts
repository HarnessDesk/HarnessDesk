import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
const send = (value: unknown) => { const body = Buffer.from(JSON.stringify(value)), head = Buffer.alloc(4); head.writeUInt32BE(body.length); process.stdout.write(Buffer.concat([head, body])) }
let buffer = Buffer.alloc(0)
process.stdin.on('data', chunk => {
  buffer = Buffer.concat([buffer, Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)]); while (buffer.length >= 4 && buffer.length >= buffer.readUInt32BE() + 4) {
    const size = buffer.readUInt32BE(), message = JSON.parse(buffer.subarray(4, size + 4).toString()); buffer = buffer.subarray(size + 4)
    if (message.type === 'initialize') send({ version: 1, type: 'ready' })
    if (message.type === 'request') {
      let spawn = 'escaped', read = 'escaped'
      try { spawnSync(process.execPath, ['--version']) } catch (error) { spawn = (error as NodeJS.ErrnoException).code! }
      try { readFileSync('/etc/hosts') } catch (error) { read = (error as NodeJS.ErrnoException).code! }
      send({ version: 1, type: 'response', id: message.id, result: { status: 'completed', text: `spawn:${spawn};read:${read}` } })
    }
    if (message.type === 'shutdown') process.exit(0)
  }
})
