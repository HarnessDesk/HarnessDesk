import { useCallback, useState } from 'react'

import { Btn, Dialog, Input } from '../design'
import { useStore } from '../state/context'
import { AlertIcon, FolderIcon, PluginIcon } from './Icons'
import styles from './InstallPlugin.module.css'

/**
 * Installing a plugin.
 *
 * Two steps on purpose. The manifest is read and shown before anything is
 * installed or imported, because "what is this allowed to do" is a question the
 * user must be able to answer *before* the answer stops mattering. An install
 * flow that hides the grant defeats the permission gate it is feeding.
 *
 * The surface, Escape, focus and where the buttons go are `Dialog`'s. This
 * screen used to draw all four out of `Settings.module.css`, and got one of
 * them wrong by omission: there was no Escape handler at all, so the only ways
 * out were the × and the ground behind it.
 */

interface Inspected {
  readonly id: string
  readonly name: string
  readonly description?: string
  readonly version?: string
  readonly permissions: readonly string[]
  readonly alreadyInstalled: boolean
}

export const InstallPlugin = ({ onClose }: { onClose: () => void }) => {
  const store = useStore()
  const [specifier, setSpecifier] = useState('')
  const [inspected, setInspected] = useState<Inspected | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const look = useCallback(async () => {
    const value = specifier.trim()
    if (value.length === 0) return
    setBusy(true)
    setError(null)
    try {
      setInspected(await store.transport.request('plugin/inspect', { specifier: value }))
    } catch (thrown) {
      setError(thrown instanceof Error ? thrown.message : String(thrown))
      setInspected(null)
    } finally {
      setBusy(false)
    }
  }, [specifier, store])

  const confirm = useCallback(async () => {
    setBusy(true)
    setError(null)
    try {
      await store.transport.request('plugin/install', { specifier: specifier.trim() })
      await store.loadPlugins()
      store.notice('info', `${inspected?.name ?? 'Plugin'} installed.`)
      onClose()
    } catch (thrown) {
      setError(thrown instanceof Error ? thrown.message : String(thrown))
    } finally {
      setBusy(false)
    }
  }, [inspected, onClose, specifier, store])

  return (
    <Dialog
      title="Install a plugin"
      icon={<PluginIcon size={16} />}
      size="md"
      onClose={onClose}
      footer={
        inspected ? (
          <>
            <Btn variant="primary" disabled={busy} onClick={() => void confirm()}>
              {busy ? 'Installing…' : 'Install and enable'}
            </Btn>
            <Btn
              disabled={busy}
              onClick={() => {
                setInspected(null)
                setError(null)
              }}
            >
              Back
            </Btn>
          </>
        ) : undefined
      }
    >
      {!inspected ? (
        <>
          <p className={styles.blurb}>
            A folder on this machine, or a package on npm. Its manifest is read and shown to you
            before anything is installed or run.
          </p>
          <div className={styles.ask}>
            <Input
              placeholder="/path/to/plugin  or  @scope/plugin-name"
              value={specifier}
              autoFocus
              onChange={(event) => setSpecifier(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter') void look()
              }}
            />
            <Btn variant="primary" disabled={busy || specifier.trim().length === 0} onClick={() => void look()}>
              {busy ? 'Reading…' : 'Continue'}
            </Btn>
          </div>
          <p className={styles.note}>
            <FolderIcon size={13} />
            <span>
              A plugin folder needs a <code className={styles.mono}>harnessdesk.plugin.json</code> at
              its root.
            </span>
          </p>
        </>
      ) : (
        <>
          <div className={styles.name}>{inspected.name}</div>
          <p className={styles.blurb}>
            {inspected.description ?? 'No description provided.'}
            {inspected.version ? ` · v${inspected.version}` : ''}
          </p>

          <section className={styles.grant}>
            <div className={styles.grantLabel}>This plugin will be able to</div>
            <ul className={styles.permissions}>
              {inspected.permissions.map((line) => (
                <li key={line}>{line}</li>
              ))}
            </ul>
          </section>

          <p className={styles.note}>
            <AlertIcon size={13} />
            <span>
              Plugins run in the HarnessDesk plugin host. Permissions are enforced at every call,
              but a plugin is still code from its author — install ones you would be willing to run.
            </span>
          </p>

          {inspected.alreadyInstalled && (
            <p className={styles.note}>
              A plugin with this id is already installed and will be replaced.
            </p>
          )}
        </>
      )}

      {error && <p className={`${styles.note} ${styles.error}`}>{error}</p>}
    </Dialog>
  )
}
