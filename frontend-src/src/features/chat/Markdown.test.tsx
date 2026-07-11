import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { Markdown } from './Markdown'

describe('Markdown', () => {
  it('renders GFM and LaTeX while keeping raw HTML inert', () => {
    const { container } = render(<Markdown>{'**加粗** $x^2$ <script>window.pwned=true</script>'}</Markdown>)
    expect(screen.getByText('加粗').tagName).toBe('STRONG')
    expect(container.querySelector('.katex')).toBeInTheDocument()
    expect(container.querySelector('script')).not.toBeInTheDocument()
    expect(window).not.toHaveProperty('pwned')
  })
})
