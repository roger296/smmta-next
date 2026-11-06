/**
 * Data hooks for the Messaging section (docs/email). Thin wrappers over the
 * API's /email/* admin routes.
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { apiFetch } from '@/lib/api-client';

export type MarketingStatus = 'all' | 'transactional_only' | 'never';
export type Deliverability = 'ok' | 'soft_bounce' | 'hard_bounce' | 'complained' | 'invalid';
export type CampaignStatus = 'draft' | 'pending_approval' | 'scheduled' | 'sending' | 'paused' | 'sent' | 'cancelled';

export interface Overview {
  sendMode: 'sandbox' | 'allowlist' | 'live';
  sendModeSet: boolean;
  marketingPaused: boolean;
  pausedReason: string;
  pendingApproval: number;
  openAlerts: number;
  materials: Array<{ key: string; name: string }>;
  lists: Array<{ name: string; contacts: number }>;
}

export interface ContactRow {
  id: string;
  email: string;
  marketingStatus: MarketingStatus;
  deliverability: Deliverability;
  isTrade: boolean;
  consentSource: string;
  lists?: string[];
  interests: string[];
  lastOrderAt: string | null;
  lastClickAt: string | null;
  lastMarketingAt: string | null;
  customerId: string | null;
}

export interface ContactDetail {
  contact: ContactRow & { createdAt: string; bouncerResult: string | null; bouncerCheckedAt: string | null; softBounceCount: number; digestEnabled: boolean; newProductAlertsEnabled: boolean; statusReason: string | null };
  interests: Record<string, number>;
  consentEvents: Array<{ id: string; fromStatus: MarketingStatus | null; toStatus: MarketingStatus; source: string; actor: string; reason: string | null; createdAt: string }>;
  timeline: Array<{ type: 'send' | 'consent' | 'order'; id: string; at: string; detail: Record<string, unknown> }>;
  orders: { count: number; totalGbp: number };
}

export interface Block {
  type: string;
  props: Record<string, unknown>;
}

export interface Campaign {
  id: string;
  name: string;
  kind: string;
  class: string;
  status: CampaignStatus;
  segment: Record<string, unknown>;
  audienceCount: number | null;
  subject: string;
  preheader: string | null;
  templateKey: string;
  content: Block[];
  scheduledAt: string | null;
  sendWindowMinutes: number;
  createdBy: string;
  approvedBy: string | null;
  createdAt: string;
  variantOf: string | null;
  abWinner: string | null;
}

export interface CampaignReport {
  total: number;
  queued: number;
  sent: number;
  delivered: number;
  bounced: number;
  dropped: number;
  opened: number;
  clicked: number;
  complained: number;
  unsubscribesAfter: number;
  orders: number;
  revenueExVat: number;
  revenuePer1000: number;
  droppedByReason: Record<string, number>;
  links: Array<{ url: string; clicks: number }>;
  ab: Array<{ variant: string; sent: number; clicked: number; clickRate: number }>;
}

export interface Preview {
  label: string;
  subject: string;
  html: string;
  text: string;
}

export const qk = {
  overview: ['email', 'overview'] as const,
  contacts: (q: Record<string, unknown>) => ['email', 'contacts', q] as const,
  contact: (id: string) => ['email', 'contact', id] as const,
  imports: ['email', 'imports'] as const,
  campaigns: (status?: string) => ['email', 'campaigns', status ?? 'all'] as const,
  campaign: (id: string) => ['email', 'campaign', id] as const,
  automations: ['email', 'automations'] as const,
  templates: ['email', 'templates'] as const,
  deliverability: ['email', 'deliverability'] as const,
  settings: ['email', 'settings'] as const,
};

export const useOverview = () =>
  useQuery({ queryKey: qk.overview, queryFn: () => apiFetch<Overview>('/email/overview'), refetchInterval: 60_000 });

export const useContacts = (q: Record<string, string | number | boolean | undefined>) =>
  useQuery({
    queryKey: qk.contacts(q),
    queryFn: () => apiFetch<{ total: number; page: number; pageSize: number; contacts: ContactRow[] }>('/email/contacts', { searchParams: q }),
  });

export const useContact = (id: string) => useQuery({ queryKey: qk.contact(id), queryFn: () => apiFetch<ContactDetail>(`/email/contacts/${id}`) });

export const useImports = () => useQuery({ queryKey: qk.imports, queryFn: () => apiFetch<Array<Record<string, any>>>('/email/imports') });

export const useCampaigns = (status?: string) =>
  useQuery({ queryKey: qk.campaigns(status), queryFn: () => apiFetch<Campaign[]>('/email/campaigns', { searchParams: { status } }) });

export const useCampaign = (id: string) =>
  useQuery({
    queryKey: qk.campaign(id),
    queryFn: () => apiFetch<{ campaign: Campaign; variant: Campaign | null; report: CampaignReport; sends: Array<Record<string, any>> }>(`/email/campaigns/${id}`),
  });

export const useCampaignPreview = (id: string, enabled: boolean) =>
  useQuery({ queryKey: ['email', 'preview', id], queryFn: () => apiFetch<Preview[]>(`/email/campaigns/${id}/preview`), enabled });

export const useAutomations = () => useQuery({ queryKey: qk.automations, queryFn: () => apiFetch<Array<Record<string, any>>>('/email/automations') });

export const useTemplates = () =>
  useQuery({ queryKey: qk.templates, queryFn: () => apiFetch<Array<{ key: string; class: string; why: string; versions: Array<{ version: number; createdAt: string }> }>>('/email/templates') });

export const useDeliverability = () => useQuery({ queryKey: qk.deliverability, queryFn: () => apiFetch<Record<string, any>>('/email/deliverability') });

export const useEmailSettings = () => useQuery({ queryKey: qk.settings, queryFn: () => apiFetch<Record<string, unknown>>('/email/settings') });

/** A mutation that refreshes everything under ['email'] when it succeeds. */
export function useEmailMutation<TVars, TOut = unknown>(fn: (v: TVars) => Promise<TOut>) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: fn,
    onSuccess: () => qc.invalidateQueries({ queryKey: ['email'] }),
  });
}

export const post = <T,>(path: string, body: unknown = {}) => apiFetch<T>(path, { method: 'POST', body });
export const patch = <T,>(path: string, body: unknown) => apiFetch<T>(path, { method: 'PATCH', body });
export const put = <T,>(path: string, body: unknown) => apiFetch<T>(path, { method: 'PUT', body });

export const STATUS_LABEL: Record<MarketingStatus, string> = {
  all: 'Accepts all',
  transactional_only: 'Transactional only',
  never: 'Never email',
};

export function fmtDate(v: string | null | undefined): string {
  return v ? new Date(v).toLocaleString('en-GB', { dateStyle: 'medium', timeStyle: 'short' }) : '—';
}
