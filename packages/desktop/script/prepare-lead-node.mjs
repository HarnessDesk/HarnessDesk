#!/usr/bin/env node
import { fileURLToPath } from 'node:url'
import { fetchLeadNode } from './fetch-lead-node.mjs'

/** The optional Lead must not prevent a source build from opening. The fetcher reuses its verified pin. */
export const prepareLeadNode = async ({ platform = process.platform, arch = process.arch, fetchNode = fetchLeadNode, warn = console.warn } = {}) => {
  if (platform !== 'darwin') return
  try { await fetchNode({ arch }) }
  catch (error) { warn(`Lead runtime could not be fetched; the app will still start: ${error instanceof Error ? error.message : String(error)}`) }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) await prepareLeadNode()
