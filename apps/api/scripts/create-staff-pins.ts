/**
 * Create a named sign-in PIN for each member of venue staff.
 *
 *   npx tsx apps/api/scripts/create-staff-pins.ts /tmp/staff.txt           # dry run
 *   npx tsx apps/api/scripts/create-staff-pins.ts /tmp/staff.txt --apply
 *
 * One person per line, `Name, Venue` — or several venues joined by `;`, the
 * first being the one they sign in to by default:
 *
 *   Eloise Frank, Birmingham
 *   Marcela Kavuliakova, London East; London South
 *   Jonas Gottschalk, Manchester; Liverpool
 *
 * A third field sets the role (`head_baker`, the default, or `site_manager`).
 * Blank lines and lines starting `#` are ignored. Venues match a site's name or
 * slug, ignoring case.
 *
 * ── Why a file on the server and not a file in the repo ──────────────────
 * This repo is public. A staff list is people's names against their workplace,
 * and it has no business in git history. The list lives in /tmp in the
 * container for the minutes it takes to run this, and what is stored is only
 * what signing in needs: the name shown on the iPad, the venues, a hash.
 *
 * ── The PIN rules this keeps ─────────────────────────────────────────────
 *  - DISTINCT from every active PIN, not just this run's. `pin-login` without
 *    a site takes the first PIN whose hash verifies, so two people sharing a
 *    PIN would sign in as whichever row Postgres returns first, and file their
 *    counts under someone else's name. A hash cannot be compared, so each
 *    candidate is VERIFIED against every active hash and redrawn on a match.
 *  - Idempotent by name. A person who already has an active PIN is left alone:
 *    re-running must never replace a PIN already handed over. To reissue one,
 *    deactivate the old row first.
 *  - Extra venues are written to `device_pin_sites` as ADMIN grants, which is
 *    what head office already sees and can revoke (`GET /device-pins`).
 *  - The PIN is printed ONCE, on --apply. It is scrypt-hashed on the way in and
 *    cannot be read back; a dry run shows none, because a PIN that was never
 *    saved is a PIN someone might write down and hand out.
 */
import "dotenv/config";
import { randomInt } from "node:crypto";
import { readFileSync } from "node:fs";
import { and, eq } from "drizzle-orm";
import { closeDatabase, getDb } from "../src/config/database.js";
import { devicePins, devicePinSites, sites } from "../src/db/schema/index.js";
import { hashPassword, verifyPassword } from "../src/shared/auth/password.js";
import { getSingletonCompanyId } from "../src/shared/auth/company.js";

const ROLES = ["head_baker", "site_manager"] as const;
type StaffRole = (typeof ROLES)[number];

export interface StaffLine {
  line: number;
  name: string;
  venues: string[];
  role: StaffRole;
}

/** Parse the staff list. Throws naming every bad line, so nothing half-runs. */
export function parseStaffList(text: string): StaffLine[] {
  const out: StaffLine[] = [];
  const problems: string[] = [];
  text.split(/\r?\n/).forEach((raw, i) => {
    const line = raw.trim();
    if (!line || line.startsWith("#")) return;
    const [name = "", venues = "", role = ""] = line
      .split(",")
      .map((s) => s.trim());
    const venueList = venues
      .split(";")
      .map((v) => v.trim())
      .filter(Boolean);
    const chosenRole = (role || "head_baker") as StaffRole;
    if (!name) problems.push(`line ${i + 1}: no name`);
    else if (name.length > 120)
      problems.push(`line ${i + 1}: name is over 120 characters`);
    if (venueList.length === 0)
      problems.push(`line ${i + 1}: no venue for "${name}"`);
    if (!ROLES.includes(chosenRole)) {
      problems.push(
        `line ${i + 1}: role "${role}" is not one of ${ROLES.join(", ")}`,
      );
    }
    out.push({ line: i + 1, name, venues: venueList, role: chosenRole });
  });
  const seen = new Map<string, number>();
  for (const s of out) {
    const key = s.name.toLowerCase();
    if (seen.has(key))
      problems.push(
        `line ${s.line}: "${s.name}" is also on line ${seen.get(key)}`,
      );
    else seen.set(key, s.line);
  }
  if (problems.length > 0)
    throw new Error(`the staff list has problems:\n  ${problems.join("\n  ")}`);
  return out;
}

/** 6 digits, no leading zero — the same shape as the site PINs, for the same
 *  reason: a leading zero does not survive a spreadsheet or a handover note. */
function drawPin(): string {
  return String(randomInt(100_000, 1_000_000));
}

export interface StaffPinResult {
  name: string;
  venues: string[];
  role: StaffRole;
  status: "created" | "exists" | "would-create";
  /** Only on a row this run created. */
  pin?: string;
}

