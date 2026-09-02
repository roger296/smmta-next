/**
 * Storefront-assistant configuration hooks.
 *
 * Backs /admin/chatbot: the store profile, the classifier prompt, the
 * six specialist prompts, their version history, and the dry-run test
 * bench. Every mutation invalidates the single `chatbot-config` query
 * so all three tabs stay in step after a save.
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { apiFetch } from '@/lib/api-client';

/** Category slugs are code-defined (they pin the tool sets); only the
 *  prompt bodies are editable. Mirrors CHAT_CATEGORIES in the API. */
export const CHAT_CATEGORIES = [
  'pre_sales',
  'order_status',
  'delivery_returns',
  'product_advice',
  'commercial_offer',
  'complaint',
] as const;
export type ChatCategory = (typeof CHAT_CATEGORIES)[number];

/** Human labels + one-line descriptions for the editor headings. */
export const CATEGORY_META: Record<ChatCategory, { label: string; blurb: string }> = {
  pre_sales: {
    label: 'Pre-sales',
    blurb: 'Choosing a product, availability, prices, building a basket.',
  },
  order_status: {
    label: 'Order status',
    blurb: 'Where is my order — account lookup, or order number plus email.',
  },
  delivery_returns: {
    label: 'Delivery & returns',
    blurb: 'Shipping times, costs, the returns policy. Answers from the knowledge base only.',
  },
  product_advice: {
    label: 'Product advice',
    blurb: 'How to use what you sell — settings, care, sizing, troubleshooting.',
  },
  commercial_offer: {
    label: 'Commercial offer',
    blurb: 'Trade, bulk, wholesale. Always escalates — no model involved.',
  },
  complaint: {
    label: 'Complaint',
    blurb: 'Faulty, damaged, disputed. Always escalates as priority — no model involved.',
  },
};

export interface ChatbotProfile {
  storeName: string;
  productKind: string;
  offtopicRefusal: string;
  escalationEmail: string;
}

export interface SpecialistRow {
  category: ChatCategory;
  systemPrompt: string;
  modelOverride: string | null;
  enabled: boolean;
  version: number;
  llmBacked: boolean;
}

export interface ChatbotConfig {
  profile: ChatbotProfile;
  classifierPrompt: string;
  specialists: SpecialistRow[];
}

export interface PromptVersion {
  id: string;
  target: string;
  version: number;
  body: string;
  savedAt: string;
}

export interface Classification {
  category: string;
  confidence: 'high' | 'medium' | 'low';
  clarifyPrompt: string | null;
  refusalReason: string | null;
  latencyMs: number;
  costMicroUsd: number;
  degraded: boolean;
  degradedReason: 'llm_error' | 'unparseable' | null;
}

export interface DryRunResult {
  failed?: boolean;
  error?: string;
  sessionId?: string;
  classification?: Classification;
  /** Which specialist actually answered. Differs from
   *  classification.category while a specialist's tools are unbuilt. */
  routedTo?: string;
  systemPrompt?: string;
  reply?: string;
  toolCalls?: number;
  windDown?: string | null;
  totalLatencyMs: number;
}

const KEY = ['chatbot-config'];

export function useChatbotConfig() {
  return useQuery({
    queryKey: KEY,
    queryFn: () => apiFetch<ChatbotConfig>('/admin/chatbot'),
  });
}

export function useUpdateProfile() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (patch: Partial<ChatbotProfile>) =>
      apiFetch('/admin/chatbot/profile', { method: 'PATCH', body: patch }),
    onSuccess: () => qc.invalidateQueries({ queryKey: KEY }),
  });
}

export function useUpdateClassifier() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: string) =>
      apiFetch('/admin/chatbot/classifier', { method: 'PUT', body: { body } }),
    onSuccess: () => qc.invalidateQueries({ queryKey: KEY }),
  });
}

export function useUpdateSpecialist() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({
      category,
      ...patch
    }: { category: ChatCategory } & Partial<
      Pick<SpecialistRow, 'systemPrompt' | 'modelOverride' | 'enabled'>
    >) =>
      apiFetch(`/admin/chatbot/specialists/${category}`, { method: 'PUT', body: patch }),
    onSuccess: () => qc.invalidateQueries({ queryKey: KEY }),
  });
}

export function usePromptVersions(target: string, enabled = true) {
  return useQuery({
    queryKey: ['prompt-versions', target],
    queryFn: () => apiFetch<PromptVersion[]>(`/admin/chatbot/versions/${target}`),
    enabled,
  });
}

export function useDryRun() {
  return useMutation({
    mutationFn: (message: string) =>
      apiFetch<DryRunResult>('/admin/chatbot/test', { method: 'POST', body: { message } }),
  });
}

// ============================================================
// Knowledge base
// ============================================================

export const KB_SLUGS = ['faq', 'product-advice'] as const;
export type KbSlug = (typeof KB_SLUGS)[number];

export const KB_META: Record<KbSlug, { label: string; blurb: string }> = {
  faq: {
    label: 'Delivery, returns & policy',
    blurb:
      'The only thing the delivery & returns specialist is allowed to answer from. One H2 heading per question.',
  },
  'product-advice': {
    label: 'Product advice',
    blurb:
      'How to use what you sell. The product-advice specialist answers from here — leave it as the placeholder and that specialist will keep handing questions to a human.',
  },
};

export interface KbDocument {
  id: string;
  slug: KbSlug;
  title: string;
  markdown: string;
  chunkCount: number;
  updatedAt: string;
}

export interface KbHit {
  heading: string;
  body: string;
  documentSlug: string;
  rank: number;
}

const KB_KEY = ['chatbot-kb'];

export function useKbDocuments() {
  return useQuery({
    queryKey: KB_KEY,
    queryFn: () => apiFetch<KbDocument[]>('/admin/chatbot/kb'),
  });
}

export function useSaveKbDocument() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ slug, markdown }: { slug: KbSlug; markdown: string }) =>
      apiFetch<KbDocument>(`/admin/chatbot/kb/${slug}`, { method: 'PUT', body: { markdown } }),
    onSuccess: () => qc.invalidateQueries({ queryKey: KB_KEY }),
  });
}

export function useKbSearch() {
  return useMutation({
    mutationFn: (query: string) =>
      apiFetch<KbHit[]>('/admin/chatbot/kb/search', { method: 'POST', body: { query } }),
  });
}
