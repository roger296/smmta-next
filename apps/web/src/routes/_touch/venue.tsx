import { createFileRoute, useNavigate } from '@tanstack/react-router';
import { useSiteContext } from '@/features/sites/site-context';
import { PwaSyncPill } from '@/features/pwa/queue-status';
import { clearToken } from '@/lib/auth';
import { clearDeviceSite } from '@/features/sites/device-site';
import { TouchScreen, TouchTopbar, BigButton } from '@/components/touch/touch';

export const Route = createFileRoute('/_touch/venue')({
  component: VenueHome,
});

/**
 * Where a PIN sign-in lands (Aug-2026 feedback set, E-2).
 *
 * A successful PIN used to `navigate({ to: '/' })` — the desktop dashboard,
 * inside the admin shell, on a device with no keyboard and no mouse. This is
 * the three-job screen a venue actually needs: the jobs, in big targets, with
 * the venue named across the top so nobody has to wonder which site they are
 * about to write to.
 */
const JOBS = [
  { to: '/pwa/goods-in', label: 'Goods In', hint: 'Book in a delivery' },
  { to: '/pwa/consumption', label: 'End of Bake', hint: 'Record what was used' },
  { to: '/pwa/stock-take', label: 'Stock Take', hint: 'Count what is on the shelf' },
] as const;

function VenueHome() {
  const navigate = useNavigate();
  const { selectedSite, isBound } = useSiteContext();

  const signOut = () => {
    clearToken();
    // The device's site binding is deliberately KEPT — it belongs to the iPad,
    // not to whoever last tapped a PIN in, and the next person should see it
    // named on the sign-in screen (B-5).
    void navigate({ to: '/pin-login' });
  };

  const forgetDevice = () => {
    clearDeviceSite();
    clearToken();
    void navigate({ to: '/pin-login' });
  };

  return (
    <TouchScreen>
      <TouchTopbar
        title="Big Bakes Stock"
        venue={selectedSite?.name ?? null}
        venueBound={isBound}
        right={<PwaSyncPill />}
      />
      <div className="scroll">
        <div className="center">
          <div className="tile-grid venue-jobs">
            {JOBS.map((job) => (
              <button key={job.to} className="tile job" onClick={() => void navigate({ to: job.to })}>
                <span className="job-label">{job.label}</span>
                <span className="job-hint">{job.hint}</span>
              </button>
            ))}
          </div>

          <div style={{ marginTop: 28 }}>
            <BigButton variant="ghost" onClick={signOut}>Sign out</BigButton>
          </div>
          <div style={{ marginTop: 10 }}>
            <button type="button" className="linklike" onClick={forgetDevice}>
              Sign out and forget this venue
            </button>
          </div>
        </div>
      </div>
    </TouchScreen>
  );
}
