/**
 * POST /api/chat/message — proxy a turn to the sales agent and stream the SSE
 * reply straight back to the browser (api-key stays server-side).
 */
import { type NextRequest } from 'next/server';
import { z } from 'zod';
import { getEnv } from '@/lib/env';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const bodySchema = z.object({
  sessionId: z.string().uuid(),
  message: z.string().min(1).max(4000),
});

export async function POST(request: NextRequest) {
  const env = getEnv();
  if (!env.SMMTA_API_KEY) {
    return new Response('event: error\ndata: {"error":"unavailable"}\n\n', {
      status: 503,
      headers: { 'Content-Type': 'text/event-stream' },
    });
  }
  const parsed = bodySchema.safeParse(await request.json().catch(() => ({})));
  if (!parsed.success) {
    return new Response('event: error\ndata: {"error":"bad_request"}\n\n', {
      status: 400,
      headers: { 'Content-Type': 'text/event-stream' },
    });
  }

  const base = env.SMMTA_API_BASE_URL.replace(/\/$/, '');
  const upstream = await fetch(`${base}/storefront/chat/message`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${env.SMMTA_API_KEY}` },
    body: JSON.stringify(parsed.data),
  });

  // Pipe the upstream event-stream through unchanged.
  return new Response(upstream.body, {
    status: upstream.status,
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
    },
  });
}
