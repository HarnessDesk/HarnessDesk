import { useEffect, type RefObject } from 'react'

/** Approval keys are scoped to the visible surface and never consume typing or a spent key. */
export const useApprovalKeys = (scope: RefObject<HTMLElement | null>, enabled: boolean, docked: boolean,
  actions: readonly { readonly shortcut: number; readonly onSelect: () => void; readonly disabled?: boolean }[],
  deny: (() => void) | undefined, typedThrough: RefObject<number>) => {
  useEffect(() => {
    if (!enabled) return
    const keydown = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.metaKey || event.ctrlKey || event.altKey || scope.current?.closest('[inert]')) return
      if (docked && (!(event.target instanceof Node) || !scope.current?.contains(event.target) ||
        event.target instanceof Element && event.target.closest('input, textarea, select, [contenteditable]:not([contenteditable="false"])') || Date.now() < typedThrough.current)) return
      if (event.key === 'Escape' && deny) { event.preventDefault(); deny(); return }
      const action = actions.find(action => String(action.shortcut) === event.key && !action.disabled)
      if (action) { event.preventDefault(); action.onSelect() }
    }
    window.addEventListener('keydown', keydown)
    return () => window.removeEventListener('keydown', keydown)
  }, [scope, enabled, docked, actions, deny, typedThrough])
}
