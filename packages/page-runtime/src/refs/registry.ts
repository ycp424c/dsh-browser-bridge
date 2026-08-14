/**
 * Generation-bound element references. Each reference maps one element to
 * the generation that captured it; resolution checks the reference format,
 * the current generation, `element.isConnected`, and the same Document.
 * HMR, navigation, DOM replacement, and dispose clear every record so a
 * stale reference is never guessed at.
 */
import { newElementRef, type ElementRef } from '@ycp424c/dsh-browser-bridge-protocol'
import { bridgeFailure } from '../tools/dispatcher.ts'

const REF_PATTERN = /^[A-Za-z0-9_-]{16,64}$/

interface RefRecord {
  element: Element
  generation: number
}

export class ElementRegistry {
  private readonly records = new Map<string, RefRecord>()
  /** One stable ref per element within a generation. */
  private readonly byElement = new WeakMap<Element, ElementRef>()

  /** Capture one element for one generation; returns a fresh random ref. */
  capture(element: Element, generation: number): ElementRef {
    const existing = this.byElement.get(element)
    if (existing !== undefined) {
      const record = this.records.get(existing)
      if (record !== undefined && record.generation === generation) return existing
    }
    const ref = newElementRef()
    this.records.set(ref, { element, generation })
    this.byElement.set(element, ref)
    return ref
  }

  /**
   * Resolve one reference for one generation, or throw a stable
   * `stale_element` bridge error. Never guesses at similar elements.
   */
  resolve(ref: string, generation: number): Element {
    if (!REF_PATTERN.test(ref)) {
      bridgeFailure('stale_element', 'element reference is malformed')
    }
    const record = this.records.get(ref)
    if (record === undefined) {
      bridgeFailure('stale_element', 'element reference is unknown')
    }
    if (record.generation !== generation) {
      bridgeFailure('stale_element', 'element reference belongs to another generation')
    }
    if (!record.element.isConnected) {
      bridgeFailure('stale_element', 'element is no longer connected')
    }
    if (record.element.ownerDocument !== this.mainDocument()) {
      bridgeFailure('stale_element', 'element belongs to another document')
    }
    return record.element
  }

  /** The main document all references must belong to. */
  private mainDocument(): Document {
    return typeof document !== 'undefined' ? document : new Document()
  }

  /** Invalidate every reference (HMR, navigation, disconnect). */
  clear(): void {
    this.records.clear()
  }

  /** Terminal: drop every record and reference mapping. */
  dispose(): void {
    this.records.clear()
  }
}
