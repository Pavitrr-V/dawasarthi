"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";
import { Button, Field, Input } from "@/components/ui";
import type { Role } from "@/lib/types";

type Mode = "signin" | "signup";

export function LoginForm() {
  const router = useRouter();

  const [mode, setMode] = useState<Mode>("signin");
  const [email, setEmail] = useState("");
  const [name, setName] = useState("");
  const [role, setRole] = useState<Role>("patient");
  const [otp, setOtp] = useState("");
  const [sent, setSent] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);

  function switchMode(next: Mode) {
    setMode(next);
    setSent(false);
    setError(null);
    setInfo(null);
  }

  async function sendCode(event: React.FormEvent) {
    event.preventDefault();
    setError(null);
    setInfo(null);

    const cleanEmail = email.trim();
    if (!cleanEmail) {
      setError("Please enter your email address.");
      return;
    }
    if (mode === "signup" && !name.trim()) {
      setError("Please enter your name.");
      return;
    }

    setPending(true);
    try {
      const supabase = createClient();
      const { error: otpError } = await supabase.auth.signInWithOtp({
        email: cleanEmail,
        options: {
          emailRedirectTo: `${window.location.origin}/auth/callback`,
          shouldCreateUser: mode === "signup",
          data:
            mode === "signup"
              ? { name: name.trim(), role, language: "en" }
              : undefined,
        },
      });

      if (otpError) {
        setError(
          mode === "signin"
            ? "We could not send a sign-in code. If you are new, create an account first."
            : otpError.message
        );
        return;
      }

      setSent(true);
      setInfo("We emailed you a 6-digit code and a magic link. Use either one.");
    } catch {
      setError("Something went wrong. Please try again.");
    } finally {
      setPending(false);
    }
  }

  async function verifyCode(event: React.FormEvent) {
    event.preventDefault();
    setError(null);

    if (otp.trim().length < 6) {
      setError("Enter the 6-digit code from your email.");
      return;
    }

    setPending(true);
    try {
      const supabase = createClient();
      const { error: verifyError } = await supabase.auth.verifyOtp({
        email: email.trim(),
        token: otp.trim(),
        type: "email",
      });

      if (verifyError) {
        setError("That code is not valid or has expired.");
        return;
      }

      router.replace("/");
      router.refresh();
    } catch {
      setError("Something went wrong. Please try again.");
    } finally {
      setPending(false);
    }
  }

  return (
    <div className="w-full">
      <div className="mb-5 grid grid-cols-2 gap-1 rounded-xl bg-slate-100 p-1">
        {(["signin", "signup"] as const).map((value) => (
          <button
            key={value}
            type="button"
            onClick={() => switchMode(value)}
            className={`min-h-[44px] rounded-lg text-[16px] font-semibold transition-colors ${
              mode === value
                ? "bg-white text-primary-700 shadow-sm"
                : "text-slate-500"
            }`}
          >
            {value === "signin" ? "Sign in" : "Sign up"}
          </button>
        ))}
      </div>

      {!sent ? (
        <form onSubmit={sendCode} className="space-y-4">
          {mode === "signup" && (
            <Field label="Your name">
              <Input
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="e.g. Anjali Sharma"
                autoComplete="name"
                required
              />
            </Field>
          )}

          <Field label="Email address">
            <Input
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="you@example.com"
              autoComplete="email"
              inputMode="email"
              required
            />
          </Field>

          {mode === "signup" && (
            <Field label="I am a">
              <div className="grid grid-cols-2 gap-2">
                {(
                  [
                    { value: "patient", label: "Patient" },
                    { value: "caregiver", label: "Caregiver" },
                  ] as const
                ).map((option) => (
                  <button
                    key={option.value}
                    type="button"
                    onClick={() => setRole(option.value)}
                    className={`min-h-[52px] rounded-xl border text-[17px] font-semibold transition-colors ${
                      role === option.value
                        ? "border-primary-600 bg-primary-50 text-primary-700"
                        : "border-slate-300 bg-white text-slate-600"
                    }`}
                  >
                    {option.label}
                  </button>
                ))}
              </div>
            </Field>
          )}

          {error && <FormMessage tone="error">{error}</FormMessage>}

          <Button type="submit" className="w-full" disabled={pending}>
            {pending ? "Sending..." : "Email me a code"}
          </Button>
          <p className="text-center text-sm text-slate-400">
            We use passwordless email sign-in. No password to remember.
          </p>
        </form>
      ) : (
        <form onSubmit={verifyCode} className="space-y-4">
          {info && <FormMessage tone="info">{info}</FormMessage>}
          <Field label="6-digit code" hint={`Sent to ${email.trim()}`}>
            <Input
              value={otp}
              onChange={(e) => setOtp(e.target.value.replace(/\D/g, ""))}
              placeholder="123456"
              inputMode="numeric"
              autoComplete="one-time-code"
              maxLength={6}
              className="text-center text-2xl tracking-[0.3em]"
              required
            />
          </Field>

          {error && <FormMessage tone="error">{error}</FormMessage>}

          <Button type="submit" className="w-full" disabled={pending}>
            {pending ? "Verifying..." : "Verify and continue"}
          </Button>
          <Button
            type="button"
            variant="ghost"
            className="w-full"
            onClick={() => {
              setSent(false);
              setError(null);
              setInfo(null);
            }}
          >
            Use a different email
          </Button>
        </form>
      )}
    </div>
  );
}

function FormMessage({
  tone,
  children,
}: {
  tone: "error" | "info";
  children: React.ReactNode;
}) {
  const styles =
    tone === "error"
      ? "border-red-200 bg-red-50 text-red-700"
      : "border-primary-200 bg-primary-50 text-primary-800";
  return (
    <div className={`rounded-xl border px-4 py-3 text-[15px] ${styles}`}>
      {children}
    </div>
  );
}
