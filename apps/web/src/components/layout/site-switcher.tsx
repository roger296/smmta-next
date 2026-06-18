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
        <SelectTrigger className="h-8 w-44" aria-label="Active site">
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
