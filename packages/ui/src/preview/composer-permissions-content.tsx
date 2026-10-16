import { permissionVariants as variants } from './composer-permissions-fixture'
import { useMemo } from 'react'
import { runtimeId, type ConfigOption, type RuntimeInfo } from '@harnessdesk/protocol'
import { AgentControl, ModeControl, ModelControl, MoreControl, PermissionControl, PlaceControl } from '../components/ComposerControls'
import { ContextUsage } from '../components/ContextUsage'
import { PlusIcon, SendIcon } from '../components/Icons'
import { Button, ComposerText, ComposerGap, ComposerSend, ComposerShell, ComposerTools, ComposerTrack } from '../design'
import { StoreProvider } from '../state/context'
import { emptySnapshot, type AppStore } from '../state/store'
import { previewStore } from './harness'

const AgentComposer = ({ variant }: { variant: typeof variants[number] }) => {
  const store = useMemo(() => {
    const id = runtimeId(`preview-permissions-${variant.name}`)
    const options: ConfigOption[] = [...variant.options,
      { id: 'model', type: 'select', category: 'model', label: 'Model', currentValue: 'model', choices: [{ value: 'model', label: variant.model }] },
      { id: 'effort', type: 'select', category: 'thought_level', label: 'Effort', currentValue: 'xhigh', choices: [{ value: 'xhigh', label: 'Extra high' }] },
    ]
    const state = previewStore({ ...emptySnapshot(), activeRuntime: id,
      runtimes: [{ id, name: variant.name, presentation: { name: variant.name }, capabilities: {} } as RuntimeInfo],
      draftOptions: options, workspace: { path: '/workspace/demo', name: 'Demo' } as never,
    })
    return new Proxy(state, { get(target, property) {
      if (property === 'setOption') return async (optionId: string, value: string | boolean) => {
        target.patch({ draftOptions: target.getSnapshot().draftOptions!.map(option => option.id === optionId ? { ...option, currentValue: value, ...(option.type === 'select' && option.collaboration ? { collaboration: { ...option.collaboration, actValue: value === option.collaboration.planValue ? 'default' : String(value) } } : {}) } as ConfigOption : option) })
      }
      return Reflect.get(target, property)
    } }) as AppStore
  }, [variant])
  return <StoreProvider store={store}>
    <section data-permissions-agent={variant.name} className="grid gap-2">
      <h3 className="text-sm font-medium">{variant.name}</h3>
      <ComposerShell>
        <ComposerText aria-label="Message" placeholder="Describe the next change…" />
        <ComposerTools data-composer-layout="draft">
          <ComposerTrack name="add"><Button variant="ghost" size="sm" aria-label="Add"><PlusIcon size={15} /></Button></ComposerTrack>
          <PlaceControl /><AgentControl /><PermissionControl /><ModeControl /><ComposerTrack name="extension" /><ComposerGap /><MoreControl /><ContextUsage /><ModelControl />
          <ComposerTrack name="send"><ComposerSend aria-label="Send"><SendIcon size={15} /></ComposerSend></ComposerTrack>
        </ComposerTools>
      </ComposerShell>
    </section>
  </StoreProvider>
}
export const ComposerPermissionsContent = () => <div data-composer-permissions className="grid gap-4 p-4 w-(--hd-column)">
  {variants.map(variant => <AgentComposer key={variant.name} variant={variant} />)}
</div>
