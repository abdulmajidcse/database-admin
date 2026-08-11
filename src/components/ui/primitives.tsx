'use client';

/**
 * The shared UI kit. Every feature area uses these so the app looks like one
 * program rather than eight. Dense, IDE-flavoured, theme-token driven.
 */

import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';
import * as React from 'react';
import { Loader2, X } from 'lucide-react';

export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs));
}

// --- Button ---------------------------------------------------------------

type ButtonVariant = 'default' | 'primary' | 'ghost' | 'danger' | 'subtle';
type ButtonSize = 'xs' | 'sm' | 'md';

export interface ButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: ButtonSize;
  loading?: boolean;
  icon?: React.ReactNode;
}

const BUTTON_VARIANTS: Record<ButtonVariant, string> = {
  default:
    'bg-[var(--bg-panel)] text-[var(--fg)] border border-[var(--border)] hover:bg-[var(--bg-hover)] active:bg-[var(--bg-active)]',
  primary: 'bg-[var(--accent)] text-[var(--accent-fg)] border border-transparent hover:opacity-90',
  ghost: 'bg-transparent text-[var(--fg)] border border-transparent hover:bg-[var(--bg-hover)]',
  subtle: 'bg-[var(--bg-subtle)] text-[var(--fg-muted)] border border-transparent hover:bg-[var(--bg-hover)]',
  danger: 'bg-[var(--danger)] text-white border border-transparent hover:opacity-90',
};

const BUTTON_SIZES: Record<ButtonSize, string> = {
  xs: 'h-6 px-2 text-[11px] gap-1',
  sm: 'h-7 px-2.5 text-xs gap-1.5',
  md: 'h-8 px-3 text-[13px] gap-2',
};

export const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { className, variant = 'default', size = 'sm', loading, icon, children, disabled, ...props },
  ref,
) {
  return (
    <button
      ref={ref}
      disabled={disabled || loading}
      className={cn(
        'inline-flex items-center justify-center rounded font-medium transition-colors select-none',
        'disabled:opacity-45 disabled:pointer-events-none focus-ring',
        BUTTON_VARIANTS[variant],
        BUTTON_SIZES[size],
        className,
      )}
      {...props}
    >
      {loading ? <Loader2 className="size-3.5 animate-spin" /> : icon}
      {children}
    </button>
  );
});

// --- Input / Select / Textarea --------------------------------------------

const FIELD_BASE =
  'w-full rounded border border-[var(--border)] bg-[var(--bg)] px-2 py-1 text-[13px] text-[var(--fg)] ' +
  'placeholder:text-[var(--fg-subtle)] focus-ring disabled:opacity-50';

export const Input = React.forwardRef<HTMLInputElement, React.InputHTMLAttributes<HTMLInputElement>>(
  function Input({ className, ...props }, ref) {
    return <input ref={ref} className={cn(FIELD_BASE, 'h-7', className)} {...props} />;
  },
);

export const Textarea = React.forwardRef<HTMLTextAreaElement, React.TextareaHTMLAttributes<HTMLTextAreaElement>>(
  function Textarea({ className, ...props }, ref) {
    return <textarea ref={ref} className={cn(FIELD_BASE, 'mono resize-y', className)} {...props} />;
  },
);

export const Select = React.forwardRef<HTMLSelectElement, React.SelectHTMLAttributes<HTMLSelectElement>>(
  function Select({ className, children, ...props }, ref) {
    return (
      <select ref={ref} className={cn(FIELD_BASE, 'h-7 cursor-pointer', className)} {...props}>
        {children}
      </select>
    );
  },
);

export function Checkbox({
  label,
  className,
  ...props
}: React.InputHTMLAttributes<HTMLInputElement> & { label?: React.ReactNode }) {
  return (
    <label className={cn('inline-flex items-center gap-2 cursor-pointer select-none text-[13px]', className)}>
      <input type="checkbox" className="size-3.5 accent-[var(--accent)] cursor-pointer" {...props} />
      {label}
    </label>
  );
}

