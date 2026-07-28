import * as React from 'react';
import { createFileRoute, useNavigate, Link } from '@tanstack/react-router';
import { ArrowLeft, Plus, Trash2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Badge } from '@/components/ui/badge';
import { Skeleton } from '@/components/ui/skeleton';
import { ProductPicker } from '@/components/ui/product-picker';
import {
  DietaryVariants,
  dietaryLinesToPayload,
  emptyDietaryLines,
  type DietaryLines,
} from '@/features/recipes/dietary-variants';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { useToast } from '@/hooks/use-toast';
import { formatDate } from '@/lib/format';
import { useSites } from '@/features/sites/use-sites';
import { useRecipe, useUpdateRecipe, useDeleteRecipe } from '@/features/recipes/use-recipes';

export const Route = createFileRoute('/_authed/recipes/$id')({
  component: RecipeDetailPage,
});

interface DraftLine {
  productId: string;
  qtyPerCover: string;
  /** So the removal lists can name the ingredient rather than show its id. */
  label?: string;
}

function RecipeDetailPage() {
  const { id } = Route.useParams();
  const navigate = useNavigate();
  const { data, isLoading, error } = useRecipe(id);
  const { data: sites } = useSites();
  const update = useUpdateRecipe();
  const remove = useDeleteRecipe();
  const { toast } = useToast();

  const [effectiveFrom, setEffectiveFrom] = React.useState('');
  const [effectiveTo, setEffectiveTo] = React.useState('');
  const [notes, setNotes] = React.useState('');
  const [lines, setLines] = React.useState<DraftLine[]>([]);
  const [dietary, setDietary] = React.useState<DietaryLines>(emptyDietaryLines);
  const [confirmDelete, setConfirmDelete] = React.useState(false);

  // Seed the form once the record lands. Keyed on the record so navigating
  // between versions re-seeds rather than showing the previous one's edits.
  React.useEffect(() => {
    if (!data) return;
    setEffectiveFrom(data.recipe.effectiveFrom ?? '');
    setEffectiveTo(data.recipe.effectiveTo ?? '');
    setNotes(data.recipe.notes ?? '');
    // Split the stored lines back into the base recipe and the four variant
    // lists. A line with no variant is BASE — every line predating this
    // feature is one.
    const isBase = (v?: string | null) => (v ?? 'BASE') === 'BASE';
    setLines(
      data.lines
        .filter((l) => isBase(l.variant))
        .map((l) => ({ productId: l.productId, qtyPerCover: String(l.qtyPerCover) })),
    );
    const grouped = emptyDietaryLines();
    for (const l of data.lines) {
      if (isBase(l.variant)) continue;
      const key = l.variant as keyof DietaryLines;
      if (grouped[key]) {
        grouped[key].push({ productId: l.productId, qtyPerCover: String(l.qtyPerCover) });
      }
    }
    setDietary(grouped);
  }, [data]);

  const setLine = (i: number, patch: Partial<DraftLine>) =>
    setLines((ls) => ls.map((l, idx) => (idx === i ? { ...l, ...patch } : l)));
  const addLine = () => setLines((ls) => [...ls, { productId: '', qtyPerCover: '' }]);
  const removeLine = (i: number) => setLines((ls) => ls.filter((_, idx) => idx !== i));

  const validLines = lines.filter((l) => l.productId && Number(l.qtyPerCover) > 0);
  const canSave = !!effectiveFrom && validLines.length > 0 && !update.isPending;

  const siteName = (siteId: string | null) =>
    siteId ? (sites?.find((s) => s.id === siteId)?.name ?? siteId.slice(0, 8)) : 'Global';

  const save = async () => {
    try {
      await update.mutateAsync({
        id,
        input: {
          effectiveFrom,
          effectiveTo: effectiveTo || null,
          notes: notes || null,
          lines: [
            ...validLines.map((l) => ({
              productId: l.productId,
              qtyPerCover: Number(l.qtyPerCover),
              variant: 'BASE' as const,
            })),
            ...dietaryLinesToPayload(dietary),
          ],
        },
      });
      toast({ title: 'Recipe updated' });
    } catch (err) {
      toast({ variant: 'destructive', title: 'Could not save', description: String(err) });
    }
  };

  const doDelete = async () => {
    try {
      await remove.mutateAsync(id);
      toast({ title: 'Recipe deleted' });
      void navigate({ to: '/recipes' });
    } catch (err) {
      toast({ variant: 'destructive', title: 'Could not delete', description: String(err) });
    }
  };

  if (isLoading) return <Skeleton className="h-96 w-full" />;
  if (error || !data) {
    return (
      <Card>
        <CardContent className="p-6">
          <p className="text-sm text-[var(--color-destructive)]">Could not load this recipe.</p>
          <Link to="/recipes" className="text-sm text-[var(--color-primary)] hover:underline">
            Back to recipes
          </Link>
        </CardContent>
      </Card>
    );
  }

  const { recipe } = data;

  return (
    <div className="space-y-6">
      <div className="flex items-start justify-between gap-4">
        <div>
          <Link
            to="/recipes"
            className="mb-1 inline-flex items-center gap-1 text-sm text-[var(--color-muted-foreground)] hover:text-[var(--color-foreground)]"
          >
            <ArrowLeft className="h-4 w-4" />
            Recipes
          </Link>
          <h1 className="text-2xl font-semibold">{recipe.bake}</h1>
          <div className="mt-1 flex items-center gap-2 text-sm text-[var(--color-muted-foreground)]">
            <Badge variant="secondary">{siteName(recipe.siteId)}</Badge>
            <span>v{recipe.version}</span>
            <span>·</span>
            <span>
              from {formatDate(recipe.effectiveFrom)}
              {recipe.effectiveTo ? ` to ${formatDate(recipe.effectiveTo)}` : ' (open-ended)'}
            </span>
          </div>
        </div>
        <Button variant="destructive" size="sm" onClick={() => setConfirmDelete(true)}>
          <Trash2 className="h-4 w-4" />
          Delete
        </Button>
      </div>

      {/* The cake, site and version are the version's IDENTITY — the unique
          index is built on them, and superseding a recipe means adding a
          version rather than renaming this one. Shown, not editable. */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Version</CardTitle>
        </CardHeader>
        <CardContent className="grid grid-cols-1 gap-4 md:grid-cols-3">
          <div className="space-y-1.5">
            <Label>Effective from</Label>
            <Input
              type="date"
              value={effectiveFrom}
              onChange={(e) => setEffectiveFrom(e.target.value)}
            />
          </div>
          <div className="space-y-1.5">
            <Label>Effective to (optional)</Label>
            <Input
              type="date"
              value={effectiveTo}
              onChange={(e) => setEffectiveTo(e.target.value)}
            />
          </div>
          <div className="space-y-1.5">
            <Label>Cake / scope</Label>
            <Input value={`${recipe.bake} — ${siteName(recipe.siteId)}`} disabled />
            <p className="text-xs text-[var(--color-muted-foreground)]">
              Fixed for this version. To change them, add a new recipe version.
            </p>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Ingredients (quantity per table)</CardTitle>
        </CardHeader>
        <CardContent className="space-y-2">
          {lines.map((line, i) => (
            <div key={i} className="flex items-center gap-2">
              <div className="flex-1">
                <ProductPicker
                  value={line.productId}
                  onChange={(v, p) =>
                    setLine(i, { productId: v, label: p ? `${p.name} (${p.stockUom})` : undefined })
                  }
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
                onChange={(e) => setLine(i, { qtyPerCover: e.target.value })}
              />
              <Button
                variant="ghost"
                size="sm"
                onClick={() => removeLine(i)}
                aria-label="Remove ingredient"
              >
                <Trash2 className="h-4 w-4" />
              </Button>
            </div>
          ))}
          {lines.length === 0 && (
            <p className="text-sm text-[var(--color-muted-foreground)]">
              No ingredients yet — a recipe needs at least one to be saved.
            </p>
          )}
          <Button variant="outline" size="sm" onClick={addLine}>
            <Plus className="h-4 w-4" />
            Add ingredient
          </Button>
        </CardContent>
      </Card>

      <DietaryVariants
        value={dietary}
        base={lines
          .filter((l) => l.productId)
          .map((l) => ({ productId: l.productId, label: l.label ?? l.productId.slice(0, 8) }))}
        onChange={setDietary}
      />

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Notes</CardTitle>
        </CardHeader>
        <CardContent>
          <Textarea rows={3} value={notes} onChange={(e) => setNotes(e.target.value)} />
        </CardContent>
      </Card>

      <div className="flex items-center justify-end gap-2">
        {/* Says why the button is off, rather than leaving a dead control. */}
        {!canSave && !update.isPending && (
          <span className="text-sm text-[var(--color-muted-foreground)]">
            {!effectiveFrom
              ? 'An effective-from date is required.'
              : 'Add at least one ingredient with a quantity.'}
          </span>
        )}
        <Button onClick={save} disabled={!canSave}>
          {update.isPending ? 'Saving…' : 'Save changes'}
        </Button>
      </div>

      <AlertDialog open={confirmDelete} onOpenChange={setConfirmDelete}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              Delete {recipe.bake} v{recipe.version}?
            </AlertDialogTitle>
            <AlertDialogDescription>
              This removes the recipe version and its ingredients. Sessions already filed keep
              the expected quantities they were measured against — those are snapshotted at
              submit, so no history changes. Future sessions for this cake will fall back to
              another version, or have no expected consumption at all if this was the only one.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={doDelete} disabled={remove.isPending}>
              {remove.isPending ? 'Deleting…' : 'Delete recipe'}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
