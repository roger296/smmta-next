import * as React from 'react';
import { createFileRoute } from '@tanstack/react-router';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { useToast } from '@/hooks/use-toast';
import {
  useMarketplaceImport,
  type MarketplaceImportConfig,
} from '@/features/integrations/use-integrations';

export const Route = createFileRoute('/_authed/integrations/marketplace')({
  component: MarketplacePage,
});

function MarketplacePage() {
  return (
    <div className="max-w-3xl space-y-6">
      <div>
        <h1 className="text-2xl font-semibold">Marketplace import</h1>
        <p className="text-sm text-[var(--color-muted-foreground)]">
          Pull orders from a connected marketplace.
        </p>
      </div>
      <Tabs defaultValue="shopify">
        <TabsList>
          <TabsTrigger value="shopify">Shopify</TabsTrigger>
          <TabsTrigger value="ebay">eBay</TabsTrigger>
          <TabsTrigger value="etsy">Etsy</TabsTrigger>
        </TabsList>
        <TabsContent value="shopify">
          <ShopifyPanel />
        </TabsContent>
        <TabsContent value="ebay">
          <EbayPanel />
        </TabsContent>
        <TabsContent value="etsy">
          <EtsyPanel />
        </TabsContent>
      </Tabs>
    </div>
  );
}

function ShopifyPanel() {
  const { toast } = useToast();
  const [shopDomain, setShopDomain] = React.useState('');
  const [accessToken, setAccessToken] = React.useState('');
  const [sinceId, setSinceId] = React.useState('');
  const importMutation = useMarketplaceImport();

  return (
    <Card>
      <CardHeader>
        <CardTitle>Shopify configuration</CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="space-y-1.5">
          <Label htmlFor="sh-domain">Shop domain</Label>
          <Input
            id="sh-domain"
            value={shopDomain}
            onChange={(e) => setShopDomain(e.target.value)}
            placeholder="mystore.myshopify.com"
          />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="sh-token">Access token</Label>
          <Input
            id="sh-token"
            type="password"
            value={accessToken}
            onChange={(e) => setAccessToken(e.target.value)}
          />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="sh-sinceid">Since order ID (optional)</Label>
          <Input id="sh-sinceid" value={sinceId} onChange={(e) => setSinceId(e.target.value)} />
        </div>
        <div className="flex justify-end">
          <Button
            disabled={!shopDomain || !accessToken || importMutation.isPending}
            onClick={async () => {
              try {
                const result = await importMutation.mutateAsync({
                  channel: 'SHOPIFY',
                  shopDomain,
                  accessToken,
                  sinceId: sinceId || undefined,
                } satisfies MarketplaceImportConfig);
                toast({
                  title: 'Import finished',
                  description: `Imported ${result.imported}, skipped ${result.skipped}`,
                });
              } catch (err) {
                toast({
                  variant: 'destructive',
                  title: 'Import failed',
                  description: err instanceof Error ? err.message : 'Unknown',
                });
              }
            }}
          >
            {importMutation.isPending ? 'Importing…' : 'Import Shopify orders'}
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}

function EbayPanel() {
  const { toast } = useToast();
  const [accessToken, setAccessToken] = React.useState('');
  const importMutation = useMarketplaceImport();
  return (
    <Card>
      <CardHeader>
        <CardTitle>eBay configuration</CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="space-y-1.5">
          <Label htmlFor="eb-token">Access token</Label>
          <Input
            id="eb-token"
            type="password"
            value={accessToken}
            onChange={(e) => setAccessToken(e.target.value)}
          />
        </div>
        <div className="flex justify-end">
          <Button
            disabled={!accessToken || importMutation.isPending}
            onClick={async () => {
              try {
                const result = await importMutation.mutateAsync({
                  channel: 'EBAY',
                  accessToken,
                });
                toast({
                  title: 'Import finished',
                  description: `Imported ${result.imported}, skipped ${result.skipped}`,
                });
              } catch (err) {
                toast({
                  variant: 'destructive',
                  title: 'Failed',
                  description: err instanceof Error ? err.message : 'Unknown',
                });
              }
            }}
          >
            {importMutation.isPending ? 'Importing…' : 'Import eBay orders'}
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}

function EtsyPanel() {
  const { toast } = useToast();
  const [accessToken, setAccessToken] = React.useState('');
  const [sellerId, setSellerId] = React.useState('');
  const importMutation = useMarketplaceImport();
  return (
    <Card>
      <CardHeader>
        <CardTitle>Etsy configuration</CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="space-y-1.5">
          <Label htmlFor="et-token">Access token</Label>
          <Input
            id="et-token"
            type="password"
            value={accessToken}
            onChange={(e) => setAccessToken(e.target.value)}
          />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="et-seller">Seller ID</Label>
          <Input id="et-seller" value={sellerId} onChange={(e) => setSellerId(e.target.value)} />
        </div>
        <div className="flex justify-end">
          <Button
            disabled={!accessToken || !sellerId || importMutation.isPending}
            onClick={async () => {
              try {
                const result = await importMutation.mutateAsync({
                  channel: 'ETSY',
                  accessToken,
                  sellerId,
                });
                toast({
                  title: 'Import finished',
                  description: `Imported ${result.imported}, skipped ${result.skipped}`,
                });
              } catch (err) {
                toast({
                  variant: 'destructive',
                  title: 'Failed',
                  description: err instanceof Error ? err.message : 'Unknown',
                });
              }
            }}
          >
            {importMutation.isPending ? 'Importing…' : 'Import Etsy orders'}
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}
