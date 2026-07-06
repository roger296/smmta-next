/**
 * Sales-agent chat route (SPEC F5, §14). Storefront-api-key gated. Start a
 * session, then POST messages; the reply streams over Server-Sent Events. The
 * loop is token-atomic here (one `message` event per turn); token-level
 * streaming is a thin future enhancement (logged in BUILD_LOG).
 */
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { apiKeyAuth } from '../../shared/middleware/api-key.js';
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
      request.log.error({ err }, 'chat turn failed');
      reply.raw.write('event: error\ndata: {"error":"internal"}\n\n');
    }
    reply.raw.end();
  });
}
