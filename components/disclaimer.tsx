import { DISCLAIMER } from "@/lib/constants";

export function Disclaimer({ className = "" }: { className?: string }) {
  return (
    <p
      role="note"
      className={`bg-amber-50 px-4 py-2 text-center text-[13px] leading-snug text-amber-900 ${className}`}
    >
      {DISCLAIMER}
    </p>
  );
}
