import type { NotificationInput, NotifierPort } from '../../core/ports/index';

export class FakeNotifier implements NotifierPort {
  readonly name = 'fake';
  readonly sent: NotificationInput[] = [];

  async notify(input: NotificationInput): Promise<void> {
    this.sent.push(input);
  }
}
