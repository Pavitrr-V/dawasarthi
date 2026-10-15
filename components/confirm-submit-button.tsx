"use client";

import type { ReactNode } from "react";
import { Button } from "@/components/ui";

/** Submit button that asks for confirmation before allowing the form to submit. */
export function ConfirmSubmitButton({
  children,
  message,
  className,
}: {
  children: ReactNode;
  message: string;
  className?: string;
}) {
  return (
    <Button
      type="submit"
      variant="secondary"
      className={className}
      onClick={(event) => {
        if (!window.confirm(message)) event.preventDefault();
      }}
    >
      {children}
    </Button>
  );
}
