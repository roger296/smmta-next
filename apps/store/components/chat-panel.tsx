'use client';

/**
 * Floating AI sales-assistant panel (SPEC F5). Talks to the SSE agent via the
 * server proxies in app/api/chat/*. Prices/stock always come from the agent's
 * tools (server-side), never invented here. Styled with the brand tokens
 * (sharp corners, hairline borders, no shadows).
 */
import { useEffect, useRef, useState } from 'react';

interface BasketLine {
  sku: string;
  name: string | null;
  qty: number;
  unitPricePence: number;
  lineTotalPence: number;
}
interface Basket {
  lines: BasketLine[];
  totalPence: number;
}
interface ChatMessage {
  role: 'user' | 'assistant';
  content: string;
}

const gbp = (pence: number) => `£${(pence / 100).toFixed(2)}`;

export function ChatPanel() {
  const [open, setOpen] = useState(false);
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [basket, setBasket] = useState<Basket | null>(null);
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight });
  }, [messages, busy]);

  async function ensureSession(): Promise<string | null> {
    if (sessionId) return sessionId;
    try {
      const res = await fetch('/api/chat/session', { method: 'POST' });
      if (!res.ok) return null;
      const { sessionId: id } = (await res.json()) as { sessionId: string };
      setSessionId(id);
      return id;
    } catch {
      return null;
    }
  }

  async function send() {
    const text = input.trim();
    if (!text || busy) return;
    setInput('');
    setMessages((m) => [...m, { role: 'user', content: text }]);
    setBusy(true);

    const id = await ensureSession();
    if (!id) {
      setMessages((m) => [...m, { role: 'assistant', content: 'Sorry — chat is unavailable right now.' }]);
      setBusy(false);
      return;
    }

    try {
      const res = await fetch('/api/chat/message', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sessionId: id, message: text }),
      });
      if (!res.body) throw new Error('no stream');

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      // Read SSE frames: blocks separated by a blank line.
      // eslint-disable-next-line no-constant-condition
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        let idx: number;
        while ((idx = buffer.indexOf('\n\n')) !== -1) {
          const frame = buffer.slice(0, idx);
          buffer = buffer.slice(idx + 2);
          handleFrame(frame);
        }
      }
    } catch {
      setMessages((m) => [...m, { role: 'assistant', content: 'Something went wrong. Please try again.' }]);
    } finally {
      setBusy(false);
    }
  }

  function handleFrame(frame: string) {
    const eventMatch = /^event:\s*(.+)$/m.exec(frame);
    const dataMatch = /^data:\s*(.+)$/m.exec(frame);
    if (!eventMatch || !dataMatch) return;
    if (eventMatch[1] === 'message') {
      try {
        const payload = JSON.parse(dataMatch[1]) as { content?: string; basket?: Basket };
        if (payload.content) setMessages((m) => [...m, { role: 'assistant', content: payload.content! }]);
        if (payload.basket) setBasket(payload.basket);
      } catch {
        /* ignore malformed frame */
      }
    }
  }

  const border = '1px solid var(--brand-border, #C7CCD1)';
  const accent = 'var(--brand-accent, #3B5266)';

  return (
    <>
      {!open && (
        <button
          onClick={() => setOpen(true)}
          aria-label="Open filament assistant"
          // Positioned bottom-right. On narrow viewports (<640px) the
          // pill would otherwise overlap primary CTAs — the full-width
          // "Proceed to checkout" bar on /cart, the price-slider label
          // on /shop — so we shrink to a short "Ask" label with tight
          // padding that only clips the corner of those controls, not
          // their text.
          className="fixed right-2 bottom-2 z-50 rounded-none border-none px-3 py-2 text-xs font-semibold text-white cursor-pointer sm:right-5 sm:bottom-5 sm:px-[18px] sm:py-3 sm:text-sm"
          style={{
            background: accent,
          }}
        >
          <span className="sm:hidden">Ask</span>
          <span className="hidden sm:inline">Ask about filament</span>
        </button>
      )}

      {open && (
        <div
          style={{
            position: 'fixed',
            right: 20,
            bottom: 20,
            zIndex: 50,
            width: 'min(380px, calc(100vw - 40px))',
            height: 'min(560px, calc(100vh - 40px))',
            display: 'flex',
            flexDirection: 'column',
            background: 'var(--brand-bone, #F5F4F0)',
            color: 'var(--brand-ink, #15161A)',
            border,
            borderRadius: 0,
          }}
        >
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '10px 14px', borderBottom: border }}>
            <strong style={{ fontSize: 14 }}>Filament assistant</strong>
            <button onClick={() => setOpen(false)} aria-label="Close" style={{ background: 'none', border: 'none', fontSize: 18, cursor: 'pointer', color: 'inherit' }}>
              ×
            </button>
          </div>

          <div ref={scrollRef} style={{ flex: 1, overflowY: 'auto', padding: 14, display: 'flex', flexDirection: 'column', gap: 10 }}>
            {messages.length === 0 && (
              <p style={{ color: 'var(--brand-muted, #6B6E76)', fontSize: 14 }}>
                Hi! Tell me what you print and I&apos;ll help you find the right filament — including pre-order deals on
                stock that&apos;s on its way.
              </p>
            )}
            {messages.map((m, i) => (
              <div
                key={i}
                style={{
                  alignSelf: m.role === 'user' ? 'flex-end' : 'flex-start',
                  maxWidth: '85%',
                  padding: '8px 10px',
                  fontSize: 14,
                  background: m.role === 'user' ? 'var(--brand-accent-ice, #B4C6D2)' : 'var(--brand-paper, #ECECE8)',
                  border,
                }}
              >
                {m.content}
              </div>
            ))}
            {busy && <div style={{ color: 'var(--brand-muted, #6B6E76)', fontSize: 13 }}>…thinking</div>}
          </div>

          {basket && basket.lines.length > 0 && (
            <div style={{ borderTop: border, padding: '8px 14px', fontSize: 13 }}>
              {basket.lines.map((l) => (
                <div key={l.sku} style={{ display: 'flex', justifyContent: 'space-between' }}>
                  <span>
                    {l.qty}× {l.name ?? l.sku}
                  </span>
                  <span>{gbp(l.lineTotalPence)}</span>
                </div>
              ))}
              <div style={{ display: 'flex', justifyContent: 'space-between', fontWeight: 700, marginTop: 4 }}>
                <span>Basket total</span>
                <span>{gbp(basket.totalPence)}</span>
              </div>
            </div>
          )}

          <form
            onSubmit={(e) => {
              e.preventDefault();
              void send();
            }}
            style={{ display: 'flex', gap: 8, padding: 10, borderTop: border }}
          >
            <input
              value={input}
              onChange={(e) => setInput(e.target.value)}
              placeholder="e.g. matte black PETG"
              style={{ flex: 1, padding: '8px 10px', border, borderRadius: 0, background: '#fff', color: 'inherit', fontSize: 14 }}
            />
            <button type="submit" disabled={busy} style={{ background: accent, color: '#fff', border: 'none', borderRadius: 0, padding: '0 14px', fontWeight: 600, cursor: busy ? 'default' : 'pointer' }}>
              Send
            </button>
          </form>
        </div>
      )}
    </>
  );
}
