"use client";

import { useEffect, useRef, useState, type ButtonHTMLAttributes, type ReactNode } from "react";
import { AlertTriangle, CheckCircle2, Info, Loader2, Upload, X } from "lucide-react";
import type { ConfirmOptions, ToastItem } from "@/lib/store";

export function cn(...c: Array<string | false | null | undefined>): string {
  return c.filter(Boolean).join(" ");
}

export const inputCls =
  "w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm text-slate-900 shadow-sm outline-none focus:border-blue-500 focus:ring-2 focus:ring-blue-200 dark:border-slate-600 dark:bg-slate-800 dark:text-slate-100";
export const labelCls = "mb-1 block text-xs font-semibold text-slate-600 dark:text-slate-300";

type Variant = "primary" | "secondary" | "danger" | "ghost" | "success" | "dark";

const VARIANTS: Record<Variant, string> = {
  primary: "bg-blue-600 text-white hover:bg-blue-500",
  secondary:
    "border border-slate-300 bg-white text-slate-800 hover:bg-slate-50 dark:border-slate-600 dark:bg-slate-800 dark:text-slate-100 dark:hover:bg-slate-700",
  danger: "bg-red-600 text-white hover:bg-red-500",
  ghost: "text-slate-700 hover:bg-slate-100 dark:text-slate-200 dark:hover:bg-slate-800",
  success: "bg-emerald-600 text-white hover:bg-emerald-500",
  dark: "bg-slate-900 text-white hover:bg-slate-800 dark:bg-slate-700",
};

export function Button({
  variant = "secondary",
  size = "md",
  className,
  ...rest
}: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: Variant; size?: "sm" | "md" | "lg" }) {
  const sz = size === "sm" ? "px-2.5 py-1.5 text-xs" : size === "lg" ? "px-5 py-3 text-base" : "px-3.5 py-2 text-sm";
  return (
    <button
      type="button"
      {...rest}
      className={cn(
        "inline-flex items-center justify-center gap-2 rounded-lg font-semibold transition focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-blue-600 disabled:cursor-not-allowed disabled:opacity-50",
        VARIANTS[variant],
        sz,
        className,
      )}
    />
  );
}

export function Card({
  title,
  icon,
  actions,
  children,
  className,
}: {
  title?: ReactNode;
  icon?: ReactNode;
  actions?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <section
      className={cn(
        "rounded-2xl border border-slate-200 bg-white p-5 shadow-sm dark:border-slate-700 dark:bg-slate-900",
        className,
      )}
    >
      {(title || actions) && (
        <header className="mb-3 flex flex-wrap items-center justify-between gap-3">
          <h2 className="flex items-center gap-2 text-base font-bold text-slate-900 dark:text-slate-100">
            {icon}
            {title}
          </h2>
          {actions}
        </header>
      )}
      {children}
    </section>
  );
}

export function PageTitle({ title, description, actions }: { title: string; description?: ReactNode; actions?: ReactNode }) {
  return (
    <div className="mb-6 flex flex-wrap items-end justify-between gap-4">
      <div>
        <h1 className="text-2xl font-black tracking-tight text-slate-900 md:text-3xl dark:text-slate-100">{title}</h1>
        {description && <div className="mt-1 max-w-3xl text-sm text-slate-600 dark:text-slate-400">{description}</div>}
      </div>
      {actions}
    </div>
  );
}

export function Notice({ tone = "info", children }: { tone?: "info" | "warn" | "error" | "success"; children: ReactNode }) {
  const map = {
    info: "border-blue-200 bg-blue-50 text-blue-900 dark:border-blue-900 dark:bg-blue-950/40 dark:text-blue-100",
    warn: "border-amber-200 bg-amber-50 text-amber-900 dark:border-amber-900 dark:bg-amber-950/40 dark:text-amber-100",
    error: "border-red-200 bg-red-50 text-red-900 dark:border-red-900 dark:bg-red-950/40 dark:text-red-100",
    success: "border-emerald-200 bg-emerald-50 text-emerald-900 dark:border-emerald-900 dark:bg-emerald-950/40 dark:text-emerald-100",
  } as const;
  const Icon = tone === "error" || tone === "warn" ? AlertTriangle : tone === "success" ? CheckCircle2 : Info;
  return (
    <div role={tone === "error" ? "alert" : "note"} className={cn("flex gap-2 rounded-xl border p-3 text-sm", map[tone])}>
      <Icon size={16} className="mt-0.5 shrink-0" aria-hidden />
      <div className="min-w-0">{children}</div>
    </div>
  );
}

export function Spinner({ label }: { label?: string }) {
  return (
    <span className="inline-flex items-center gap-2" role="status">
      <Loader2 className="animate-spin" size={16} aria-hidden />
      {label && <span>{label}</span>}
    </span>
  );
}

export function ProgressBar({ value, label }: { value: number; label?: string }) {
  const v = Math.max(0, Math.min(100, Math.round(value)));
  return (
    <div className="w-full">
      {label && <div className="mb-1 flex justify-between text-xs text-slate-600 dark:text-slate-300"><span>{label}</span><span>{v}%</span></div>}
      <div className="h-2.5 w-full overflow-hidden rounded-full bg-slate-200 dark:bg-slate-700" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={v} aria-label={label ?? "Progress"}>
        <div className="h-full bg-blue-600 transition-all" style={{ width: `${v}%` }} />
      </div>
    </div>
  );
}

