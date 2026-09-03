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
      // The full error — including which model failed and why — stays
      // server-side. `ref` is the only part the customer sees, and it
      // ties their report back to this log line.
      const ref = errorRef();
      request.log.error({ err, sessionId, ref }, 'chat turn failed');
      const payload = summariseChatError(err, ref);
      reply.raw.write(`event: error\ndata: ${JSON.stringify(payload)}\n\n`);
    }
    reply.raw.end();
  });
}

/**
 * Turn an internal exception into a payload safe to stream to a browser.
 *
 * `detail` used to carry the truncated exception text. That leaked the
 * provider and model names — an audit found "OpenRouter failed: No
 * endpoints found for google/gemini-flash-1.5" visible to anyone with
 * devtools open, which tells a competitor exactly which provider and
 * model the store pays for.
 *
 * The diagnosis it was there for still matters, so instead of dropping
 * it we swap it for a correlation id: the full error goes to the server
 * log alongside the same id, and a customer reporting "it said ref
 * a1b2c3d4" can be matched to the exact log line in seconds.
 */
function summariseChatError(
  err: unknown,
  ref: string,
): {
  error: string;
  message: string;
  ref: string;
} {
  if (err instanceof LlmUnavailableError) {
    // Operator-facing misconfiguration, not a customer-facing bug. Say
    // the assistant is off rather than implying the customer's question
    // broke something.
    return {
      error: 'unavailable',
      message:
        'The assistant is offline at the moment. Please email sales@cleverdeals.net and we’ll help directly.',
      ref,
    };
  }
  const raw = err instanceof Error ? err.message : String(err);
  if (raw === 'session not found') {
    return {
      error: 'session_expired',
      message: "That chat session isn't valid any more — refresh the page to start a new one.",
      ref,
    };
  }
  return {
    error: 'internal',
    message: 'Something went wrong on our end. Please try again in a moment.',
    ref,
  };
}

/** Short, non-guessable id tying a customer-visible error to a log line. */
function errorRef(): string {
  return Math.random().toString(16).slice(2, 10);
}
