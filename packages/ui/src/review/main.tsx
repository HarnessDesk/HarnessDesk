import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'

import '../styles/app.css'
import { Review } from './Review'

/**
 * The review board's entry: `pnpm design`, then `/review.html`.
 *
 * Like the preview, it is a development page and not part of the build; it
 * loads `app.css` so its own chrome sits on the cascade the product ships.
 */
const root = document.getElementById('root')
if (root) createRoot(root).render(<StrictMode><Review /></StrictMode>)
