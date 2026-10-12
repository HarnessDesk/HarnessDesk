import { useEffect, useState } from 'react'
import { LeftColumnNavigation, LeftColumnRow } from '../design'
import { desktop, type AppUpdateFact } from '../lib/desktop'
import { RefreshIcon } from './Icons'

/** Native advisory lifetime is independent of the current destination. */
export const SidebarUpdate = () => {
  const [update, setUpdate] = useState<AppUpdateFact | null>(null)
  useEffect(() => {
    const bridge = desktop()
    let live = true, pushed = false
    const off = bridge?.onAppUpdate?.(fact => { pushed = true; if (live) setUpdate(fact) })
    void bridge?.readAppUpdate?.().then(fact => { if (live && !pushed) setUpdate(fact) }).catch(() => {})
    return () => { live = false; off?.() }
  }, [])
  return update ? <LeftColumnNavigation><LeftColumnRow label={update.label} icon={<RefreshIcon size={16} />}
    disabled={!update.enabled} onClick={() => desktop()?.appUpdateAction?.()} /></LeftColumnNavigation> : null
}
