import { describe, expect, it, vi } from 'vitest'
import { ConsoleCapture } from '../src/tools/console.ts'

function makeCapture(): { console: ConsoleCapture; originals: Record<string, unknown> } {
  const capture = new ConsoleCapture({ generation: () => 1 })
  const originals = {
    log: console.log,
    info: console.info,
    warn: console.warn,
    error: console.error,
    debug: console.debug,
  }
  capture.start()
  return { console: capture, originals }
}

describe('console capture', () => {
  it('wraps console methods while preserving behavior and return values', () => {
    const logSpy = vi.fn(() => 'return-value')
    console.log = logSpy as unknown as typeof console.log
    const { console: capture } = makeCapture()
    const returned = console.log('hello')
    expect(returned).toBe('return-value')
    expect(logSpy).toHaveBeenCalledWith('hello')
    expect(capture.rows()).toContainEqual(expect.objectContaining({ level: 'log', text: 'hello', generation: 1 }))
  })

  it('captures warn and error levels with primitive-safe text', () => {
    const { console: capture } = makeCapture()
    console.warn('careful', 42)
    console.error(new Error('boom'))
    const rows = capture.rows()
    expect(rows).toContainEqual(expect.objectContaining({ level: 'warn', text: expect.stringContaining('careful') }))
    expect(rows).toContainEqual(expect.objectContaining({ level: 'error', text: expect.stringContaining('boom') }))
  })

  it('bounds the buffer at 200 rows', () => {
    const { console: capture } = makeCapture()
    for (let index = 0; index < 250; index += 1) {
      console.log(`row ${index}`)
    }
    expect(capture.rows()).toHaveLength(200)
    expect(capture.rows()[199]).toMatchObject({ text: 'row 249' })
  })

  it('captures window errors and unhandled rejections after start', () => {
    const { console: capture } = makeCapture()
    window.dispatchEvent(new ErrorEvent('error', { message: 'script exploded', error: new Error('script exploded') }))
    const rejection = new Event('unhandledrejection')
    Object.defineProperty(rejection, 'reason', { value: new Error('rejected promise') })
    window.dispatchEvent(rejection)
    const rows = capture.rows()
    expect(rows).toContainEqual(expect.objectContaining({ level: 'error', text: expect.stringContaining('script exploded') }))
    expect(rows).toContainEqual(expect.objectContaining({ level: 'error', text: expect.stringContaining('rejected promise') }))
  })

  it('masks sensitive patterns', () => {
    const { console: capture } = makeCapture()
    console.log('token=super-secret-value')
    const json = JSON.stringify(capture.rows())
    expect(json).not.toContain('super-secret-value')
  })

  it('tags rows with the current generation', () => {
    let generation = 1
    const capture = new ConsoleCapture({ generation: () => generation })
    capture.start()
    console.log('before')
    generation = 2
    console.log('after')
    const rows = capture.rows()
    expect(rows[0]).toMatchObject({ generation: 1 })
    expect(rows[1]).toMatchObject({ generation: 2 })
  })

  it('clear drops the buffer', () => {
    const { console: capture } = makeCapture()
    console.log('x')
    capture.clear()
    expect(capture.rows()).toHaveLength(0)
  })

  it('dispose restores every original method and listener', () => {
    const { console: capture, originals } = makeCapture()
    console.log('x')
    capture.dispose()
    expect(console.log).toBe(originals.log)
    expect(console.info).toBe(originals.info)
    expect(console.warn).toBe(originals.warn)
    expect(console.error).toBe(originals.error)
    expect(console.debug).toBe(originals.debug)
    console.log('after dispose')
    // Nothing after dispose is captured.
    expect(capture.rows()).toHaveLength(0)
  })

  it('never persists captured evidence anywhere', () => {
    const before = window.localStorage.length
    const { console: capture } = makeCapture()
    console.log('evidence')
    capture.clear()
    capture.dispose()
    expect(window.localStorage.length).toBe(before)
    expect(window.sessionStorage.getItem('dsh-browser-bridge:console')).toBeNull()
  })
})
