/**
 * The brand list, read out of the interface's own source.
 *
 * `packages/ui/src/lib/brands.ts` is where a mark's key is decided, and the
 * menu-bar rows have to draw the same set — so `build-icons.mjs` reads that
 * file rather than keeping a second copy of the list. The copy it used to keep
 * is what left the status item showing a generic robot beside a name the app
 * itself drew a logo for.
 *
 * The parser lives here, apart from the renderer that uses it, for the reason
 * `gates.test.mjs` exists: a gate's parser fails quietly. This one decides
 * which files get rendered, and a key it fails to see is not an error — it is
 * an omission, and the mark simply never appears.
 */

/** Where the list starts and ends in the TypeScript source. */
const BLOCK = /export const BRANDS = \[[\s\S]*?\n\] as const/

/**
 * Every brand named in `brands.ts`, in the order the file names them.
 *
 * It reads *every* quoted string in the block rather than a shape a brand is
 * expected to have. `/'([a-z]+)',/g` looks equivalent and is not: a key it
 * cannot match — one carrying a digit, say — is skipped rather than refused,
 * and a skip leaves the count exactly where it was, so a floor on the count
 * stays satisfied while the mark it dropped is never rendered. A guard that
 * can only see the list shrink is half a guard.
 *
 * @param {string} source  the contents of `packages/ui/src/lib/brands.ts`
 * @param {number} floor   the smallest believable list, to catch a block match
 *                         that stopped early and returned a plausible answer
 * @returns {string[]}
 */
export const brandsIn = (source, floor = 0) => {
  const block = BLOCK.exec(source)?.[0]
  if (!block) throw new Error('brands: cannot find the BRANDS list in lib/brands.ts')
  const named = (block.match(/'[^']*'/g) ?? []).map((entry) => entry.slice(1, -1))
  const brands = [...new Set(named)]
  if (brands.length !== named.length) {
    const twice = named.filter((brand, at) => named.indexOf(brand) !== at)
    throw new Error(`brands: lib/brands.ts names ${[...new Set(twice)].join(', ')} more than once`)
  }
  if (brands.length < floor) {
    throw new Error(`brands: read only ${brands.length} brands from lib/brands.ts, expected at least ${floor}`)
  }
  return brands
}
