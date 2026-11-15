// Derived from the pinned protocol canonical-transcript.ts; return only bytes.
export const canonicalBytes = turns => {
  const canonical = JSON.stringify(turns, (_key, value) => {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) return value
    return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0))
  })
  return new TextEncoder().encode(`v1:${canonical}`).byteLength
}

export const summarize = (sessions, work, protectedKeys, bytes) => {
  let knownWorkloadLoaded=0, knownWorkloadBytes=0, protectedBytes=0
  for(const key of work){const value=sessions.get(key);if(value?.itemsLoaded){knownWorkloadLoaded++;knownWorkloadBytes+=bytes(value.turns)}}
  const protectedBytesByKind={}
  for(const [index,key] of protectedKeys.entries()){const value=sessions.get(key);if(!value?.itemsLoaded)throw Error('sentinel not loaded');const size=bytes(value.turns);protectedBytes+=size;protectedBytesByKind[['visible','draft','pending'][index]]=size}
  return {knownWorkloadLoaded,knownWorkloadBytes,protectedSentinels:protectedKeys.length,protectedBytes,protectedBytesByKind}
}
