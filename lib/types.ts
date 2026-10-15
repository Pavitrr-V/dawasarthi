export type Role = "patient" | "caregiver";

export type Profile = {
  id: string;
  role: Role;
  name: string | null;
  phone: string | null;
  language: string;
};
