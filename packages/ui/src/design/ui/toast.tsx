import { Toaster as Sonner, toast } from 'sonner'
import type * as React from 'react'

/**
 * Vendored from shadcn/ui (toast), which is Sonner underneath.
 *
 * What it brings that the app's own notice stack did not: toasts that stack
 * and collapse rather than pushing each other down the screen, swipe to
 * dismiss, a promise form that shows pending and then the outcome, and a
 * `toast()` that can be called from anywhere &mdash; which matters here,
 * because half the things worth announcing happen in the transport, nowhere
 * near a component.
 *
 * Two departures from the registry's file:
 *
 *   No `next-themes`.   The registry reads the theme from a Next.js provider.
 *                       This app has its own, and adding a second theme source
 *                       to a desktop app that already knows whether it is dark
 *                       is exactly the kind of dependency the audit counts.
 *   Tokens, not classes. The `--normal-*` variables Sonner reads are pointed at
 *                       the `--hd-` layer, so a toast follows a palette swap
 *                       and both faces without a class override per part.
 *   Theme is a prop.    Everything in this folder is unaware of the app &mdash;
 *                       no store, no context &mdash; so the resolved theme
 *                       arrives from the caller rather than being read here.
 *                       That is what keeps this file mountable on the sign-in
 *                       screen and in the explorer alike.
 *
 * **The notice policy is not this.** `Notices.tsx` holds four lifetimes, a
 * dismissal that escalates after the second time, and Settings &rsaquo;
 * Notifications as the way back &mdash; those are product decisions and they
 * stay. This is the surface they are drawn on.
 */

const Toaster = ({ theme = 'light', ...props }: React.ComponentProps<typeof Sonner>) => (
  <Sonner
    theme={theme}
    className="toaster group"
    position="bottom-right"
    style={
      {
        '--normal-bg': 'var(--hd-popover)',
        '--normal-text': 'var(--hd-popover-foreground)',
        '--normal-border': 'var(--hd-border-strong)',
        '--border-radius': 'var(--hd-radius)',
      } as React.CSSProperties
    }
    toastOptions={{
      classNames: {
        toast: 'shadow-(--hd-shadow) text-base',
        description: 'text-(--hd-muted-foreground) text-xs',
        /* A toast's action is a button, so it is ink like every other one. */
        actionButton: 'bg-(--hd-solid) text-(--hd-solid-foreground)',
        cancelButton: 'bg-(--hd-muted) text-(--hd-muted-foreground)',
      },
    }}
    {...props}
  />
)

export { Toaster, toast }
