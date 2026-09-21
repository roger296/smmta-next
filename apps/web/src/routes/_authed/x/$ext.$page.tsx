import { createFileRoute } from '@tanstack/react-router';
import { Puzzle } from 'lucide-react';
import { EmptyState } from '@/components/empty-state';
import { extensionPage } from '@/extensions/registry';

/** A screen supplied by an extension (apps/web/src/extensions). */
export const Route = createFileRoute('/_authed/x/$ext/$page')({
  component: ExtensionPage,
});

function ExtensionPage() {
  const { ext, page } = Route.useParams();
  const Page = extensionPage(ext, page);
  if (!Page) return <EmptyState icon={Puzzle} title="Page not found" description="This deployment has no such screen." />;
  return <Page />;
}
