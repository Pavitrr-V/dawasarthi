import fs from "fs";
import path from "path";

const walk = (d) =>
  fs.readdirSync(d, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? walk(path.join(d, e.name)) : [path.join(d, e.name)]
  );

const manual = [];
for (const f of walk("app").filter((f) => f.endsWith("page.tsx"))) {
  let s = fs.readFileSync(f, "utf8");
  if (s.includes("connection()")) continue;
  if (/^\s*["']use client["']/m.test(s)) { console.log("skip (client):", f); continue; }

  const re = /(export default async function\s+\w+\s*\([^)]*\)\s*(?::[^{]+)?\{)/;
  if (!re.test(s)) { manual.push(f); continue; }

  s = s.replace(re, "$1\n  await connection();");
  s = `import { connection } from "next/server";\n` + s;
  fs.writeFileSync(f, s);
  console.log("fixed:", f);
}
if (manual.length) console.log("\nHaath se karo (async function nahi mila):\n" + manual.join("\n"));
