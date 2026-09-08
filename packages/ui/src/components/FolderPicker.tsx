import { useCallback, useEffect, useState } from 'react'

import { Btn, Dialog } from '../design'
import { useSnapshot, useStore } from '../state/context'
import { FolderIcon } from './Icons'
import styles from './FolderPicker.module.css'

/**
 * In-app folder browsing.
 *
 * The desktop shell goes straight to the system dialog and never shows this;
 * it is what the browser build uses, and the fallback when the native dialog
 * is unavailable. Without it, HarnessDesk in a browser could not open a
 * project at all. The path is a breadcrumb — every ancestor is one click
 * away, which is the navigation a folder tree actually needs.
 *
 * `tall` is the point of the geometry: the surface takes a fixed height, so
 * walking into a folder with two entries does not shrink the dialog and move
 * the buttons out from under the pointer.
 */

/** '/Users/me/code' → [{name:'/',path:'/'},{name:'Users',…},…] */
const crumbsOf = (path: string): readonly { readonly name: string; readonly path: string }[] => {
  const parts = path.split('/').filter(Boolean)
  const crumbs = [{ name: '/', path: '/' }]
  let current = ''
  for (const part of parts) {
    current += `/${part}`
    crumbs.push({ name: part, path: current })
  }
  return crumbs
}

interface Listing {
  readonly path: string
  readonly parent: string | null
  readonly entries: readonly { readonly name: string; readonly path: string }[]
}

export const FolderPicker = ({ onClose }: { onClose: () => void }) => {
  const store = useStore()
  const [listing, setListing] = useState<Listing | null>(null)
  const [loading, setLoading] = useState(true)

  // The runtime's own directory listing where it has one, so the folders on
  // offer are the ones the agent can actually reach.
  const runtime = useSnapshot().activeRuntime
  const browse = useCallback(
    (path?: string) => {
      setLoading(true)
      void store.transport
        .request('workspace/browse', {
          ...(path === undefined ? {} : { path }),
          ...(runtime ? { runtime } : {}),
        })
        .then((result) => setListing(result))
        .catch(() => setListing(null))
        .finally(() => setLoading(false))
    },
    [store, runtime],
  )

  useEffect(() => browse(), [browse])

  return (
    <Dialog
      title="Choose a project folder"
      icon={<FolderIcon size={16} />}
      size="lg"
      tall
      flush
      onClose={onClose}
      subhead={
        <nav className={styles.crumbs} aria-label="Location" title={listing?.path}>
          {listing ? (
            crumbsOf(listing.path).map((crumb, index, all) => (
              <span key={crumb.path} className={styles.crumbWrap}>
                {index > 1 && <span className={styles.crumbSep}>/</span>}
                {index === all.length - 1 ? (
                  <span className={styles.crumbCurrent}>{crumb.name}</span>
                ) : (
                  <button type="button" className={styles.crumb} onClick={() => browse(crumb.path)}>
                    {crumb.name}
                  </button>
                )}
              </span>
            ))
          ) : (
            <span className={styles.crumbCurrent}>…</span>
          )}
        </nav>
      }
      footer={
        <>
          <Btn
            variant="primary"
            disabled={!listing}
            onClick={() => {
              if (!listing) return
              onClose()
              void store.openWorkspace(listing.path)
            }}
          >
            Open {listing ? `“${crumbsOf(listing.path).at(-1)?.name ?? listing.path}”` : 'folder'}
          </Btn>
          <Btn onClick={onClose}>Cancel</Btn>
        </>
      }
      footerAside="Click a folder to enter it; open the one you are in."
    >
      <div className={styles.list}>
        {loading && <p className={styles.empty}>Loading…</p>}
        {!loading && listing?.entries.length === 0 && (
          <p className={styles.empty}>No sub-folders here.</p>
        )}
        {listing?.entries.map((entry) => (
          <button
            key={entry.path}
            type="button"
            className={styles.entry}
            onClick={() => browse(entry.path)}
          >
            <FolderIcon size={13} />
            {entry.name}
          </button>
        ))}
      </div>
    </Dialog>
  )
}
