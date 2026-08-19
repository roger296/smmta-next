import { MapPin } from 'lucide-react';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { useSiteContext } from '@/features/sites/site-context';

/**
 * Header site switcher (P2, spec §A5). Drives the active site for the stock
 * screens via SiteContext. Hidden until at least one site exists.
 */
export function SiteSwitcher() {
  const { sites, selectedSiteId, setSelectedSiteId, isLoading } = useSiteContext();

  if (isLoading || sites.length === 0) {
    return null;
  }

  return (
    <div className="flex items-center gap-2">
      <MapPin className="h-4 w-4 text-[var(--color-muted-foreground)]" aria-hidden />
      <Select value={selectedSiteId ?? undefined} onValueChange={setSelectedSiteId}>
        {/*
         * Explicit colours (defect B-6). `SelectTrigger` sets
         * `bg-[var(--color-background)]` — near-white — but sits in the navy
         * header, so it inherited `--color-shell-foreground` (a pale grey
         * meant for a dark ground). Pale grey on near-white is roughly 1.6:1;
         * the venue name was effectively unreadable, on the one control that
         * says where stock is being booked. `--color-foreground` on that
         * background is ~13:1, comfortably past WCAG AA at 14px.
         */}
        <SelectTrigger
          className="h-8 w-44 text-[var(--color-foreground)] [&>span]:text-[var(--color-foreground)]"
          aria-label="Active site"
        >
          <SelectValue placeholder="Select site" />
        </SelectTrigger>
        <SelectContent>
          {sites.map((site) => (
            <SelectItem key={site.id} value={site.id}>
              {site.name}
              {!site.isActive ? ' (inactive)' : ''}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  );
}
