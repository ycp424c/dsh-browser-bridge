import type { UserMessage } from '@deepseek-ai/dsh-session'

/** Driver-independent queue for bridge admission tests; the real loop is tested separately. */
export class StubInbox {
  readonly nextTurn: UserMessage[] = []
  readonly nextStep: UserMessage[] = []

  constructor(private readonly claimed: (message: UserMessage, turn: number) => void) {}

  append(target: 'next-turn' | 'next-step', message: UserMessage): void {
    ;(target === 'next-turn' ? this.nextTurn : this.nextStep).push(message)
  }

  claim(target: 'next-turn' | 'next-step', turn: number): UserMessage[] {
    const messages = this.nextStep.splice(0)
    if (target === 'next-turn') messages.push(...this.nextTurn.splice(0, 1))
    for (const message of messages) this.claimed(message, turn)
    return messages
  }
}
