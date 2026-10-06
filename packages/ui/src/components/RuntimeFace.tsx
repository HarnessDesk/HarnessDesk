import type { ComponentProps } from 'react'
import type { RuntimeInfo } from '@harnessdesk/protocol'

import { IconTile } from '../design'
import { accountIdentity, accountKey, accountName, runtimeAccountBadge, runtimeTint } from '../lib/accounts'
import { useSnapshot } from '../state/context'
import { RuntimeMark } from './BrandIcons'

/** The runtime face, qualified by its signed-in account from the 24px step up. */
export const RuntimeFace = ({ runtime, size = 'default', ...props }: {
  readonly runtime: RuntimeInfo
  readonly size?: ComponentProps<typeof IconTile>['size']
} & Omit<ComponentProps<typeof IconTile>, 'children' | 'shape' | 'tint' | 'tone' | 'color' | 'badge'>) => {
  const snapshot = useSnapshot()
  const account = snapshot.accountsByRuntime[runtime.id]?.accounts[0]
  const name = account && accountName(account, snapshot.accountPrefs[accountKey(runtime.id, account)], runtime.presentation.name)
  const badge = size === 'navigation' || size === 'stack' || size === 'xs' ? undefined
    : runtimeAccountBadge(runtime, snapshot.runtimes, snapshot.accountsByRuntime, snapshot.accountPrefs)
  return <IconTile {...props} size={size} shape="face" tint={runtimeTint(runtime.id, snapshot.accountsByRuntime, snapshot.accountPrefs)} badge={badge}
    title={[runtime.presentation.name, name !== runtime.presentation.name && name, account && accountIdentity(account)].filter(Boolean).join(' · ')}>
    <RuntimeMark runtime={runtime} />
  </IconTile>
}
