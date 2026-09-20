/**
 * Small presentational primitives for the dashboard. Dark ops-console theme,
 * no component library.
 */

import type { ReactNode } from 'react';

export function Button({
  children,
  onClick,
  variant = 'default',
  disabled = false,
  title,
  submit = false,
}: {
  children: ReactNode;
  onClick?: () => void;
  variant?: 'default' | 'primary' | 'danger' | 'ghost';
  disabled?: boolean;
  title?: string;
  submit?: boolean;
}): React.JSX.Element {
  const style =
    variant === 'primary'
      ? 'bg-indigo-600 hover:bg-indigo-500 text-white'
      : variant === 'danger'
        ? 'bg-red-700 hover:bg-red-600 text-white'
        : variant === 'ghost'
          ? 'bg-transparent hover:bg-zinc-800 text-zinc-300'
          : 'bg-zinc-700 hover:bg-zinc-600 text-zinc-100';
  return (
    <button
      type={submit ? 'submit' : 'button'}
      title={title}
      disabled={disabled}
      onClick={onClick}
      className={`rounded px-3 py-1.5 text-sm font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-40 ${style}`}
    >
      {children}
    </button>
  );
}

export function Field({
  label,
  children,
}: {
  label: string;
  children: ReactNode;
}): React.JSX.Element {
  return (
    <label className="block">
      <span className="mb-1 block text-xs font-medium uppercase tracking-wide text-zinc-400">{label}</span>
      {children}
    </label>
  );
}

export const inputClass =
  'w-full rounded border border-zinc-700 bg-zinc-900 px-3 py-1.5 text-sm text-zinc-100 placeholder:text-zinc-500 focus:border-indigo-500 focus:outline-none';

export function Modal({
  title,
  onClose,
  children,
}: {
  title: string;
  onClose: () => void;
  children: ReactNode;
}): React.JSX.Element {
  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4"
      onClick={onClose}
      role="presentation"
    >
      <div
        className="w-full max-w-lg rounded-lg border border-zinc-700 bg-zinc-900 p-5 shadow-xl"
        onClick={(e): void => {
          e.stopPropagation();
        }}
        role="dialog"
        aria-modal="true"
        aria-label={title}
      >
        <div className="mb-4 flex items-center justify-between">
          <h2 className="text-lg font-semibold">{title}</h2>
          <button
            type="button"
            onClick={onClose}
            className="rounded px-2 py-1 text-zinc-400 hover:bg-zinc-800 hover:text-zinc-100"
            aria-label="Close"
          >
            ✕
          </button>
        </div>
        {children}
      </div>
    </div>
  );
}

export function StateBadge({ state }: { state: string }): React.JSX.Element {
  const colors: Record<string, string> = {
    running: 'bg-green-900 text-green-300 border-green-700',
    launching: 'bg-yellow-900 text-yellow-300 border-yellow-700',
    stopping: 'bg-yellow-900 text-yellow-300 border-yellow-700',
    stopped: 'bg-zinc-800 text-zinc-300 border-zinc-600',
    created: 'bg-zinc-800 text-zinc-400 border-zinc-600',
    crashed: 'bg-red-900 text-red-300 border-red-700',
  };
  const color = colors[state] ?? 'bg-zinc-800 text-zinc-300 border-zinc-600';
  return (
    <span className={`inline-block rounded border px-2 py-0.5 text-xs font-medium ${color}`}>
      {state}
    </span>
  );
}

export function ErrorBanner({ message, onDismiss }: { message: string; onDismiss: () => void }): React.JSX.Element {
  return (
    <div className="mb-4 flex items-start justify-between gap-4 rounded border border-red-800 bg-red-950/60 px-4 py-3 text-sm text-red-200">
      <span className="break-words">{message}</span>
      <button
        type="button"
        onClick={onDismiss}
        className="shrink-0 rounded px-2 py-0.5 text-red-300 hover:bg-red-900"
        aria-label="Dismiss error"
      >
        ✕
      </button>
    </div>
  );
}

export function EmptyState({ message }: { message: string }): React.JSX.Element {
  return <p className="py-8 text-center text-sm text-zinc-500">{message}</p>;
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${String(bytes)} B`;
  const units = ['KB', 'MB', 'GB'];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value.toFixed(1)} ${units[unit] ?? 'GB'}`;
}

export function formatTime(iso: string | null): string {
  if (!iso) return '—';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return date.toLocaleString();
}
