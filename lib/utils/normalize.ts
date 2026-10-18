export function normalizeIngredient(s: string): string {
  if (!s) return "";
  return s
    .toLowerCase()
    .trim()
    .replace(/[()\-+/;,.]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function tokenize(s: string): string[] {
  const n = normalizeIngredient(s);
  if (!n) return [];
  return n.split(" ").filter(Boolean);
}

export function ingredientKey(s: string): string {
  const n = normalizeIngredient(s);
  return n;
}