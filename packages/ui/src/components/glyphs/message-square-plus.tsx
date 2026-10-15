// Vendored from lucide-animated (`message-square-plus`); ./index.ts says what changed.

import { motion, type Variants } from 'motion/react'

import { Glyph, type GlyphProps } from './glyph'

const PLUS_VARIANTS: Variants = {
  normal: {
    pathLength: 1,
    opacity: 1,
    transition: {
      duration: 0.3,
    },
  },
  animate: {
    pathLength: [0, 1],
    opacity: [0, 1],
    transition: {
      pathLength: { duration: 0.4, ease: 'easeInOut' },
      opacity: { duration: 0.4, ease: 'easeInOut' },
    },
  },
}

const PLUS_HORIZONTAL_VARIANTS: Variants = {
  normal: {
    pathLength: 1,
    opacity: 1,
    transition: {
      duration: 0.3,
    },
  },
  animate: {
    pathLength: [0, 1],
    opacity: [0, 1],
    transition: {
      pathLength: { duration: 0.4, ease: 'easeInOut', delay: 0.2 },
      opacity: { duration: 0.4, ease: 'easeInOut', delay: 0.2 },
    },
  },
}

export const MessageSquarePlusGlyph = ({ controls, ...props }: GlyphProps) => (
  <Glyph name="message-square-plus" {...props}>
    <path d="M22 17a2 2 0 0 1-2 2H6.828a2 2 0 0 0-1.414.586l-2.202 2.202A.71.71 0 0 1 2 21.286V5a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2z" />
    <motion.path
      animate={controls}
      d="M12 8v6"
      initial="normal"
      variants={PLUS_VARIANTS}
    />
    <motion.path
      animate={controls}
      d="M9 11h6"
      initial="normal"
      variants={PLUS_HORIZONTAL_VARIANTS}
    />
  </Glyph>
)
