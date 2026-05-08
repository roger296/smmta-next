/**
 * Next.js instrumentation hook — runs once per server process at boot.
 *
 * https://nextjs.org/docs/app/building-your-application/optimizing/instrumentation
 *
 * We use it to initialise Sentry; the helper is idempotent so this is
 * safe even if the file is re-imported during HMR.
 */
export async function register() {
  if (process.env.NEXT_RUNTIME === 'nodejs') {
    const { initSentry } = await import('./lib/sentry');
    await initSentry();
  }
}
