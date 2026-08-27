import type { NotificationInput, NotifierPort } from '../../ports/notifier.js';

export class FakeNotifier implements NotifierPort {
  readonly name = 'fake';
  readonly sent: NotificationInput[] = [];

  constructor(private readonly onNotify?: (input: NotificationInput) => void) {}

  async notify(input: NotificationInput): Promise<void> {
    this.sent.push(input);
    this.onNotify?.(input);
  }
}
