import type { ReactNode, ButtonHTMLAttributes, InputHTMLAttributes } from "react";

export function Card({
  children,
  className = "",
}: {
  children: ReactNode;
  className?: string;
}) {
  return (
    <div
      className={`rounded-2xl border border-slate-200 bg-white p-4 shadow-sm ${className}`}
    >
      {children}
    </div>
  );
}

export function PageHeader({
  title,
  subtitle,
}: {
  title: string;
  subtitle?: string;
}) {
  return (
    <header className="mb-4">
      <h1 className="text-2xl font-bold text-slate-900">{title}</h1>
      {subtitle && <p className="mt-1 text-slate-500">{subtitle}</p>}
    </header>
  );
}

export function EmptyState({
  title,
  description,
  action,
}: {
  title: string;
  description: string;
  action?: ReactNode;
}) {
  return (
    <Card className="flex flex-col items-center gap-2 py-8 text-center">
      <p className="text-lg font-semibold text-slate-800">{title}</p>
      <p className="text-slate-500">{description}</p>
      {action}
    </Card>
  );
}

export function Button({
  variant = "primary",
  className = "",
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: "primary" | "secondary" | "ghost";
}) {
  const styles = {
    primary:
      "bg-primary-600 text-white hover:bg-primary-700 disabled:bg-primary-300",
    secondary:
      "border border-slate-300 bg-white text-slate-700 hover:bg-slate-50",
    ghost: "text-primary-700 hover:bg-primary-50",
  }[variant];

  return (
    <button
      className={`inline-flex min-h-[52px] items-center justify-center rounded-xl px-5 text-[17px] font-semibold transition-colors disabled:cursor-not-allowed disabled:opacity-70 ${styles} ${className}`}
      {...props}
    />
  );
}

export function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: ReactNode;
}) {
  return (
    <label className="block">
      <span className="mb-1 block text-[15px] font-medium text-slate-700">
        {label}
      </span>
      {children}
      {hint && <span className="mt-1 block text-sm text-slate-400">{hint}</span>}
    </label>
  );
}

/**
 * tone="verify" draws the amber "please check this value" border used by the
 * scan review form for low-confidence extractions.
 */
export function Input({
  tone = "default",
  ...props
}: InputHTMLAttributes<HTMLInputElement> & { tone?: "default" | "verify" }) {
  const skin =
    tone === "verify"
      ? "border-amber-400 focus:border-amber-500 focus:ring-amber-200"
      : "border-slate-300 focus:border-primary-500 focus:ring-primary-200";
  return (
    <input
      {...props}
      className={`min-h-[52px] w-full rounded-xl border bg-white px-4 text-[17px] text-slate-900 placeholder:text-slate-400 focus:outline-none focus:ring-2 ${skin} ${props.className ?? ""}`}
    />
  );
}
