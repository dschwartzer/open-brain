import { createClient } from "https://esm.sh/@supabase/supabase-js@2.47.10";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const OPENROUTER_API_KEY = Deno.env.get("OPENROUTER_API_KEY")!;
const MCP_ACCESS_KEY = Deno.env.get("MCP_ACCESS_KEY")!;

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

// --- Helpers ---

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

async function generateEmbeddings(texts: string[]): Promise<number[][]> {
  // OpenAI embedding API accepts arrays — one call for many chunks
  const res = await fetch("https://openrouter.ai/api/v1/embeddings", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${OPENROUTER_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ model: "openai/text-embedding-3-small", input: texts }),
  });
  const data = await res.json();
  return data.data.map((d: any) => d.embedding);
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

function formatThought(t: any): string {
  const lines = [t.content];
  const meta = [];
  if (t.type) meta.push(`Type: ${t.type}`);
  if (t.category) meta.push(`Category: ${t.category}`);
  if (t.source) meta.push(`Source: ${t.source}`);
  if (t.people?.length) meta.push(`People: ${t.people.join(", ")}`);
  if (t.topics?.length) meta.push(`Topics: ${t.topics.join(", ")}`);
  if (t.action_items?.length) meta.push(`Action items: ${t.action_items.join("; ")}`);
  if (t.similarity !== undefined) meta.push(`Relevance: ${(t.similarity * 100).toFixed(0)}%`);
  meta.push(`Captured: ${new Date(t.created_at).toLocaleDateString()}`);
  meta.push(`ID: ${t.id}`);
  if (meta.length) lines.push(`[${meta.join(" | ")}]`);
  return lines.join("\n");
}

// --- Chunking ---

function chunkText(text: string, maxChunkSize = 800, overlap = 100): string[] {
  // Split into paragraphs
  const paragraphs = text.split(/\n\s*\n/).map(p => p.trim()).filter(p => p.length > 0);

  const chunks: string[] = [];
  let current = "";

  for (const para of paragraphs) {
    // If a single paragraph exceeds max size, split by sentences
    if (para.length > maxChunkSize) {
      if (current.length > 0) {
        chunks.push(current.trim());
        current = "";
      }
      const sentences = para.split(/(?<=[.!?。])\s+/);
      let sentenceChunk = "";
      for (const sentence of sentences) {
        if ((sentenceChunk + " " + sentence).length > maxChunkSize && sentenceChunk.length > 0) {
          chunks.push(sentenceChunk.trim());
          // Keep overlap from end of previous chunk
          const words = sentenceChunk.split(/\s+/);
          const overlapWords = words.slice(-Math.ceil(overlap / 5));
          sentenceChunk = overlapWords.join(" ") + " " + sentence;
        } else {
          sentenceChunk = sentenceChunk ? sentenceChunk + " " + sentence : sentence;
        }
      }
      if (sentenceChunk.length > 0) current = sentenceChunk;
      continue;
    }

    // If adding this paragraph exceeds max size, start a new chunk
    if ((current + "\n\n" + para).length > maxChunkSize && current.length > 0) {
      chunks.push(current.trim());
      // Keep overlap from end of previous chunk
      const words = current.split(/\s+/);
      const overlapWords = words.slice(-Math.ceil(overlap / 5));
      current = overlapWords.join(" ") + "\n\n" + para;
    } else {
      current = current ? current + "\n\n" + para : para;
    }
  }

  if (current.trim().length > 0) {
    chunks.push(current.trim());
  }

  // If nothing was chunked (e.g. short text), return the whole thing
  if (chunks.length === 0 && text.trim().length > 0) {
    chunks.push(text.trim());
  }

  return chunks;
}

// --- Tool definitions ---

