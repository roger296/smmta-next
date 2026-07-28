import * as React from 'react';
import { createFileRoute } from '@tanstack/react-router';
import { BookOpen, Plus, Trash2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Skeleton } from '@/components/ui/skeleton';
import { EmptyState } from '@/components/empty-state';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { useToast } from '@/hooks/use-toast';
import { formatDate } from '@/lib/format';
import { useSites } from '@/features/sites/use-sites';
import { ProductPicker } from '@/components/ui/product-picker';
import {
  useRecipes,
  useBakes,
  useCreateRecipe,
  type Recipe,
} from '@/features/recipes/use-recipes';

export const Route = createFileRoute('/_authed/recipes')({
  component: RecipesPage,
});

interface DraftLine {
  productId: string;
  qtyPerCover: string;
}

function RecipesPage() {
  const { data: recipes, isLoading } = useRecipes();
  const { data: bakes } = useBakes();
  const { data: sites } = useSites();
  const create = useCreateRecipe();
  const { toast } = useToast();

  const siteName = React.useCallback(
    (id: string | null) => (id ? sites?.find((s) => s.id === id)?.name ?? id.slice(0, 8) : 'Global'),
    [sites],
  );

  const [bake, setBake] = React.useState<string>('');
  const [scope, setScope] = React.useState<string>('GLOBAL');
  const [effectiveFrom, setEffectiveFrom] = React.useState<string>('');
  const [effectiveTo, setEffectiveTo] = React.useState<string>('');
  const [lines, setLines] = React.useState<DraftLine[]>([{ productId: '', qtyPerCover: '' }]);

  const setLine = (i: number, patch: Partial<DraftLine>) =>
    setLines((ls) => ls.map((l, idx) => (idx === i ? { ...l, ...patch } : l)));
  const addLine = () => setLines((ls) => [...ls, { productId: '', qtyPerCover: '' }]);
  const removeLine = (i: number) => setLines((ls) => ls.filter((_, idx) => idx !== i));

  const validLines = lines.filter((l) => l.productId && Number(l.qtyPerCover) > 0);
  const canSubmit = !!bake.trim() && !!effectiveFrom && validLines.length > 0 && !create.isPending;

  const submit = async () => {
    try {
      await create.mutateAsync({
        bake: bake.trim(),
        siteId: scope === 'GLOBAL' ? null : scope,
        effectiveFrom,
        effectiveTo: effectiveTo || null,
        lines: validLines.map((l) => ({ productId: l.productId, qtyPerCover: Number(l.qtyPerCover) })),
      });
      toast({ title: `Recipe saved — ${bake.trim()} (${siteName(scope === 'GLOBAL' ? null : scope)})` });
      setLines([{ productId: '', qtyPerCover: '' }]);
      setEffectiveTo('');
    } catch (err) {
      toast({ variant: 'destructive', title: 'Could not save recipe', description: String(err) });
    }
  };

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold">Recipes</h1>
        <p className="text-sm text-[var(--color-muted-foreground)]">
          What each cake consumes per cover (per guest). Recipes are keyed by the cake, not the
          experience package — Classic / Sweeter / Ultimate are price tiers, not recipes. Versioned
          and date-effective; a per-site recipe overrides the global one (e.g. Dallas in imperial
          units). Expected consumption = recipe × covers.
        </p>
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">New recipe version</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid grid-cols-1 gap-4 md:grid-cols-4">
            <div className="space-y-1.5">
              <Label>Cake</Label>
              <Input
                list="bake-options"
                value={bake}
                onChange={(e) => setBake(e.target.value)}
                placeholder="e.g. Victoria Sponge"
              />
              <datalist id="bake-options">
                {(bakes ?? []).map((b) => (
                  <option key={b} value={b} />
                ))}
              </datalist>
            </div>
            <div className="space-y-1.5">
              <Label>Scope</Label>
              <Select value={scope} onValueChange={setScope}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="GLOBAL">Global (all sites)</SelectItem>
                  {(sites ?? []).map((s) => (
                    <SelectItem key={s.id} value={s.id}>
                      {s.name} (override)
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label>Effective from</Label>
              <Input type="date" value={effectiveFrom} onChange={(e) => setEffectiveFrom(e.target.value)} />
            </div>
            <div className="space-y-1.5">
              <Label>Effective to (optional)</Label>
              <Input type="date" value={effectiveTo} onChange={(e) => setEffectiveTo(e.target.value)} />
            </div>
          </div>

          <div className="space-y-2">
            <Label>Ingredients (quantity per cover)</Label>
            {lines.map((line, i) => (
              <div key={i} className="flex items-center gap-2">
                <div className="flex-1">
                  <ProductPicker
                    value={line.productId}
                    onChange={(v) => setLine(i, { productId: v })}
                    itemKind={['INGREDIENT', 'PACKAGING']}
                  />
                </div>
                <Input
                  type="number"
                  min="0"
                  step="any"
                  className="w-32"
                  placeholder="qty / cover"
                  value={line.qtyPerCover}
                  onChange={(e) => setLine(i, { qtyPerCover: e.target.value })}
                />
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => removeLine(i)}
                  disabled={lines.length === 1}
                  aria-label="Remove line"
                >
                  <Trash2 className="h-4 w-4" />
                </Button>
              </div>
            ))}
            <Button variant="outline" size="sm" onClick={addLine}>
              <Plus className="h-4 w-4" />
              Add ingredient
            </Button>
          </div>

          <div className="flex justify-end">
            <Button onClick={submit} disabled={!canSubmit}>
              {create.isPending ? 'Saving…' : 'Save recipe version'}
            </Button>
          </div>
        </CardContent>
      </Card>

      {isLoading && (
        <Card>
          <CardContent className="space-y-2 p-6">
            <Skeleton className="h-10 w-full" />
            <Skeleton className="h-10 w-full" />
          </CardContent>
        </Card>
      )}

      {!isLoading && recipes && recipes.length === 0 && (
        <EmptyState
          icon={BookOpen}
          title="No recipes yet"
          description="Define what each cake consumes per cover above."
        />
      )}

      {!isLoading && recipes && recipes.length > 0 && (
        <Card>
          <CardContent className="p-0">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-[var(--color-border)] text-left text-[var(--color-muted-foreground)]">
                  <th className="px-4 py-3 font-medium">Cake</th>
                  <th className="px-4 py-3 font-medium">Scope</th>
                  <th className="px-4 py-3 font-medium">Version</th>
                  <th className="px-4 py-3 font-medium">Effective from</th>
                  <th className="px-4 py-3 font-medium">Effective to</th>
                </tr>
              </thead>
              <tbody>
                {recipes.map((r: Recipe) => (
                  <tr key={r.id} className="border-b border-[var(--color-border)] last:border-0">
                    <td className="px-4 py-3 font-medium">{r.bake}</td>
                    <td className="px-4 py-3">
                      {r.siteId ? siteName(r.siteId) : <span className="text-[var(--color-muted-foreground)]">Global</span>}
                    </td>
                    <td className="px-4 py-3 tabular-nums">v{r.version}</td>
                    <td className="px-4 py-3">{formatDate(r.effectiveFrom)}</td>
                    <td className="px-4 py-3">{r.effectiveTo ? formatDate(r.effectiveTo) : '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
