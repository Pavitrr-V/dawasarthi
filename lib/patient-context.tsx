"use client";

import {
  createContext,
  useCallback,
  useContext,
  useTransition,
  type ReactNode,
} from "react";
import { useRouter } from "next/navigation";
import { setSelectedPatient } from "@/app/(app)/patient-actions";
import type { PatientOption } from "@/lib/types";

type PatientContextValue = {
  patients: PatientOption[];
  selected: PatientOption | null;
  isSwitching: boolean;
  selectPatient: (id: string) => void;
};

const PatientContext = createContext<PatientContextValue | null>(null);

export function PatientProvider({
  patients,
  selectedId,
  children,
}: {
  patients: PatientOption[];
  selectedId: string | null;
  children: ReactNode;
}) {
  const router = useRouter();
  const [isSwitching, startTransition] = useTransition();

  const selected = patients.find((p) => p.id === selectedId) ?? patients[0] ?? null;

  const selectPatient = useCallback(
    (id: string) => {
      startTransition(async () => {
        await setSelectedPatient(id);
        router.refresh();
      });
    },
    [router]
  );

  return (
    <PatientContext.Provider
      value={{ patients, selected, isSwitching, selectPatient }}
    >
      {children}
    </PatientContext.Provider>
  );
}

export function usePatient(): PatientContextValue {
  const ctx = useContext(PatientContext);
  if (!ctx) {
    throw new Error("usePatient must be used within a PatientProvider");
  }
  return ctx;
}
