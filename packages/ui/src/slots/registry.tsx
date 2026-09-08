import { createContext, useContext, useMemo, type ComponentType, type ReactNode } from 'react'

import type { CapabilityContribution, UiSlot } from '@harnessdesk/protocol'

import { useSnapshot } from '../state/context'

/**
 * The slot registry.
 *
 * HarnessDesk's own features register here alongside plugin-contributed ones, so
 * there is one composition mechanism rather than a built-in path and a
 * second-class extension path. That is the property that stops the plugin
 * surface from rotting: if the app itself did not use it, nobody would notice
 * when it broke.
 *
 * A contribution names a component by id; this table resolves the id. A plugin
 * cannot inject arbitrary React — it selects from components the renderer
 * publishes, which keeps untrusted code out of the render tree.
 */

export interface SlotProps {
  /** Set when the occupant came from a plugin rather than a built-in feature. */
  readonly contribution?: CapabilityContribution
}

export type SlotComponent = ComponentType<SlotProps>

interface Registration {
  readonly id: string
  readonly slot: UiSlot
  readonly component: SlotComponent
  readonly order: number
  /** Hides the occupant without unregistering it. */
  readonly when?: (snapshot: ReturnType<typeof useSnapshot>) => boolean
}

class SlotRegistry {
  readonly #bySlot = new Map<UiSlot, Registration[]>()
  readonly #components = new Map<string, SlotComponent>()

  /** Registers a built-in occupant. */
  register(registration: Registration): void {
    const existing = this.#bySlot.get(registration.slot) ?? []
    this.#bySlot.set(
      registration.slot,
      [...existing, registration].sort((a, b) => a.order - b.order),
    )
    this.#components.set(registration.id, registration.component)
  }

  /** Publishes a component a plugin may reference by id. */
  publish(id: string, component: SlotComponent): void {
    this.#components.set(id, component)
  }

  occupants(slot: UiSlot): readonly Registration[] {
    return this.#bySlot.get(slot) ?? []
  }

  resolve(id: string): SlotComponent | undefined {
    return this.#components.get(id)
  }
}

const registry = new SlotRegistry()

export const registerSlot = (
  slot: UiSlot,
  id: string,
  component: SlotComponent,
  options: { order?: number; when?: Registration['when'] } = {},
): void => {
  registry.register({
    id,
    slot,
    component,
    order: options.order ?? 100,
    ...(options.when ? { when: options.when } : {}),
  })
}

export const publishComponent = (id: string, component: SlotComponent): void => {
  registry.publish(id, component)
}

/**
 * The read side of `publishComponent`.
 *
 * `Slot` resolves through the registry instance directly; this exists so a
 * published component can be rendered on its own — which is how the block
 * vocabulary is tested, one contribution at a time, without standing up a
 * slot and a plugin host to reach it.
 */
export const resolveComponent = (id: string): SlotComponent | undefined => registry.resolve(id)

const RegistryContext = createContext(registry)

export const useSlotRegistry = (): SlotRegistry => useContext(RegistryContext)

/**
 * Renders everything registered in a slot, built-ins and plugin contributions
 * interleaved by order.
 */
export const Slot = ({
  name,
  fallback,
}: {
  name: UiSlot
  fallback?: ReactNode
}): ReactNode => {
  const snapshot = useSnapshot()
  const table = useSlotRegistry()

  const occupants = useMemo(() => {
    const builtins = table
      .occupants(name)
      .filter((entry) => !entry.when || entry.when(snapshot))
      .map((entry) => ({
        key: entry.id,
        order: entry.order,
        component: entry.component,
        contribution: undefined as CapabilityContribution | undefined,
      }))

    const contributed = snapshot.contributions
      .filter((entry): entry is Extract<CapabilityContribution, { kind: 'ui' }> =>
        entry.kind === 'ui' &&
        entry.slot === name &&
        // A contribution that declares `mounts` is a *panel*, not a slot
        // occupant: the panel system mounts it, gives it a tab and lets the
        // person move it. Drawing it inline here as well would put the same
        // thing on screen twice.
        !(Array.isArray(entry.mounts) && entry.mounts.length > 0),
      )
      .map((entry) => {
        const component = table.resolve(entry.component)
        return component
          ? { key: String(entry.id), order: entry.order, component, contribution: entry }
          : null
      })
      .filter((entry): entry is NonNullable<typeof entry> => entry !== null)

    return [...builtins, ...contributed].sort((a, b) => a.order - b.order)
  }, [name, snapshot, table])

  if (occupants.length === 0) return fallback ?? null

  return (
    <>
      {occupants.map(({ key, component: Component, contribution }) => (
        <Component key={key} {...(contribution ? { contribution } : {})} />
      ))}
    </>
  )
}

/** True when anything would render into a slot. Used to decide whether to show chrome. */
export const useSlotFilled = (name: UiSlot): boolean => {
  const snapshot = useSnapshot()
  const table = useSlotRegistry()
  return (
    table.occupants(name).some((entry) => !entry.when || entry.when(snapshot)) ||
    snapshot.contributions.some(
      (entry) =>
        entry.kind === 'ui' &&
        entry.slot === name &&
        !(Array.isArray(entry.mounts) && entry.mounts.length > 0),
    )
  )
}
