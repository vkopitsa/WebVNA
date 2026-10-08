import { describe, expect, it } from 'vitest'
import { buildPrecache, renderServiceWorker } from './pwa-precache.ts'

const f = (name: string, content = name) => ({ name, content })

describe('buildPrecache', () => {
  const files = [f('index.html'), f('assets/b.js'), f('assets/a.css'), f('manifest.webmanifest'), f('icon-192.png'),
    f('og-image.jpg'), f('sitemap.xml'), f('robots.txt'), f('sw.js'), f('assets/a.js.map')]

  it('lists shipped assets sorted, skips SEO files, maps and the worker itself', () => {
    expect(buildPrecache(files).urls).toEqual(['./', 'assets/a.css', 'assets/b.js', 'icon-192.png', 'index.html', 'manifest.webmanifest'])
  })

  it('is independent of input order and path style', () => {
    const a = buildPrecache(files)
    const b = buildPrecache([...files].reverse().map((x) => ({ ...x, name: x.name.replace(/\//g, '\\') })))
    expect(b).toEqual(a)
  })

  it('changes version when content or the file list changes, not when skipped files change', () => {
    const base = buildPrecache(files).version
    expect(base).toMatch(/^[0-9a-f]{10}$/)
    expect(buildPrecache(files.map((x) => (x.name === 'icon-192.png' ? f(x.name, 'new') : x))).version).not.toBe(base)
    expect(buildPrecache([...files, f('assets/c.js')]).version).not.toBe(base)
    expect(buildPrecache(files.map((x) => (x.name === 'og-image.jpg' ? f(x.name, 'new') : x))).version).toBe(base)
  })
})

describe('renderServiceWorker', () => {
  it('embeds the version and URL list, without auto skipWaiting', () => {
    const p = buildPrecache([f('index.html'), f('assets/x.js')])
    const src = renderServiceWorker(p)
    expect(src).toContain(JSON.stringify(p.version))
    expect(src).toContain('"assets/x.js"')
    expect(src).toContain('SKIP_WAITING')
    expect(() => new Function(src)).not.toThrow()
    expect(src.match(/skipWaiting\(\)/g)).toHaveLength(1) // only inside the message handler
  })
})
