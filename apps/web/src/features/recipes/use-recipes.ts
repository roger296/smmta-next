import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { apiFetch } from '@/lib/api-client';

/**
 * How a bake is grouped on the end-of-bake picker (Sept-2026, item 2).
 * Presentation only — nothing in the costing or stock maths reads it.
 */
export const BAKE_TYPES = ['CORPORATE', 'REGULAR', 'OTHER'] as const;
export type BakeType = (typeof BAKE_TYPES)[number];

/** The order the groups appear on the picker, and their headings. */
export const BAKE_TYPE_LABELS: Record<BakeType, string> = {
  CORPORATE: 'Corporate',
  REGULAR: 'Regular',
  OTHER: 'Other',
};

/** One cake on the menu. */
export interface MenuBake {
  bake: string;
  bakeType: BakeType;
  isActive: boolean;
}

export interface Recipe {
  id: string;
  /** The cake this recipe makes (free-form, e.g. "Victoria Sponge"). */
  bake: string;
  bakeType: BakeType;
  /** Off the menu when false — hidden from the venue picker, not deleted. */
  isActive: boolean;
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
  /** BASE, or one of the gluten-free / vegan lists. Absent on lines written
   *  before dietary variants existed — treat that as BASE. */
  variant?: 'BASE' | 'GF_REMOVE' | 'GF_ADD' | 'VEGAN_REMOVE' | 'VEGAN_ADD';
  /** Resolved server-side. Without it the editor can only show an id. */
  productName?: string;
  productStockUom?: string;
  qtyPerCover: string;
  stockUom: string;
  unitCost: string | null;
}

export interface RecipeLineInput {
  productId: string;
  variant?: 'BASE' | 'GF_REMOVE' | 'GF_ADD' | 'VEGAN_REMOVE' | 'VEGAN_ADD';
  qtyPerCover: number;
  stockUom?: string;
  unitCost?: number | null;
}

export interface CreateRecipeInput {
  bake: string;
  siteId?: string | null;
  bakeType?: BakeType;
  isActive?: boolean;
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

/**
 * The cakes the picker offers, each with its group (Sept-2026, items 2 and 3).
 *
 * ACTIVE ONLY by default — the venue picker shows tonight's menu, not every
 * cake the company has ever costed. The admin Recipes page passes
 * `includeInactive` so a switched-off cake can be found and switched back on.
 */
export function useBakes(opts: { includeInactive?: boolean } = {}) {
  return useQuery<MenuBake[]>({
    queryKey: [...recipeKeys.all, 'bakes', opts.includeInactive ?? false],
    queryFn: () =>
      apiFetch<MenuBake[]>('/recipes/bakes', {
        searchParams: opts.includeInactive ? { includeInactive: 'true' } : undefined,
      }),
  });
}

/**
 * Group the menu for display, in the fixed order Corporate → Regular → Other.
 *
 * Fixed rather than data-driven: the headings are a convention the venue reads
 * the same way every session, and a group that moves because tonight happens
 * to have no corporate bake is a group a baker has to re-find.
 */
export function groupBakes(menu: MenuBake[] | undefined): Array<{
  type: BakeType;
  label: string;
  bakes: MenuBake[];
}> {
  const order: BakeType[] = ['CORPORATE', 'REGULAR', 'OTHER'];
  return order
    .map((type) => ({
      type,
      label: BAKE_TYPE_LABELS[type],
      bakes: (menu ?? []).filter((b) => b.bakeType === type),
    }))
    .filter((g) => g.bakes.length > 0);
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
  bakeType?: BakeType;
  isActive?: boolean;
  /** When given, REPLACES the ingredient list wholesale. */
  lines?: Array<{ productId: string; qtyPerCover: number; variant?: string }>;
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
