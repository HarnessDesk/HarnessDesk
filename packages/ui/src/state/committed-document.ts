import { useEffect, useState } from 'react'

import type { RunChange } from '../lib/run-timeline'
import { documentPath, type CommittedDocument } from '../lib/committed-document'
import { useStore } from './context'

/** Whether a card's recorded change may be a document worth reading: one changed file, in a checkout the desk named. */
export const mayBeDocument = (change: RunChange | null): change is RunChange & { cwd: string } =>
  change !== null && change.cwd !== null && change.files === 1 && change.added + change.removed > 0

/** One read per change and per store, shared by every mount that asks; a failed read is forgotten so the next mount asks again. */
const reads = new WeakMap<object, Map<string, Promise<CommittedDocument | null>>>()

/**
 * The document a card committed, read from the checkout it was committed in
 * (`git/diffRange`, the difference the desk already records the size of). Null
 * while it is being read, when the change was not a document, and when the host
 * would not say: a card that cannot show its document shows its own words, and
 * nothing is drawn that was not read.
 */
export const useCommittedDocument = (change: RunChange | null): CommittedDocument | null => {
  const store = useStore()
  const key = mayBeDocument(change) ? `${change.cwd}\0${change.from}\0${change.revision}` : null
  const [found, setFound] = useState<{ key: string; document: CommittedDocument | null } | null>(null)
  useEffect(() => {
    setFound(null)
    if (key === null || !mayBeDocument(change)) return
    let live = true
    const cache = reads.get(store) ?? new Map<string, Promise<CommittedDocument | null>>()
    reads.set(store, cache)
    const read = cache.get(key) ?? store.transport.request('git/diffRange', { root: change.cwd, from: change.from, to: change.revision })
      .then(async result => {
        const path = documentPath(result.diff)
        if (path === null) return null
        const file = await store.transport.request('git/fileAtRevision', { root: change.cwd, sha: change.revision, path })
        return file === null ? null : { path, text: file.text }
      }).catch(() => { cache.delete(key); return null })
    cache.set(key, read)
    void read.then(value => { if (live) setFound({ key, document: value }) })
    return () => { live = false }
  }, [store, key])
  return found?.key === key ? found.document : null
}
