export function assertSource({ git, sha, base, expected }) {
  if (!/^[0-9a-f]{40}$/.test(base)) throw new Error('final source pin missing')
  if (git('merge-base','HEAD',base)!==base) throw new Error('source base mismatch')
  const changed=git('diff','--name-only',base,'HEAD','--',':(exclude).github/workflows/ci.yml',':(exclude)diagnostic/stop-history')
  if(changed || git('status','--porcelain=v1')) throw new Error('production source or checkout changed')
  for(const [fileName,hash] of Object.entries(expected))if(sha(fileName)!==hash)throw new Error('source fingerprint mismatch')
}
