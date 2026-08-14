/**
 * Generation-bound element reference registry. References are short-lived:
 * a main-frame document navigation clears the whole registry, and resolving
 * a ref from another generation fails with `stale_element`.
 */
import { bridgeError, newElementRef, type ElementRef as ElementRefBrand } from '@ycp424c/dsh-browser-bridge-protocol'

export interface NodeRecord {
  ref: ElementRefBrand
  backendNodeId: number
  frameId: string
  generation: number
}

export interface NodeRegistryOptions {
  randomId?: () => ElementRefBrand
}

export class NodeRegistry {
  private readonly randomId: () => ElementRefBrand
  private readonly records = new Map<string, NodeRecord>()

  constructor(options: NodeRegistryOptions = {}) {
    this.randomId = options.randomId ?? newElementRef
  }

  /** Register a backend node and mint a fresh reference for this generation. */
  register(backendNodeId: number, frameId: string, generation: number): ElementRefBrand {
    const ref = this.randomId()
    this.records.set(ref, { ref, backendNodeId, frameId, generation })
    return ref
  }

  /** Resolve a reference of the CURRENT generation or fail stale. */
  resolve(ref: string, generation: number): NodeRecord {
    const record = this.records.get(ref)
    if (record === undefined || record.generation !== generation) {
      throw bridgeError('stale_element', 'element reference is stale; observe the page again', false)
    }
    return record
  }

  /** Drop every reference (main-frame document navigation). */
  clear(): void {
    this.records.clear()
  }
}
