import { useState } from 'react'
import { runtimeId, sessionId, sessionKey, type ConfigOption, type RuntimeInfo, type Session } from '@harnessdesk/protocol'

import { AgentControl, ComposerTrack, ModeControl, ModelControl, MoreControl, PermissionControl, PlaceControl } from '../components/ComposerControls'
import { ContextUsage } from '../components/ContextUsage'
import { Frame } from './main'
import { ComposerGap, ComposerSend, ComposerTools, Button } from '../design'
import { PaneProvider, StoreProvider } from '../state/context'
import { emptySnapshot, type AppSnapshot } from '../state/store'
import { previewStore } from './harness'

const optionsFor = (shape: number): ConfigOption[] => {
  const mode: ConfigOption = { id: 'mode', type: 'select', label: 'Mode', category: 'mode', currentValue: 'direct', choices: [{ value: 'direct', label: 'Direct' }, { value: 'plan', label: 'Plan' }] }
  const model: ConfigOption = { id: 'model', type: 'select', label: 'Model', category: 'model', currentValue: 'model-a', choices: [{ value: 'model-a', label: 'Model A' }, { value: 'model-b', label: 'Model B' }] }
  const reasoning: ConfigOption = { id: 'reasoning', type: 'select', label: 'Reasoning', category: 'thought_level', currentValue: 'standard', choices: [{ value: 'standard', label: 'Standard' }, { value: 'deep', label: 'Deep' }] }
  const permissions: ConfigOption = { id: 'permissions', type: 'select', label: 'Permissions', category: '_permissions', currentValue: 'ask', choices: [{ value: 'ask', label: 'Ask first' }, { value: 'allow', label: 'Allow' }] }
  const modelConfig: ConfigOption = { id: 'model-config', type: 'boolean', label: 'Model config', category: 'model_config' as unknown as ConfigOption['category'], currentValue: true }
  const other: ConfigOption = { id: 'other', type: 'boolean', label: 'Other option', category: 'other', currentValue: true }
  switch (shape) {
    case 0: return [mode, model, reasoning, permissions, other]
    case 1: return [mode, model, modelConfig, reasoning]
    case 2: return [mode, other]
    default: return [mode, model, reasoning, permissions, other]
  }
}

const SHAPES = ['Assistant A', 'Assistant B', 'Assistant C', 'Assistant D'] as const

const SlotToolbar = ({ shape, live, extensionAction = false }: { shape: number; live: boolean; extensionAction?: boolean }) => {
  const runtime = { id: runtimeId(`preview-${shape}`), name: SHAPES[shape], capabilities: { metered: false }, presentation: { name: SHAPES[shape] } } as unknown as RuntimeInfo
  const key = sessionKey(runtime.id, sessionId(`composer-slots-${shape}`))
  const options = optionsFor(shape)
  const session = {
    id: sessionId(`composer-slots-${shape}`), runtime: runtime.id, cwd: '/workspace', status: { type: 'idle' },
    createdAt: 0, updatedAt: 0, turns: [], itemsLoaded: true, options,
  } as unknown as Session
  const snapshot: AppSnapshot = {
    ...emptySnapshot(), runtimes: [runtime], activeRuntime: runtime.id,
    ...(live ? { sessions: new Map([[key, session]]), activeSessionKey: key } : { draftOptions: options }),
    workspace: { path: '/workspace', name: 'Workspace' } as AppSnapshot['workspace'],
  }
  const state = previewStore(snapshot)
  const toolbar = (
    <ComposerTools className="w-full min-w-0" data-composer-layout={live ? 'live' : 'draft'}>
      <ComposerTrack name="add"><Button variant="ghost" size="sm" aria-label="Add" title="Add">+</Button></ComposerTrack>
      <PlaceControl />
      <AgentControl />
      <PermissionControl />
      <ModeControl />
      <ComposerTrack name="extension">{extensionAction && <Button variant="ghost" size="sm" title="Plugin action" aria-label="Plugin action">◇</Button>}</ComposerTrack>
      <ComposerGap />
      <MoreControl />
      <ContextUsage />
      <ModelControl />
      <ComposerTrack name="send"><ComposerSend aria-label="Send" title="Send"><span aria-hidden>↑</span></ComposerSend></ComposerTrack>
    </ComposerTools>
  )
  return (
    <StoreProvider store={state}>
      <PaneProvider scope={{ paneId: `composer-slots-${shape}` as never, view: { kind: 'conversation', session: key } as never, sessionKey: key }}>
        {toolbar}
      </PaneProvider>
    </StoreProvider>
  )
}

const LayoutSwitchCase = () => {
  const [live, setLive] = useState(false)
  return (
    <section data-layout-switch-case>
      <Button variant="outline" size="sm" data-layout-switch onClick={() => setLive((current) => !current)}>
        Switch to {live ? 'draft' : 'live'}
      </Button>
      <div className="w-(--hd-composer-slots-preview-narrow) max-w-full">
        <SlotToolbar shape={0} live={live} />
      </div>
    </section>
  )
}

const ExtensionWidthCase = () => (
  <section data-extension-width-case className="grid w-(--hd-composer-slots-preview-narrow) max-w-full gap-1">
    <SlotToolbar shape={0} live={false} />
    <SlotToolbar shape={0} live={false} extensionAction />
  </section>
)

const widths = [
  { name: 'composer', width: 'var(--hd-column)' },
  { name: '560', width: 'var(--hd-composer-slots-preview-narrow)' },
  { name: '360', width: 'var(--hd-composer-slots-preview-tight)' },
  { name: '320', width: 320 },
] as const

export const ComposerSlotsFrames = () => (
  <Frame id="composer-slots" title="Composer — fixed slots">
    <div className="grid gap-4 p-4" data-composer-slots-preview>
      {widths.map(({ name, width }) => (
        <section key={name} className="grid gap-2">
          <h3 className="text-sm font-medium">{name === 'composer' ? 'Composer width' : `${name}px`}</h3>
          <div
            data-composer-width={name}
            className="grid min-w-0 gap-2 max-w-(--hd-column)"
            style={{ width }}
          >
            {SHAPES.map((shapeName, shape) => (
              <section key={shapeName} data-composer-shape={shapeName} className="grid min-w-0 gap-1">
                <h4 className="text-sm font-medium">{shapeName}</h4>
                <div className="grid gap-1">
                  <span className="text-xs text-(--hd-muted-foreground)">Draft</span>
                  <SlotToolbar shape={shape} live={false} />
                  <span className="text-xs text-(--hd-muted-foreground)">Live</span>
                  <SlotToolbar shape={shape} live />
                </div>
              </section>
            ))}
          </div>
        </section>
      ))}
      <LayoutSwitchCase />
      <ExtensionWidthCase />
    </div>
  </Frame>
)
