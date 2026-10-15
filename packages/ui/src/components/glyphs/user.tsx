// Vendored from lucide-animated (`user`); ./index.ts says what changed.

import { motion, type Variants } from 'motion/react'

import { Glyph, type GlyphProps } from './glyph'

const PATH_VARIANT: Variants = {
  normal: { pathLength: 1, opacity: 1, pathOffset: 0 },
  animate: {
    pathLength: [0, 1],
    opacity: [0, 1],
    pathOffset: [1, 0],
  },
}

const CIRCLE_VARIANT: Variants = {
  normal: {
    pathLength: 1,
    pathOffset: 0,
    scale: 1,
  },
  animate: {
    pathLength: [0, 1],
    pathOffset: [1, 0],
    scale: [0.5, 1],
  },
}

export const UserGlyph = ({ controls, ...props }: GlyphProps) => (
  <Glyph name="user" {...props}>
    <motion.circle
      animate={controls}
      cx="12"
      cy="8"
      r="5"
      variants={CIRCLE_VARIANT}
    />

    <motion.path
      animate={controls}
      d="M20 21a8 8 0 0 0-16 0"
      transition={{
        delay: 0.2,
        duration: 0.4,
      }}
      variants={PATH_VARIANT}
    />
  </Glyph>
)
