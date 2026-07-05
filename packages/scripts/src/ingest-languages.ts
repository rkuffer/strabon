// packages/scripts/src/ingest-languages.ts
// =============================================================================
// Resolve QIDs for the curated language referential and ingest into
// wikidata_entities (kind='language'). Same workflow as ingest-religions.ts:
//   --resolve   : resolve names → QIDs via Wikidata, output JSON for review
//   --ingest    : insert the resolved list into wikidata_entities
//
// Usage:
//   npx tsx packages/scripts/src/ingest-languages.ts --resolve > languages-resolved.json
//   # Review, fix wrong QIDs
//   npx tsx packages/scripts/src/ingest-languages.ts --ingest < languages-resolved.json
// =============================================================================

import { wikiFetchJson } from "../../server/src/agent/wiki-fetch.js";
import { getSql, closeSql } from "@strabon/db";

const WIKIDATA_API = "https://www.wikidata.org/w/api.php";

type LangEntry = { name: string; family: string; notes?: string };

const FAMILIES: Record<string, LangEntry[]> = {

  // ── INDO-EUROPEAN — Romance ───────────────────────────────────────────────
  "Indo-European": [
    // Romance
    { name: "Latin", family: "Indo-European" },
    { name: "Old French", family: "Indo-European" },
    { name: "French", family: "Indo-European" },
    { name: "Occitan", family: "Indo-European" },
    { name: "Spanish", family: "Indo-European" },
    { name: "Portuguese", family: "Indo-European" },
    { name: "Italian", family: "Indo-European" },
    { name: "Romanian", family: "Indo-European" },
    { name: "Catalan", family: "Indo-European" },
    { name: "Sardinian", family: "Indo-European" },
    { name: "Dalmatian language", family: "Indo-European", notes: "extinct, medieval Adriatic" },
    { name: "Galician", family: "Indo-European" },

    // Germanic
    { name: "Old English", family: "Indo-European" },
    { name: "Middle English", family: "Indo-European" },
    { name: "English", family: "Indo-European" },
    { name: "Old High German", family: "Indo-European" },
    { name: "Middle High German", family: "Indo-European" },
    { name: "German", family: "Indo-European" },
    { name: "Dutch", family: "Indo-European" },
    { name: "Old Norse", family: "Indo-European" },
    { name: "Swedish", family: "Indo-European" },
    { name: "Danish", family: "Indo-European" },
    { name: "Norwegian", family: "Indo-European" },
    { name: "Icelandic", family: "Indo-European" },
    { name: "Gothic language", family: "Indo-European", notes: "extinct, Goths" },
    { name: "Yiddish", family: "Indo-European" },
    { name: "Afrikaans", family: "Indo-European" },

    // Slavic
    { name: "Old Church Slavonic", family: "Indo-European" },
    { name: "Old East Slavic", family: "Indo-European" },
    { name: "Russian", family: "Indo-European" },
    { name: "Ukrainian", family: "Indo-European" },
    { name: "Polish", family: "Indo-European" },
    { name: "Czech", family: "Indo-European" },
    { name: "Slovak", family: "Indo-European" },
    { name: "Slovene", family: "Indo-European" },
    { name: "Serbian", family: "Indo-European" },
    { name: "Croatian", family: "Indo-European" },
    { name: "Bulgarian", family: "Indo-European" },
    { name: "Macedonian language", family: "Indo-European" },

    // Hellenic
    { name: "Ancient Greek", family: "Indo-European" },
    { name: "Greek", family: "Indo-European", notes: "Modern Greek" },

    // Indo-Iranian
    { name: "Sanskrit", family: "Indo-European" },
    { name: "Hindi", family: "Indo-European" },
    { name: "Urdu", family: "Indo-European" },
    { name: "Punjabi", family: "Indo-European" },
    { name: "Bengali", family: "Indo-European" },
    { name: "Old Persian", family: "Indo-European" },
    { name: "Middle Persian", family: "Indo-European" },
    { name: "Persian", family: "Indo-European", notes: "Modern Persian / Farsi" },
    { name: "Avestan", family: "Indo-European" },
    { name: "Kurdish", family: "Indo-European" },
    { name: "Pashto", family: "Indo-European" },
    { name: "Sogdian", family: "Indo-European", notes: "extinct, Silk Road lingua franca" },
    { name: "Nepali", family: "Indo-European" },

    // Celtic
    { name: "Old Irish", family: "Indo-European" },
    { name: "Irish", family: "Indo-European" },
    { name: "Welsh", family: "Indo-European" },
    { name: "Breton", family: "Indo-European" },
    { name: "Scottish Gaelic", family: "Indo-European" },

    // Baltic
    { name: "Lithuanian", family: "Indo-European" },
    { name: "Latvian", family: "Indo-European" },

    // Other IE
    { name: "Albanian", family: "Indo-European" },
    { name: "Armenian", family: "Indo-European" },
    { name: "Tocharian", family: "Indo-European", notes: "extinct, Silk Road" },
    { name: "Hittite language", family: "Indo-European", notes: "oldest attested IE language" },
    { name: "Phrygian language", family: "Indo-European", notes: "extinct, ancient Anatolia" },
    { name: "Ladino", family: "Indo-European", notes: "Judeo-Spanish, Sephardic diaspora" },
  ],

  // ── SEMITIC / AFRO-ASIATIC ──────────────────────────────────────────────────
  "Semitic/Afro-Asiatic": [
    { name: "Akkadian", family: "Semitic/Afro-Asiatic" },
    { name: "Aramaic", family: "Semitic/Afro-Asiatic" },
    { name: "Biblical Hebrew", family: "Semitic/Afro-Asiatic", notes: "ancient/classical Hebrew" },
    { name: "Hebrew", family: "Semitic/Afro-Asiatic", notes: "Modern Hebrew" },
    { name: "Arabic", family: "Semitic/Afro-Asiatic" },
    { name: "Phoenician language", family: "Semitic/Afro-Asiatic" },
    { name: "Ugaritic", family: "Semitic/Afro-Asiatic" },
    { name: "Ge'ez", family: "Semitic/Afro-Asiatic", notes: "Ethiopian ancient, liturgical" },
    { name: "Amharic", family: "Semitic/Afro-Asiatic" },
    { name: "Coptic language", family: "Semitic/Afro-Asiatic" },
    { name: "Egyptian language", family: "Semitic/Afro-Asiatic", notes: "Ancient Egyptian" },
    { name: "Maltese", family: "Semitic/Afro-Asiatic" },
    { name: "Elamite language", family: "Semitic/Afro-Asiatic", notes: "extinct, ancient Persia — language isolate, placed here by geography" },
    { name: "Hausa", family: "Semitic/Afro-Asiatic" },
  ],

  // ── SINO-TIBETAN ────────────────────────────────────────────────────────────
  "Sino-Tibetan": [
    { name: "Classical Chinese", family: "Sino-Tibetan" },
    { name: "Mandarin", family: "Sino-Tibetan" },
    { name: "Cantonese", family: "Sino-Tibetan" },
    { name: "Tibetan language", family: "Sino-Tibetan" },
    { name: "Burmese", family: "Sino-Tibetan" },
  ],

  // ── TURKIC ──────────────────────────────────────────────────────────────────
  "Turkic": [
    { name: "Old Turkic", family: "Turkic" },
    { name: "Turkish", family: "Turkic" },
    { name: "Azerbaijani", family: "Turkic" },
    { name: "Uzbek", family: "Turkic" },
    { name: "Kazakh", family: "Turkic" },
    { name: "Tatar", family: "Turkic" },
    { name: "Crimean Tatar", family: "Turkic" },
    { name: "Bashkir", family: "Turkic" },
    { name: "Chuvash", family: "Turkic" },
  ],

  // ── URALIC ──────────────────────────────────────────────────────────────────
  "Uralic": [
    { name: "Finnish", family: "Uralic" },
    { name: "Hungarian", family: "Uralic" },
    { name: "Estonian", family: "Uralic" },
  ],

  // ── AUSTRONESIAN ────────────────────────────────────────────────────────────
  "Austronesian": [
    { name: "Malay", family: "Austronesian" },
    { name: "Javanese", family: "Austronesian" },
    { name: "Tagalog", family: "Austronesian" },
    { name: "Malagasy", family: "Austronesian" },
  ],

  // ── DRAVIDIAN ───────────────────────────────────────────────────────────────
  "Dravidian": [
    { name: "Tamil", family: "Dravidian" },
    { name: "Telugu", family: "Dravidian" },
    { name: "Kannada", family: "Dravidian" },
  ],

  // ── MONGOLIC ────────────────────────────────────────────────────────────────
  "Mongolic": [
    { name: "Mongolian", family: "Mongolic" },
    { name: "Buryat", family: "Mongolic" },
    { name: "Kalmyk", family: "Mongolic" },
  ],

  // ── TAI-KADAI ───────────────────────────────────────────────────────────────
  "Tai-Kadai": [
    { name: "Thai", family: "Tai-Kadai" },
  ],

  // ── AUSTROASIATIC ───────────────────────────────────────────────────────────
  "Austroasiatic": [
    { name: "Vietnamese", family: "Austroasiatic" },
    { name: "Khmer", family: "Austroasiatic" },
  ],

  // ── KOREANIC ────────────────────────────────────────────────────────────────
  "Koreanic": [
    { name: "Korean", family: "Koreanic" },
  ],

  // ── JAPONIC ─────────────────────────────────────────────────────────────────
  "Japonic": [
    { name: "Japanese", family: "Japonic" },
  ],

  // ── KARTVELIAN ──────────────────────────────────────────────────────────────
  "Kartvelian": [
    { name: "Georgian", family: "Kartvelian" },
  ],

  // ── NORTHEAST CAUCASIAN ─────────────────────────────────────────────────────
  "Northeast Caucasian": [
    { name: "Chechen", family: "Northeast Caucasian" },
  ],

  // ── LANGUAGE ISOLATES ───────────────────────────────────────────────────────
  "Language isolate": [
    { name: "Sumerian", family: "Language isolate" },
    { name: "Basque", family: "Language isolate" },
    { name: "Etruscan language", family: "Language isolate", notes: "extinct, pre-Roman Italy" },
  ],

  // ── NIGER-CONGO / AFRICAN ───────────────────────────────────────────────────
  "Niger-Congo": [
    { name: "Swahili", family: "Niger-Congo" },
    { name: "Yoruba", family: "Niger-Congo" },
    { name: "Zulu", family: "Niger-Congo" },
  ],

  // ── ESKIMO-ALEUT ────────────────────────────────────────────────────────────
  "Eskimo-Aleut": [
    { name: "Inuktitut", family: "Eskimo-Aleut" },
    { name: "Greenlandic", family: "Eskimo-Aleut" },
  ],

  // ── INDIGENOUS AMERICAS ─────────────────────────────────────────────────────
  "Indigenous Americas": [
    { name: "Nahuatl", family: "Indigenous Americas" },
    { name: "Quechua", family: "Indigenous Americas" },
    { name: "Guarani", family: "Indigenous Americas" },
    { name: "Yucatec Maya", family: "Indigenous Americas" },
    { name: "Aymara", family: "Indigenous Americas" },
    { name: "Mapudungun", family: "Indigenous Americas" },
  ],

  // ── AUSTRALIAN ──────────────────────────────────────────────────────────────
  "Australian Aboriginal": [
    { name: "Australian Aboriginal languages", family: "Australian Aboriginal", notes: "generic umbrella entry" },
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
    console.error(`Resolving ${allEntries.length} languages...`);

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
          'language',
          ${r.resolved_label || r.name},
          ${r.resolved_description || null},
          ${r.name},
          ${null},
          ${r.family},
          'curated'
        )
        ON CONFLICT (qid) DO UPDATE SET
          kind = 'language',
          label_en = COALESCE(EXCLUDED.label_en, wikidata_entities.label_en),
          family_label = EXCLUDED.family_label,
          source_class = 'curated'
      `;
      inserted++;
      console.error(`  ✓ ${r.qid} ${r.name} [${r.family}]`);
    }
    console.error(`\nIngested ${inserted} languages`);
    await closeSql();

  } else {
    console.error("Usage:");
    console.error("  --resolve   Resolve names to QIDs, output JSON to stdout");
    console.error("  --ingest    Read resolved JSON from stdin, insert into wikidata_entities");
    process.exit(1);
  }
}

main().catch((err) => {
  console.error("FAILED:", err?.message ?? err);
  process.exit(1);
});
