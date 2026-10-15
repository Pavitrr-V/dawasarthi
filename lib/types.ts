export type Role = "patient" | "caregiver";

export type Profile = {
  id: string;
  role: Role;
  name: string | null;
  phone: string | null;
  language: string;
};

export type PatientProfile = {
  id: string;
  name: string;
  age: number | null;
  allergies: string[];
  conditions: string[];
  breakfast_time: string | null;
  lunch_time: string | null;
  dinner_time: string | null;
};

/** Lightweight shape passed to the client profile switcher. */
export type PatientOption = {
  id: string;
  name: string;
  age: number | null;
};
