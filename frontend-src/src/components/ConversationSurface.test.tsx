import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { ConversationTool } from './ConversationSurface'
describe('shared conversation tool disclosure',()=>{
  it('exposes a real keyboard button and preserves details when folded',()=>{
    render(<ConversationTool label="读取文稿" result="原始工具结果"/>)
    const button=screen.getByRole('button',{name:'读取文稿 已完成'})
    expect(button).toHaveAttribute('aria-expanded','false')
    fireEvent.click(button)
    expect(button).toHaveAttribute('aria-expanded','true')
    expect(screen.getByText('原始工具结果')).toBeInTheDocument()
    fireEvent.click(button)
    expect(button).toHaveAttribute('aria-expanded','false')
  })
})
