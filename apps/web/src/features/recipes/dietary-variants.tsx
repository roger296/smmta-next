import { Plus, Trash2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { ProductPicker } from '@/components/ui/product-picker';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';

export type RecipeLineVariant = 'BASE' | 'GF_REMOVE' | 'GF_ADD' | 'VEGAN_REMOVE' | 'VEGAN_ADD';

export interface VariantLine {
  productId: string;
  qtyPerCover: string;
}

export interface DietaryLines {
  GF_REMOVE: VariantLine[];
  GF_ADD: VariantLine[];
  VEGAN_REMOVE: VariantLine[];
  VEGAN_ADD: VariantLine[];
}

export const emptyDietaryLines = (): DietaryLines => ({
  GF_REMOVE: [],
  GF_ADD: [],
  VEGAN_REMOVE: [],
  VEGAN_ADD: [],
});

/** The base-recipe ingredients a removal list can choose from. */
export interface BaseIngredient {
  productId: string;
  label: string;
}

/**
 * A removal list.
 *
 * Chooses only from what the base recipe actually contains — you cannot remove
 * an ingredient that was never in it, and offering the whole catalogue here
 * would invite exactly that. A new empty row appears as soon as the last one
 * is filled, so the list grows as it is used rather than needing an Add click.
 *
 * No quantity: a removal takes the whole ingredient out.
 */
function RemovalList({
  title,
  lines,
  base,
  onChange,
}: {
  title: string;
  lines: VariantLine[];
  base: BaseIngredient[];
  onChange: (next: VariantLine[]) => void;
}) {
  const chosen = new Set(lines.map((l) => l.productId).filter(Boolean));
  // Always render one more row than is filled, so the next choice is there
  // waiting. Roger's phrasing: "when one is selected a new line should open up
  // below so that a second can also be selected".
  const rows = [...lines.filter((l) => l.productId), { productId: '', qtyPerCover: '0' }];
  const available = base.filter((b) => !chosen.has(b.productId));

  const set = (i: number, productId: string) => {
    const next = rows.slice(0, -1);
    if (i >= next.length) {
      if (productId) next.push({ productId, qtyPerCover: '0' });
    } else if (productId) {
      next[i] = { productId, qtyPerCover: '0' };
    } else {
      next.splice(i, 1);
    }
    onChange(next);
  };

  return (
    <div className="space-y-2">
      <Label>{title}</Label>
      {base.length === 0 && (
        <p className="text-sm text-[var(--color-muted-foreground)]">
          Add ingredients to the recipe above first — there is nothing to remove yet.
        </p>
      )}
      {base.length > 0 &&
        rows.map((line, i) => {
          const isNew = i === rows.length - 1;
          if (isNew && available.length === 0) return null;
          return (
            <div key={`${line.productId}-${i}`} className="flex items-center gap-2">
              <Select value={line.productId} onValueChange={(v) => set(i, v)}>
                <SelectTrigger className="flex-1">
                  <SelectValue placeholder={isNew ? 'Choose an ingredient to remove…' : undefined} />
                </SelectTrigger>
                <SelectContent>
                  {base
                    .filter((b) => b.productId === line.productId || !chosen.has(b.productId))
                    .map((b) => (
                      <SelectItem key={b.productId} value={b.productId}>
                        {b.label}
                      </SelectItem>
                    ))}
                </SelectContent>
              </Select>
              {!isNew && (
                <Button variant="ghost" size="sm" onClick={() => set(i, '')} aria-label="Undo removal">
                  <Trash2 className="h-4 w-4" />
                </Button>
              )}
            </div>
          );
        })}
    </div>
  );
}

/** An addition list — any product, with a quantity, exactly like the base recipe. */
function AdditionList({
  title,
  lines,
  onChange,
}: {
  title: string;
  lines: VariantLine[];
  onChange: (next: VariantLine[]) => void;
}) {
  const set = (i: number, patch: Partial<VariantLine>) =>
    onChange(lines.map((l, idx) => (idx === i ? { ...l, ...patch } : l)));

  return (
    <div className="space-y-2">
      <Label>{title}</Label>
      {lines.map((line, i) => (
        <div key={i} className="flex items-center gap-2">
          <div className="flex-1">
            <ProductPicker
              value={line.productId}
              onChange={(v) => set(i, { productId: v })}
              itemKind={['INGREDIENT', 'PACKAGING']}
            />
          </div>
          <Input
            type="number"
            min="0"
            step="any"
            className="w-32"
            placeholder="qty / table"
            value={line.qtyPerCover}
            onChange={(e) => set(i, { qtyPerCover: e.target.value })}
          />
          <Button
            variant="ghost"
            size="sm"
            onClick={() => onChange(lines.filter((_, idx) => idx !== i))}
            aria-label="Remove line"
          >
            <Trash2 className="h-4 w-4" />
          </Button>
        </div>
      ))}
      <Button
        variant="outline"
        size="sm"
        onClick={() => onChange([...lines, { productId: '', qtyPerCover: '' }])}
      >
        <Plus className="h-4 w-4" />
        Add ingredient
      </Button>
    </div>
  );
}

/**
 * The gluten-free and vegan variations on a recipe.
 *
 * Grouped in pairs because that is how a baker thinks about it: to make the
 * gluten-free version, take THESE out and put THOSE in. Splitting the four
 * lists apart would make someone reconstruct the pairing in their head.
 */
export function DietaryVariants({
  value,
  base,
  onChange,
}: {
  value: DietaryLines;
  base: BaseIngredient[];
  onChange: (next: DietaryLines) => void;
}) {
  const patch = (p: Partial<DietaryLines>) => onChange({ ...value, ...p });

  return (
    <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Gluten-free version</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <RemovalList
            title="Remove for Gluten Free Version"
            lines={value.GF_REMOVE}
            base={base}
            onChange={(l) => patch({ GF_REMOVE: l })}
          />
          <AdditionList
            title="Add in for Gluten Free Version"
            lines={value.GF_ADD}
            onChange={(l) => patch({ GF_ADD: l })}
          />
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Vegan version</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <RemovalList
            title="Remove for Vegan Version"
            lines={value.VEGAN_REMOVE}
            base={base}
            onChange={(l) => patch({ VEGAN_REMOVE: l })}
          />
          <AdditionList
            title="Add in for Vegan Version"
            lines={value.VEGAN_ADD}
            onChange={(l) => patch({ VEGAN_ADD: l })}
          />
        </CardContent>
      </Card>
    </div>
  );
}

/** Flatten the four lists into the API's line shape. */
export function dietaryLinesToPayload(
  d: DietaryLines,
): Array<{ productId: string; qtyPerCover: number; variant: RecipeLineVariant }> {
  const out: Array<{ productId: string; qtyPerCover: number; variant: RecipeLineVariant }> = [];
  for (const variant of ['GF_REMOVE', 'GF_ADD', 'VEGAN_REMOVE', 'VEGAN_ADD'] as const) {
    for (const l of d[variant]) {
      if (!l.productId) continue;
      // A removal carries no quantity — the whole ingredient comes out.
      const isRemoval = variant === 'GF_REMOVE' || variant === 'VEGAN_REMOVE';
      if (!isRemoval && !(Number(l.qtyPerCover) > 0)) continue;
      out.push({ productId: l.productId, qtyPerCover: isRemoval ? 0 : Number(l.qtyPerCover), variant });
    }
  }
  return out;
}
