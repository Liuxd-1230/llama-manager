import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const stylesDir = resolve(__dirname, 'styles')
const appCss = readFileSync(resolve(stylesDir, 'app.css'), 'utf8')
const baseCss = readFileSync(resolve(stylesDir, 'base.css'), 'utf8')

const LITERAL = /#[0-9a-fA-F]{3,8}\b|rgba?\(|hsl\(|%23[0-9a-fA-F]{3,6}\b/

describe('studio styles guard', () => {
  it('app.css contains no color literals', () => {
    const offending = appCss.split(/\r?\n/).map((line, i) => `${i + 1}: ${line.trim()}`).filter(line => LITERAL.test(line))
    expect(offending, `color literals found in app.css:\n${offending.join('\n')}`).toEqual([])
  })

  it('base.css color literals live only in the remap block or the escape-hatch list', () => {
    const remapStart = baseCss.indexOf('/* ===== remap')
    const remapEnd = baseCss.indexOf('\n}', remapStart)
    const hatchStart = baseCss.indexOf('/* ===== 覆盖清单')
    const hatchEnd = baseCss.indexOf('/* ===== end escape-hatch')
    expect(remapStart).toBeGreaterThanOrEqual(0)
    expect(remapEnd).toBeGreaterThan(remapStart)
    expect(hatchStart).toBeGreaterThanOrEqual(0)
    expect(hatchEnd).toBeGreaterThan(hatchStart)

    const sanctioned = [[remapStart, remapEnd + 2], [hatchStart, hatchEnd + 40]] as const
    const outside = (index: number) => !sanctioned.some(([start, end]) => index >= start && index < end)
    const offending: string[] = []
    for (const match of baseCss.matchAll(new RegExp(LITERAL.source, 'g'))) {
      if (outside(match.index ?? 0)) {
        const line = baseCss.slice(0, match.index).split(/\r?\n/).length
        offending.push(`${line}: ${match[0]}`)
      }
    }
    expect(offending, `color literals outside sanctioned blocks:\n${offending.join('\n')}`).toEqual([])
  })

  it('scrollbar styling stays scoped to studio selectors', () => {
    for (const [name, css] of [['base.css', baseCss], ['app.css', appCss]] as const) {
      const bad = css.split(/\r?\n/).map((line, i) => ({ line, no: i + 1 })).filter(({ line }) => line.trimStart().startsWith('::-webkit-scrollbar'))
      expect(bad.map(({ no }) => `${name}:${no}`), 'bare ::-webkit-scrollbar selector leaks into the host').toEqual([])
    }
  })
})
