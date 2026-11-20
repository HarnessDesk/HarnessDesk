// Only a framed synthetic transport. The parent owns the real supervisor and this pid.
let buffered = Buffer.alloc(0)
process.stdin.on('data', (chunk: Buffer) => {
  buffered = Buffer.concat([buffered, chunk])
  while (buffered.length >= 4 && buffered.length >= buffered.readUInt32BE() + 4) {
    const size = buffered.readUInt32BE(), body = buffered.subarray(4, size + 4)
    buffered = buffered.subarray(size + 4)
    const message = JSON.parse(body.toString()) as { type: string }
    if (message.type === 'initialize') {
      const ready = Buffer.from(JSON.stringify({ version: 1, type: 'ready' })), head = Buffer.alloc(4)
      head.writeUInt32BE(ready.length); process.stdout.write(Buffer.concat([head, ready]))
    } else if (message.type === 'shutdown') process.exit(0)
    else throw new Error('unexpected synthetic child message')
  }
})
