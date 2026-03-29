#!/usr/bin/env node

/**
 * WhatsApp Group Import → Open Brain Knowledge Base (Final)
 *
 * Features:
 *   - Config file with per-group settings
 *   - Incremental import: only processes messages after last indexed date
 *   - Message-level dedup: filters consecutive identical messages in export
 *   - 4-pass smart chunking: silence → size guard → temporal headers → long split
 *   - Aggressive filtering of low-value messages
 *
 * Usage:
 *   node import-whatsapp.mjs --config config.json --dry-run          # dry run all groups
 *   node import-whatsapp.mjs --config config.json --group "Clawders" # import one group
 *   node import-whatsapp.mjs --config config.json                    # import all groups
 *   node import-whatsapp.mjs <file.txt> --group "Name"               # standalone mode
 *
 * Environment:
 *   SUPABASE_URL (or set in config), SUPABASE_SERVICE_ROLE_KEY, OPENROUTER_API_KEY
 */

import { readFileSync, existsSync } from "fs";
import { basename, resolve } from "path";
import { homedir } from "os";

// --- CLI args ---
const args = process.argv.slice(2);

function getArg(flag, fallback) {
  const idx = args.indexOf(flag);
  return idx !== -1 && idx + 1 < args.length ? args[idx + 1] : fallback;
}

const configPath = getArg("--config", null);
const targetGroup = getArg("--group", null);
const dryRun = args.includes("--dry-run");

// --- Load config or standalone mode ---

let config;
if (configPath) {
  config = JSON.parse(readFileSync(configPath, "utf-8"));
} else {
  const filePath = args.find((a) => !a.startsWith("--"));
  if (!filePath) {
    console.error("Usage:");
    console.error("  node import-whatsapp.mjs --config config.json [--group 'Name'] [--dry-run]");
    console.error("  node import-whatsapp.mjs <file.txt> --group 'Name' [--dry-run]");
    process.exit(1);
  }
  config = {
    collection_name: "WhatsApp Groups",
    defaults: { gap: 10, maxChars: 1500, maxMsgs: 15, overlap: 3, merge: 300 },
    groups: [{
      name: getArg("--group", basename(filePath, ".txt")),
      file: filePath,
      gap: parseInt(getArg("--gap", "0")) || undefined,
      maxChars: parseInt(getArg("--max-chars", "0")) || undefined,
      maxMsgs: parseInt(getArg("--max-msgs", "0")) || undefined,
      overlap: parseInt(getArg("--overlap", "0")) || undefined,
      merge: parseInt(getArg("--merge", "0")) || undefined,
    }],
  };
}

const SUPABASE_URL = process.env.SUPABASE_URL || config.supabase_url;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const OPENROUTER_KEY = process.env.OPENROUTER_API_KEY;
const COLLECTION_NAME = config.collection_name || "WhatsApp Groups";
const DEFAULTS = config.defaults || { gap: 10, maxChars: 1500, maxMsgs: 15, overlap: 3, merge: 300 };

if (!SUPABASE_URL || !SUPABASE_KEY || !OPENROUTER_KEY) {
  console.error("Missing env vars: SUPABASE_URL (or config), SUPABASE_SERVICE_ROLE_KEY, OPENROUTER_API_KEY");
  process.exit(1);
}

function expandPath(p) {
  return p.startsWith("~") ? resolve(homedir(), p.slice(2)) : resolve(p);
}

// --- Parse WhatsApp ---

const MESSAGE_RE = /^(\d{1,2}\/\d{1,2}\/\d{2,4},\s*\d{1,2}:\d{2}\s*[APap][Mm])\s*-\s*(.+?):\s*(.+)$/;
const SYSTEM_LINE_RE = /^\d{1,2}\/\d{1,2}\/\d{2,4},\s*\d{1,2}:\d{2}\s*[APap][Mm]\s*-\s*/;

function isSystemLine(line) {
  return SYSTEM_LINE_RE.test(line) && !MESSAGE_RE.test(line);
}

