import * as React from 'react';
import { createFileRoute, Link, useNavigate } from '@tanstack/react-router';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Field } from '@/components/forms/form-field';
import { useToast } from '@/hooks/use-toast';
import { useCreateProductGroup } from '@/features/product-groups/use-product-groups';
import { ArrowLeft } from 'lucide-react';

export const Route = createFileRoute('/_authed/product-groups/new')({
  component: NewProductGroupPage,
});

function NewProductGroupPage() {
  const navigate = useNavigate();
  const { toast } = useToast();
  const create = useCreateProductGroup();

  const [name, setName] = React.useState('');
  const [description, setDescription] = React.useState('');

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!name.trim()) return;
    try {
      const group = await create.mutateAsync({
        name: name.trim(),
        description: description.trim() || undefined,
      });
      toast({ title: 'Product group created' });
      navigate({ to: '/product-groups/$id', params: { id: group.id } });
    } catch (err) {
      toast({
        variant: 'destructive',
        title: 'Create failed',
        description: err instanceof Error ? err.message : 'Unknown error',
      });
    }
  };

  return (
    <div className="space-y-6">
      <div>
        <Link
          to="/product-groups"
          className="mb-2 inline-flex items-center text-sm text-[var(--color-muted-foreground)] hover:underline"
        >
          <ArrowLeft className="mr-1 h-3 w-3" />
          Product groups
        </Link>
        <h1 className="text-2xl font-semibold">New product group</h1>
        <p className="text-sm text-[var(--color-muted-foreground)]">
          Start with a name. You can fill in storefront content (slug, hero image, SEO, etc.) on
          the next screen.
        </p>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Basics</CardTitle>
        </CardHeader>
        <CardContent>
          <form onSubmit={handleSubmit} aria-label="New product group form" className="space-y-4">
            <Field id="g-new-name" label="Name" required>
              <Input
                id="g-new-name"
                value={name}
                onChange={(e) => setName(e.target.value)}
                maxLength={200}
                required
                autoFocus
              />
            </Field>
            <Field id="g-new-description" label="Internal description">
              <Textarea
                id="g-new-description"
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                rows={2}
                placeholder="Operator-only notes about this group."
              />
            </Field>
            <div className="flex justify-end gap-2">
              <Button asChild type="button" variant="outline">
                <Link to="/product-groups">Cancel</Link>
              </Button>
              <Button type="submit" disabled={create.isPending || !name.trim()}>
                {create.isPending ? 'Creating…' : 'Create group'}
              </Button>
            </div>
          </form>
        </CardContent>
      </Card>
    </div>
  );
}
