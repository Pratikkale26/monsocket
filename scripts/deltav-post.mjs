/**
 * Post a weekly update to deltaV (deltav.monad.xyz).
 *
 *   node scripts/deltav-post.mjs notes/updates/2026-08-09.md [x-link]
 *
 * Reads DELTAV_API_KEY from .env. The key is scoped to the `monsocket`
 * startup profile, so the update is attributed automatically — there is no
 * startup id to pass.
 *
 * The endpoint takes plain text, not markdown: the feed renders link syntax
 * literally, so write for raw display.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const ENDPOINT = "https://deltav.monad.xyz/api/v1/weekly-updates";

const [file, xLink] = process.argv.slice(2);
if (!file) {
  console.error("usage: node scripts/deltav-post.mjs <file.md> [x-link]");
  process.exit(1);
}

// A four-line .env parser beats a dependency for one key.
const env = Object.fromEntries(
  readFileSync(resolve(import.meta.dirname, "../.env"), "utf8")
    .split("\n")
    .filter((l) => l.trim() && !l.startsWith("#"))
    .map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1)]),
);

const key = env.DELTAV_API_KEY;
if (!key) throw new Error("DELTAV_API_KEY missing from .env");

const content = readFileSync(file, "utf8").trim();
if (!content) throw new Error(`${file} is empty`);
if (content.length > 50_000) throw new Error("over the 50,000 character limit");

const res = await fetch(ENDPOINT, {
  method: "POST",
  headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
  body: JSON.stringify(xLink ? { content, xLink } : { content }),
});

const body = await res.text();
if (!res.ok) {
  // Never retry blindly on a failure — check the feed first. A duplicate
  // weekly update is public and cannot be quietly undone.
  console.error(`HTTP ${res.status}\n${body}`);
  process.exit(1);
}

console.log(`posted (${content.length} chars) — ${JSON.parse(body).id}`);
