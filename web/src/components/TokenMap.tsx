import { useMemo, useState } from 'react';
import { Search, UserPlus, Trash2 } from 'lucide-react';
import { useStore } from '../store';
import { getCategoryStyle } from '../lib/colors';
import { cn } from '../lib/cn';

/**
 * Content-only body of the token map — search, add-customer, list.
 *
 * Extracted from the legacy `<TokenMap>` so the new `<TokenMapDrawer>` can host
 * the same UX inside a Radix dialog without inheriting the outer
 * `border-t` / panel padding that made sense in the middle-column layout.
 */
export function TokenMapBody(): JSX.Element {
  const tokens = useStore((s) => s.tokens);
  const tokenUnion = useStore((s) => s.tokenUnion);
  const vocab = useStore((s) => s.vocab);
  const addCustomerName = useStore((s) => s.addCustomerName);
  const forgetVocab = useStore((s) => s.forgetVocab);

  const [query, setQuery] = useState('');
  const [newCustomer, setNewCustomer] = useState('');

  const rows = useMemo(() => {
    const seen = new Set<string>();
    type Row = { token: string; realValue: string; category: string; fromCurrent: boolean };
    const out: Row[] = [];
    for (const t of tokens) {
      if (seen.has(t.token)) continue;
      seen.add(t.token);
      out.push({
        token: t.token,
        realValue: t.realValue,
        category: t.category,
        fromCurrent: true,
      });
    }
    for (const [tok, t] of tokenUnion) {
      if (seen.has(tok)) continue;
      seen.add(tok);
      out.push({ token: tok, realValue: t.realValue, category: t.category, fromCurrent: false });
    }
    for (const v of vocab) {
      if (seen.has(v.token)) continue;
      seen.add(v.token);
      out.push({
        token: v.token,
        realValue: v.real_value,
        category: v.category,
        fromCurrent: false,
      });
    }
    const q = query.trim().toLowerCase();
    if (!q) return out;
    return out.filter(
      (r) =>
        r.token.toLowerCase().includes(q) ||
        r.realValue.toLowerCase().includes(q) ||
        r.category.toLowerCase().includes(q),
    );
  }, [tokens, tokenUnion, vocab, query]);

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-2">
      <div className="flex items-center justify-between">
        <span className="text-[11px] uppercase tracking-wider text-zinc-500">
          {rows.length} {rows.length === 1 ? 'entry' : 'entries'}
        </span>
      </div>

      <div className="flex gap-2">
        <div className="relative flex-1">
          <Search className="pointer-events-none absolute left-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-zinc-500" />
          <input
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="search token / value / category"
            className="w-full rounded-md border border-zinc-800 bg-zinc-900/60 py-1.5 pl-7 pr-2 text-xs placeholder:text-zinc-600 focus:outline-none focus:ring-2 focus:ring-indigo-500/40"
          />
        </div>
      </div>

      <form
        onSubmit={(e) => {
          e.preventDefault();
          const v = newCustomer.trim();
          if (!v) return;
          void addCustomerName(v);
          setNewCustomer('');
        }}
        className="flex gap-2"
      >
        <input
          type="text"
          value={newCustomer}
          onChange={(e) => setNewCustomer(e.target.value)}
          placeholder="add a customer name"
          className="flex-1 rounded-md border border-zinc-800 bg-zinc-900/60 px-2 py-1.5 text-xs placeholder:text-zinc-600 focus:outline-none focus:ring-2 focus:ring-indigo-500/40"
        />
        <button
          type="submit"
          disabled={!newCustomer.trim()}
          className={cn(
            'flex items-center gap-1 rounded-md border px-2 py-1.5 text-xs',
            newCustomer.trim()
              ? 'border-indigo-700 bg-indigo-900/40 text-indigo-200 hover:bg-indigo-900/60'
              : 'cursor-not-allowed border-zinc-800 bg-zinc-900/40 text-zinc-600',
          )}
          title="Mint a token for this customer name"
        >
          <UserPlus className="h-3.5 w-3.5" /> add
        </button>
      </form>

      <div className="min-h-0 flex-1 overflow-auto rounded-md border border-zinc-800 bg-zinc-900/30">
        {rows.length === 0 ? (
          <div className="flex h-full min-h-[160px] flex-col items-center justify-center gap-2 p-6 text-center">
            <p className="text-sm text-zinc-400">No tokens yet</p>
            <p className="max-w-[280px] text-xs text-zinc-500">
              Tokens appear here when names, emails, IPs, or other PII are detected. Or add
              a customer name above to mint one now.
            </p>
          </div>
        ) : (
          <ul className="divide-y divide-zinc-800">
            {rows.map((r) => {
              const style = getCategoryStyle(r.category);
              return (
                <li
                  key={r.token}
                  className="group flex items-center gap-2 px-2 py-1.5 text-xs"
                >
                  <span
                    className={cn(
                      'inline-block rounded border px-1.5 py-0.5 font-mono',
                      style.bg,
                      style.border,
                      style.text,
                    )}
                  >
                    {r.token}
                  </span>
                  <span className="text-zinc-600">→</span>
                  <span
                    className={cn(
                      'flex-1 truncate font-mono text-zinc-200',
                      r.fromCurrent ? '' : 'text-zinc-400',
                    )}
                    title={r.realValue}
                  >
                    {r.realValue}
                  </span>
                  <span
                    className="text-[10px] uppercase tracking-wider text-zinc-500"
                    title={r.category}
                  >
                    {r.category}
                  </span>
                  <button
                    type="button"
                    onClick={() => void forgetVocab(r.realValue)}
                    className="rounded p-0.5 text-zinc-600 opacity-0 transition-opacity hover:bg-zinc-800 hover:text-red-300 group-hover:opacity-100"
                    aria-label={`forget ${r.realValue}`}
                    title="forget (remove from vocab)"
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                  </button>
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </div>
  );
}

/**
 * Legacy panel wrapper — kept for back-compat / tests, no longer used in App.
 * The token map now lives in `<TokenMapDrawer>`.
 */
export function TokenMap(): JSX.Element {
  return (
    <section className="flex min-h-0 flex-col gap-2 border-t border-zinc-800 p-4">
      <header className="flex items-center justify-between">
        <h2 className="text-xs font-semibold uppercase tracking-wider text-zinc-400">
          Token map
        </h2>
      </header>
      <TokenMapBody />
    </section>
  );
}
