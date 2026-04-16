import {
  useMutation,
  useQuery,
  useQueryClient,
  type UseMutationOptions,
  type UseQueryOptions,
} from '@tanstack/react-query';
import { apiFetch, type PaginatedResult } from '@/lib/api-client';

interface ResourceConfig {
  /** Plural path like "/customers" */
  basePath: string;
  /** React-Query root key like "customers" */
  queryKey: string;
}

export function createResourceHooks<
  TEntity extends { id: string },
  TCreateInput,
  TUpdateInput,
  TListQuery = Record<string, unknown>,
>(config: ResourceConfig) {
  const keys = {
    all: [config.queryKey] as const,
    lists: () => [...keys.all, 'list'] as const,
    list: (params: TListQuery) => [...keys.lists(), params] as const,
    details: () => [...keys.all, 'detail'] as const,
    detail: (id: string) => [...keys.details(), id] as const,
  };

  function useList(params: TListQuery = {} as TListQuery, options?: Partial<UseQueryOptions<PaginatedResult<TEntity>>>) {
    return useQuery<PaginatedResult<TEntity>>({
      queryKey: keys.list(params),
      queryFn: () =>
        apiFetch<PaginatedResult<TEntity>>(config.basePath, {
          searchParams: params as Record<string, string | number | boolean | undefined>,
        }),
      ...options,
    });
  }

  function useOne(id: string | undefined, options?: Partial<UseQueryOptions<TEntity>>) {
    return useQuery<TEntity>({
      queryKey: keys.detail(id ?? ''),
      queryFn: () => apiFetch<TEntity>(`${config.basePath}/${id}`),
      enabled: !!id,
      ...options,
    });
  }

  function useCreate(options?: UseMutationOptions<TEntity, Error, TCreateInput>) {
    const qc = useQueryClient();
    return useMutation<TEntity, Error, TCreateInput>({
      mutationFn: (input) =>
        apiFetch<TEntity>(config.basePath, { method: 'POST', body: input }),
      ...options,
      onSuccess: (...args) => {
        qc.invalidateQueries({ queryKey: keys.lists() });
        (options?.onSuccess as ((...a: unknown[]) => void) | undefined)?.(...args);
      },
    });
  }

  function useUpdate(options?: UseMutationOptions<TEntity, Error, { id: string; input: TUpdateInput }>) {
    const qc = useQueryClient();
    return useMutation<TEntity, Error, { id: string; input: TUpdateInput }>({
      mutationFn: ({ id, input }) =>
        apiFetch<TEntity>(`${config.basePath}/${id}`, { method: 'PUT', body: input }),
      ...options,
      onSuccess: (...args) => {
        const variables = args[1] as { id: string };
        qc.invalidateQueries({ queryKey: keys.lists() });
        qc.invalidateQueries({ queryKey: keys.detail(variables.id) });
        (options?.onSuccess as ((...a: unknown[]) => void) | undefined)?.(...args);
      },
    });
  }

  function useDelete(options?: UseMutationOptions<void, Error, string>) {
    const qc = useQueryClient();
    return useMutation<void, Error, string>({
      mutationFn: (id) => apiFetch<void>(`${config.basePath}/${id}`, { method: 'DELETE' }),
      ...options,
      onSuccess: (...args) => {
        qc.invalidateQueries({ queryKey: keys.lists() });
        (options?.onSuccess as ((...a: unknown[]) => void) | undefined)?.(...args);
      },
    });
  }

  return { keys, useList, useOne, useCreate, useUpdate, useDelete };
}
