"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import type { Role } from "@/lib/types";
import {
  CabinetIcon,
  DashboardIcon,
  HistoryIcon,
  HomeIcon,
  PatientsIcon,
  ScanIcon,
  UserIcon,
} from "@/components/icons";

type Tab = {
  href: string;
  label: string;
  Icon: (props: { className?: string }) => React.ReactNode;
};

const PATIENT_TABS: Tab[] = [
  { href: "/home", label: "Home", Icon: HomeIcon },
  { href: "/scan", label: "Scan", Icon: ScanIcon },
  { href: "/cabinet", label: "Cabinet", Icon: CabinetIcon },
  { href: "/history", label: "History", Icon: HistoryIcon },
  { href: "/profile", label: "Profile", Icon: UserIcon },
];

const CAREGIVER_TABS: Tab[] = [
  { href: "/caregiver", label: "Dashboard", Icon: DashboardIcon },
  { href: "/caregiver/patients", label: "Patients", Icon: PatientsIcon },
  { href: "/caregiver/profile", label: "Profile", Icon: UserIcon },
];

export function BottomNav({ role }: { role: Role }) {
  const pathname = usePathname();
  const tabs = role === "caregiver" ? CAREGIVER_TABS : PATIENT_TABS;

  return (
    <nav className="bg-white pt-1">
      <ul className="flex items-stretch justify-around">
        {tabs.map(({ href, label, Icon }) => {
          const active =
            pathname === href ||
            (href !== "/caregiver" && pathname.startsWith(`${href}/`));
          return (
            <li key={href} className="flex-1">
              <Link
                href={href}
                aria-current={active ? "page" : undefined}
                className={`flex min-h-[60px] flex-col items-center justify-center gap-1 rounded-xl px-1 py-2 text-[12px] font-medium transition-colors ${
                  active
                    ? "text-primary-700"
                    : "text-slate-500 hover:text-primary-600"
                }`}
              >
                <Icon className={active ? "h-6 w-6" : "h-6 w-6 opacity-80"} />
                {label}
              </Link>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
