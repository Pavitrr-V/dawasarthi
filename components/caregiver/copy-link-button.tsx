"use client";

import { useState } from "react";
import { Button } from "@/components/ui";
import { joinUrl } from "@/lib/caregiver";

/** Copies the absolute /join link for an invite code. */
export function CopyLinkButton({
  code,
  className,
}: {
  code: string;
  className?: string;
}) {
  const [copied, setCopied] = useState(false);

  async function copy() {
    const appUrl =
      process.env.NEXT_PUBLIC_APP_URL || window.location.origin;
    const url = joinUrl(code, appUrl);
    try {
      await navigator.clipboard.writeText(url);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      window.prompt("Copy this link:", url);
    }
  }

  return (
    <Button
      type="button"
      variant="secondary"
      className={className}
      onClick={copy}
    >
      {copied ? "Link copied" : "Copy link"}
    </Button>
  );
}
