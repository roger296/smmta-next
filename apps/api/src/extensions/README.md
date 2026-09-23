# Extensions

This folder is empty upstream, on purpose.

It is where a business that runs its own copy of this repo keeps behaviour that is its own and
nobody else's, **in new files**, so that taking a new upstream release never conflicts with it.
Every sub-folder with an `index.ts` is loaded at start-up by the API and by the worker
(`apps/api/src/shared/extensions/load.ts`).

```
apps/api/src/extensions/
  my_extension/
    index.ts          default-exports an ApiExtension
    migrations/       its own drizzle migrations (optional)
    ...
```

```ts
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ApiExtension } from '../../shared/extensions/load.js';
import { registerOrderHoldCheck } from '../../modules/orders/order-hold.service.js';

const here = dirname(fileURLToPath(import.meta.url));

const extension: ApiExtension = {
  key: 'my_extension',                       // lower-case, digits, underscores
  migrationsFolder: join(here, 'migrations'), // recorded in __ext_my_extension_migrations
  setup() {
    // Runs in the API and in the worker. Asked about every new order, inside the
    // transaction that creates it; answer with a hold, or null to let it through.
    registerOrderHoldCheck(async (tx, order) =>
      order.warehouseId === '…' ? { holderKey: 'my_extension', reason: 'Waiting for sign-off' } : null,
    );
  },
  async registerApi(app) {
    // Mounted under /api/v1. Add requireAuth yourself, as the core routes do.
    app.get('/my-extension/ping', async () => ({ success: true }));
  },
};

export default extension;
```

## What an extension can build on

- **Order holds** (`modules/orders/order-hold.service.ts`). A held order keeps its status and is
  allocated stock as usual, but gets no pick note and no label and cannot ship. `place` and
  `release` a hold under your own `holderKey`; when an order's last hold is released the core
  emits `order.released` and makes the documents it was denied. `registerOrderHoldCheck` holds a
  new order as it is created, whatever route it came in by.
- **Domain events** (`shared/events`). Emit your own inside your transactions; react to the
  core's from `registerWorker` with `reactToEvent(eventType, '<key>-<name>', handler, logger)`
  (`shared/extensions/react.ts`): your handler runs on its own queue with the core's exactly-once
  and retry behaviour, and is given the event row. `order.lines_changed`, `order.released`,
  `order.held`, `order.allocated` and `order.dispatched` are the ones most worth reacting to.
- **Your own tables**, in your own migrations folder. Prefix table names with your key. Your
  migrations are tracked in their own table, so they never collide with the core's numbering.

The admin app has the matching folder: `apps/web/src/extensions`.

## Rules of the road

- New files only. If the core needs to change for you, change the core upstream — add the
  setting or the hook there, for everyone — and use it from here.
- An extension that throws while loading stops the API starting, the same as a failed core
  migration. That is deliberate: better no service than one silently missing its rules.
