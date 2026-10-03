/** Real Flow inputs and the real start dialog, on synthetic catalogue data. */
import { useEffect, useMemo, useRef, useState } from 'react'
import type { FlowPreview } from '@harnessdesk/protocol'

import { FlowStart } from '../components/FlowStart'
import { NewSessionChoice } from '../components/NewSessionChoice'
import { Button } from '../design'
import { StoreProvider } from '../state/context'
import { useTheme } from '../state/theme'
import type { AppStore } from '../state/store'
import { previewStore } from './harness'
import { PREVIEW_ROOT } from './sidebar-fixture'

export const BRIEF_PARAGRAPHS = 'Make the settings easier to read.\n\nKeep each choice beside its explanation and preserve keyboard navigation.\n\nCheck both themes and a narrow window before handing over the change.'
export const BRIEF_SCENES = ['empty', 'filled', 'long', 'refused', 'pending'] as const
export type BriefScene = (typeof BRIEF_SCENES)[number]

const briefStore = (scene: BriefScene): AppStore => {
  const preview: FlowPreview = {
    token: 'preview-brief', messaging: 'board-only', seats: [], guards: [], commands: [], problems: [],
    compiled: { bindings: [], problems: [], document: { format: 'agents', flow: {
      version: 2, name: 'Work from a brief',
      inputs: [{ id: 'brief', label: 'Brief', default: scene === 'filled' ? BRIEF_PARAGRAPHS : scene === 'long' ? Array.from({ length: 80 }, (_, i) => `Paragraph ${i + 1}: ${BRIEF_PARAGRAPHS}`).join('\n\n') : '' }],
      roles: [], rules: [], seed: { role: 'implementer', title: 'Improve the settings' }, wait: 240, messaging: 'board-only',
    } } },
  }
  const base = previewStore({ theme: 'system' })
  return new Proxy(base, {
    get(target, property, receiver) {
      if (property === 'loadAgents') return async () => {}
      if (property === 'flowCatalog') return async () => [{ id: 'brief', name: 'Work from a brief', origin: 'project', path: '.harnessdesk/flows/brief.yml', description: null, format: 'agents', problem: null, shadows: [] }]
      if (property === 'flowSource') return async () => 'version: 2\nname: Work from a brief\n'
      if (property === 'previewFlow') return async () => preview
      const value = Reflect.get(target, property, receiver)
      return typeof value === 'function' ? value.bind(target) : value
    },
  }) as AppStore
}

/** Drive the fixture through the same choice and file events as a person. */
const useBriefScene = (scene: BriefScene, host: () => ParentNode | null, dialog: boolean) => {
  useEffect(() => {
    let chosen = false
    const timer = window.setInterval(() => {
      const container = host()
      if (!container) return
      if (dialog) {
        const next = [...container.querySelectorAll<HTMLButtonElement>('button')].find((button) => button.textContent === 'Continue')
        if (next) { next.click(); return }
      }
      const select = container.querySelector<HTMLSelectElement>('select')
      if (!chosen) {
        if (!select || select.disabled) return
        select.value = 'brief'
        select.dispatchEvent(new Event('change', { bubbles: true }))
        chosen = true
      }
      const area = container.querySelector('textarea')
      if (!area) return
      const title = container.querySelector<HTMLInputElement>('[aria-label="What finishes this?"]')
      if (title) {
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(title, 'Improve the settings')
        title.dispatchEvent(new Event('input', { bubbles: true }))
      }
      if (scene === 'refused' || scene === 'pending') {
        const input = container.querySelector<HTMLInputElement>('input[type="file"]')!
        const file = new File([scene === 'refused' ? 'A'.repeat(64 * 1024 + 1) : 'A brief'], 'brief.txt', { type: 'text/plain' })
        if (scene === 'pending') Object.defineProperty(file, 'text', { value: () => new Promise<string>(() => {}) })
        const files = new DataTransfer()
        files.items.add(file)
        input.files = files.files
        input.dispatchEvent(new Event('change', { bubbles: true }))
      }
      window.clearInterval(timer)
    }, 10)
    return () => window.clearInterval(timer)
  }, [scene, dialog])
}

export const FlowBriefCases = () => {
  const [scene, setScene] = useState<BriefScene>('empty')
  const host = useRef<HTMLDivElement>(null)
  const store = useMemo(() => briefStore(scene), [scene])
  useBriefScene(scene, () => host.current, false)
  return <div className="flex flex-col gap-(--hd-space-4)">
    <div className="flex flex-wrap gap-(--hd-space-2)">
      {BRIEF_SCENES.map((one) => <Button key={one} variant="secondary" aria-pressed={scene === one} onClick={() => setScene(one)}>{one}</Button>)}
    </div>
    <StoreProvider store={store}><div ref={host}><FlowStart key={scene} root={PREVIEW_ROOT} onChange={() => {}} /></div></StoreProvider>
  </div>
}

/** Dedicated preview frames include the title and Start on the shipped dialog. */
const BriefDialogBody = ({ scene }: { readonly scene: BriefScene }) => {
  useTheme()
  const [open, setOpen] = useState(true)
  useBriefScene(scene, () => document, true)
  return open && <NewSessionChoice initialKind="flow" onClose={() => setOpen(false)} />
}

export const FlowBriefDialog = ({ scene }: { readonly scene: BriefScene }) => {
  const store = useMemo(() => briefStore(scene), [scene])
  return <StoreProvider store={store}><BriefDialogBody scene={scene} /></StoreProvider>
}
