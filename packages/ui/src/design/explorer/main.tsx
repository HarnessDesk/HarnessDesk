import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'

import '../../styles/app.css'
import { Explorer } from './Explorer'

/**
 * The explorer's entry, separate from the app's.
 *
 * It pulls in `app.css` — the same stylesheet the product loads — so the
 * system is documented under exactly the cascade it ships under. It does not
 * pull in the store, the transport or any session: a primitive that needs
 * those is not a primitive, and this entry failing to build is how we find
 * out.
 */
const root = document.getElementById('root')
if (root) createRoot(root).render(<StrictMode><Explorer /></StrictMode>)
