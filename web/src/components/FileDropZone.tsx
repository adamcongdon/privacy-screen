import { useCallback, useRef, useState, type ChangeEvent, type DragEvent } from 'react';
import { Paperclip, Upload, X, AlertTriangle, CheckCircle2, FileWarning } from 'lucide-react';
import { useStore, type FileChip } from '../store';
import { cn } from '../lib/cn';

function formatSize(n: number): string {
  if (n < 1024) return `${n}B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)}KB`;
  return `${(n / 1024 / 1024).toFixed(1)}MB`;
}

function ChipStatusIcon({ chip }: { chip: FileChip }) {
  if (chip.error) return <FileWarning className="h-3.5 w-3.5 text-red-400" aria-label="error" />;
  if (chip.hasCredentials)
    return <AlertTriangle className="h-3.5 w-3.5 text-red-400" aria-label="credential detected" />;
  return <CheckCircle2 className="h-3.5 w-3.5 text-emerald-400" aria-label="scrubbed" />;
}

export function FileDropZone(): JSX.Element {
  const files = useStore((s) => s.files);
  const addFiles = useStore((s) => s.addFiles);
  const removeFile = useStore((s) => s.removeFile);
  const [isDragOver, setDragOver] = useState(false);
  const inputRef = useRef<HTMLInputElement | null>(null);

  const onPickClick = useCallback(() => {
    inputRef.current?.click();
  }, []);

  const onInputChange = useCallback(
    (e: ChangeEvent<HTMLInputElement>) => {
      const list = e.target.files;
      if (list && list.length > 0) void addFiles(list);
      // Reset so picking the same file twice in a row still fires onChange.
      e.target.value = '';
    },
    [addFiles],
  );

  const onDragOver = useCallback((e: DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    e.stopPropagation();
    setDragOver(true);
  }, []);

  const onDragLeave = useCallback((e: DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    e.stopPropagation();
    setDragOver(false);
  }, []);

  const onDrop = useCallback(
    (e: DragEvent<HTMLDivElement>) => {
      e.preventDefault();
      e.stopPropagation();
      setDragOver(false);
      const dt = e.dataTransfer;
      if (!dt) return;
      const list = dt.files;
      if (list && list.length > 0) void addFiles(list);
    },
    [addFiles],
  );

  return (
    <div className="flex flex-col gap-2">
      <div
        onDragOver={onDragOver}
        onDragEnter={onDragOver}
        onDragLeave={onDragLeave}
        onDrop={onDrop}
        onClick={onPickClick}
        role="button"
        tabIndex={0}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            onPickClick();
          }
        }}
        className={cn(
          'flex cursor-pointer items-center justify-center gap-2 rounded-md border border-dashed py-3 text-sm transition-colors',
          isDragOver
            ? 'border-indigo-400 bg-indigo-500/10 text-indigo-200'
            : 'border-zinc-700 bg-zinc-900/40 text-zinc-400 hover:border-zinc-600 hover:text-zinc-300',
        )}
      >
        {isDragOver ? <Upload className="h-4 w-4" /> : <Paperclip className="h-4 w-4" />}
        <span>{isDragOver ? 'drop to upload' : 'drop files here or click to browse'}</span>
      </div>
      <input
        ref={inputRef}
        type="file"
        multiple
        className="hidden"
        onChange={onInputChange}
        accept=".txt,.md,.log,.json,.csv,.yaml,.yml,.conf,.config,.env,.ini,.toml,.xml,.html,.htm,.tsv,.sql,.sh,.bash,.zsh,text/*,application/json"
      />

      {files.length > 0 && (
        <ul className="flex flex-col gap-1">
          {files.map((f) => (
            <li
              key={f.id}
              className={cn(
                'group flex items-center gap-2 rounded-md border px-2 py-1.5 text-xs',
                f.error
                  ? 'border-red-900/60 bg-red-950/30'
                  : f.hasCredentials
                    ? 'border-red-900/40 bg-red-950/20'
                    : 'border-zinc-800 bg-zinc-900/50',
              )}
              title={f.error ?? (f.hasCredentials ? 'credential detected' : 'scrubbed')}
            >
              <ChipStatusIcon chip={f} />
              <span className="flex-1 truncate font-mono text-zinc-200">{f.name}</span>
              <span className="text-zinc-500">{formatSize(f.size)}</span>
              <button
                type="button"
                onClick={(e) => {
                  e.stopPropagation();
                  removeFile(f.id);
                }}
                className="rounded p-0.5 text-zinc-500 hover:bg-zinc-800 hover:text-zinc-300"
                aria-label={`remove ${f.name}`}
              >
                <X className="h-3.5 w-3.5" />
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
