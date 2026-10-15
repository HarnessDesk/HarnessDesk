// Vendored from lucide-animated (`users`); ./index.ts says what changed.

import { motion, type Variants } from 'motion/react'

import { Glyph, type GlyphProps } from './glyph'

const PATH_VARIANTS: Variants = {
  normal: {
    translateX: 0,
    transition: {
      type: 'spring',
      stiffness: 200,
      damping: 13,
    },
  },
  animate: {
    translateX: [-6, 0],
    transition: {
      delay: 0.1,
      type: 'spring',
      stiffness: 200,
      damping: 13,
    },
  },
}

export const UsersGlyph = ({ controls, ...props }: GlyphProps) => (
  <Glyph name="users" {...props}>
    <path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2" />
    <circle cx="9" cy="7" r="4" />
    <motion.path
      animate={controls}
      d="M22 21v-2a4 4 0 0 0-3-3.87"
      variants={PATH_VARIANTS}
    />
    <motion.path
      animate={controls}
      d="M16 3.13a4 4 0 0 1 0 7.75"
      variants={PATH_VARIANTS}
    />
  </Glyph>
)
