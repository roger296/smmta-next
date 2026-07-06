/**
 * Approval-queue admin routes (SPEC §17). JWT-gated. The admin SPA (apps/web)
 * mobile-first screens consume these; the SPA UI is deferred to the broader
 * admin-frontend pass (logged in BUILD_LOG entry 10).
 */
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requireAuth } from '../../shared/middleware/auth.js';
import { ApprovalQueueService, IllegalTransitionError } from './approval.service.js';

const queue = new ApprovalQueueService();

export async function approvalRoutes(app: FastifyInstance) {
  app.addHook('preHandler', requireAuth);

  app.get('/admin/queue', async () => ({ success: true, data: await queue.listQueue() }));

  app.get('/admin/queue/drafts/:id', async (request, reply) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
    const detail = await queue.getDraftDetail(id);
    if (!detail) return reply.status(404).send({ success: false, error: 'not found' });
    return { success: true, data: detail };
  });

  const wrap = async (reply: import('fastify').FastifyReply, fn: () => Promise<void>) => {
    try {
      await fn();
      return reply.send({ success: true });
    } catch (err) {
      if (err instanceof IllegalTransitionError) {
        return reply.status(409).send({ success: false, error: err.message });
      }
      throw err;
    }
  };

  app.post('/admin/queue/drafts/:id/approve', async (request, reply) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
    return wrap(reply, () => queue.approve(id));
  });

  app.post('/admin/queue/drafts/:id/edit-approve', async (request, reply) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
    const { subject, body } = z.object({ subject: z.string().min(1), body: z.string().min(1) }).parse(request.body);
    return wrap(reply, () => queue.editThenApprove(id, subject, body));
  });

  app.post('/admin/queue/drafts/:id/reject', async (request, reply) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
    const { reason } = z
      .object({ reason: z.enum(['wrong_facts', 'wrong_tone', 'should_not_send', 'other']) })
      .parse(request.body);
    return wrap(reply, () => queue.reject(id, reason));
  });

  app.get('/admin/queue/groups/:groupKey', async (request, reply) => {
    const { groupKey } = z.object({ groupKey: z.string() }).parse(request.params);
    return reply.send({ success: true, data: await queue.getGroup(groupKey) });
  });

  app.post('/admin/queue/groups/:groupKey/approve', async (request, reply) => {
    const { groupKey } = z.object({ groupKey: z.string() }).parse(request.params);
    const count = await queue.approveGroup(groupKey);
    return reply.send({ success: true, data: { approved: count } });
  });

  app.post('/admin/escalations/:id/resolve', async (request, reply) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
    await queue.resolveEscalation(id);
    return reply.send({ success: true });
  });

  app.get('/admin/agent-config', async () => ({ success: true, data: await queue.listAgentConfig() }));

  app.get('/admin/agent-config/:templateKey/graduation', async (request, reply) => {
    const { templateKey } = z.object({ templateKey: z.string() }).parse(request.params);
    return reply.send({ success: true, data: await queue.graduationStats(templateKey) });
  });

  app.post('/admin/agent-config/:templateKey/auto-send', async (request, reply) => {
    const { templateKey } = z.object({ templateKey: z.string() }).parse(request.params);
    const { enabled } = z.object({ enabled: z.boolean() }).parse(request.body);
    await queue.setAutoSend(templateKey, enabled);
    return reply.send({ success: true });
  });
}
