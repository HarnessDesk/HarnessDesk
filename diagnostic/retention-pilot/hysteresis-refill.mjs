// Private controller orchestration. All IDs stay in the controller; only fixed
// booleans and counts may be returned to the hosted result.
export async function exerciseRefill({ total, chosen, initialLoaded, inspect, restore, verify, begin, end, crossed }) {
  if (!Number.isSafeInteger(total) || total < 130 || !Number.isSafeInteger(chosen) || chosen < 0 || chosen >= total) throw Error('invalid refill fixture')
  const initial = new Set(initialLoaded)
  if (initial.size !== initialLoaded.length || initial.size >= 128 || initial.has(chosen)) throw Error('under-high-water precondition missing')
  const check = state => {
    if (!state?.quiet || !state.protected || !Array.isArray(state.loaded) || new Set(state.loaded).size !== state.loaded.length || !Number.isSafeInteger(state.bytes) || state.bytes < 0 || state.bytes > 8 * 1024 * 1024) throw Error('refill protection or byte precondition failed')
    return new Set(state.loaded)
  }
  if (!await restore(chosen)) throw Error('under-high restore refused')
  let loaded = check(await inspect())
  if (loaded.size !== initial.size + 1 || !loaded.has(chosen) || [...initial].some(i => !loaded.has(i))) throw Error('under-high restore was not retained')
  if (!await verify(chosen)) throw Error('under-high restored content differs')
  let restores = 1
  while (loaded.size < 128) {
    const next = Array.from({ length: total }, (_, i) => i).find(i => !loaded.has(i))
    if (next === undefined || !await restore(next)) throw Error('refill restore refused')
    restores++
    const before = loaded
    loaded = check(await inspect())
    if (loaded.size !== before.size + 1 || [...before].some(i => !loaded.has(i)) || !loaded.has(next)) throw Error('unexpected release below high water')
  }
  const next = Array.from({ length: total }, (_, i) => i).find(i => !loaded.has(i))
  if (next === undefined) throw Error('no released body available to cross high water')
  let observation
  await begin()
  try {
    if (!await restore(next)) throw Error('crossing restore refused')
    restores++
    if (!await crossed()) throw Error('high-water crossing was not observed')
    const after = check(await inspect())
    if (![...initial, chosen].some(i => !after.has(i))) throw Error('fresh automatic release not observed')
  } finally { observation = await end() }
  if (!(observation.snapshots > 0 && observation.prepares > 0 && observation.freshReleased === true)) throw Error('fresh Host proof not observed')
  return { underHighWarm: true, contentExact: true, crossedHigh: true, releaseObserved: true, restores }
}