export function Field({
  label,
  hint,
  error,
  children,
  className,
}: {
  label: React.ReactNode;
  hint?: React.ReactNode;
  error?: React.ReactNode;
  children: React.ReactNode;
  className?: string;
}) {
  const autoId = React.useId();

  // Associate the label with its control. Without this the label is decorative:
  // clicking it does nothing, screen readers announce an unlabelled input, and
  // getByLabel() cannot find the field. Respect an id the caller already set.
  const child = React.isValidElement(children) ? (children as React.ReactElement<{ id?: string; 'aria-describedby'?: string }>) : null;
  const controlId = child?.props?.id ?? autoId;
  const describedBy = hint || error ? `${controlId}-desc` : undefined;
  const control = child
    ? React.cloneElement(child, { id: controlId, 'aria-describedby': describedBy })
    : children;

  return (
    <div className={cn('flex flex-col gap-1', className)}>
      <label
        htmlFor={controlId}
        className="text-[11px] font-medium uppercase tracking-wide text-[var(--fg-muted)]"
      >
        {label}
      </label>
      {control}
      {hint && !error && (
        <p id={describedBy} className="text-[11px] text-[var(--fg-subtle)] leading-snug">
          {hint}
        </p>
      )}
      {error && (
        <p id={describedBy} className="text-[11px] text-[var(--danger)] leading-snug">
          {error}
        </p>
      )}
    </div>
  );
}

// --- Dialog ---------------------------------------------------------------

export function Dialog({
  open,
  onClose,
  title,
  children,
  footer,
  width = 'md',
}: {
  open: boolean;
  onClose: () => void;
  title: React.ReactNode;
  children: React.ReactNode;
  footer?: React.ReactNode;
  width?: 'sm' | 'md' | 'lg' | 'xl' | 'full';
}) {
  React.useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  if (!open) return null;

  const widths = {
    sm: 'max-w-md',
    md: 'max-w-2xl',
    lg: 'max-w-4xl',
    xl: 'max-w-6xl',
    full: 'max-w-[95vw]',
  }[width];

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-black/40 p-8">
      <div
        className={cn(
          'w-full rounded-lg border border-[var(--border)] bg-[var(--bg-panel)] shadow-2xl',
          'flex max-h-[85vh] flex-col',
          widths,
        )}
        role="dialog"
        aria-modal="true"
      >
        <div className="flex items-center justify-between border-b border-[var(--border)] px-4 py-2.5">
          <h2 className="text-[13px] font-semibold">{title}</h2>
          <Button variant="ghost" size="xs" onClick={onClose} aria-label="Close">
            <X className="size-3.5" />
          </Button>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto p-4">{children}</div>
        {footer && (
          <div className="flex items-center justify-end gap-2 border-t border-[var(--border)] px-4 py-2.5">
            {footer}
          </div>
        )}
      </div>
    </div>
  );
}

// --- Tabs -----------------------------------------------------------------

export interface TabItem {
  id: string;
  label: React.ReactNode;
  detail?: React.ReactNode;
  closable?: boolean;
}

export function Tabs({
  items,
  active,
  onSelect,
  onClose,
  className,
  right,
}: {
  items: TabItem[];
  active: string;
  onSelect: (id: string) => void;
  onClose?: (id: string) => void;
  className?: string;
  right?: React.ReactNode;
}) {
  return (
    <div
      className={cn(
        'flex items-stretch border-b border-[var(--border)] bg-[var(--bg-subtle)] overflow-x-auto',
        className,
      )}
    >
      {items.map((t) => (
        <div
          key={t.id}
          onClick={() => onSelect(t.id)}
          className={cn(
            'group flex shrink-0 cursor-pointer items-center gap-1.5 border-r border-[var(--border)] px-3 py-1.5 text-xs',
            active === t.id
              ? 'bg-[var(--bg)] text-[var(--fg)] shadow-[inset_0_-2px_0_var(--accent)]'
              : 'text-[var(--fg-muted)] hover:bg-[var(--bg-hover)]',
          )}
        >
          <span className="whitespace-nowrap">{t.label}</span>
          {t.detail && <span className="text-[10px] text-[var(--fg-subtle)]">{t.detail}</span>}
          {t.closable && onClose && (
            <button
              onClick={(e) => {
                e.stopPropagation();
                onClose(t.id);
              }}
              className="ml-1 rounded p-0.5 opacity-0 hover:bg-[var(--bg-active)] group-hover:opacity-100"
              aria-label="Close tab"
            >
              <X className="size-3" />
            </button>
          )}
        </div>
      ))}
      {right && <div className="ml-auto flex items-center gap-1 px-2">{right}</div>}
    </div>
  );
}

