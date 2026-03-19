import { createClient } from "https://esm.sh/@supabase/supabase-js@2.47.10";

const OPENROUTER_API_KEY = Deno.env.get("OPENROUTER_API_KEY")!;
const SLACK_BOT_TOKEN = Deno.env.get("SLACK_BOT_TOKEN")!;
const SLACK_CAPTURE_CHANNEL = Deno.env.get("SLACK_CAPTURE_CHANNEL")!;
const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

async function generateEmbedding(text: string): Promise<number[]> {
  const res = await fetch("https://openrouter.ai/api/v1/embeddings", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${OPENROUTER_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ model: "openai/text-embedding-3-small", input: text }),
  });
  const data = await res.json();
  return data.data[0].embedding;
}

async function extractMetadata(text: string) {
  const res = await fetch("https://openrouter.ai/api/v1/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${OPENROUTER_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: "openai/gpt-4o-mini",
      messages: [
        {
          role: "system",
          content: `You extract metadata from thoughts/notes. Return ONLY valid JSON, no markdown or backticks.

{
  "type": one of "decision", "person_note", "insight", "meeting_note", "idea", "task", "reference", "note",
  "category": short topic area (e.g. "career", "product", "health", "finance", "relationships"),
  "people": array of names mentioned (empty array if none),
  "topics": array of 1-3 key topics,
  "action_items": array of any action items or next steps (empty array if none)
}`,
        },
        { role: "user", content: text },
      ],
      temperature: 0,
    }),
  });
  const data = await res.json();
  try {
    const raw = data.choices[0].message.content.replace(/```json\n?/g, "").replace(/```\n?/g, "").trim();
    return JSON.parse(raw);
  } catch {
    return { type: "note", category: "uncategorized", people: [], topics: [], action_items: [] };
  }
}

async function slackReply(channel: string, threadTs: string, text: string) {
  await fetch("https://slack.com/api/chat.postMessage", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${SLACK_BOT_TOKEN}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ channel, thread_ts: threadTs, text }),
  });
}

async function processThought(rowId: string, text: string, channel: string, ts: string) {
  try {
    const [embedding, meta] = await Promise.all([
      generateEmbedding(text),
      extractMetadata(text),
    ]);

    const { error } = await supabase.from("thoughts").update({
      embedding,
      type: meta.type,
      category: meta.category,
      people: meta.people,
      action_items: meta.action_items,
      topics: meta.topics,
    }).eq("id", rowId);

    if (error) throw error;

    const parts = [`✓ Captured as *${meta.type}*`];
    if (meta.category) parts[0] += ` — ${meta.category}`;
    if (meta.topics?.length) parts.push(`Topics: ${meta.topics.join(", ")}`);
    if (meta.people?.length) parts.push(`People: ${meta.people.join(", ")}`);
    if (meta.action_items?.length) parts.push(`Action items: ${meta.action_items.join("; ")}`);

    await slackReply(channel, ts, parts.join("\n"));
  } catch (err) {
    console.error("Error processing thought:", err);
    await slackReply(channel, ts, "⚠️ Failed to capture — check Edge Function logs");
  }
}

Deno.serve(async (req) => {
  const body = await req.json();

  // Slack URL verification
  if (body.type === "url_verification") {
    return new Response(JSON.stringify({ challenge: body.challenge }), {
      headers: { "Content-Type": "application/json" },
    });
  }

  const event = body.event;
  if (!event || event.type !== "message" || event.subtype || event.bot_id) {
    return new Response("ok");
  }
  if (event.channel !== SLACK_CAPTURE_CHANNEL) {
    return new Response("ok");
  }

  const text = event.text?.trim();
  if (!text) return new Response("ok");

  const idempotencyKey = `slack:${event.channel}:${event.ts}`;

  // CLAIM FIRST: insert a placeholder row with just content + idempotency key
  // This is instant (no API calls) and the unique constraint blocks duplicates
  const { data: claimed, error: claimErr } = await supabase.from("thoughts").insert({
    content: text,
    source: "slack",
    idempotency_key: idempotencyKey,
    metadata: {},
  }).select("id").single();

  // If unique constraint violation → another invocation already claimed it
  if (claimErr) {
    // 23505 = unique_violation — already being processed, skip silently
    return new Response("ok");
  }

  // We claimed the slot — process in background (embedding + metadata)
  processThought(claimed.id, text, event.channel, event.ts);

  // Return immediately to Slack
  return new Response("ok");
});