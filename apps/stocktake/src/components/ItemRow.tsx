import type { CountEntry } from '../lib/types';

interface ItemRowProps {
  name: string;
  hint: string | null;
  isCustom: boolean;
  entry: CountEntry | undefined;
  onSet: (quantity: number) => void;
  onType: () => void;
}

/** One count line: status dot, name + pack hint, then the fast-entry controls
 *  (− / value / + / big 0). Tapping the value opens the keypad for odd numbers. */
export function ItemRow({ name, hint, isCustom, entry, onSet, onType }: ItemRowProps) {
  const counted = entry?.counted ?? false;
  const qty = entry?.quantity ?? 0;

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
      </div>
    </div>
  );
}
