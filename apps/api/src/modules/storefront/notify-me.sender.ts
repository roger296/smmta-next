/**
 * Back-in-stock emails are sent by the email system (modules/email,
 * GateNotifyMeSender): the gate decides, and the shared sender delivers.
 * Until the email build this file held an HTTP sender that posted each
 * notice to the storefront's internal email route; that route is no longer
 * called by the API.
 */
import type { NotifyMeSender, NotifyMeSendPayload } from './notify-me.service.js';

/**
 * Test/dev sender that records calls instead of making HTTP requests.
 * Used by the GRN trigger tests so we don't have to spin up the
 * storefront just to assert "yes, a send was attempted".
 */
export class InMemoryNotifyMeSender implements NotifyMeSender {
  public readonly sent: NotifyMeSendPayload[] = [];
  public failNext = false;

  async send(payload: NotifyMeSendPayload): Promise<void> {
    if (this.failNext) {
      this.failNext = false;
      throw new Error('simulated send failure');
    }
    this.sent.push(payload);
  }
}
