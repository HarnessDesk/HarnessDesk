import { createContext } from 'react'

/**
 * Whether a part is drawn inside a dialog's form body.
 *
 * It lives below the design system's layers so the primitives can answer it
 * too: `Dialog`'s body says true (`design/patterns/DialogForm.tsx`), and every
 * surface that opens *over* something — dialog and alert content, a popover,
 * a menu — says false for what it holds. React context crosses portals, so
 * without that a popover opened from a dialog's field would draw its rows as
 * the dialog's form.
 */
export const DialogFormContext = createContext(false)
