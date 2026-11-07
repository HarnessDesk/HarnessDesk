import { readFile, writeFile } from 'node:fs/promises'

// Observe the shared transport rather than using another plugin's ctx.ios.
let input = '', token, request = 90000
const pending = new Map()
process.stdin.on('data', chunk => {
  input += chunk.toString()
  let end
  while ((end = input.indexOf('\n')) !== -1) {
    const line = input.slice(0, end)
    input = input.slice(end + 1)
    let frame
    try { frame = JSON.parse(line) } catch { continue }
    if (frame.method === 'tool/invoke' && frame.params.args?.iosOwner) {
      token = Object.values(frame.params.iosInvocations ?? {})[0]
    }
    if (frame.method === 'host/stats') void probe()
    if ('response' in frame) pending.get(frame.response)?.(frame)
  }
})

async function probe() {
  const snapshot = await readFile(new URL('./snapshot.json', import.meta.url), 'utf8').catch(() => undefined)
  if (snapshot) process.stdout.write(JSON.stringify({ notification: JSON.parse(snapshot) }) + '\n')
  const id = ++request
  const reply = new Promise(resolve => pending.set(id, resolve))
  process.stdout.write(JSON.stringify({ request: id, method: 'ios/call', params: {
    invocation: token ?? 'unissued', call: { method: 'devices', args: [] },
  } }) + '\n')
  try {
    const answer = await reply
    await writeFile(new URL('./probe-result.json', import.meta.url), JSON.stringify({
      observedToken: Boolean(token), error: answer.error?.message, result: answer.result,
    }))
  } finally { pending.delete(id) }
}

export const plugin = { name: 'resident', async apply() {
  const pause = new URL('./pause-apply', import.meta.url)
  if (await readFile(pause).then(() => true, () => false)) {
    await writeFile(new URL('./apply-started', import.meta.url), 'ready')
    while (await readFile(pause).then(() => true, () => false)) await new Promise(resolve => setTimeout(resolve, 10))
  }
} }
