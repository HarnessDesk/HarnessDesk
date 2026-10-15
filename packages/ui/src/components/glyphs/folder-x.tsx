// Vendored from lucide-animated (`folder-x`); ./index.ts says what changed.

import { motion, type Variants } from 'motion/react'

import { Glyph, type GlyphProps } from './glyph'

const PATH_VARIANTS: Variants = {
  normal: {
    opacity: 1,
    pathLength: 1,
  },
  animate: {
    opacity: [0, 1],
    pathLength: [0, 1],
  },
}

export const FolderXGlyph = ({ controls, ...props }: GlyphProps) => (
  <Glyph name="folder-x" {...props}>
    <path d="M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z" />
    <motion.path
      animate={controls}
      d="m9.5 10.5 5 5"
      initial="normal"
      variants={PATH_VARIANTS}
    />
    <motion.path
      animate={controls}
      d="m14.5 10.5-5 5"
      initial="normal"
      transition={{ delay: 0.2 }}
      variants={PATH_VARIANTS}
    />
  </Glyph>
)