const LEAKED_PATTERNS = [
  /^\d{1,2}\/\d{1,2}\/\d{2,4},\s*\d{1,2}:\d{2}\s*[APap][Mm]\s*-/,
  /^~?\s*\w+\s+added\s+\+?\d/i,
  /^~?\s*\w+\s+removed\s+\+?\d/i,
  /^~?\s*\w+\s+left$/i,
  /^~?\s*\w+\s+joined/i,
  /הוסיף את\s+\+?\d/,
  /הוציא את/,
  /added\s+\+\d{3}\s+\d/,
];

function isLeakedSystemLine(line) {
  return LEAKED_PATTERNS.some((p) => p.test(line));
}

function parseMessages(text) {
  const lines = text.split("\n");
  const messages = [];
  let current = null;

  for (const line of lines) {
    if (isSystemLine(line)) continue;
    if (!MESSAGE_RE.test(line) && LEAKED_PATTERNS.some((p) => p.test(line))) continue;

    const match = line.match(MESSAGE_RE);
    if (match) {
      if (current) messages.push(current);
      const [, dateStr, sender, content] = match;
      current = {
        date: parseDate(dateStr),
        sender: normalizeSender(sender),
        content: content.trim(),
      };
    } else if (current && line.trim()) {
      const trimmed = line.trim();
      if (!isLeakedSystemLine(trimmed)) {
        current.content += "\n" + trimmed;
      }
    }
  }
  if (current) messages.push(current);
  return messages;
}

function parseDate(str) {
  const [datePart, timePart] = str.split(",").map((s) => s.trim());
  const [month, day, year] = datePart.split("/").map(Number);
  const fullYear = year < 100 ? 2000 + year : year;
  const timeMatch = timePart.match(/(\d{1,2}):(\d{2})\s*([APap][Mm])/);
  if (!timeMatch) return new Date(fullYear, month - 1, day);
  let [, hours, minutes, ampm] = timeMatch;
  hours = parseInt(hours);
  minutes = parseInt(minutes);
  if (ampm.toUpperCase() === "PM" && hours !== 12) hours += 12;
  if (ampm.toUpperCase() === "AM" && hours === 12) hours = 0;
  return new Date(fullYear, month - 1, day, hours, minutes);
}

function normalizeSender(s) { return s.replace(/\u200e/g, "").trim(); }

// --- Filtering ---

const SYSTEM_PATTERNS = [
  /messages and calls are end-to-end encrypted/i,
  /created group/i, /added you/i, /changed the subject/i,
  /changed this group/i, /\bleft\s*$/i, /\bremoved\b/i, /joined using/i,
  /changed the group description/i, /pinned a message/i,
  /<Media omitted>/i, /You deleted this message/i,
  /This message was deleted/i, /waiting for this message/i,
  /security code changed/i, /\badded\s+\+\d{3}/i,
  /הצטרפ/, /יצר את הקבוצה/, /שינה את/, /הוסיף את/, /הוצא/, /עזב/,
  /ההודעה נמחקה/, /מחקת הודעה/, /ממתין להודעה/,
];

const LOW_VALUE_PATTERNS = [
  /^(ok|okay|lol|haha|hahaha|yes|no|yep|nope|nice|cool|wow|thanks|thx|ty|np|gg)$/i,
  /^(תודה|תודה רבה|מעולה|יופי|אחלה|וואו|נייס|קול|בסדר|כן|לא|אוקיי|אוקי|סבבה|מסכים|בדיוק|נכון|ברור)$/,
  /^(👍|👏|🙏|❤️|🔥|😂|😄|😊|🤣|💪|👆|☝️|✅|💯|😍|🎉|👌|🤝|😅|🤷|🙈|😁)+$/,
  /^\+1$/, /^(amen|אמן)$/i,
  /^(good morning|בוקר טוב|לילה טוב|good night|שבת שלום|shabbat shalom|חג שמח)$/i,
  /^https?:\/\/\S+$/,
];

