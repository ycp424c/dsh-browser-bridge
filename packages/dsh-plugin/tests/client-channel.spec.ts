// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest'
import { ExtensionChannel, channelFromWindow, type ExtensionChannelEnv } from '../src/client/extension-channel.ts'

const EXT = 'chrome-extension://abcdefghijklmnopabcdefghijklmnop'

interface TestEnv {
  env: ExtensionChannelEnv
  sent: Array<{ message: unknown; target: string }>
  handler: ((event: MessageEvent) => void) | null
  deliver(event: MessageEvent): void
}

function makeEnv(overrides: Partial<ExtensionChannelEnv> = {}): TestEnv {
  const sent: Array<{ message: unknown; target: string }> = []
  let handler: ((event: MessageEvent) => void) | null = null
  const env: ExtensionChannelEnv = {
    referrer: `${EXT}/sidepanel.html`,
    parent: {},
    addMessageListener: (listener: (event: MessageEvent) => void) => { handler = listener },
    removeMessageListener: vi.fn(() => { handler = null }),
    postToParent: (message: unknown, target: string) => { sent.push({ message, target }) },
    ...overrides,
  }
  return {
    env,
    sent,
    get handler() { return handler },
    deliver(event) { handler?.(event) },
  }
}

function replyEvent(requestId: string, value: unknown, source: object): MessageEvent {
  return {
    source,
    origin: EXT,
    data: { type: 'panel.reply', requestId, ok: true, value },
  } as unknown as MessageEvent
}

describe('extension channel', () => {
  it('derives the extension origin from the parent referrer', () => {
    const { env } = makeEnv()
    const channel = new ExtensionChannel(env)
    expect(channel.extensionOrigin).toBe(EXT)
  })

  it('rejects a non-extension parent', () => {
    const { env } = makeEnv({ referrer: 'https://example.com/page' })
    expect(() => new ExtensionChannel(env)).toThrow(/chrome-extension/)
    expect(() => channelFromWindow(window)).toThrow(/chrome-extension/)
  })

  it('posts requests to the exact parent origin', async () => {
    const { env, sent } = makeEnv()
    const channel = new ExtensionChannel(env)
    void channel.request('tabs.list', {})
    expect(sent).toHaveLength(1)
    const { message, target } = sent[0]!
    expect(target).toBe(EXT)
    expect(message).toMatchObject({ type: 'tabs.list' })
    expect((message as { requestId: string }).requestId).toMatch(/^[A-Za-z0-9_-]{32,64}$/)
  })

  it('resolves a request from a matching reply', async () => {
    const { env, sent, deliver } = makeEnv()
    const channel = new ExtensionChannel(env)
    const pending = channel.request<Array<{ tabId: number }>>('tabs.list', {})
    const request = sent[0]!.message as { requestId: string }
    deliver(replyEvent(request.requestId, [{ tabId: 7 }], env.parent))
    await expect(pending).resolves.toEqual([{ tabId: 7 }])
  })

  it('ignores replies from the wrong origin or source', async () => {
    const { env, sent, deliver } = makeEnv()
    const channel = new ExtensionChannel(env, { timeoutMs: 5 })
    const pending = channel.request('tabs.list', {})
    const request = sent[0]!.message as { requestId: string }
    deliver({
      source: undefined,
      origin: 'https://evil.example',
      data: { type: 'panel.reply', requestId: request.requestId, ok: true, value: [1] },
    } as unknown as MessageEvent)
    deliver({
      source: {},
      origin: EXT,
      data: { type: 'panel.reply', requestId: request.requestId, ok: true, value: [2] },
    } as unknown as MessageEvent)
    // Neither reply was accepted; the request times out instead.
    await expect(pending).rejects.toMatchObject({ code: 'timeout' })
  })

  it('rejects with the bridge error when the reply carries an error', async () => {
    const { env, sent, deliver } = makeEnv()
    const channel = new ExtensionChannel(env)
    const pending = channel.request('grant.create', {})
    const request = sent[0]!.message as { requestId: string }
    deliver({
      source: env.parent,
      origin: EXT,
      data: { type: 'panel.reply', requestId: request.requestId, ok: false, error: { code: 'tab_closed', message: 'gone', retryable: false } },
    } as unknown as MessageEvent)
    await expect(pending).rejects.toMatchObject({ code: 'tab_closed' })
  })

  it('times out requests and supports abort', async () => {
    const { env } = makeEnv()
    const channel = new ExtensionChannel(env, { timeoutMs: 5 })
    await expect(channel.request('tabs.list', {})).rejects.toMatchObject({ code: 'timeout' })

    const controller = new AbortController()
    const pending = channel.request('tabs.list', {}, controller.signal)
    controller.abort()
    await expect(pending).rejects.toMatchObject({ code: 'bridge_disconnected' })
  })

  it('forwards unsolicited parent messages to subscribers', () => {
    const { env, deliver } = makeEnv()
    const channel = new ExtensionChannel(env)
    const received: unknown[] = []
    const off = channel.onParentMessage(message => received.push(message))
    const event = {
      source: env.parent,
      origin: EXT,
      data: { type: 'bridge.pairing-required' },
    } as unknown as MessageEvent
    deliver(event)
    expect(received).toEqual([{ type: 'bridge.pairing-required' }])
    off()
    deliver(event)
    expect(received).toHaveLength(1)
  })

  it('notifies the parent without expecting a reply', () => {
    const { env, sent } = makeEnv()
    const channel = new ExtensionChannel(env)
    channel.post({ type: 'bridge.client-ready' })
    expect(sent).toHaveLength(1)
    expect(sent[0]).toMatchObject({ message: { type: 'bridge.client-ready' }, target: EXT })
  })

  it('dispose removes the window listener and rejects pending and new requests', async () => {
    const { env, sent, deliver } = makeEnv()
    const channel = new ExtensionChannel(env)
    const pending = channel.request('tabs.list', {})
    channel.dispose()
    // The listener is gone: a late reply can no longer be received.
    const request = sent[0]!.message as { requestId: string }
    deliver(replyEvent(request.requestId, [{ tabId: 7 }], env.parent))
    await expect(pending).rejects.toMatchObject({ code: 'bridge_disconnected' })
    // New requests fail fast instead of leaking correlation state.
    await expect(channel.request('tabs.list', {})).rejects.toMatchObject({ code: 'bridge_disconnected' })
    channel.post({ type: 'bridge.client-ready' })
    expect(sent).toHaveLength(1)
    expect(env.removeMessageListener).toHaveBeenCalled()
  })

  it('dispose is idempotent', () => {
    const { env } = makeEnv()
    const channel = new ExtensionChannel(env)
    channel.dispose()
    channel.dispose()
    expect(env.removeMessageListener).toHaveBeenCalledTimes(1)
  })
})
