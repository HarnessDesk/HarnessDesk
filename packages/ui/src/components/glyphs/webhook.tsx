// Vendored from lucide-animated (`webhook`); ./index.ts says what changed.

import { motion, type Transition, type Variants } from 'motion/react'

import { Glyph, type GlyphProps } from './glyph'

const TRANSITION: Transition = {
  duration: 0.3,
  opacity: { delay: 0.15 },
}

const VARIANTS: Variants = {
  normal: {
    pathLength: 1,
    opacity: 1,
  },
  animate: {
    pathLength: [0, 1],
    opacity: [0, 1],
    transition: {
      ...TRANSITION,
      delay: 0.1,
    },
  },
}

export const WebhookGlyph = ({ controls, ...props }: GlyphProps) => (
  <Glyph name="webhook" {...props}>
    <motion.path
      animate={controls}
      d="M18 16.98h-5.99c-1.1 0-1.95.94-2.48 1.9A4 4 0 0 1 2 17c.01-.7.2-1.4.57-2"
      variants={VARIANTS}
    />
    <motion.path
      animate={controls}
      d="m6 17 3.13-5.78c.53-.97.1-2.18-.5-3.1a4 4 0 1 1 6.89-4.06"
      variants={VARIANTS}
    />
    <motion.path
      animate={controls}
      d="m12 6 3.13 5.73C15.66 12.7 16.9 13 18 13a4 4 0 0 1 0 8"
      variants={VARIANTS}
    />
  </Glyph>
)