function filterMessages(messages) {
  const before = messages.length;

  // Step 1: Remove system messages and low-value
  let filtered = messages
    .filter((m) => !SYSTEM_PATTERNS.some((p) => p.test(m.content)))
    .map((m) => ({ ...m, content: m.content.replace(/<This message was edited>/g, "").trim() }))
    .filter((m) => m.content.length > 0)
    .filter((m) => {
      const t = m.content.trim();
      if (/This message was deleted/i.test(t)) return false;
      if (/ההודעה נמחקה/.test(t)) return false;
      if (t.length < 15) return false;
      const noEmoji = t.replace(/[\p{Emoji_Presentation}\p{Emoji}\u200d\ufe0f\u20e3]/gu, "").trim();
      if (noEmoji.length === 0) return false;
      if (LOW_VALUE_PATTERNS.some((p) => p.test(t))) return false;
      return true;
    });

  // Step 2: Remove consecutive duplicate messages (WhatsApp export bug)
  const deduped = [filtered[0]];
  for (let i = 1; i < filtered.length; i++) {
    const prev = filtered[i - 1];
    const curr = filtered[i];
    // Skip if same sender + same content + within 1 minute
    if (curr.sender === prev.sender &&
        curr.content === prev.content &&
        Math.abs(curr.date - prev.date) < 60000) {
      continue;
    }
    deduped.push(curr);
  }

  return { filtered: deduped, removed: before - deduped.length };
}

// --- Smart Chunking ---

function splitOnSilence(messages, gapMin) {
  if (messages.length === 0) return [];
  const blocks = [];
  let current = [messages[0]];
  for (let i = 1; i < messages.length; i++) {
    const gap = (messages[i].date - messages[i - 1].date) / 60000;
    if (gap > gapMin) { blocks.push(current); current = [messages[i]]; }
    else current.push(messages[i]);
  }
  if (current.length > 0) blocks.push(current);
  return blocks;
}

function fmtMsg(m) { return `[${m.sender}]: ${m.content}`; }
function measureBlock(msgs) { return msgs.map(fmtMsg).join("\n").length; }

function splitOversized(blocks, maxC, maxM, overlap, merge) {
  const result = [];
  for (const block of blocks) {
    if (measureBlock(block) <= maxC && block.length <= maxM) { result.push(block); continue; }
    let i = 0;
    while (i < block.length) {
      const chunk = [block[i]];
      let chunkLen = fmtMsg(block[i]).length;
      let j = i + 1;
      while (j < block.length) {
        const next = fmtMsg(block[j]);
        if (chunkLen + 1 + next.length > maxC || chunk.length >= maxM) break;
        chunk.push(block[j]);
        chunkLen = chunkLen + 1 + next.length;
        j++;
      }
      result.push(chunk);
      const ns = j - overlap;
      i = Math.max(ns, i + 1);
      if (i >= block.length) break;
    }
  }
  // Merge tiny chunks
  const merged = [];
  for (const block of result) {
    const bl = measureBlock(block);
    if (bl < merge && merged.length > 0) {
      const pl = measureBlock(merged[merged.length - 1]);
      const cm = merged[merged.length - 1].length + block.length;
      if (pl + bl + 1 <= maxC && cm <= 20) { merged[merged.length - 1].push(...block); continue; }
    }
    merged.push([...block]);
  }
  return merged;
}

function blocksToChunks(blocks, group) {
  return blocks.map((msgs) => {
    const startDate = msgs[0].date;
    const endDate = msgs[msgs.length - 1].date;
    const participants = [...new Set(msgs.map((m) => m.sender))];
    const dateStr = startDate.toLocaleDateString("en-IL", { year: "numeric", month: "short", day: "numeric" });
    const header = `[${group} | ${dateStr} | ${msgs.length} messages | ${participants.length} participants]`;
    const body = msgs.map(fmtMsg).join("\n");
    return {
      content: `${header}\n\n${body}`,
      metadata: {
        start_date: startDate.toISOString(),
        end_date: endDate.toISOString(),
        participants,
        message_count: msgs.length,
        group_name: group,
      },
    };
  });
}

