/**
 * Email-PO renderer (P7, spec §A7) — the fallback "connector" for suppliers
 * that take an emailed purchase order rather than an API call. It renders a
 * structured PO document (stored on the proposal); actually sending the email
 * is a deploy/go-live concern (P24). During the build it is never sent — the
 * rendered doc is logged / stored only.
 */
export interface EmailPOLineInput {
  supplierSku: string;
  productName: string;
  qty: number;
  uom: string;
  unitCost: number;
}

export interface EmailPODoc {
  to: string | null;
  subject: string;
  supplierName: string;
  siteName: string;
  lines: Array<EmailPOLineInput & { lineTotal: number }>;
  total: number;
  body: string;
}

export function renderEmailPO(input: {
  supplierName: string;
  orderEmail: string | null;
  siteName: string;
  lines: EmailPOLineInput[];
}): EmailPODoc {
  const lines = input.lines.map((l) => ({
    ...l,
    lineTotal: Math.round(l.qty * l.unitCost * 100) / 100,
  }));
  const total = Math.round(lines.reduce((s, l) => s + l.lineTotal, 0) * 100) / 100;
  const subject = `Purchase order — ${input.supplierName} (deliver to ${input.siteName})`;
  const lineText = lines
    .map(
      (l) =>
        `  ${l.qty} × ${l.uom}  ${l.productName}` +
        (l.supplierSku ? ` [${l.supplierSku}]` : '') +
        `  @ ${l.unitCost.toFixed(2)} = ${l.lineTotal.toFixed(2)}`,
    )
    .join('\n');
  const body =
    `Dear ${input.supplierName},\n\n` +
    `Please supply the following to ${input.siteName}:\n\n` +
    `${lineText}\n\n` +
    `Order total: ${total.toFixed(2)}\n\n` +
    `Many thanks,\nBig Bakes`;
  return { to: input.orderEmail, subject, supplierName: input.supplierName, siteName: input.siteName, lines, total, body };
}
