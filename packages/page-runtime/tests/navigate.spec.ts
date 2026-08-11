import { describe, expect, it, vi } from 'vitest'
import { navigatePage } from '../src/tools/navigate.ts'

function makeContext() {
  const assign = vi.fn()
  const reload = vi.fn()
  const back = vi.fn()
  const forward = vi.fn()
  const win = {
    location: { origin: 'http://127.0.0.1:5173', href: 'http://127.0.0.1:5173/', assign, reload },
    history: { back, forward },
  } as unknown as Window
  return {
    win,
    assign,
    reload,
    back,
    forward,
    navigate: (args: Record<string, unknown>) =>
      navigatePage({ win, args: args as never }),
  }
}

describe('navigate page', () => {
  it('navigates to a same-origin URL', () => {
    const { navigate, assign } = makeContext()
    const result = navigate({ url: 'http://127.0.0.1:5173/app' })
    expect(assign).toHaveBeenCalledWith('http://127.0.0.1:5173/app')
    expect(result).toEqual({ url: 'http://127.0.0.1:5173/app' })
  })

  it('rejects a cross-origin URL BEFORE navigation', () => {
    const { navigate, assign } = makeContext()
    expect(() => navigate({ url: 'https://other.example/' }))
      .toThrowError(/navigation_requires_confirmation/)
    expect(assign).not.toHaveBeenCalled()
  })

  it('rejects a scheme-less or malformed URL before navigation', () => {
    const { navigate, assign } = makeContext()
    expect(() => navigate({ url: 'javascript:alert(1)' })).toThrow()
    expect(assign).not.toHaveBeenCalled()
  })

  it('goes back and forward through history', () => {
    const { navigate, back, forward } = makeContext()
    navigate({ history: 'back' })
    expect(back).toHaveBeenCalledOnce()
    navigate({ history: 'forward' })
    expect(forward).toHaveBeenCalledOnce()
  })

  it('reloads the page', () => {
    const { navigate, reload } = makeContext()
    navigate({ reload: true })
    expect(reload).toHaveBeenCalledOnce()
  })

  it('requires exactly one of url/history/reload', () => {
    const { navigate, assign, back } = makeContext()
    expect(() => navigate({})).toThrow()
    expect(() => navigate({ url: 'http://127.0.0.1:5173/x', history: 'back' })).toThrow()
    expect(assign).not.toHaveBeenCalled()
    expect(back).not.toHaveBeenCalled()
  })
})
