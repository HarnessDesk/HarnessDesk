// Vendored from lucide-animated (`users-round`); ./index.ts says what changed.

import { motion, type Variants } from 'motion/react'

import { Glyph, type GlyphProps } from './glyph'

const PATH_VARIANTS: Variants = {
  normal: {
    translateX: 0,
    opacity: 1,
    transition: {
      type: 'spring',
      stiffness: 200,
      damping: 13,
    },
  },
  animate: {
    translateX: [-4, 0],
    opacity: [0, 1],
    transition: {
      delay: 0.1,
      type: 'spring',
      stiffness: 200,
      damping: 13,
    },
  },
}

export const UsersRoundGlyph = ({ controls, ...props }: GlyphProps) => (
  <Glyph name="users-round" {...props}>
    <path d="M18 21a8 8 0 0 0-16 0" />
    <circle cx="10" cy="8" r="5" />
    <motion.path
      animate={controls}
      d="M22 20c0-3.37-2-6.5-4-8a5 5 0 0 0-.45-8.3"
      initial="normal"
      variants={PATH_VARIANTS}
    />
  </Glyph>
)
