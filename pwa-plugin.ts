import { readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join, relative, sep } from 'node:path'
import type { Plugin } from 'vite'
import { buildPrecache, renderServiceWorker, type PrecacheFile } from './pwa-precache.ts'

function walk(dir: string, out: string[] = []): string[] {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name)
    if (e.isDirectory()) walk(p, out)
    else out.push(p)
  }
  return out
}

/** Emits dist/sw.js after the bundle and public files are written: precaches everything that was shipped. */
export function pwaPlugin(): Plugin {
  let outDir = 'dist'
  return {
    name: 'webvna-pwa',
    apply: 'build',
    configResolved(c) { outDir = join(c.root, c.build.outDir) },
    writeBundle() {
      const files: PrecacheFile[] = walk(outDir).map((p) => ({ name: relative(outDir, p).split(sep).join('/'), content: readFileSync(p) }))
      writeFileSync(join(outDir, 'sw.js'), renderServiceWorker(buildPrecache(files)))
    },
  }
}
