import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { b64u, fromB64u, generateSigningIdentity, idFromPub, signingIdentityFromPkcs8, type SigningIdentity } from '@harnessdesk/crypto'

/** This desk's long-term key. The phone pins its public half from the pairing code. */
export interface DeskIdentity {
  readonly key: SigningIdentity
  /** `base64url(sha256(pub)[0..16])`: the desk is named by its key. */
  readonly id: string
  readonly pub: string
}

const FILE = 'desk-key.json'

/**
 * Reads the desk key, creating it on the first run only. A key that exists but cannot be read is an error and
 * never a reason to make a new one: a new key would silently unpair every phone.
 */
export async function loadOrCreateDeskIdentity(dir: string): Promise<DeskIdentity> {
  await mkdir(dir, { recursive: true, mode: 0o700 })
  const path = join(dir, FILE)
  let text: string | null = null
  try { text = await readFile(path, 'utf8') } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw new Error(`The desk key at ${path} could not be read.`, { cause: error })
  }
  if (text === null) {
    const key = await generateSigningIdentity()
    const stored = JSON.stringify({ v: 1, pkcs8: b64u(await key.exportPkcs8()) })
    try { await writeFile(path, stored, { mode: 0o600, flag: 'wx' }) } catch (error) {
      // Another start of this desk won the race to create it: use theirs.
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') return loadOrCreateDeskIdentity(dir)
      throw error
    }
    return describe(key)
  }
  let key: SigningIdentity
  try {
    const parsed = JSON.parse(text) as { v?: unknown; pkcs8?: unknown }
    if (parsed.v !== 1 || typeof parsed.pkcs8 !== 'string') throw new Error('unexpected shape')
    key = await signingIdentityFromPkcs8(fromB64u(parsed.pkcs8))
  } catch (error) {
    throw new Error(`The desk key at ${path} is not a valid key file, and was left as it is.`, { cause: error })
  }
  return describe(key)
}

async function describe(key: SigningIdentity): Promise<DeskIdentity> {
  return { key, id: await idFromPub(key.pub), pub: b64u(key.pub) }
}
