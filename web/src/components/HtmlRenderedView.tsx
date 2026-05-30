import { useMemo } from 'react';
import type { Token } from '../api';
import { sanitizeHtmlWithTokens } from '../lib/sanitizeHtmlWithTokens';
import { cn } from '../lib/cn';

type Props = {
  html: string;
  tokens: Token[];
  className?: string;
};

export function HtmlRenderedView({ html, tokens, className }: Props): JSX.Element {
  const tokensKey = useMemo(
    () => tokens.map((t) => `${t.token}\u0001${t.realValue}\u0001${t.category}`).join('\u0002'),
    [tokens],
  );

  const sanitized = useMemo(() => {
    const map = new Map(tokens.map((t) => [t.token, t]));
    return sanitizeHtmlWithTokens(html, map);
  }, [html, tokensKey]);

  return (
    <div className={cn('flex h-full min-h-0 flex-col', className)}>
      <iframe
        srcDoc={sanitized}
        sandbox=""
        referrerPolicy="no-referrer"
        loading="eager"
        title="Rendered HTML preview"
        className="h-full w-full rounded-md border border-zinc-800 bg-white"
      />
      <p className="mt-1 text-[10px] text-zinc-500">
        Links and scripts disabled. Switch to <span className="font-semibold">Source</span>{' '}
        to mint new tokens from selection.
      </p>
    </div>
  );
}
