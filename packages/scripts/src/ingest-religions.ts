// packages/scripts/src/ingest-religions.ts
// =============================================================================
// Resolve QIDs for the curated religion referential and ingest into
// wikidata_entities (kind='religion'). Two modes:
//   --resolve   : resolve names → QIDs via Wikidata, output JSON for review
//   --ingest    : insert the resolved list into wikidata_entities
//
// Usage:
//   npx tsx packages/scripts/src/ingest-religions.ts --resolve > religions-resolved.json
//   npx tsx packages/scripts/src/ingest-religions.ts --ingest
// =============================================================================

import { wikiFetchJson } from "../../server/src/agent/wiki-fetch.js";
import { getSql, closeSql } from "@strabon/db";

const WIKIDATA_API = "https://www.wikidata.org/w/api.php";

// ── The curated list ──────────────────────────────────────────────────────────

type ReligionEntry = {
  name: string;
  family: string;
  family_id?: string; // resolved later or manually
  notes?: string;
};

const FAMILIES: Record<string, ReligionEntry[]> = {
  // ── ABRAHAMIC — Islam ───────────────────────────────────────────────────────
  "Abrahamic": [
    // Islam
    { name: "Islam", family: "Abrahamic" },
    { name: "Sunni Islam", family: "Abrahamic" },
    { name: "Shia Islam", family: "Abrahamic" },
    { name: "Ismaili", family: "Abrahamic", notes: "Ismaili branch of Shia Islam" },
    { name: "Ibadi Islam", family: "Abrahamic" },
    { name: "Druze", family: "Abrahamic" },
    { name: "Ahmadiyya", family: "Abrahamic" },
    // Christianity
    { name: "Christianity", family: "Abrahamic" },
    { name: "Eastern Orthodox Church", family: "Abrahamic" },
    { name: "Catholic Church", family: "Abrahamic" },
    { name: "Protestantism", family: "Abrahamic" },
    { name: "Lutheranism", family: "Abrahamic" },
    { name: "Calvinism", family: "Abrahamic" },
    { name: "Anglicanism", family: "Abrahamic" },
    { name: "Baptists", family: "Abrahamic" },
    { name: "Anabaptism", family: "Abrahamic" },
    { name: "Church of the East", family: "Abrahamic", notes: "Nestorianism" },
    { name: "Coptic Orthodox Church", family: "Abrahamic" },
    { name: "Armenian Apostolic Church", family: "Abrahamic" },
    { name: "Ethiopian Orthodox Tewahedo Church", family: "Abrahamic" },
    { name: "Arianism", family: "Abrahamic" },
    { name: "Hussites", family: "Abrahamic" },
    { name: "Waldensians", family: "Abrahamic" },
    // Heterodox / dissident
    { name: "Gnosticism", family: "Abrahamic", notes: "sub-currents (Valentinianism, Marcionites) in meta" },
    { name: "Manichaeism", family: "Abrahamic", notes: "Iranian origin but classified here for hull grouping" },
    { name: "Catharism", family: "Abrahamic" },
    { name: "Bogomilism", family: "Abrahamic" },
    { name: "Paulicianism", family: "Abrahamic" },
    { name: "Donatism", family: "Abrahamic" },
    { name: "Mandaeism", family: "Abrahamic", notes: "Separate entry due to importance in emergence of Islam" },
    // Judaism
    { name: "Judaism", family: "Abrahamic" },
    { name: "ancient Israelite religion", family: "Abrahamic", notes: "pre-exilic Hebrew religion" },
    { name: "Rabbinic Judaism", family: "Abrahamic" },
    { name: "Karaite Judaism", family: "Abrahamic" },
    { name: "Samaritanism", family: "Abrahamic" },
  ],

  // ── IRANIAN ─────────────────────────────────────────────────────────────────
  "Iranian": [
    { name: "Zoroastrianism", family: "Iranian" },
    { name: "Zurvanism", family: "Iranian" },
    { name: "Yazidism", family: "Iranian" },
  ],

  // ── INDIAN / DHARMIC ────────────────────────────────────────────────────────
  "Indian/Dharmic": [
    { name: "Hinduism", family: "Indian/Dharmic" },
    { name: "Buddhism", family: "Indian/Dharmic" },
    { name: "Theravada", family: "Indian/Dharmic" },
    { name: "Mahayana", family: "Indian/Dharmic" },
    { name: "Vajrayana", family: "Indian/Dharmic", notes: "Tibetan Buddhism" },
    { name: "Jainism", family: "Indian/Dharmic" },
    { name: "Sikhism", family: "Indian/Dharmic" },
    { name: "Historical Vedic religion", family: "Indian/Dharmic" },
    { name: "Ājīvika", family: "Indian/Dharmic" },
  ],

  // ── EAST ASIAN ──────────────────────────────────────────────────────────────
  "East Asian": [
    { name: "Confucianism", family: "East Asian" },
    { name: "Taoism", family: "East Asian" },
    { name: "Shinto", family: "East Asian" },
    { name: "Chinese folk religion", family: "East Asian" },
    { name: "Bon", family: "East Asian", notes: "pre-Buddhist Tibetan religion" },
  ],

  // ── ANCIENT NEAR EAST ───────────────────────────────────────────────────────
  "Ancient Near East": [
    { name: "Sumerian religion", family: "Ancient Near East" },
    { name: "Ancient Mesopotamian religion", family: "Ancient Near East", notes: "Babylonian/Assyrian" },
    { name: "ancient Egyptian religion", family: "Ancient Near East" },
    { name: "Canaanite religion", family: "Ancient Near East" },
    { name: "Hittite religion", family: "Ancient Near East", notes: "may be hard to find on Wikidata" },
    { name: "Ugaritic religion", family: "Ancient Near East", notes: "may be hard to find on Wikidata" },
    { name: "Phoenician religion", family: "Ancient Near East" },
  ],

  // ── ANCIENT MEDITERRANEAN ───────────────────────────────────────────────────
  "Ancient Mediterranean": [
    { name: "ancient Greek religion", family: "Ancient Mediterranean" },
    { name: "religion in ancient Rome", family: "Ancient Mediterranean" },
    { name: "Mithraism", family: "Ancient Mediterranean" },
    { name: "Eleusinian Mysteries", family: "Ancient Mediterranean" },
    { name: "Orphism", family: "Ancient Mediterranean" },
    { name: "Etruscan religion", family: "Ancient Mediterranean", notes: "may be hard to find" },
  ],

  // ── EURASIAN / STEPPE ───────────────────────────────────────────────────────
  "Eurasian/Steppe": [
    { name: "Tengrism", family: "Eurasian/Steppe" },
    { name: "Germanic paganism", family: "Eurasian/Steppe" },
    { name: "Celtic religion", family: "Eurasian/Steppe", notes: "may be 'Celtic polytheism'" },
    { name: "Slavic paganism", family: "Eurasian/Steppe" },
    { name: "Baltic paganism", family: "Eurasian/Steppe", notes: "may be 'Baltic religion'" },
    { name: "shamanism", family: "Eurasian/Steppe" },
    { name: "Finnish paganism", family: "Eurasian/Steppe" },
  ],

  // ── AFRICAN TRADITIONAL ─────────────────────────────────────────────────────
  "African traditional": [
    { name: "traditional African religions", family: "African traditional" },
    { name: "Vodou", family: "African traditional" },
    { name: "Yoruba religion", family: "African traditional" },
  ],

  // ── PRE-COLUMBIAN ───────────────────────────────────────────────────────────
  "Pre-Columbian": [
    { name: "Aztec religion", family: "Pre-Columbian" },
    { name: "Maya religion", family: "Pre-Columbian" },
    { name: "Inca religion", family: "Pre-Columbian" },
  ],
};