export function EmptyState({ icon, title, text, action }: { icon?: ReactNode; title: string; text: string; action?: ReactNode }) {
  return (
    <div className="flex flex-col items-center justify-center gap-2 rounded-2xl border border-dashed border-slate-300 p-8 text-center dark:border-slate-600">
      {icon && <div className="text-blue-600">{icon}</div>}
      <p className="font-bold text-slate-800 dark:text-slate-100">{title}</p>
      <p className="max-w-md text-sm text-slate-500 dark:text-slate-400">{text}</p>
      {action && <div className="mt-2">{action}</div>}
    </div>
  );
}

export function Dropzone({
  onFiles,
  accept,
  multiple = false,
  title,
  hint,
  disabled,
  compact,
}: {
  onFiles: (files: File[]) => void;
  accept?: string;
  multiple?: boolean;
  title: string;
  hint?: string;
  disabled?: boolean;
  compact?: boolean;
}) {
  const [over, setOver] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const handle = (list: File[]) => {
    if (!list.length) return;
    onFiles(multiple ? list : [list[0]]);
  };
  return (
    <div
      role="button"
      tabIndex={disabled ? -1 : 0}
      aria-disabled={disabled}
      aria-label={title}
      onClick={() => !disabled && inputRef.current?.click()}
      onKeyDown={(e) => {
        if ((e.key === "Enter" || e.key === " ") && !disabled) {
          e.preventDefault();
          inputRef.current?.click();
        }
      }}
      onDragOver={(e) => {
        e.preventDefault();
        if (!disabled) setOver(true);
      }}
      onDragLeave={() => setOver(false)}
      onDrop={(e) => {
        e.preventDefault();
        setOver(false);
        if (!disabled) handle(Array.from(e.dataTransfer.files));
      }}
      className={cn(
        "cursor-pointer rounded-2xl border-2 border-dashed text-center transition focus-visible:outline-2 focus-visible:outline-blue-600",
        over ? "border-blue-500 bg-blue-50 dark:bg-blue-950/40" : "border-blue-300 bg-blue-50/50 hover:bg-blue-50 dark:border-slate-600 dark:bg-slate-900",
        compact ? "p-4" : "p-8",
        disabled && "cursor-not-allowed opacity-60",
      )}
    >
      <Upload className="mx-auto text-blue-600" size={compact ? 22 : 32} aria-hidden />
      <p className="mt-2 font-bold text-slate-900 dark:text-slate-100">{title}</p>
      {hint && <p className="mt-1 text-sm text-slate-500 dark:text-slate-400">{hint}</p>}
      <input
        ref={inputRef}
        type="file"
        className="sr-only"
        tabIndex={-1}
        aria-hidden
        accept={accept}
        multiple={multiple}
        disabled={disabled}
        onChange={(e) => {
          const files = Array.from(e.target.files ?? []);
          e.target.value = "";
          handle(files);
        }}
      />
    </div>
  );
}

export function Modal({
  open,
  onClose,
  title,
  children,
  footer,
  wide,
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  children: ReactNode;
  footer?: ReactNode;
  wide?: boolean;
}) {
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);
  if (!open) return null;
  return (
    <div
      className="fixed inset-0 z-[100] flex items-center justify-center bg-slate-950/50 p-4"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label={title}
        className={cn("w-full rounded-2xl bg-white shadow-2xl dark:bg-slate-900", wide ? "max-w-3xl" : "max-w-md")}
      >
        <div className="flex items-center justify-between border-b px-5 py-3 dark:border-slate-700">
          <h2 className="font-bold text-slate-900 dark:text-slate-100">{title}</h2>
          <button aria-label="Close dialog" onClick={onClose} className="rounded p-1 hover:bg-slate-100 dark:hover:bg-slate-800">
            <X size={18} />
          </button>
        </div>
        <div className="max-h-[70vh] overflow-auto px-5 py-4 text-sm text-slate-700 dark:text-slate-200">{children}</div>
        {footer && <div className="flex justify-end gap-2 border-t px-5 py-3 dark:border-slate-700">{footer}</div>}
      </div>
    </div>
  );
}

export function ConfirmDialog({ opts, onAnswer }: { opts: ConfirmOptions | null; onAnswer: (v: boolean) => void }) {
  const close = () => onAnswer(false);
  return (
    <Modal
      open={!!opts}
      onClose={close}
      title={opts?.title ?? "Confirm"}
      footer={
        <>
          <Button variant="secondary" onClick={close}>
            Cancel
          </Button>
          <Button variant={opts?.danger ? "danger" : "primary"} onClick={() => onAnswer(true)} autoFocus>
            {opts?.confirmLabel ?? "Confirm"}
          </Button>
        </>
      }
    >
      <p>{opts?.message}</p>
    </Modal>
  );
}

export function Toaster({ toasts, onDismiss }: { toasts: ToastItem[]; onDismiss: (id: string) => void }) {
  return (
    <div className="pointer-events-none fixed bottom-4 right-4 z-[110] flex w-[min(92vw,380px)] flex-col gap-2" aria-live="polite" role="status">
      {toasts.map((t) => (
        <div
          key={t.id}
          className={cn(
            "pointer-events-auto flex items-start gap-2 rounded-xl px-4 py-3 text-sm text-white shadow-xl",
            t.kind === "error" ? "bg-red-600" : t.kind === "success" ? "bg-emerald-600" : "bg-slate-800",
          )}
        >
          <span className="min-w-0 flex-1 break-words">{t.text}</span>
          <button aria-label="Dismiss notification" onClick={() => onDismiss(t.id)} className="opacity-80 hover:opacity-100">
            <X size={14} />
          </button>
        </div>
      ))}
    </div>
  );
}