const TOOLS = [
  // === Original thought tools ===
  {
    name: "search_thoughts",
    description: "Search your personal memories/thoughts/captures by meaning. For searching knowledge base documents, use search_knowledge instead.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "What you're looking for — natural language" },
        threshold: { type: "number", description: "Minimum similarity 0-1. Default 0.3" },
        limit: { type: "number", description: "Max results. Default 10" },
      },
      required: ["query"],
    },
  },
  {
    name: "browse_recent",
    description: "Browse your most recent personal thoughts. Optionally filter by type, category, or source.",
    inputSchema: {
      type: "object",
      properties: {
        limit: { type: "number", description: "Number of thoughts. Default 20" },
        type: { type: "string", description: "Filter: decision, person_note, insight, meeting_note, idea, task, reference, note" },
        category: { type: "string", description: "Filter by category" },
        source: { type: "string", description: "Filter: slack, mcp" },
      },
    },
  },
  {
    name: "brain_stats",
    description: "Overview of your brain — total thoughts, breakdown by type, category, source, people. Also shows knowledge base collections.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "capture_thought",
    description: "Save a thought, decision, insight, or note. Automatically embeds and classifies it.",
    inputSchema: {
      type: "object",
      properties: {
        content: { type: "string", description: "The thought to capture" },
      },
      required: ["content"],
    },
  },
  {
    name: "update_thought",
    description: "Update an existing thought. Re-generates embedding and metadata.",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string", description: "The thought ID to update" },
        content: { type: "string", description: "The new content" },
      },
      required: ["id", "content"],
    },
  },
  {
    name: "delete_thought",
    description: "Permanently delete a thought by ID.",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string", description: "The thought ID to delete" },
      },
      required: ["id"],
    },
  },
  // === Knowledge base tools ===
  {
    name: "search_knowledge",
      description: "Search your knowledge base by meaning — this contains imported documents, WhatsApp group conversations, blog posts, trading knowledge, podcast transcripts, and other reference material you have ingested. When the user mentions WhatsApp, group discussions, or asks what people said about a topic, use this tool. Can scope to a specific collection or search everything. Works in Hebrew and English. IMPORTANT: Always return results in the original source language — never translate.",
      inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "What you're looking for — natural language. Works in Hebrew and English." },
        collection: { type: "string", description: "Optional: collection name to scope search (e.g. 'WhatsApp Groups', 'Trading Knowledge'). Leave empty to search all." },
        threshold: { type: "number", description: "Minimum similarity 0-1. Default 0.25 (lower than thoughts since chunks are denser)" },
        limit: { type: "number", description: "Max results. Default 10" },
        recency: { type: "number", description: "Recency boost 0-1. 0 = pure relevance, 0.5 = moderate freshness bias, 1.0 = strongly prefer recent. Default 0" },
        after: { type: "string", description: "Only search after this date (ISO format, e.g. '2025-01-01')" },
        before: { type: "string", description: "Only search before this date (ISO format)" },
      },
      required: ["query"],
    },
  },
  {
    name: "list_collections",
    description: "List all knowledge base collections with document counts and chunk counts.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "create_collection",
    description: "Create a new knowledge base collection to organize documents by topic or source.",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string", description: "Collection name (e.g. 'WhatsApp Groups', 'My Blog Posts', 'Trading Knowledge')" },
        description: { type: "string", description: "What this collection contains" },
        source_type: { type: "string", description: "Type: whatsapp, blog, trading, podcast, other" },
        language: { type: "string", description: "Primary language: 'he' for Hebrew, 'en' for English. Default 'en'" },
      },
      required: ["name", "source_type"],
    },
  },
  {
    name: "ingest_document",
    description: "Add a document to a collection. Automatically chunks the content, generates embeddings for each chunk, and makes it all searchable. For large content, pass the full text — chunking is handled automatically. Works with Hebrew and English.",
    inputSchema: {
      type: "object",
      properties: {
        collection: { type: "string", description: "Collection name to add this document to" },
        title: { type: "string", description: "Document title (e.g. 'WhatsApp AI Group - March 2026', 'Blog: My Trading Strategy')" },
        content: { type: "string", description: "The full text content to ingest" },
        source_url: { type: "string", description: "Optional: URL or source reference" },
        author: { type: "string", description: "Optional: author name" },
        chunk_size: { type: "number", description: "Optional: target chunk size in characters. Default 800" },
      },
      required: ["collection", "title", "content"],
    },
  },
];

// --- Tool handlers ---

