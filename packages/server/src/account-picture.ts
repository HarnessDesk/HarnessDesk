import { lookup } from 'node:dns/promises'
import type { LookupAddress } from 'node:dns'
import { request as httpsRequest } from 'node:https'
import { BlockList } from 'node:net'

const MAX_BYTES = 256 * 1024
const blockedV4 = new BlockList()
for (const [ip, prefix] of [
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16],
  ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.0.2.0', 24], ['192.88.99.0', 24], ['192.168.0.0', 16],
  ['198.18.0.0', 15], ['198.51.100.0', 24], ['203.0.113.0', 24], ['224.0.0.0', 3],
] as const) blockedV4.addSubnet(ip, prefix, 'ipv4')
const globalV6 = new BlockList(); globalV6.addSubnet('2000::', 3, 'ipv6')
const blockedV6 = new BlockList()
for (const [ip, prefix] of [['2001::', 23], ['2001:db8::', 32], ['2002::', 16], ['3fff::', 20]] as const) blockedV6.addSubnet(ip, prefix, 'ipv6')
const publicAddress = (address: LookupAddress) => address.family === 4 ? !blockedV4.check(address.address, 'ipv4')
  : address.family === 6 && globalV6.check(address.address, 'ipv6') && !blockedV6.check(address.address, 'ipv6')

interface Picture { type: string; bytes: Uint8Array }
interface Options {
  lookup?: (hostname: string) => Promise<LookupAddress[]>
  request?: (url: URL, address: LookupAddress) => Promise<Picture>
}
const raster = (type: string, bytes: Uint8Array) => {
  const b = Buffer.from(bytes)
  return type === 'image/png' ? b.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
    : type === 'image/jpeg' ? b[0] === 255 && b[1] === 216 && b[2] === 255
      : type === 'image/webp' && b.subarray(0, 4).toString() === 'RIFF' && b.subarray(8, 12).toString() === 'WEBP'
}
export const isAccountPictureDataUrl = (value: unknown): value is string => {
  if (typeof value !== 'string' || value.length > MAX_BYTES * 1.4) return false
  const match = /^data:(image\/(?:png|jpeg|webp));base64,([A-Za-z0-9+/]+={0,2})$/.exec(value)
  if (!match) return false
  const bytes = Buffer.from(match[2]!, 'base64')
  return bytes.length <= MAX_BYTES && raster(match[1]!, bytes)
}

const requestPicture = (url: URL, address: LookupAddress): Promise<Picture> => new Promise((resolve, reject) => {
  // Resolve once and pin the result on the actual request: a second DNS lookup would permit rebinding.
  const request = httpsRequest(url, {
    lookup: (_host, options, callback) => {
      if (options.all) callback(null, [{ address: address.address, family: address.family }])
      else callback(null, address.address, address.family)
    },
    headers: { accept: 'image/png, image/jpeg, image/webp' },
  }, response => {
    if (response.statusCode !== 200) { response.destroy(); reject(new Error('picture unavailable')); return }
    const type = (response.headers['content-type'] ?? '').split(';')[0]!.trim().toLowerCase()
    if (!['image/png', 'image/jpeg', 'image/webp'].includes(type) || Number(response.headers['content-length'] ?? 0) > MAX_BYTES) {
      response.destroy(); reject(new Error('picture refused')); return
    }
    const chunks: Buffer[] = []; let length = 0
    response.on('data', (chunk: Buffer) => {
      length += chunk.length
      if (length > MAX_BYTES) { response.destroy(); reject(new Error('picture too large')) }
      else chunks.push(chunk)
    })
    response.on('error', reject)
    response.on('end', () => resolve({ type, bytes: Buffer.concat(chunks) }))
  })
  const deadline = setTimeout(() => request.destroy(new Error('picture timed out')), 5000)
  deadline.unref()
  request.on('close', () => clearTimeout(deadline))
  request.on('error', reject)
  // No cookies, credentials, redirects, referrer or browser session are sent.
  request.end()
})

/** Keep the renderer's self/data/blob image CSP intact, including for untrusted transcripts. */
export async function loadAccountPicture(input: string, options: Options = {}): Promise<string | undefined> {
  try {
    const url = new URL(input)
    if (url.protocol !== 'https:' || url.username || url.password || url.port && url.port !== '443') return
    let deadline: ReturnType<typeof setTimeout> | undefined
    const addresses = await Promise.race([
      (options.lookup ?? (host => lookup(host, { all: true })))(url.hostname.replace(/^\[|\]$/g, '')),
      new Promise<never>((_resolve, reject) => { deadline = setTimeout(() => reject(new Error('picture lookup timed out')), 2000); deadline.unref() }),
    ]).finally(() => { if (deadline) clearTimeout(deadline) })
    if (!addresses.length || addresses.some(address => !publicAddress(address))) return
    const picture = await (options.request ?? requestPicture)(url, addresses[0]!)
    if (picture.bytes.length > MAX_BYTES || !raster(picture.type, picture.bytes)) return
    return `data:${picture.type};base64,${Buffer.from(picture.bytes).toString('base64')}`
  } catch { return undefined }
}
