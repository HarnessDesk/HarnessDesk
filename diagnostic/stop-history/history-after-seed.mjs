import { lstatSync, readFileSync, writeFileSync } from 'node:fs'

const requireAbsent = path => {
  try { lstatSync(path) } catch (error) { if (error?.code === 'ENOENT') return; throw error }
  throw Error('history already exists')
}

/** Install the recovery fixture only after the seeding Host has disposed. */
export async function seedThenInstallHistory({ path, ledger, seed }) {
  requireAbsent(path)
  const flow = await seed()
  requireAbsent(path)
  writeFileSync(path, JSON.stringify(ledger)+'\n', { flag:'wx', mode:0o600 })
  const stat=lstatSync(path)
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink!==1 || (stat.mode&0o777)!==0o600) throw Error('history fixture invalid')
  const actual=JSON.parse(readFileSync(path,'utf8'))
  if (JSON.stringify(actual)!==JSON.stringify(ledger) || actual.stopIntents?.length!==3 ||
      actual.stopIntents[0]?.key?.comment!=='101' || actual.stopIntents[0]?.state!=='inFlight') throw Error('history fixture invalid')
  return flow
}
