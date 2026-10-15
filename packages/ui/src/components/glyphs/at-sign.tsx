// Vendored from lucide-animated (`at-sign`); ./index.ts says what changed.

import { motion, type Variants } from 'motion/react'

import { Glyph, type GlyphProps } from './glyph'

const CIRCLE_VARIANTS: Variants = {
  normal: {
    opacity: 1,
    pathLength: 1,
    pathOffset: 0,
    transition: {
      duration: 0.4,
      opacity: { duration: 0.1 },
    },
  },
  animate: {
    opacity: [0, 1],
    pathLength: [0, 1],
    pathOffset: [1, 0],
    transition: {
      duration: 0.3,
      opacity: { duration: 0.1 },
    },
  },
}

const PATH_VARIANTS: Variants = {
  normal: {
    opacity: 1,
    pathLength: 1,
    transition: {
      delay: 0.3,
      duration: 0.3,
      opacity: { duration: 0.1, delay: 0.3 },
    },
  },
  animate: {
    opacity: [0, 1],
    pathLength: [0, 1],
    transition: {
      delay: 0.3,
      duration: 0.3,
      opacity: { duration: 0.1, delay: 0.3 },
    },
  },
}

export const AtSignGlyph = ({ controls, ...props }: GlyphProps) => (
  <Glyph name="at-sign" {...props}>
    <motion.circle
      animate={controls}
      cx="12"
      cy="12"
      r="4"
      variants={CIRCLE_VARIANTS}
    />
    <motion.path
      animate={controls}
      d="M16 8v5a3 3 0 0 0 6 0v-1a10 10 0 1 0-4 8"
      variants={PATH_VARIANTS}
    />
  </Glyph>
)