function splitLongChunks(chunks, maxC) {
  const final = [];
  for (const chunk of chunks) {
    if (chunk.content.length <= maxC + 100) { final.push(chunk); continue; }
    const header = chunk.content.split("\n\n")[0];
    const body = chunk.content.slice(header.length + 2);
    const paragraphs = body.split(/\n/).filter((p) => p.trim().length > 0);
    let current = header + "\n\n";
    let part = 1;
    for (const para of paragraphs) {
      if (current.length + para.length + 1 > maxC && current.length > header.length + 10) {
        final.push({ ...chunk, content: current.trim(), metadata: { ...chunk.metadata, split_part: part } });
        part++;
        current = header + ` (cont.)\n\n` + para + "\n";
      } else {
        current += para + "\n";
      }
    }
    if (current.trim().length > header.length + 5) {
      final.push({ ...chunk, content: current.trim(), metadata: { ...chunk.metadata, split_part: part } });
    }
  }
  return final;
}

// --- Supabase ---

const hdrs = {
  apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}`,
  "Content-Type": "application/json", Prefer: "return=representation",
};

async function sbPost(table, data) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${table}`, { method: "POST", headers: hdrs, body: JSON.stringify(data) });
  if (!res.ok) { const e = await res.text(); throw new Error(`POST ${table}: ${res.status} ${e}`); }
  return res.json();
}

async function sbGet(table, query) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${table}?${query}`, { headers: hdrs });
  if (!res.ok) throw new Error(`GET ${table}: ${res.status}`);
  return res.json();
}

// --- Get last indexed date for incremental import ---

async function getLastIndexedDate(collectionId, groupName) {
  // Find the document for this group
  const docs = await sbGet("documents", `collection_id=eq.${collectionId}&title=eq.${encodeURIComponent(groupName)}&select=id`);
  if (docs.length === 0) return null;

  // Find the latest chunk's end_date from metadata
  const chunks = await sbGet("chunks",
    `document_id=eq.${docs[0].id}&select=metadata&order=created_at.desc&limit=1`
  );
  if (chunks.length === 0) return null;

  const endDate = chunks[0].metadata?.end_date;
  return endDate ? new Date(endDate) : null;
}

// --- Embedding ---

async function batchEmbed(texts) {
  const batchSize = 50;
  const all = [];
  for (let i = 0; i < texts.length; i += batchSize) {
    const batch = texts.slice(i, i + batchSize);
    const res = await fetch("https://openrouter.ai/api/v1/embeddings", {
      method: "POST",
      headers: { Authorization: `Bearer ${OPENROUTER_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify({ model: "openai/text-embedding-3-small", input: batch }),
    });
    const data = await res.json();
    if (!data.data) throw new Error(`Embedding failed: ${JSON.stringify(data)}`);
    all.push(...data.data.map((d) => d.embedding));
    process.stdout.write(`  Embedded ${Math.min(i + batchSize, texts.length)}/${texts.length}\r`);
    if (i + batchSize < texts.length) await new Promise((r) => setTimeout(r, 200));
  }
  console.log(`  Embedded ${texts.length}/${texts.length}`);
  return all;
}

// --- Process one group ---

