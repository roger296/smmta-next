/**
 * Operator-facing routes for configuring the storefront assistant.
 * JWT-gated — the storefront never calls these.
 *
 * Mounted at `/api/v1/admin/chatbot` (see `app.ts`). Backs the three
 * tabs of the admin page: store profile, prompts (with version
 * history + rollback), and the dry-run test bench.
 */
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { getAuthUser, requireAuth } from '../../shared/middleware/auth.js';
import { CHAT_CATEGORIES, KB_DOCUMENT_SLUGS, type ChatCategory } from '../../db/schema/index.js';
import { ChatbotConfigService } from './chatbot-config.service.js';
import { DEFAULT_SPECIALISTS } from './default-prompts.js';
import { AgentService } from './agent.service.js';
import { KbService } from './kb.service.js';

const config = new ChatbotConfigService();
const agent = new AgentService();
const kb = new KbService();

const profileSchema = z.object({
  storeName: z.string().min(1).max(120).optional(),
  productKind: z.string().min(1).max(120).optional(),
  offtopicRefusal: z.string().min(1).max(2000).optional(),
  escalationEmail: z.string().email().optional(),
});

const specialistSchema = z.object({
  systemPrompt: z.string().max(20_000).optional(),
  modelOverride: z.string().max(120).nullable().optional(),
  enabled: z.boolean().optional(),
});

const categorySchema = z.enum(CHAT_CATEGORIES);

/** Which categories are answered by a model vs by fixed copy. The
 *  admin UI greys out the prompt editor for rule-based ones. */
const LLM_BACKED = new Set(
  DEFAULT_SPECIALISTS.filter((d) => d.llmBacked).map((d) => d.category),
);

export async function chatbotAdminRoutes(app: FastifyInstance) {
  app.addHook('preHandler', requireAuth);

  // GET /admin/chatbot — the whole resolved config, for all three tabs.
  app.get('/admin/chatbot', async () => {
    const cfg = await config.get();
    return {
      success: true,
      data: {
        profile: {
          storeName: cfg.storeName,
          productKind: cfg.productKind,
          offtopicRefusal: cfg.offtopicRefusal,
          escalationEmail: cfg.escalationEmail,
        },
        classifierPrompt: cfg.classifierPrompt,
        specialists: [...cfg.specialists.values()].map((s) => ({
          ...s,
          llmBacked: LLM_BACKED.has(s.category),
        })),
      },
    };
  });

  // PATCH /admin/chatbot/profile — store name, product kind, refusal copy.
  app.patch('/admin/chatbot/profile', async (request, reply) => {
    const user = getAuthUser(request);
    const patch = profileSchema.parse(request.body);
    const cfg = await config.updateProfile(patch, user.userId);
    return reply.send({ success: true, data: { profile: {
      storeName: cfg.storeName,
      productKind: cfg.productKind,
      offtopicRefusal: cfg.offtopicRefusal,
      escalationEmail: cfg.escalationEmail,
    } } });
  });

  // PUT /admin/chatbot/classifier — save the classifier prompt.
  app.put('/admin/chatbot/classifier', async (request, reply) => {
    const user = getAuthUser(request);
    const { body } = z.object({ body: z.string().min(1).max(20_000) }).parse(request.body);
    const cfg = await config.updateClassifierPrompt(body, user.userId);
    return reply.send({ success: true, data: { classifierPrompt: cfg.classifierPrompt } });
  });

  // PUT /admin/chatbot/specialists/:category — save one specialist.
  app.put('/admin/chatbot/specialists/:category', async (request, reply) => {
    const user = getAuthUser(request);
    const { category } = z.object({ category: categorySchema }).parse(request.params);
    const patch = specialistSchema.parse(request.body);
    const cfg = await config.updateSpecialist(category as ChatCategory, patch, user.userId);
    const updated = cfg.specialists.get(category as ChatCategory);
    return reply.send({ success: true, data: updated });
  });

  // GET /admin/chatbot/versions/:target — history for the rollback picker.
  // target is 'classifier' or 'specialist:<category>'.
  app.get('/admin/chatbot/versions/:target', async (request) => {
    const { target } = z.object({ target: z.string().min(1).max(64) }).parse(request.params);
    const rows = await config.listVersions(target);
    return { success: true, data: rows };
  });

  // GET /admin/chatbot/kb — knowledge-base documents (seeded on first read).
  app.get('/admin/chatbot/kb', async () => {
    const docs = await kb.list();
    return { success: true, data: docs };
  });

  // PUT /admin/chatbot/kb/:slug — save markdown and re-chunk.
  app.put('/admin/chatbot/kb/:slug', async (request, reply) => {
    const user = getAuthUser(request);
    const { slug } = z.object({ slug: z.enum(KB_DOCUMENT_SLUGS) }).parse(request.params);
    const { markdown, title } = z
      .object({ markdown: z.string().max(200_000), title: z.string().min(1).max(200).optional() })
      .parse(request.body);
    const doc = await kb.save(slug, markdown, title, user.userId);
    return reply.send({ success: true, data: doc });
  });

  // POST /admin/chatbot/kb/search — try a retrieval without a chat turn.
  // Lets an operator check that an edit is actually findable before
  // trusting the assistant to find it.
  app.post('/admin/chatbot/kb/search', async (request, reply) => {
    const { query } = z.object({ query: z.string().min(1).max(500) }).parse(request.body);
    const hits = await kb.search(query);
    return reply.send({ success: true, data: hits });
  });

  // POST /admin/chatbot/test — dry-run one message through the pipeline.
  //
  // Runs against a throwaway session so nothing persists to the real
  // chat history, no basket is mutated, and no escalation email fires.
  // Returns each stage's output so the operator can see where a bad
  // answer came from.
  app.post('/admin/chatbot/test', async (request, reply) => {
    const { message } = z
      .object({ message: z.string().min(1).max(4000) })
      .parse(request.body);

    const started = Date.now();
    try {
      const result = await agent.dryRun(message);
      return reply.send({
        success: true,
        data: { ...result, totalLatencyMs: Date.now() - started },
      });
    } catch (err) {
      // The bench reports failures rather than 500ing — a prompt that
      // makes the model throw is exactly what the operator is here to
      // find out about.
      return reply.send({
        success: true,
        data: {
          failed: true,
          error: err instanceof Error ? err.message : String(err),
          totalLatencyMs: Date.now() - started,
        },
      });
    }
  });
}
