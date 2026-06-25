import { useState } from 'react';
import type { CountEntry } from '../lib/types';
import { partUnit } from '../lib/fractions';

interface ItemRowProps {
  name: string;
  hint: string | null;
  isCustom: boolean;
  entry: CountEntry | undefined;
  onSet: (quantity: number) => void;
  onType: () => void;
}

const FRACTIONS: Array<{ label: string; value: number }> = [
  { label: '¼', value: 0.25 },
  { label: '½', value: 0.5 },
  { label: '¾', value: 0.75 },
];

/** One count line: status dot, name + pack hint, then the fast-entry controls
 *  (− / value / + / big 0). The "½" unlock button reveals ¼ ½ ¾ for part-units
 *  (e.g. half a 10kg fondant block) — hidden by default so the common case
 *  stays whole-number only. A fraction adds to the whole count (4 + ½ = 4.5);
 *  tapping the active fraction again clears it back to the whole number. */
export function ItemRow({ name, hint, isCustom, entry, onSet, onType }: ItemRowProps) {
  const [fracOpen, setFracOpen] = useState(false);
  const counted = entry?.counted ?? false;
  const qty = entry?.quantity ?? 0;

  const current = counted ? qty : 0;
  const whole = Math.floor(current);
  const remainder = Math.round((current - whole) * 100) / 100;

  const applyFraction = (f: number) => onSet(partUnit(current, f));

  return (
    <div className={`row${counted ? ' counted' : ''}`}>
      <div className="status" aria-hidden="true">
        {isCustom ? (
          <span className="status-custom">+</span>
        ) : counted ? (
          <span className="status-done">●</span>
        ) : (
          <span className="status-todo">○</span>
        )}
      </div>

      <div className="meta">
        <div className="name">
          {name}
          {isCustom && <span className="badge-added">added</span>}
        </div>
        {hint && <div className="hint">{hint}</div>}
      </div>

      <div className="qty-controls">
        <button
          className="step"
          aria-label={`Decrease ${name}`}
          onClick={() => onSet(Math.max(0, (counted ? qty : 0) - 1))}
        >
          −
        </button>
        <button
          className={`qty-value${counted ? '' : ' todo'}`}
          aria-label={`Type quantity for ${name}`}
          onClick={onType}
        >
          {counted ? qty : '—'}
        </button>
        <button
          className="step"
          aria-label={`Increase ${name}`}
          onClick={() => onSet((counted ? qty : 0) + 1)}
        >
          +
        </button>
        <button className="zero" aria-label={`Set ${name} to zero`} onClick={() => onSet(0)}>
          0
        </button>

        {fracOpen ? (
          <span className="fracs" role="group" aria-label={`Part quantity for ${name}`}>
            {FRACTIONS.map((f) => (
              <button
                key={f.label}
                className={`frac${Math.abs(remainder - f.value) < 0.001 ? ' on' : ''}`}
                aria-label={`${f.label} unit for ${name}`}
                onClick={() => applyFraction(f.value)}
              >
                {f.label}
              </button>
            ))}
          </span>
        ) : (
          <button
            className="unlock"
            aria-label={`Add a part-unit for ${name}`}
            onClick={() => setFracOpen(true)}
          >
            ½
          </button>
        )}
      </div>
    </div>
  );
}