// ── QID resolution ────────────────────────────────────────────────────────────

async function resolveQid(name: string): Promise<{ qid: string; label: string; description: string } | null> {
  const url =
    `${WIKIDATA_API}?action=wbsearchentities&format=json&language=en&uselang=en` +
    `&type=item&limit=5&search=${encodeURIComponent(name)}`;
  const data = await wikiFetchJson(url);
  const hits = data?.search ?? [];
  if (hits.length === 0) return null;
  // Take the first hit — for curated names this should be the right one,
  // but the output is for HUMAN REVIEW before ingestion.
  return {
    qid: hits[0].id,
    label: hits[0].label ?? name,
    description: hits[0].description ?? "",
  };
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  const mode = process.argv[2];

  if (mode === "--resolve") {
    const results: any[] = [];
    const allEntries = Object.values(FAMILIES).flat();
    console.error(`Resolving ${allEntries.length} religions...`);

    for (const entry of allEntries) {
      const resolved = await resolveQid(entry.name);
      results.push({
        name: entry.name,
        family: entry.family,
        qid: resolved?.qid ?? "NOT_FOUND",
        resolved_label: resolved?.label ?? "",
        resolved_description: resolved?.description ?? "",
        notes: entry.notes ?? "",
        ok: resolved ? "✓" : "✗",
      });
      console.error(`  ${resolved ? "✓" : "✗"} ${entry.name} → ${resolved?.qid ?? "NOT_FOUND"} (${resolved?.description ?? ""})`);
    }

    console.log(JSON.stringify(results, null, 2));
    console.error(`\nDone: ${results.filter(r => r.ok === "✓").length}/${results.length} resolved`);

  } else if (mode === "--ingest") {
    // Read resolved JSON from stdin
    const chunks: Buffer[] = [];
    for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
    const resolved: any[] = JSON.parse(Buffer.concat(chunks).toString());

    const sql = getSql();
    let inserted = 0;
    for (const r of resolved) {
      if (r.qid === "NOT_FOUND") {
        console.error(`  SKIP ${r.name} (no QID)`);
        continue;
      }
      await sql`
        INSERT INTO wikidata_entities (qid, kind, label_en, description_en, search_text, family_qid, family_label, source_class)
        VALUES (
          ${r.qid},
          'religion',
          ${r.resolved_label || r.name},
          ${r.resolved_description || null},
          ${r.name},
          ${null},
          ${r.family},
          'curated'
        )
        ON CONFLICT (qid) DO UPDATE SET
          kind = 'religion',
          label_en = COALESCE(EXCLUDED.label_en, wikidata_entities.label_en),
          family_label = EXCLUDED.family_label,
          source_class = 'curated'
      `;
      inserted++;
      console.error(`  ✓ ${r.qid} ${r.name} [${r.family}]`);
    }
    console.error(`\nIngested ${inserted} religions`);
    await closeSql();

  } else {
    console.error("Usage:");
    console.error("  --resolve   Resolve names to QIDs, output JSON to stdout");
    console.error("  --ingest    Read resolved JSON from stdin, insert into wikidata_entities");
    console.error("");
    console.error("Workflow:");
    console.error("  npx tsx ingest-religions.ts --resolve > religions-resolved.json");
    console.error("  # Review religions-resolved.json, fix any wrong QIDs");
    console.error("  npx tsx ingest-religions.ts --ingest < religions-resolved.json");
    process.exit(1);
  }
}

main().catch((err) => {
  console.error("FAILED:", err?.message ?? err);
  process.exit(1);
});