export async function createStaffPins(
  staff: StaffLine[],
  opts: { apply?: boolean; addedBy?: string } = {},
): Promise<StaffPinResult[]> {
  const companyId = getSingletonCompanyId();
  const db = getDb();

  const siteRows = await db.query.sites.findMany({
    where: eq(sites.companyId, companyId),
  });
  const findSite = (v: string) => {
    const k = v.toLowerCase();
    return siteRows.find(
      (s) => s.name.toLowerCase() === k || s.slug.toLowerCase() === k,
    );
  };
  // Every venue checked before anything is written: a typo on line 9 must not
  // leave lines 1–8 created and the rest not.
  const unknown = staff.flatMap((s) =>
    s.venues.filter((v) => !findSite(v)).map((v) => `"${v}" (${s.name})`),
  );
  if (unknown.length > 0) {
    throw new Error(
      `no venue called ${unknown.join(", ")}. Venues here: ${siteRows.map((s) => s.name).join(", ")}`,
    );
  }

  const active = await db.query.devicePins.findMany({
    where: and(
      eq(devicePins.companyId, companyId),
      eq(devicePins.isActive, true),
    ),
  });
  const existingByName = new Set(
    active.map((p) => p.label.trim().toLowerCase()),
  );
  const hashes = active.map((p) => p.pinHash);
  const drawn = new Set<string>();

  async function distinctPin(): Promise<string> {
    for (let attempt = 0; attempt < 50; attempt++) {
      const pin = drawPin();
      if (drawn.has(pin)) continue;
      let clash = false;
      for (const h of hashes) {
        if (await verifyPassword(pin, h)) {
          clash = true;
          break;
        }
      }
      if (!clash) {
        drawn.add(pin);
        return pin;
      }
    }
    throw new Error("could not draw a PIN distinct from the active ones");
  }

  const results: StaffPinResult[] = [];
  for (const person of staff) {
    const venues = person.venues.map((v) => findSite(v)!);
    const base = {
      name: person.name,
      venues: venues.map((v) => v.name),
      role: person.role,
    };
    if (existingByName.has(person.name.toLowerCase())) {
      results.push({ ...base, status: "exists" });
      continue;
    }
    if (!opts.apply) {
      results.push({ ...base, status: "would-create" });
      continue;
    }

    const pin = await distinctPin();
    const [home, ...extras] = venues;
    await db.transaction(async (tx) => {
      const [row] = await tx
        .insert(devicePins)
        .values({
          companyId,
          siteId: home!.id,
          label: person.name,
          pinHash: await hashPassword(pin),
          roles: [person.role],
        })
        .returning({ id: devicePins.id });
      for (const site of extras) {
        await tx.insert(devicePinSites).values({
          companyId,
          devicePinId: row!.id,
          siteId: site.id,
          addedVia: "ADMIN",
          addedBy: opts.addedBy ?? "create-staff-pins",
        });
      }
    });
    results.push({ ...base, status: "created", pin });
  }
  return results;
}

const isCliEntry = process.argv[1]?.endsWith("create-staff-pins.ts") ?? false;

if (isCliEntry) {
  const apply = process.argv.includes("--apply");
  const file = process.argv.slice(2).find((a) => !a.startsWith("--"));
  Promise.resolve()
    .then(() => {
      if (!file)
        throw new Error("give the staff list file, e.g. /tmp/staff.txt");
      return createStaffPins(parseStaffList(readFileSync(file, "utf8")), {
        apply,
      });
    })
    .then((results) => {
      console.log(
        `[create-staff-pins] ${apply ? "OK" : "DRY RUN — nothing written, no PINs issued"}`,
      );
      console.log("");
      for (const r of results) {
        const state =
          r.status === "exists"
            ? "(already has a PIN — unchanged)"
            : r.status === "created"
              ? r.pin!
              : "would create";
        const role = r.role === "head_baker" ? "" : ` [${r.role}]`;
        console.log(
          `  ${r.name.padEnd(24)} ${state.padEnd(34)} ${r.venues.join(" + ")}${role}`,
        );
      }
      if (results.some((r) => r.pin)) {
        console.log("");
        console.log(
          "  ^ Copy these now — they are hashed and cannot be read back.",
        );
        console.log("    Then delete the list: rm " + file);
      } else if (!apply) {
        console.log("");
        console.log("  Looks right? Run again with --apply to create them.");
      }
    })
    .catch((err) => {
      console.error(
        "[create-staff-pins] FAILED:",
        err instanceof Error ? err.message : err,
      );
      process.exitCode = 1;
    })
    .finally(() => closeDatabase());
}
