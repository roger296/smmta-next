/**
 * Rendering entry point the sender calls. Section 6 placeholder: a plain
 * layout from the send's data. Section 7 replaces the body with the template
 * registry (layout, blocks, UTM links).
 */
import type { Contact } from '../services/contacts.service.js';
import type { EmailSend } from '../services/sends.service.js';

export interface RenderedEmail {
  subject: string;
  html: string;
  text: string;
}

export async function renderSend(send: EmailSend, _contact: Contact): Promise<RenderedEmail> {
  const subject = (send.data.subject as string | undefined) ?? 'CleverDeals';
  return { subject, html: `<p>${subject}</p>`, text: subject };
}
