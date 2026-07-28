import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { apiFetch } from '@/lib/api-client';

export interface Recipe {
  id: string;
  /** The cake this recipe makes (free-form, e.g. "Victoria Sponge"). */
  bake: string;
  siteId: string | null;
  version: number;
  effectiveFrom: string;
  effectiveTo: string | null;
  name: string | null;
  notes: string | null;
  createdAt: string;
}

export interface RecipeLine {
  id: string;
  recipeId: string;
  productId: string;
  qtyPerCover: string;
  stockUom: string;
  unitCost: string | null;
}

export interface RecipeLineInput {
  productId: string;
  qtyPerCover: number;
  stockUom?: string;
  unitCost?: number | null;
}

export interface CreateRecipeInput {
  bake: string;
  siteId?: string | null;
  effectiveFrom: string;
  effectiveTo?: string | null;
  name?: string | null;
  notes?: string | null;
  lines: RecipeLineInput[];
}

export const recipeKeys = {
  all: ['recipes'] as const,
  detail: (id: string) => ['recipes', 'detail', id] as const,
};

export function useRecipes(filter?: { bake?: string; siteId?: string }) {
  return useQuery<Recipe[]>({
    queryKey: [...recipeKeys.all, filter ?? {}],
    queryFn: () => apiFetch<Recipe[]>('/recipes', { searchParams: filter }),
  });
}

/** The distinct cakes that have a recipe (the menu) — for pickers. */
export function useBakes() {
  return useQuery<string[]>({
    queryKey: [...recipeKeys.all, 'bakes'],
    queryFn: () => apiFetch<string[]>('/recipes/bakes'),
  });
}

export function useRecipe(id: string | undefined) {
  return useQuery<{ recipe: Recipe; lines: RecipeLine[] }>({
    queryKey: recipeKeys.detail(id ?? ''),
    queryFn: () => apiFetch<{ recipe: Recipe; lines: RecipeLine[] }>(`/recipes/${id}`),
    enabled: !!id,
  });
}

export function useCreateRecipe() {
  const qc = useQueryClient();
  return useMutation<{ recipe: Recipe; lines: RecipeLine[] }, Error, CreateRecipeInput>({
    mutationFn: (input) =>
      apiFetch<{ recipe: Recipe; lines: RecipeLine[] }>('/recipes', { method: 'POST', body: input }),
    onSuccess: () => qc.invalidateQueries({ queryKey: recipeKeys.all }),
  });
}

/** An amendment. bake/site/version identify the version and are not editable —
 *  superseding a recipe means adding a version, not renaming one. */
export interface UpdateRecipeInput {
  effectiveFrom?: string;
  effectiveTo?: string | null;
  name?: string | null;
  notes?: string | null;
  /** When given, REPLACES the ingredient list wholesale. */
  lines?: Array<{ productId: string; qtyPerCover: number }>;
}

export function useUpdateRecipe() {
  const qc = useQueryClient();
  return useMutation<
    { recipe: Recipe; lines: RecipeLine[] },
    Error,
    { id: string; input: UpdateRecipeInput }
  >({
    mutationFn: ({ id, input }) =>
      apiFetch<{ recipe: Recipe; lines: RecipeLine[] }>(`/recipes/${id}`, {
        method: 'PUT',
        body: input,
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: recipeKeys.all }),
  });
}

export function useDeleteRecipe() {
  const qc = useQueryClient();
  return useMutation<{ id: string }, Error, string>({
    mutationFn: (id) => apiFetch<{ id: string }>(`/recipes/${id}`, { method: 'DELETE' }),
    onSuccess: () => qc.invalidateQueries({ queryKey: recipeKeys.all }),
  });
}
