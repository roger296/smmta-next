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
  role: 'user' | 'assistant' | 'error';
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
  const panelRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const launcherRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight });
  }, [messages, busy]);

  // Focus management for the dialog.
  //
  // The panel had none of this: no role, no focus move, no Escape, and
  // nothing stopping Tab walking out of it into the page behind. A
  // keyboard user could open it and then have no idea where their focus
  // had gone, and no way to close it without a mouse.
  //
  // On open: focus the input (the thing you came to use). On close:
  // return focus to the launcher, so Tab order resumes where it was.
  useEffect(() => {
    if (open) {
      inputRef.current?.focus();
    } else {
      launcherRef.current?.focus();
    }
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        setOpen(false);
        return;
      }
      if (e.key !== 'Tab') return;

      // Trap Tab inside the panel while it's modal.
      const panel = panelRef.current;
      if (!panel) return;
      const focusable = panel.querySelectorAll<HTMLElement>(
        'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])',
      );
      if (focusable.length === 0) return;
      const first = focusable[0]!;
      const last = focusable[focusable.length - 1]!;
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [open]);

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
      setMessages((m) => [...m, { role: 'error', content: 'Sorry — chat is unavailable right now.' }]);
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
      setMessages((m) => [...m, { role: 'error', content: 'Something went wrong. Please try again.' }]);
    } finally {
      setBusy(false);
    }
  }

  function handleFrame(frame: string) {
    const eventMatch = /^event:\s*(.+)$/m.exec(frame);
    const dataMatch = /^data:\s*(.+)$/m.exec(frame);
    if (!eventMatch || !dataMatch) return;
    const eventName = eventMatch[1].trim();

    if (eventName === 'message') {
      try {
        const payload = JSON.parse(dataMatch[1]) as { content?: string; basket?: Basket };
        if (payload.content) setMessages((m) => [...m, { role: 'assistant', content: payload.content! }]);
        if (payload.basket) setBasket(payload.basket);
      } catch {
        /* ignore malformed frame */
      }
      return;
    }

    // Previously only 'message' was handled, so an error frame left the
    // customer staring at their own question forever with no feedback.
    // The API sends a customer-safe `message` on every error frame; fall
    // back to generic copy if the payload is malformed.
    if (eventName === 'error') {
      let text = 'Sorry — something went wrong. Please try again.';
      try {
        const payload = JSON.parse(dataMatch[1]) as { message?: string; ref?: string };
        if (payload.message) text = payload.message;
        // The server keeps the real cause in its log under this ref.
        // Showing it lets a customer quote something useful without
        // exposing which provider or model the store pays for.
        if (payload.ref) text = `${text} (ref ${payload.ref})`;
      } catch {
        /* keep the generic fallback */
      }
      setMessages((m) => [...m, { role: 'error', content: text }]);
      return;
    }
    // 'done' and any future frame types need no client state change.
  }

  return (
    <>
      {!open && (
        <button
          ref={launcherRef}
          onClick={() => setOpen(true)}
          aria-label="Open filament assistant"
          aria-haspopup="dialog"
          // Positioned bottom-right. On narrow viewports (<640px) the
          // pill would otherwise overlap primary CTAs — the full-width
          // "Proceed to checkout" bar on /cart, the price-slider label
          // on /shop — so we shrink to a short "Ask" label with tight
          // padding that only clips the corner of those controls.
          className="fixed right-2 bottom-2 z-50 min-h-11 cursor-pointer border-none bg-[var(--brand-accent)] px-3 py-2 text-xs font-semibold text-[var(--brand-paper)] sm:right-5 sm:bottom-5 sm:px-[18px] sm:py-3 sm:text-sm"
        >
          <span className="sm:hidden">Ask</span>
          <span className="hidden sm:inline">Ask about filament</span>
        </button>
      )}

      {open && (
        <div
          ref={panelRef}
          role="dialog"
          aria-modal="true"
          aria-labelledby="chat-panel-title"
          className="fixed right-2 bottom-2 z-50 flex w-[min(380px,calc(100vw-1rem))] flex-col border border-[var(--brand-border)] bg-[var(--brand-bone)] text-[var(--brand-ink)] sm:right-5 sm:bottom-5 sm:w-[min(380px,calc(100vw-2.5rem))]"
          style={{ height: 'min(560px, calc(100dvh - 1rem))' }}
        >
          <div className="flex items-center justify-between border-b border-[var(--brand-border)] px-3.5 py-2.5">
            <strong id="chat-panel-title" className="text-sm">
              Filament assistant
            </strong>
            <button
              onClick={() => setOpen(false)}
              aria-label="Close assistant"
              className="inline-flex h-11 w-11 items-center justify-center text-lg text-[var(--brand-ink)]"
            >
              ×
            </button>
          </div>

          {/*
            aria-live="polite" so a screen-reader user hears the reply
            arrive. Without it the panel updated silently and the only
            way to know an answer had come back was to go looking.
          */}
          <div
            ref={scrollRef}
            className="flex flex-1 flex-col gap-2.5 overflow-y-auto p-3.5"
            aria-live="polite"
            aria-busy={busy}
          >
            {messages.length === 0 && (
              <p className="text-sm text-[var(--brand-muted)]">
                Hi! Tell me what you print and I&apos;ll help you find the right filament —
                including pre-order deals on stock that&apos;s on its way.
              </p>
            )}
            {messages.map((m, i) => (
              <div
                key={i}
                role={m.role === 'error' ? 'alert' : undefined}
                className={
                  m.role === 'user'
                    ? 'max-w-[85%] self-end border border-[var(--brand-border)] bg-[var(--brand-accent-ice)] px-2.5 py-2 text-sm'
                    : m.role === 'error'
                      ? 'max-w-[85%] self-start border-l-2 border-[#A0523B] bg-[var(--brand-bone)] px-2.5 py-2 text-sm italic text-[var(--brand-muted)]'
                      : 'max-w-[85%] self-start border border-[var(--brand-border)] bg-[var(--brand-paper)] px-2.5 py-2 text-sm'
                }
              >
                {m.content}
              </div>
            ))}
            {busy && <div className="text-[13px] text-[var(--brand-muted)]">…thinking</div>}
          </div>

          {basket && basket.lines.length > 0 && (
            <div className="border-t border-[var(--brand-border)] px-3.5 py-2 text-[13px]">
              {basket.lines.map((l) => (
                <div key={l.sku} className="flex justify-between">
                  <span>
                    {l.qty}× {l.name ?? l.sku}
                  </span>
                  <span>{gbp(l.lineTotalPence)}</span>
                </div>
              ))}
              <div className="mt-1 flex justify-between font-bold">
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
            className="flex gap-2 border-t border-[var(--brand-border)] p-2.5"
          >
            <label htmlFor="chat-panel-input" className="sr-only">
              Ask the filament assistant a question
            </label>
            <input
              id="chat-panel-input"
              ref={inputRef}
              value={input}
              onChange={(e) => setInput(e.target.value)}
              placeholder="e.g. matte black PETG"
              autoComplete="off"
              className="min-h-11 flex-1 border border-[var(--brand-border)] bg-[var(--brand-paper)] px-2.5 text-sm text-[var(--brand-ink)] focus-visible:border-[var(--brand-ink)] focus-visible:outline-none"
            />
            <button
              type="submit"
              disabled={busy}
              className="min-h-11 border-none bg-[var(--brand-accent)] px-3.5 font-semibold text-[var(--brand-paper)] disabled:cursor-default disabled:opacity-70"
            >
              Send
            </button>
          </form>
        </div>
      )}
    </>
  );
}
