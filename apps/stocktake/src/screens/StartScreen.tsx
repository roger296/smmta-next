import { useState } from 'react';
import { PERIOD, SITES } from '../lib/catalogue';
import { newDeviceId } from '../lib/storage';
import type { Session } from '../lib/types';

interface StartScreenProps {
  initial: Partial<Session> | null;
  onStart: (session: Session) => void;
  onOpenAdmin: () => void;
}

/** First screen: the counter picks their site, types their name, and (once per
 *  iPad) the shared access code. Everything is remembered for next time. */
export function StartScreen({ initial, onStart, onOpenAdmin }: StartScreenProps) {
  const [site, setSite] = useState(initial?.siteSlug ?? '');
  const [name, setName] = useState(initial?.counterName ?? '');
  const [code, setCode] = useState(initial?.accessCode ?? '');

  const ready = site && name.trim().length > 0;

  const start = () => {
    if (!ready) return;
    onStart({
      deviceId: initial?.deviceId ?? newDeviceId(),
      accessCode: code.trim(),
      period: PERIOD,
      siteSlug: site,
      counterName: name.trim(),
    });
  };

  return (
    <div className="center">
      <h1>Stock take</h1>
      <p className="lede">{PERIOD.replace('-', ' ')} · pick your site and pop your name in to begin.</p>

      <div className="field">
        <label>Your site</label>
        <div className="site-grid">
          {SITES.map((s) => (
            <button
              key={s.slug}
              className={`site-btn${site === s.slug ? ' on' : ''}`}
              onClick={() => setSite(s.slug)}
            >
              {s.name}
            </button>
          ))}
        </div>
      </div>

      <div className="field">
        <label>Your name</label>
        <input
          className="input"
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="e.g. Sam"
          autoCapitalize="words"
        />
      </div>

      <div className="field">
        <label>Access code</label>
        <input
          className="input"
          value={code}
          onChange={(e) => setCode(e.target.value)}
          placeholder="from head office"
          autoCapitalize="off"
          autoCorrect="off"
        />
      </div>

      <button className="btn solid" disabled={!ready} onClick={start} style={{ opacity: ready ? 1 : 0.5 }}>
        Start counting
      </button>

      <button className="linkbtn" style={{ display: 'block', margin: '18px auto 0' }} onClick={onOpenAdmin}>
        Head office: consolidate &amp; export →
      </button>
    </div>
  );
}