async function handleTool(name: string, args: any): Promise<string> {
  switch (name) {
    // === Original thought tools ===
    case "search_thoughts": {
      const embedding = await generateEmbedding(args.query);
      const { data, error } = await supabase.rpc("match_thoughts", {
        query_embedding: embedding,
        match_threshold: args.threshold ?? 0.3,
        match_count: args.limit ?? 10,
      });
      if (error) return `Error: ${error.message}`;
      if (!data?.length) return "No matching thoughts found. Try a lower threshold or different wording.";
      return `Found ${data.length} thought(s):\n\n` + data.map((t: any, i: number) => `${i + 1}. ${formatThought(t)}`).join("\n\n");
    }
    case "browse_recent": {
      let query = supabase
        .from("thoughts")
        .select("id, content, type, category, source, people, action_items, topics, created_at")
        .order("created_at", { ascending: false })
        .limit(args.limit ?? 20);
      if (args.type) query = query.eq("type", args.type);
      if (args.category) query = query.eq("category", args.category);
      if (args.source) query = query.eq("source", args.source);
      const { data, error } = await query;
      if (error) return `Error: ${error.message}`;
      if (!data?.length) return "No thoughts found with those filters.";
      return `${data.length} recent thought(s):\n\n` + data.map((t: any, i: number) => `${i + 1}. ${formatThought(t)}`).join("\n\n");
    }
    case "brain_stats": {
      const { data: thoughts, error: tErr } = await supabase.from("thoughts").select("type, category, source, people, created_at");
      const { data: colls, error: cErr } = await supabase.from("collections").select("id, name, source_type");
      const { data: docs } = await supabase.from("documents").select("collection_id");
      const { data: chnks } = await supabase.from("chunks").select("collection_id");

      if (tErr) return `Error: ${tErr.message}`;
      const lines: string[] = [];

      // Thoughts stats
      if (thoughts?.length) {
        const types: Record<string, number> = {};
        const categories: Record<string, number> = {};
        const sources: Record<string, number> = {};
        const people: Record<string, number> = {};
        for (const t of thoughts) {
          types[t.type || "note"] = (types[t.type || "note"] || 0) + 1;
          if (t.category) categories[t.category] = (categories[t.category] || 0) + 1;
          sources[t.source || "unknown"] = (sources[t.source || "unknown"] || 0) + 1;
          for (const p of t.people || []) people[p] = (people[p] || 0) + 1;
        }
        const sorted = (obj: Record<string, number>) =>
          Object.entries(obj).sort((a, b) => b[1] - a[1]).map(([k, v]) => `  ${k}: ${v}`).join("\n");
        const first = new Date(thoughts[thoughts.length - 1].created_at).toLocaleDateString();
        lines.push(`=== Personal Thoughts ===`);
        lines.push(`Total: ${thoughts.length} | Since: ${first}`);
        lines.push(`By type:\n${sorted(types)}`);
        lines.push(`By category:\n${sorted(categories)}`);
        if (Object.keys(people).length) lines.push(`People mentioned:\n${sorted(people)}`);
      } else {
        lines.push(`=== Personal Thoughts ===\nNone yet.`);
      }

      // Knowledge base stats
      lines.push(`\n=== Knowledge Base ===`);
      if (colls?.length) {
        for (const c of colls) {
          const docCount = docs?.filter((d: any) => d.collection_id === c.id).length || 0;
          const chunkCount = chnks?.filter((ch: any) => ch.collection_id === c.id).length || 0;
          lines.push(`  ${c.name} (${c.source_type}): ${docCount} docs, ${chunkCount} chunks`);
        }
      } else {
        lines.push(`No collections yet. Use create_collection to start.`);
      }

      return lines.join("\n");
    }
    case "capture_thought": {
      const [embedding, meta] = await Promise.all([generateEmbedding(args.content), extractMetadata(args.content)]);
      const { data, error } = await supabase.from("thoughts").insert({
        content: args.content, embedding, type: meta.type, category: meta.category,
        source: "mcp", people: meta.people, action_items: meta.action_items, topics: meta.topics, metadata: {},
      }).select("id").single();
      if (error) return `Error saving: ${error.message}`;
      return `Captured as ${meta.type} — ${meta.category || "uncategorized"}\nTopics: ${meta.topics?.join(", ") || "none"}\nPeople: ${meta.people?.join(", ") || "none"}\nID: ${data.id}`;
    }
    case "update_thought": {
      const [embedding, meta] = await Promise.all([generateEmbedding(args.content), extractMetadata(args.content)]);
      const { error } = await supabase.from("thoughts").update({
        content: args.content, embedding, type: meta.type, category: meta.category,
        people: meta.people, action_items: meta.action_items, topics: meta.topics, updated_at: new Date().toISOString(),
      }).eq("id", args.id);
      if (error) return `Error: ${error.message}`;
      return `Updated thought ${args.id} — now classified as ${meta.type} (${meta.category})`;
    }
    case "delete_thought": {
      const { error } = await supabase.from("thoughts").delete().eq("id", args.id);
      if (error) return `Error: ${error.message}`;
      return `Deleted thought ${args.id}`;
    }

    // === Knowledge base tools ===
    case "search_knowledge": {
      // Resolve collection name to ID if provided
      let collectionId = null;
      if (args.collection) {
        const { data: coll } = await supabase
          .from("collections")
          .select("id")
          .ilike("name", `%${args.collection}%`)
          .limit(1)
          .single();
        if (coll) collectionId = coll.id;
        else return `Collection "${args.collection}" not found. Use list_collections to see available collections.`;
      }

      const embedding = await generateEmbedding(args.query);
      const { data, error } = await supabase.rpc("match_chunks_with_recency", {
        query_embedding: embedding,
        match_threshold: args.threshold ?? 0.25,
        match_count: args.limit ?? 10,
        filter_collection_id: collectionId,
        recency_weight: args.recency ?? 0.0,
        after_date: args.after || null,
        before_date: args.before || null,
      });
      if (error) return `Error: ${error.message}`;
      if (!data?.length) return "No matching knowledge found. Try different wording or a lower threshold.";

      const results = data.map((ch, i) => {
        const lines = [ch.content];
        const meta = [
          `Relevance: ${(ch.similarity * 100).toFixed(0)}%`,
          `Score: ${(ch.final_score * 100).toFixed(0)}%`,
          `From: ${ch.document_title}`,
          `Collection: ${ch.collection_name}`,
          `Date: ${new Date(ch.created_at).toLocaleDateString()}`,
        ];
        lines.push(`[${meta.join(" | ")}]`);
        return `${i + 1}. ${lines.join("\n")}`;
      });

      return `Found ${data.length} result(s):\n\n${results.join("\n\n")}`;
    }

    case "list_collections": {
      const { data: colls, error } = await supabase
        .from("collections")
        .select("id, name, description, source_type, language, created_at")
        .order("created_at", { ascending: false });
      if (error) return `Error: ${error.message}`;
      if (!colls?.length) return "No collections yet. Use create_collection to create one.";

      const results: string[] = [];
      for (const c of colls) {
        const { count: docCount } = await supabase
          .from("documents").select("id", { count: "exact", head: true }).eq("collection_id", c.id);
        const { count: chunkCount } = await supabase
          .from("chunks").select("id", { count: "exact", head: true }).eq("collection_id", c.id);
        results.push(
          `${c.name}\n[Type: ${c.source_type} | Language: ${c.language} | Docs: ${docCount || 0} | Chunks: ${chunkCount || 0} | ID: ${c.id}]` +
          (c.description ? `\n${c.description}` : "")
        );
      }
      return `${colls.length} collection(s):\n\n${results.join("\n\n")}`;
    }

    case "create_collection": {
      const { data, error } = await supabase.from("collections").insert({
        name: args.name,
        description: args.description || null,
        source_type: args.source_type,
        language: args.language || "en",
      }).select("id").single();
      if (error) return `Error: ${error.message}`;
      return `Created collection "${args.name}" (${args.source_type})\nID: ${data.id}`;
    }

    case "ingest_document": {
      // Find collection by name
      const { data: coll } = await supabase
        .from("collections")
        .select("id")
        .ilike("name", `%${args.collection}%`)
        .limit(1)
        .single();
      if (!coll) return `Collection "${args.collection}" not found. Create it first with create_collection.`;

      // Store the full document
      const { data: doc, error: docErr } = await supabase.from("documents").insert({
        collection_id: coll.id,
        title: args.title,
        content: args.content,
        source_url: args.source_url || null,
        author: args.author || null,
      }).select("id").single();
      if (docErr) return `Error storing document: ${docErr.message}`;

      // Chunk the content
      const chunkSize = args.chunk_size || 800;
      const textChunks = chunkText(args.content, chunkSize);

      // Embed all chunks in batches of 20
      const allChunkRows: any[] = [];
      const batchSize = 20;
      for (let i = 0; i < textChunks.length; i += batchSize) {
        const batch = textChunks.slice(i, i + batchSize);
        const embeddings = await generateEmbeddings(batch);
        for (let j = 0; j < batch.length; j++) {
          allChunkRows.push({
            document_id: doc.id,
            collection_id: coll.id,
            content: batch[j],
            embedding: embeddings[j],
            chunk_index: i + j,
            metadata: {},
          });
        }
      }

      // Insert all chunks
      const { error: chunkErr } = await supabase.from("chunks").insert(allChunkRows);
      if (chunkErr) return `Document saved but chunking failed: ${chunkErr.message}`;

      return `Ingested "${args.title}" into ${args.collection}\n${textChunks.length} chunks created and embedded\nDocument ID: ${doc.id}`;
    }

    default:
      return `Unknown tool: ${name}`;
  }
}

