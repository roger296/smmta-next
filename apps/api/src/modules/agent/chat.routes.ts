/**
 * Sales-agent chat route (SPEC F5, §14). Storefront-api-key gated. Start a
 * session, then POST messages; the reply streams over Server-Sent Events. The
 * loop is token-atomic here (one `message` event per turn); token-level
 * streaming is a thin future enhancement (logged in BUILD_LOG).
 */
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { apiKeyAuth } from '../../shared/middleware/api-key.js';
import { LlmUnavailableError } from '../../integrations/openrouter/index.js';
import { AgentService } from './agent.service.js';

const agent = new AgentService();

export async function chatRoutes(app: FastifyInstance) {
  app.addHook('preHandler', apiKeyAuth(['storefront:write']));

  app.post('/storefront/chat/sessions', async (request, reply) => {
    const body = z.object({ userId: z.string().uuid().optional() }).parse(request.body ?? {});
    const session = await agent.startSession(body.userId);
    return reply.status(201).send({ success: true, data: session });
  });

  app.post('/storefront/chat/message', async (request, reply) => {
    const { sessionId, message } = z
      .object({ sessionId: z.string().uuid(), message: z.string().min(1).max(4000) })
      .parse(request.body);

    reply.raw.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    });
    try {
      const result = await agent.runTurn(sessionId, message);
      reply.raw.write(
        `event: message\ndata: ${JSON.stringify({
          content: result.content,
          basket: result.basket,
          windDown: result.windDown ?? null,
        })}\n\n`,
      );
      reply.raw.write('event: done\ndata: {}\n\n');
    } catch (err) {
      request.log.error({ err, sessionId }, 'chat turn failed');
      const payload = summariseChatError(err);
      reply.raw.write(`event: error\ndata: ${JSON.stringify(payload)}\n\n`);
    }
    reply.raw.end();
  });
}

/**
 * Turn an internal exception into a payload the storefront can render
 * verbatim. The API's error frame is proxied through unchanged so the
 * customer sees `message` immediately — the storefront doesn't need to
 * know about our internal error taxonomy.
 *
 * `detail` is intentionally truncated: enough to distinguish common
 * failure modes when a customer reports "the chat said X" without
 * dumping stack traces or leaking connection strings. Only surfaced
 * from our own thrown errors (never user-typed content echoed back).
 */
function summariseChatError(err: unknown): {
  error: string;
  message: string;
  detail?: string;
} {
  if (err instanceof LlmUnavailableError) {
    // Operator-facing misconfiguration, not a customer-facing bug. Say
    // the assistant is off rather than implying the customer's question
    // broke something — and keep the detail so /admin and the browser
    // console name the missing variable directly.
    return {
      error: 'unavailable',
      message:
        'The assistant is offline at the moment. Please email sales@cleverdeals.net and we’ll help directly.',
      detail: 'OPENROUTER_API_KEY not configured',
    };
  }
  const raw = err instanceof Error ? err.message : String(err);
  if (raw === 'session not found') {
    return {
      error: 'session_expired',
      message: "That chat session isn't valid any more — refresh the page to start a new one.",
    };
  }
  return {
    error: 'internal',
    message: 'Something went wrong on our end. Please try again in a moment.',
    // Wide enough to carry an AllModelsFailedError listing every
    // candidate and its reason — the whole point of that error is
    // that a truncated list hides which model actually broke.
    detail: raw.slice(0, 400),
  };
}