// --- Misc -----------------------------------------------------------------

export function Spinner({ className }: { className?: string }) {
  return <Loader2 className={cn('size-4 animate-spin text-[var(--fg-muted)]', className)} />;
}

export function Badge({
  children,
  tone = 'neutral',
  className,
}: {
  children: React.ReactNode;
  tone?: 'neutral' | 'ok' | 'warn' | 'danger' | 'accent';
  className?: string;
}) {
  const tones = {
    neutral: 'bg-[var(--bg-active)] text-[var(--fg-muted)]',
    ok: 'bg-[var(--ok-bg)] text-[var(--ok)]',
    warn: 'bg-[var(--warn-bg)] text-[var(--warn)]',
    danger: 'bg-[var(--danger-bg)] text-[var(--danger)]',
    accent: 'bg-[var(--selection)] text-[var(--accent)]',
  }[tone];
  return (
    <span className={cn('inline-flex items-center rounded px-1.5 py-0.5 text-[10px] font-medium', tones, className)}>
      {children}
    </span>
  );
}

export function Toolbar({ children, className }: { children: React.ReactNode; className?: string }) {
  return (
    <div
      className={cn(
        'flex shrink-0 items-center gap-1.5 border-b border-[var(--border)] bg-[var(--bg-subtle)] px-2 py-1',
        className,
      )}
    >
      {children}
    </div>
  );
}

export function EmptyState({
  icon,
  title,
  description,
  action,
}: {
  icon?: React.ReactNode;
  title: React.ReactNode;
  description?: React.ReactNode;
  action?: React.ReactNode;
}) {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-2 p-8 text-center">
      {icon && <div className="text-[var(--fg-subtle)]">{icon}</div>}
      <p className="text-[13px] font-medium text-[var(--fg-muted)]">{title}</p>
      {description && <p className="max-w-md text-xs text-[var(--fg-subtle)]">{description}</p>}
      {action && <div className="mt-2">{action}</div>}
    </div>
  );
}

export function ErrorBox({ title, message, hint }: { title?: string; message: string; hint?: string }) {
  return (
    <div className="rounded border border-[var(--danger)]/40 bg-[var(--danger-bg)] p-3">
      {title && <p className="text-xs font-semibold text-[var(--danger)]">{title}</p>}
      <p className="mono mt-1 whitespace-pre-wrap break-words text-[var(--fg)]">{message}</p>
      {hint && <p className="mt-2 text-xs text-[var(--fg-muted)]">{hint}</p>}
    </div>
  );
}

/** Confirmation for destructive statements (§9) — types the target to confirm. */
export function ConfirmDialog({
  open,
  onClose,
  onConfirm,
  title,
  message,
  confirmWord,
  danger = true,
}: {
  open: boolean;
  onClose: () => void;
  onConfirm: () => void;
  title: string;
  message: React.ReactNode;
  confirmWord?: string;
  danger?: boolean;
}) {
  const [typed, setTyped] = React.useState('');
  React.useEffect(() => {
    if (open) setTyped('');
  }, [open]);
  const ready = !confirmWord || typed === confirmWord;

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title={title}
      width="sm"
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button
            variant={danger ? 'danger' : 'primary'}
            disabled={!ready}
            onClick={() => {
              onConfirm();
              onClose();
            }}
          >
            Confirm
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-3 text-[13px]">
        <div>{message}</div>
        {confirmWord && (
          <Field label={`Type ${confirmWord} to confirm`}>
            <Input value={typed} onChange={(e) => setTyped(e.target.value)} autoFocus />
          </Field>
        )}
      </div>
    </Dialog>
  );
}

export function Separator({ vertical }: { vertical?: boolean }) {
  return vertical ? (
    <div className="mx-1 h-4 w-px shrink-0 bg-[var(--border)]" />
  ) : (
    <div className="my-1 h-px w-full bg-[var(--border)]" />
  );
}
