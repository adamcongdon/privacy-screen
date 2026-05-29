import { useMemo, useState } from 'react';
import { Search, UserPlus, Trash2 } from 'lucide-react';
import { useStore } from '../store';
import { getCategoryStyle } from '../lib/colors';
import { cn } from '../lib/cn';

export function TokenMap(): JSX.Element {
  const tokens = useStore((s) => s.tokens);
  const tokenUnion = useStore((s) => s.tokenUnion);
  const vocab = useStore((s) => s.vocab);
  const addCustomerName = useStore((s) => s.addCustomerName);
  const forgetVocab = useStore((s) => s.forgetVocab);

  const [query, setQuery] = useState('');
  const [newCustomer, setNewCustomer] = useState('');

  // Merge tokens active in the current preview with the cross-session union.
  // Current-preview tokens display first so the user immediately sees what's
  // in their composer; vocab fills the long tail.
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
    // Anything in vocab DB that we haven't already seen (older sessions).
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
    <section className="flex min-h-0 flex-col gap-2 border-t border-zinc-800 p-4">
      <header className="flex items-center justify-between">
        <h2 className="text-xs font-semibold uppercase tracking-wider text-zinc-400">
          Token map
        </h2>
        <span className="text-[11px] uppercase tracking-wider text-zinc-500">
          {rows.length} entries
        </span>
      </header>

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
          <p className="p-3 text-xs text-zinc-500">No tokens yet.</p>
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
    </section>
  );
}
