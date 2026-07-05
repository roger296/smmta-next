/**
 * Inbound-shipment admin hooks (SPEC F1, Prompt 4). The admin surface for
 * pre-order stock pools: list/detail, create, ETA edit, status, goods-in.
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { apiFetch } from '@/lib/api-client';

export type ShipmentMode = 'sea' | 'air' | 'road' | 'rail' | 'courier';
export type ShipmentStatus = 'booked' | 'in_transit' | 'at_port' | 'customs' | 'received' | 'reconciled';

export interface Shipment {
  id: string;
  reference: string;
  mode: ShipmentMode;
  supplier: string | null;
  carrier: string | null;
  eta: string;
  etaOriginal: string;
  status: ShipmentStatus;
  bufferPct: number;
  arrivedAt: string | null;
}

export interface ShipmentLine {
  id: string;
  sku: string;
  qtyManifested: number;
  qtyReceived: number | null;
  qtyPresold: number;
}

export interface ShipmentDetail extends Shipment {
  lines: ShipmentLine[];
}

export interface CreateShipmentInput {
  reference: string;
  mode?: ShipmentMode;
  supplier?: string;
  carrier?: string;
  eta: string;
  bufferPct?: number;
  lines: Array<{ sku: string; qtyManifested: number }>;
}

const KEY = ['inbound-shipments'];

export function useShipments() {
  return useQuery({ queryKey: KEY, queryFn: () => apiFetch<Shipment[]>('/inbound/shipments') });
}

export function useShipment(id: string, enabled = true) {
  return useQuery({
    queryKey: [...KEY, id],
    queryFn: () => apiFetch<ShipmentDetail>(`/inbound/shipments/${id}`),
    enabled,
  });
}

function useInvalidate() {
  const qc = useQueryClient();
  return () => qc.invalidateQueries({ queryKey: KEY });
}

export function useCreateShipment() {
  const invalidate = useInvalidate();
  return useMutation({
    mutationFn: (input: CreateShipmentInput) => apiFetch<Shipment>('/inbound/shipments', { method: 'POST', body: input }),
    onSuccess: invalidate,
  });
}

export function useUpdateEta() {
  const invalidate = useInvalidate();
  return useMutation({
    mutationFn: ({ id, eta }: { id: string; eta: string }) =>
      apiFetch(`/inbound/shipments/${id}/eta`, { method: 'PATCH', body: { eta } }),
    onSuccess: invalidate,
  });
}

export function useGoodsIn() {
  const invalidate = useInvalidate();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, receipts }: { id: string; receipts: Array<{ sku: string; qtyReceived: number }> }) =>
      apiFetch(`/inbound/shipments/${id}/goods-in`, { method: 'POST', body: { receipts } }),
    onSuccess: (_data, vars) => {
      invalidate();
      void qc.invalidateQueries({ queryKey: [...KEY, vars.id] });
    },
  });
}
