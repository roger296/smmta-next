import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { apiFetch } from '@/lib/api-client';

export type ExperienceType = 'CLASSIC' | 'SWEETER' | 'ULTIMATE';

export interface Recipe {
  id: string;
  experience: ExperienceType;
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
  experience: ExperienceType;
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

export function useRecipes(filter?: { experience?: ExperienceType; siteId?: string }) {
  return useQuery<Recipe[]>({
    queryKey: [...recipeKeys.all, filter ?? {}],
    queryFn: () => apiFetch<Recipe[]>('/recipes', { searchParams: filter }),
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
