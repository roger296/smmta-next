import * as React from 'react';
import { createFileRoute, useNavigate } from '@tanstack/react-router';
import { clearToken } from '@/lib/auth';
import { useSiteContext } from '@/features/sites/site-context';
import { useAddVenue, useMyVenues, useRemoveVenue } from '@/features/sites/use-my-venues';
import {
  TouchScreen,
  TouchTopbar,
  BigButton,
  ErrorBanner,
  BottomSheet,
} from '@/components/touch/touch';

export const Route = createFileRoute('/_touch/pwa/my-venues')({
  component: MyVenuesScreen,
});

/**
 * "Add location" (Sept-2026 user testing, item 1).
 *
 * "a button on the ipad app marked 'add location' when they press it they see a
 *  list of locations that can be added, they choose one and confirm and from
 *  then on every time they login they will be presented with a modal to choose
 *  their current location."
 *
 * Self-service was the owner's decision, on the condition that it is logged and
 * reversible — so the screen says plainly that head office can see it. Being
 * told that up front is part of what makes self-service safe; discovering it
 * afterwards is not.
 *
 * Adding a venue does NOT widen the token in hand. The server refuses to
 * reissue one on the strength of the narrower token that asked, so the new
 * venue starts working at the next PIN tap — which is what the confirmation
 * tells the baker to do.
 */
export function MyVenuesScreen() {
  const navigate = useNavigate();
  const { selectedSite, isBound } = useSiteContext();
  const venues = useMyVenues();
  const add = useAddVenue();
  const remove = useRemoveVenue();

  const [confirming, setConfirming] = React.useState<{ id: string; name: string } | null>(null);
  const [added, setAdded] = React.useState<string | null>(null);
  const [error, setError] = React.useState<string | null>(null);

  const doRemove = async (siteId: string, name: string) => {
    setError(null);
    try {
      await remove.mutateAsync(siteId);
    } catch (err) {
      // A-1: a failed submission must SAY so. Swallowing this would leave the
      // venue on screen, apparently removed, and still granted on the server.
      setError(
        err instanceof Error ? err.message : `Could not remove ${name}. It is still on your list.`,
      );
    }
  };

  const doAdd = async () => {
    if (!confirming) return;
    setError(null);
    try {
      await add.mutateAsync(confirming.id);
      setAdded(confirming.name);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not add that venue.');
    } finally {
      setConfirming(null);
    }
  };

  return (
    <TouchScreen>
      <TouchTopbar
        title="My venues"
        venue={selectedSite?.name ?? null}
        venueBound={isBound}
        onBack={() => void navigate({ to: '/venue' })}
        stat={venues.data ? `Signed in as ${venues.data.label}` : undefined}
      />
      <div className="scroll">
        {error && (
          <ErrorBanner title="That didn't work" message={error} onDismiss={() => setError(null)} />
        )}

        {venues.isPending && <div className="empty">Loading…</div>}
        {venues.isError && (
          <div className="empty">
            Only a PIN sign-in has venues of its own. Sign in with your PIN to manage them.
          </div>
        )}

        {venues.data && (
          <>
            <h2 className="section-head">Venues you can work at</h2>
            {venues.data.sites.map((v) => (
              <div className="row" key={v.id}>
                <div className="meta">
                  <div className="name">
                    {v.name}
                    {v.isHome && <span className="component">Home</span>}
                  </div>
                  <div className="hint book">
                    {v.isHome
                      ? 'Set by head office — this one cannot be removed here.'
                      : 'Added by you.'}
                  </div>
                </div>
                {!v.isHome && (
                  <div className="qty-controls">
                    <button
                      className="zero"
                      aria-label={`Remove ${v.name}`}
                      disabled={remove.isPending}
                      onClick={() => void doRemove(v.id, v.name)}
                    >
                      Remove
                    </button>
                  </div>
                )}
              </div>
            ))}

            <h2 className="section-head">Add a venue</h2>
            {venues.data.available.length === 0 ? (
              <div className="empty">You can already work at every venue.</div>
            ) : (
              <div className="tile-group">
                <div className="tile-grid">
                  {venues.data.available.map((s) => (
                    <button
                      key={s.id}
                      className="tile"
                      onClick={() => setConfirming({ id: s.id, name: s.name })}
                    >
                      {s.name}
                    </button>
                  ))}
                </div>
              </div>
            )}
            <p className="field-note" style={{ padding: '12px 16px' }}>
              Venues you add are recorded against your PIN and visible to head office, who can
              remove them.
            </p>
          </>
        )}
      </div>

      {confirming && (
        <BottomSheet title={`Add ${confirming.name}?`} onClose={() => setConfirming(null)}>
          <p className="lede">
            You will be able to record deliveries, bakes, counts and wastage at {confirming.name}.
            This is recorded against your PIN and head office can see it.
          </p>
          <div className="sheet-actions">
            <BigButton variant="ghost" onClick={() => setConfirming(null)}>
              Cancel
            </BigButton>
            <BigButton variant="solid" disabled={add.isPending} onClick={() => void doAdd()}>
              {add.isPending ? 'Adding…' : 'Add venue'}
            </BigButton>
          </div>
        </BottomSheet>
      )}

      {added && (
        // Not dismissible to a "done" that would be a lie: the venue is granted
        // but this token predates the grant, so the baker has to sign in again
        // before it works. Saying so here beats a refusal at the shelf.
        <BottomSheet title={`${added} added`} onClose={() => setAdded(null)}>
          <p className="lede">
            Sign in again with your PIN to start working at {added}. You will be asked which venue
            you are at each time you sign in from now on.
          </p>
          <div className="sheet-actions">
            <BigButton variant="ghost" onClick={() => setAdded(null)}>
              Later
            </BigButton>
            <BigButton
              variant="solid"
              onClick={() => {
                clearToken();
                void navigate({ to: '/pin-login' });
              }}
            >
              Sign in again
            </BigButton>
          </div>
        </BottomSheet>
      )}
    </TouchScreen>
  );
}
