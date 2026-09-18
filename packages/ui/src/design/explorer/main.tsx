import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'

import '../../styles/app.css'
import { Explorer } from './Explorer'

/**
 * The explorer's entry, separate from the app's.
 *
 * It pulls in `app.css` — the same stylesheet the product loads — so the
 * system is documented under exactly the cascade it ships under.
 *
 * What it loads eagerly holds no store, no transport and no session: a
 * primitive that needs those is not a primitive. The whole-screen surfaces do
 * need them — they mount the app's own screens — so `Explorer.tsx` loads them
 * behind a `React.lazy` split, and the store arrives only when a surface is
 * opened. Checked against a production build: of the chunks `design.html`
 * loads up front, none contains the harness or the app's store.
 */
const root = document.getElementById('root')
if (root) createRoot(root).render(<StrictMode><Explorer /></StrictMode>)