async function processGroup(group, collectionId) {
  const gap = group.gap || DEFAULTS.gap;
  const maxC = group.maxChars || DEFAULTS.maxChars;
  const maxM = group.maxMsgs || DEFAULTS.maxMsgs;
  const overlap = group.overlap || DEFAULTS.overlap;
  const merge = group.merge || DEFAULTS.merge;
  const filePath = expandPath(group.file);

  console.log(`\n${"═".repeat(60)}`);
  console.log(`📱 ${group.name}`);
  console.log(`${"═".repeat(60)}`);
  console.log(`   File:      ${filePath}`);
  console.log(`   Settings:  gap=${gap}m, max=${maxC}c/${maxM}m, overlap=${overlap}, merge=${merge}`);

  if (!existsSync(filePath)) {
    console.error(`   ❌ File not found: ${filePath}`);
    return;
  }

  // Parse
  const raw = readFileSync(filePath, "utf-8");
  const allMessages = parseMessages(raw);
  console.log(`\n   📊 Raw: ${allMessages.length} messages`);

  const { filtered: messages, removed } = filterMessages(allMessages);
  console.log(`   Filtered: ${removed} removed (${(removed / allMessages.length * 100).toFixed(0)}%), ${messages.length} kept`);

  if (messages.length === 0) { console.log("   No messages survived filtering."); return; }

  // Check for incremental import
  let incrementalFrom = null;
  if (!dryRun && collectionId) {
    incrementalFrom = await getLastIndexedDate(collectionId, group.name);
    if (incrementalFrom) {
      const newMessages = messages.filter((m) => m.date > incrementalFrom);
      if (newMessages.length === 0) {
        console.log(`   ✅ Already up to date (last indexed: ${incrementalFrom.toLocaleDateString()})`);
        return;
      }
      console.log(`   📆 Incremental: ${newMessages.length} new messages since ${incrementalFrom.toLocaleDateString()}`);
      // Replace messages with only new ones for chunking
      messages.splice(0, messages.length, ...newMessages);
    }
  }

  const participants = [...new Set(messages.map((m) => m.sender))];
  const firstDate = messages[0].date.toLocaleDateString();
  const lastDate = messages[messages.length - 1].date.toLocaleDateString();
  console.log(`   ${participants.length} participants | ${firstDate} → ${lastDate}`);

  // Chunking pipeline
  console.log(`\n   🔪 Chunking...`);
  const p1 = splitOnSilence(messages, gap);
  console.log(`   Pass 1 (silence): ${p1.length} blocks`);
  const p2 = splitOversized(p1, maxC, maxM, overlap, merge);
  console.log(`   Pass 2 (size): ${p2.length} blocks`);
  let chunks = blocksToChunks(p2, group.name);
  console.log(`   Pass 3 (headers): ${chunks.length} chunks`);
  chunks = splitLongChunks(chunks, maxC);
  console.log(`   Pass 4 (long split): ${chunks.length} final chunks`);

  // Stats
  const charLens = chunks.map((c) => c.content.length);
  const msgCnts = chunks.map((c) => c.metadata.message_count);
  const avg = (a) => (a.reduce((s, v) => s + v, 0) / a.length).toFixed(0);
  const singles = chunks.filter((c) => c.metadata.message_count === 1).length;
  const overMax = charLens.filter((c) => c > maxC + 100).length;
  const totalChars = charLens.reduce((s, v) => s + v, 0);
  const estCost = ((totalChars / 4) / 1000000 * 0.02).toFixed(4);

  console.log(`\n   📦 Chars: avg ${avg(charLens)}, min ${Math.min(...charLens)}, max ${Math.max(...charLens)}`);
  console.log(`   Msgs:  avg ${avg(msgCnts)}, min ${Math.min(...msgCnts)}, max ${Math.max(...msgCnts)}`);
  console.log(`   Singles: ${singles} (${(singles / chunks.length * 100).toFixed(0)}%)`);
  if (overMax > 0) console.log(`   ⚠️  ${overMax} chunks exceed ${maxC} chars`);
  console.log(`   💰 Est. cost: $${estCost}`);

  if (dryRun) {
    console.log(`\n   --- Samples ---`);
    for (const i of [0, Math.floor(chunks.length / 2), chunks.length - 1]) {
      if (i >= chunks.length) continue;
      const c = chunks[i];
      console.log(`\n   ━━━ Chunk ${i + 1}/${chunks.length} (${c.metadata.message_count} msgs, ${c.content.length} chars) ━━━`);
      console.log("   " + c.content.substring(0, 400).split("\n").join("\n   "));
      if (c.content.length > 400) console.log(`   ... (${c.content.length - 400} more chars)`);
    }
    return;
  }

  // --- Real import ---

  // Ensure document exists (for incremental, we append chunks to existing doc)
  let docId;
  const existingDocs = await sbGet("documents", `collection_id=eq.${collectionId}&title=eq.${encodeURIComponent(group.name)}`);

  if (existingDocs.length > 0) {
    docId = existingDocs[0].id;
    // Update document metadata
    const updateRes = await fetch(`${SUPABASE_URL}/rest/v1/documents?id=eq.${docId}`, {
      method: "PATCH",
      headers: hdrs,
      body: JSON.stringify({
        metadata: {
          ...existingDocs[0].metadata,
          last_incremental: new Date().toISOString(),
          total_messages: (existingDocs[0].metadata?.total_messages || existingDocs[0].metadata?.message_count || 0) + messages.length,
        },
      }),
    });
    console.log(`\n   📄 Appending to existing document: ${group.name}`);
  } else {
    const [doc] = await sbPost("documents", {
      collection_id: collectionId,
      title: group.name,
      content: `WhatsApp group "${group.name}" | ${participants.length} participants | ${firstDate} → ${lastDate}`,
      author: `WhatsApp (${participants.length} participants)`,
      metadata: {
        participants, message_count: messages.length, chunk_count: chunks.length,
        date_range: { from: messages[0].date.toISOString(), to: messages[messages.length - 1].date.toISOString() },
        import_settings: { gap, maxChars: maxC, maxMsgs: maxM, overlap, merge },
      },
    });
    docId = doc.id;
    console.log(`\n   📄 Created document: ${group.name} (${docId})`);
  }

  // Embed
  console.log(`\n   🧠 Embedding ${chunks.length} chunks...`);
  const embeddings = await batchEmbed(chunks.map((c) => c.content));

  // Store
  console.log(`\n   💾 Storing...`);
  const chunkRows = chunks.map((c, i) => ({
    document_id: docId, collection_id: collectionId,
    content: c.content, embedding: embeddings[i],
    chunk_index: i, metadata: c.metadata,
    created_at: c.metadata.start_date,
  }));

  const batch = 10;
  for (let i = 0; i < chunkRows.length; i += batch) {
    const slice = chunkRows.slice(i, i + batch);
    let retries = 3;
    while (retries > 0) {
      try {
        await sbPost("chunks", slice);
        break;
      } catch (err) {
        retries--;
        if (retries === 0) throw err;
        console.log(`\n   ⚠️  Batch ${Math.floor(i / batch) + 1} failed, retrying (${retries} left)...`);
        await new Promise((r) => setTimeout(r, 2000));
      }
    }
    process.stdout.write(`  Stored ${Math.min(i + batch, chunkRows.length)}/${chunkRows.length}\r`);
    if (i + batch < chunkRows.length) await new Promise((r) => setTimeout(r, 200));
  }
  console.log(`\n\n   ✅ ${messages.length} messages → ${chunks.length} chunks (~$${estCost})`);
}