// --- MCP JSON-RPC handler ---

async function handleMcpRequest(body: any) {
  const { method, id, params } = body;
  switch (method) {
    case "initialize":
      return { jsonrpc: "2.0", id, result: {
        protocolVersion: "2024-11-05",
        capabilities: { tools: {} },
        serverInfo: { name: "open-brain", version: "2.0.0" },
      }};
    case "notifications/initialized":
      return null;
    case "tools/list":
      return { jsonrpc: "2.0", id, result: { tools: TOOLS } };
    case "tools/call": {
      const { name, arguments: args } = params;
      try {
        const text = await handleTool(name, args || {});
        return { jsonrpc: "2.0", id, result: { content: [{ type: "text", text }] } };
      } catch (err: any) {
        return { jsonrpc: "2.0", id, result: { content: [{ type: "text", text: `Error: ${err.message}` }], isError: true } };
      }
    }
    case "ping":
      return { jsonrpc: "2.0", id, result: {} };
    default:
      return { jsonrpc: "2.0", id, error: { code: -32601, message: `Method not found: ${method}` } };
  }
}

// --- HTTP server ---

Deno.serve(async (req) => {
  const url = new URL(req.url);

  // Auth check
  const key =
    url.searchParams.get("key") ||
    req.headers.get("x-brain-key") ||
    req.headers.get("authorization")?.replace("Bearer ", "");
  if (key !== MCP_ACCESS_KEY) {
    return new Response(JSON.stringify({ error: "Unauthorized" }), {
      status: 401,
      headers: { "Content-Type": "application/json" },
    });
  }

  // SSE for MCP client discovery
  if (req.method === "GET") {
    const sessionId = crypto.randomUUID();
    const postUrl = `${url.pathname}?key=${MCP_ACCESS_KEY}&sessionId=${sessionId}`;
    const body = new ReadableStream({
      start(controller) {
        const enc = new TextEncoder();
        controller.enqueue(enc.encode(`event: endpoint\ndata: ${postUrl}\n\n`));
        const keepAlive = setInterval(() => {
          try { controller.enqueue(enc.encode(": keepalive\n\n")); } catch { clearInterval(keepAlive); }
        }, 30000);
      },
    });
    return new Response(body, {
      headers: {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        "Connection": "keep-alive",
      },
    });
  }

  // POST — JSON-RPC
  if (req.method === "POST") {
    try {
      const body = await req.json();
      const result = await handleMcpRequest(body);
      if (result === null) return new Response(null, { status: 204 });
      return new Response(JSON.stringify(result), {
        headers: { "Content-Type": "application/json" },
      });
    } catch (err: any) {
      return new Response(JSON.stringify({
        jsonrpc: "2.0", id: null,
        error: { code: -32700, message: `Parse error: ${err.message}` },
      }), { status: 400, headers: { "Content-Type": "application/json" } });
    }
  }

  return new Response("Method not allowed", { status: 405 });
});