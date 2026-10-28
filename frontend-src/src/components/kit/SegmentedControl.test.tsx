import { fireEvent, render, screen } from '@testing-library/react'
import { useState } from 'react'
import { describe, expect, it } from 'vitest'
import { SegmentedControl } from './SegmentedControl'

describe('view switch keyboard contract', () => {
  it('moves focus and selection together with arrows, Home and End', () => {
    function View() {
      const [value, setValue] = useState('draft')
      return <SegmentedControl label="views" value={value} onChange={setValue} options={[{ id: 'draft', label: '成稿' }, { id: 'layout', label: '构图' }, { id: 'image', label: '出图' }]} />
    }
    render(<View />)
    const draft = screen.getByRole('button', { name: '成稿' })
    draft.focus()
    fireEvent.keyDown(draft, { key: 'ArrowRight' })
    const layout = screen.getByRole('button', { name: '构图' })
    expect(document.activeElement).toBe(layout)
    expect(layout.getAttribute('aria-pressed')).toBe('true')
    fireEvent.keyDown(layout, { key: 'End' })
    expect(document.activeElement).toBe(screen.getByRole('button', { name: '出图' }))
    fireEvent.keyDown(document.activeElement!, { key: 'Home' })
    expect(document.activeElement).toBe(draft)
  })
})