// --- Main ---

async function main() {
  const groups = targetGroup
    ? config.groups.filter((g) => g.name.toLowerCase().includes(targetGroup.toLowerCase()))
    : config.groups;

  if (groups.length === 0) {
    console.error(`No groups found${targetGroup ? ` matching "${targetGroup}"` : ""}`);
    process.exit(1);
  }

  console.log(`\n🧠 Open Brain WhatsApp Import`);
  console.log(`   Groups: ${groups.map((g) => g.name).join(", ")}`);
  console.log(`   Mode: ${dryRun ? "DRY RUN" : "LIVE IMPORT"}`);

  // Ensure collection exists (unless dry run)
  let collectionId = null;
  if (!dryRun) {
    let collections = await sbGet("collections", `name=eq.${encodeURIComponent(COLLECTION_NAME)}`);
    if (collections.length > 0) {
      collectionId = collections[0].id;
    } else {
      const [created] = await sbPost("collections", {
        name: COLLECTION_NAME, description: "Imported WhatsApp group conversations",
        source_type: "whatsapp", language: "he",
      });
      collectionId = created.id;
    }
  }

  for (const group of groups) {
    await processGroup(group, collectionId);
  }

  console.log(`\n${"═".repeat(60)}`);
  console.log(`🏁 Done. ${groups.length} group(s) processed.`);
  if (dryRun) console.log(`   Remove --dry-run to import for real.`);
  else console.log(`   Search: "search knowledge: [your question]"`);
}

main().catch((err) => { console.error("\n❌", err.message); process.exit(1); });
