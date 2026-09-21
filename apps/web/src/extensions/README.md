# Admin-app extensions

Empty upstream, on purpose. The partner of `apps/api/src/extensions`: screens a business adds to
its own copy of this repo, **in new files**, so a new upstream release never conflicts.

Every folder here with an `index.ts` / `index.tsx` is picked up at build time (`registry.ts`).

```tsx
import { ShieldCheck } from 'lucide-react';
import type { WebExtension } from '../registry';
import { SettingsPage } from './settings-page';
import { OrderPanel } from './order-panel';

const extension: WebExtension = {
  key: 'my_extension',
  pages: { settings: SettingsPage },                       // shown at /x/my_extension/settings
  navItems: [{ label: 'Sign-off settings', page: 'settings', icon: ShieldCheck }],
  orderPanels: [OrderPanel],                               // top of every order page
};

export default extension;
```

Use the core's building blocks (`@/components/ui/*`, `apiFetch` from `@/lib/api-client`,
`@tanstack/react-query`) so your screens look and behave like the rest of the admin. After an
action that changes an order, invalidate `['orders', 'detail', orderId]` and `['orders', 'list']`.
