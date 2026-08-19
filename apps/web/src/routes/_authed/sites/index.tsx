import * as React from 'react';
import { createFileRoute } from '@tanstack/react-router';
import { Plus, MapPin, Pencil } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Badge } from '@/components/ui/badge';
import { Checkbox } from '@/components/ui/checkbox';
import { Card, CardContent } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { EmptyState } from '@/components/empty-state';
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import {
  useSites,
  useCreateSite,
  useUpdateSite,
  type Site,
  type SiteInput,
} from '@/features/sites/use-sites';

export const Route = createFileRoute('/_authed/sites/')({
  component: SitesPage,
});

const EMPTY_FORM: SiteInput = {
  slug: '',
  name: '',
  canonicalName: '',
  currencyCode: 'GBP',
  uomSystem: 'METRIC',
  timezone: 'Europe/London',
  isActive: true,
  benchesPerTable: null,
};

function SitesPage() {
  const { data: sites = [], isLoading, isError, error } = useSites();
  const [dialogOpen, setDialogOpen] = React.useState(false);
  const [editing, setEditing] = React.useState<Site | null>(null);

  const openCreate = () => {
    setEditing(null);
    setDialogOpen(true);
  };
  const openEdit = (site: Site) => {
    setEditing(site);
    setDialogOpen(true);
  };

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold">Sites</h1>
          <p className="text-sm text-[var(--color-muted-foreground)]">
            Locations that hold stock. Currency and unit system are set per site, so adding a
            site (including a US one) needs no code change.
          </p>
        </div>
        <Button onClick={openCreate}>
          <Plus className="h-4 w-4" />
          New site
        </Button>
      </div>

      {isLoading && (
        <Card>
          <CardContent className="space-y-2 p-6">
            <Skeleton className="h-10 w-full" />
            <Skeleton className="h-10 w-full" />
          </CardContent>
        </Card>
      )}
      {isError && (
        <Card>
          <CardContent className="p-6" role="alert">
            <p className="text-sm text-[var(--color-destructive)]">
              Failed to load: {error instanceof Error ? error.message : 'Unknown error'}
            </p>
          </CardContent>
        </Card>
      )}
      {!isLoading && !isError && sites.length === 0 && (
        <EmptyState
          icon={MapPin}
          title="No sites yet"
          action={
            <Button onClick={openCreate}>
              <Plus className="h-4 w-4" />
              New site
            </Button>
          }
        />
      )}
      {!isLoading && !isError && sites.length > 0 && (
        <Card>
          <CardContent className="p-0">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-[var(--color-border)] text-left text-[var(--color-muted-foreground)]">
                  <th className="px-4 py-3 font-medium">Name</th>
                  <th className="px-4 py-3 font-medium">Slug</th>
                  <th className="px-4 py-3 font-medium">Currency</th>
                  <th className="px-4 py-3 font-medium">Units</th>
                  <th className="px-4 py-3 font-medium">Timezone</th>
                  <th className="px-4 py-3 font-medium">Status</th>
                  <th className="px-4 py-3" />
                </tr>
              </thead>
              <tbody>
                {sites.map((site) => (
                  <tr key={site.id} className="border-b border-[var(--color-border)] last:border-0">
                    <td className="px-4 py-3 font-medium">{site.name}</td>
                    <td className="px-4 py-3 font-mono text-xs">{site.slug}</td>
                    <td className="px-4 py-3">{site.currencyCode}</td>
                    <td className="px-4 py-3">{site.uomSystem}</td>
                    <td className="px-4 py-3">{site.timezone}</td>
                    <td className="px-4 py-3">
                      <Badge variant={site.isActive ? 'default' : 'secondary'}>
                        {site.isActive ? 'Active' : 'Inactive'}
                      </Badge>
                    </td>
                    <td className="px-4 py-3 text-right">
                      <Button variant="ghost" size="sm" onClick={() => openEdit(site)}>
                        <Pencil className="h-4 w-4" />
                        Edit
                      </Button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </CardContent>
        </Card>
      )}

      <SiteFormDialog
        open={dialogOpen}
        onOpenChange={setDialogOpen}
        editing={editing}
      />
    </div>
  );
}

function SiteFormDialog({
  open,
  onOpenChange,
  editing,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  editing: Site | null;
}) {
  const createSite = useCreateSite();
  const updateSite = useUpdateSite();
  const [form, setForm] = React.useState<SiteInput>(EMPTY_FORM);
  const [errorMsg, setErrorMsg] = React.useState<string | null>(null);

  // Reset the form whenever the dialog opens (for create or a specific edit).
  React.useEffect(() => {
    if (!open) return;
    setErrorMsg(null);
    if (editing) {
      setForm({
        slug: editing.slug,
        name: editing.name,
        canonicalName: editing.canonicalName,
        currencyCode: editing.currencyCode,
        uomSystem: editing.uomSystem,
        timezone: editing.timezone,
        isActive: editing.isActive,
        benchesPerTable: editing.benchesPerTable ? Number(editing.benchesPerTable) : null,
      });
    } else {
      setForm(EMPTY_FORM);
    }
  }, [open, editing]);

  const set = <K extends keyof SiteInput>(key: K, value: SiteInput[K]) =>
    setForm((f) => ({ ...f, [key]: value }));

  const pending = createSite.isPending || updateSite.isPending;

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setErrorMsg(null);
    try {
      if (editing) {
        await updateSite.mutateAsync({ id: editing.id, input: form });
      } else {
        await createSite.mutateAsync(form);
      }
      onOpenChange(false);
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : 'Save failed');
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{editing ? 'Edit site' : 'New site'}</DialogTitle>
        </DialogHeader>
        <form onSubmit={handleSubmit} className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="site-name">Name</Label>
            <Input
              id="site-name"
              value={form.name}
              onChange={(e) => set('name', e.target.value)}
              required
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="site-slug">Slug</Label>
            <Input
              id="site-slug"
              value={form.slug}
              onChange={(e) => set('slug', e.target.value)}
              placeholder="london-east"
              required
            />
            <p className="text-xs text-[var(--color-muted-foreground)]">
              Lowercase, hyphen-separated. Aligns with BumbleBee's canonical site.
            </p>
          </div>
          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-2">
              <Label htmlFor="site-currency">Currency</Label>
              <Input
                id="site-currency"
                value={form.currencyCode}
                onChange={(e) => set('currencyCode', e.target.value.toUpperCase())}
                maxLength={3}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="site-uom">Unit system</Label>
              <Select
                value={form.uomSystem}
                onValueChange={(v) => set('uomSystem', v as 'METRIC' | 'IMPERIAL')}
              >
                <SelectTrigger id="site-uom">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="METRIC">Metric (g, kg)</SelectItem>
                  <SelectItem value="IMPERIAL">Imperial (oz, lb)</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>
          <div className="space-y-2">
            <Label htmlFor="site-tz">Timezone</Label>
            <Input
              id="site-tz"
              value={form.timezone}
              onChange={(e) => set('timezone', e.target.value)}
              placeholder="Europe/London"
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="site-benches">Benches per table</Label>
            <Input
              id="site-benches"
              type="number"
              step="any"
              min="0"
              value={form.benchesPerTable ?? ''}
              onChange={(e) =>
                set('benchesPerTable', e.target.value === '' ? null : Number(e.target.value))
              }
              placeholder="e.g. 6"
            />
            {/* F-7: bakers set up and count in benches, but the recipe and the
                session are in tables. Left blank the venue screens say
                "benches not set for this venue" rather than assuming a number. */}
            <p className="text-xs text-[var(--color-muted-foreground)]">
              Shown under the kilo figures on the End of Bake screen. Leave blank if this venue
              does not use benches.
            </p>
          </div>
          <div className="flex items-center gap-2">
            <Checkbox
              id="site-active"
              checked={form.isActive}
              onCheckedChange={(c) => set('isActive', c === true)}
            />
            <Label htmlFor="site-active">Active</Label>
          </div>
          {errorMsg && (
            <p className="text-sm text-[var(--color-destructive)]" role="alert">
              {errorMsg}
            </p>
          )}
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" disabled={pending}>
              {pending ? 'Saving…' : editing ? 'Save changes' : 'Create site'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
