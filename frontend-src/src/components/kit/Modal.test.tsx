import { fireEvent, render, screen } from '@testing-library/react'
import { useState } from 'react'
import { describe, expect, it, vi } from 'vitest'
import { Modal } from './Modal'

describe('overlay focus ownership', () => {
  it('skips inert controls while a native picker owns the background', () => {
    render(<Modal title="picker" onClose={()=>{}}><div inert><button>unavailable</button></div><button>cancel native</button></Modal>)
    screen.getByRole('dialog').focus()
    fireEvent.keyDown(document,{key:'Tab'})
    expect(document.activeElement).toBe(screen.getByRole('button',{name:'cancel native'}))
  })

  it('closes only the top overlay and returns focus to its parent', () => {
    const closeParent = vi.fn()
    function Stack() {
      const [child, setChild] = useState(false)
      return <Modal title="parent" onClose={closeParent}><button onClick={() => setChild(true)}>open child</button>{child && <Modal title="child" onClose={() => setChild(false)}><button>child action</button></Modal>}</Modal>
    }
    render(<Stack />)
    fireEvent.click(screen.getByRole('button', { name: 'open child' }))
    const action = screen.getByRole('button', { name: 'child action' })
    action.focus()
    expect(document.activeElement).toBe(action)
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(screen.queryByRole('dialog', { name: 'child' })).toBeNull()
    expect(closeParent).not.toHaveBeenCalled()
    expect(screen.getByRole('dialog', { name: 'parent' }).contains(document.activeElement)).toBe(true)
  })

  it('does not close the overlay when Escape belongs to IME composition', () => {
    const close = vi.fn()
    render(<Modal title="input" onClose={close}><input /></Modal>)
    fireEvent.keyDown(document, { key: 'Escape', isComposing: true })
    fireEvent.keyDown(document, { key: 'Escape', keyCode: 229 })
    expect(close).not.toHaveBeenCalled()
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(close).toHaveBeenCalledOnce()
  })
})
