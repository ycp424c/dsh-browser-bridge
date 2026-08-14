/**
 * Evidence capture: viewport/element screenshots plus bounded console and
 * network projections. Console and network rows contain no headers, bodies,
 * cookies, or stack-local values; buffers start empty on attach and are
 * cleared on detach.
 */
import { bridgeError } from '@ycp424c/dsh-browser-bridge-protocol'
import type { ConsoleRow, NetworkRow, TabSession } from './session-manager.ts'
import { resolveNode } from './inspect.ts'

export const EVIDENCE_BUFFER_SIZE = 200

export interface ScreenshotResult {
  mimeType: 'image/png'
  data: string
  url: string
  width: number
  height: number
  generation: number
}

/** Push one row into a bounded ring buffer. */
export function pushBounded<T>(buffer: T[], row: T, capacity: number): void {
  buffer.push(row)
  if (buffer.length > capacity) buffer.splice(0, buffer.length - capacity)
}

export function consoleEntries(session: TabSession): readonly ConsoleRow[] {
  return session.consoleEntries
}

export function networkEntries(session: TabSession): readonly NetworkRow[] {
  return session.networkEntries
}

const CONSOLE_LEVELS: Record<string, ConsoleRow['level']> = {
  error: 'error',
  warning: 'warning',
  warn: 'warning',
  info: 'log',
  debug: 'log',
  log: 'log',
}

function stringifyArg(arg: unknown): string {
  if (typeof arg === 'string') return arg
  if (typeof arg === 'number' || typeof arg === 'boolean') return String(arg)
  if (arg === null) return 'null'
  if (arg === undefined) return 'undefined'
  if (typeof arg === 'object' && arg !== null && 'value' in arg) {
    const value = (arg as { value: unknown }).value
    return typeof value === 'string' ? value : String(value)
  }
  return String(arg)
}

export function normalizeConsoleEntry(
  method: string,
  params: Record<string, unknown>,
): ConsoleRow | null {
  if (method === 'Runtime.consoleAPICalled') {
    const type = String(params.type ?? 'log')
    const level = CONSOLE_LEVELS[type] ?? 'log'
    const args = Array.isArray(params.args) ? params.args : []
    const text = args.map(stringifyArg).join(' ')
    const stackTrace = params.stackTrace as { callFrames?: Array<{ url?: string }> } | undefined
    const frames = stackTrace?.callFrames
    const url = frames?.find(frame => frame.url !== undefined && frame.url !== '')?.url ?? ''
    return { timestamp: Date.now(), level, text, url }
  }
  if (method === 'Log.entryAdded') {
    const entry = (params.entry ?? {}) as {
      level?: string
      text?: string
      url?: string
      timestamp?: number
    }
    const level: ConsoleRow['level'] = entry.level === 'error' || entry.level === 'warning'
      ? entry.level
      : 'log'
    return {
      timestamp: entry.timestamp !== undefined ? entry.timestamp * 1_000 : Date.now(),
      level,
      text: entry.text ?? '',
      url: entry.url ?? '',
    }
  }
  return null
}

/**
 * In-flight request method correlation (requestWillBeSent → response/failure).
 * One map per session: request ids are only unique within a CDP target, and
 * correlation state must die with the grant that owns it.
 */
export function normalizeNetworkEntry(
  method: string,
  params: Record<string, unknown>,
  requestMethods: Map<string, string>,
): NetworkRow | null {
  if (method === 'Network.requestWillBeSent') {
    const requestId = String(params.requestId ?? '')
    const request = (params.request ?? {}) as { method?: string }
    if (request.method !== undefined) requestMethods.set(requestId, request.method)
    // Bounded correlation table: unmatched requests must not leak forever.
    if (requestMethods.size > 2_000) {
      for (const stale of requestMethods.keys()) requestMethods.delete(stale)
    }
    return null
  }
  if (method === 'Network.responseReceived') {
    const requestId = String(params.requestId ?? '')
    const response = (params.response ?? {}) as { status?: number; url?: string }
    if (response.status === undefined || response.status < 400) {
      requestMethods.delete(requestId)
      return null
    }
    const row: NetworkRow = {
      timestamp: Date.now(),
      url: response.url ?? '',
      status: response.status,
    }
    const requestMethod = requestMethods.get(requestId)
    if (requestMethod !== undefined) row.method = requestMethod
    requestMethods.delete(requestId)
    return row
  }
  if (method === 'Network.loadingFailed') {
    const requestId = String(params.requestId ?? '')
    const row: NetworkRow = {
      timestamp: Date.now(),
      url: '',
      error: String(params.errorText ?? 'unknown failure'),
    }
    const requestMethod = requestMethods.get(requestId)
    if (requestMethod !== undefined) row.method = requestMethod
    requestMethods.delete(requestId)
    return row
  }
  return null
}

export async function captureScreenshot(
  session: TabSession,
  args: { ref?: string; selector?: string },
): Promise<ScreenshotResult> {
  let clip: { x: number; y: number; width: number; height: number; scale: number } | undefined
  if (args.ref !== undefined || args.selector !== undefined) {
    const nodeId = await resolveNode(session, {
      ...(args.ref !== undefined ? { ref: args.ref } : {}),
      ...(args.selector !== undefined ? { selector: args.selector } : {}),
    })
    const box = await session.send('DOM.getBoxModel', { nodeId })
    const content = (box as { model?: { content?: number[] } }).model?.content
    if (content === undefined || content.length < 8) {
      throw bridgeError('stale_element', 'element has no layout box', false)
    }
    const x = Math.min(content[0]!, content[2]!, content[4]!, content[6]!)
    const y = Math.min(content[1]!, content[3]!, content[5]!, content[7]!)
    const width = Math.max(content[0]!, content[2]!, content[4]!, content[6]!) - x
    const height = Math.max(content[1]!, content[3]!, content[5]!, content[7]!) - y
    if (width <= 0 || height <= 0 || x < 0 || y < 0) {
      throw bridgeError('stale_element', 'element is off-document or has zero area', false)
    }
    clip = { x, y, width, height, scale: 1 }
  }
  const response = await session.send('Page.captureScreenshot', {
    format: 'png',
    fromSurface: true,
    captureBeyondViewport: false,
    ...(clip !== undefined ? { clip } : {}),
  })
  const data = (response as { data?: string }).data
  if (data === undefined) {
    throw bridgeError('internal', 'screenshot capture returned no data', false)
  }
  let width = clip?.width ?? 0
  let height = clip?.height ?? 0
  if (clip === undefined) {
    const viewport = await session.send('Runtime.evaluate', {
      expression: `({ width: innerWidth, height: innerHeight })`,
      returnByValue: true,
    }) as { result?: { value?: { width?: number; height?: number } } } | undefined
    width = viewport?.result?.value?.width ?? 0
    height = viewport?.result?.value?.height ?? 0
  }
  return {
    mimeType: 'image/png',
    data,
    url: session.currentUrl,
    width,
    height,
    generation: session.generation,
  }
}
