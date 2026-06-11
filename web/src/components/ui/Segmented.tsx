import * as React from 'react';

/**
 * Shared Segmented control (and roving hook) for radiogroup a11y.
 * - Roving tabindex: only the active/checked radio is in tab order (tabIndex 0).
 * - Arrow/Home/End navigation per ARIA radio group / segmented control pattern.
 * - orientation controls arrow axis (horizontal: Left/Right; vertical: Up/Down).
 * - Click still works; onChange fires for both.
 * - Used by ScrubSend (reply + header mode), Review (filter), Settings (channel + mode via hook).
 *
 * Acceptance for #91: keyboard-only users can change mode (and other segmented) with arrows;
 * cannot Tab out of modals (handled by Radix in the dialog files).
 */
export function useRovingRadio<T extends string>(
  options: ReadonlyArray<{ value: T }>,
  value: T,
  onChange: (v: T) => void,
  orientation: 'horizontal' | 'vertical' = 'horizontal',
): {
  getTabIndex: (v: T) => 0 | -1;
  onKeyDown: (e: React.KeyboardEvent<HTMLElement>) => void;
} {
  const currentIndex = options.findIndex((o) => o.value === value);

  const getTabIndex = (v: T): 0 | -1 => (v === value ? 0 : -1);

  const move = (delta: number) => {
    if (options.length === 0) return;
    let next = currentIndex + delta;
    if (next < 0) next = options.length - 1;
    if (next >= options.length) next = 0;
    onChange(options[next].value);
  };

  const goHome = () => {
    if (options.length > 0) onChange(options[0].value);
  };
  const goEnd = () => {
    if (options.length > 0) onChange(options[options.length - 1].value);
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLElement>) => {
    const isVertical = orientation === 'vertical';
    switch (e.key) {
      case 'ArrowRight':
      case 'ArrowDown': {
        const forward = isVertical ? e.key === 'ArrowDown' : e.key === 'ArrowRight';
        if (forward) {
          e.preventDefault();
          move(1);
        }
        break;
      }
      case 'ArrowLeft':
      case 'ArrowUp': {
        const backward = isVertical ? e.key === 'ArrowUp' : e.key === 'ArrowLeft';
        if (backward) {
          e.preventDefault();
          move(-1);
        }
        break;
      }
      case 'Home':
        e.preventDefault();
        goHome();
        break;
      case 'End':
        e.preventDefault();
        goEnd();
        break;
      default:
        break;
    }
  };

  return { getTabIndex, onKeyDown };
}

export function Segmented<T extends string>({
  label,
  value,
  options,
  onChange,
  orientation = 'horizontal',
}: {
  label: string;
  value: T;
  options: ReadonlyArray<{ value: T; label: string; icon?: JSX.Element }>;
  onChange: (v: T) => void;
  orientation?: 'horizontal' | 'vertical';
}): JSX.Element {
  const { getTabIndex, onKeyDown } = useRovingRadio(options, value, onChange, orientation);

  const flex = orientation === 'vertical' ? 'flex-col items-stretch' : 'items-center';

  return (
    <div
      role="radiogroup"
      aria-label={label}
      className={`inline-flex ${flex} gap-0.5 rounded-lg border border-border bg-surface-2 p-0.5`}
      onKeyDown={onKeyDown}
    >
      {options.map((opt) => {
        const active = opt.value === value;
        return (
          <button
            key={opt.value}
            type="button"
            role="radio"
            aria-checked={active}
            tabIndex={getTabIndex(opt.value)}
            onClick={() => onChange(opt.value)}
            className="flex items-center gap-1 rounded-md px-2.5 py-1 text-[12px] font-medium transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-[var(--acc)]"
            style={
              active
                ? { background: 'var(--acc-tint)', color: 'var(--acc)' }
                : { color: 'var(--text-dim)' }
            }
          >
            {opt.icon}
            {opt.label}
          </button>
        );
      })}
    </div>
  );
}
