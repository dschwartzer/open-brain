# Open Brain

A personal "second brain" that stores your thoughts, decisions, and knowledge — searchable by meaning via any AI assistant that supports MCP.

## Architecture

```
Slack #capture channel          Any MCP client (Claude, ChatGPT, Cursor...)
       │                                      │
       ▼                                      ▼
  ingest-thought                      open-brain-mcp
  (Edge Function)                     (Edge Function)
       │                                      │
       ├──→ OpenRouter (embed + classify) ←───┤
       │                                      │
       ▼                                      ▼
   Supabase Postgres + pgvector (semantic search)
```

**Two layers of data:**

- **Thoughts** — quick captures (decisions, insights, meeting notes, ideas) via Slack or MCP
- **Knowledge Base** — longer documents organized into collections (WhatsApp exports, blog posts, transcripts, etc.)

## Stack

| Component | Role |
|-----------|------|
| **Supabase** | PostgreSQL database, Edge Functions, pgvector |
| **OpenRouter** | AI gateway → `text-embedding-3-small` (embeddings) + `gpt-4o-mini` (metadata) |
| **Slack** | Capture interface via webhook |
| **MCP** | Open protocol — any AI client can read/write your brain |

## Project Structure

```
open-brain/
├── supabase/
│   ├── migrations/
│   │   └── 20250101000000_initial_schema.sql   # Tables, indexes, RLS, functions
│   ├── functions/
│   │   ├── ingest-thought/
│   │   │   └── index.ts                        # Slack → thoughts pipeline
│   │   └── open-brain-mcp/
│   │       └── index.ts                        # MCP server (10 tools)
│   └── config.toml                             # Supabase CLI config (created by `supabase init`)
├── scripts/
│   ├── import-whatsapp.mjs                     # WhatsApp group importer
│   └── whatsapp-config.example.json            # Import config template (copy and customize)
├── slack/
│   └── manifest.yml                            # Slack app manifest
├── docs/
│   ├── architecture.html                       # Technical architecture
│   ├── user-guide.html                         # User guide
│   └── tool-guide.html                         # MCP tool reference & customization
├── .env.example
├── .gitignore
├── LICENSE
└── README.md
```

## Database Schema

**4 tables**, 3 RPC functions, HNSW vector indexes:

| Table | Purpose |
|-------|---------|
| `thoughts` | Personal captures with embeddings, type/category/people/topics |
| `collections` | Knowledge base containers (e.g. "WhatsApp Groups", "Trading Knowledge") |
| `documents` | Full documents within a collection |
| `chunks` | Embedded chunks of documents for semantic search |

Key functions:
- `match_thoughts(embedding, threshold, count)` — semantic search over thoughts
- `match_chunks(embedding, threshold, count, collection_id)` — semantic search over KB
- `match_chunks_with_recency(...)` — KB search with recency boost + date filters

## MCP Tools (10 total)

### Thought tools
| Tool | Description |
|------|-------------|
| `search_thoughts` | Semantic search over personal thoughts |
| `browse_recent` | List recent thoughts with optional filters |
| `brain_stats` | Overview — totals, breakdowns by type/category/source/people |
| `capture_thought` | Save a new thought (auto-embeds + classifies) |
| `update_thought` | Update existing thought by ID |
| `delete_thought` | Delete thought by ID |

### Knowledge base tools
| Tool | Description |
|------|-------------|
| `search_knowledge` | Semantic search over KB with optional collection scope, recency boost, date filters |
| `list_collections` | List all collections with doc/chunk counts |
| `create_collection` | Create a new collection |
| `ingest_document` | Add a document — auto-chunks + embeds |

## Setup

### Prerequisites

- [Node.js](https://nodejs.org) v18+ (for the WhatsApp import script)
- [Supabase CLI](https://supabase.com/docs/guides/cli)
- [OpenRouter](https://openrouter.ai) account with API key (minimum $5 credit — lasts months at this usage)
- A Slack workspace (for thought capture — optional, you can use MCP capture instead)

### 1. Clone & create your Supabase project

```bash
git clone https://github.com/youruser/open-brain.git
cd open-brain
```

Create a free project at [supabase.com](https://supabase.com). Note your **project ref** (the string in your dashboard URL) and your **service role key** (Settings → API).

### 2. Link to Supabase and run the migration

```bash
supabase link --project-ref <your-project-ref>
supabase db push
```

This creates all four tables, HNSW vector indexes, RLS policies, and the three search functions.

### 3. Set Supabase secrets

These are the environment variables your Edge Functions need at runtime. They are stored securely in Supabase — never in the repo.

```bash
supabase secrets set \
  OPENROUTER_API_KEY=<your-openrouter-key> \
  SLACK_BOT_TOKEN=<your-slack-bot-token> \
  SLACK_CAPTURE_CHANNEL=<your-slack-channel-id> \
  MCP_ACCESS_KEY=<pick-any-secret-string>
```

| Secret | Where to get it |
|--------|----------------|
| `OPENROUTER_API_KEY` | [openrouter.ai/keys](https://openrouter.ai/keys) |
| `SLACK_BOT_TOKEN` | Your Slack app's OAuth token (starts with `xoxb-`) |
| `SLACK_CAPTURE_CHANNEL` | Right-click channel in Slack → "View channel details" → Channel ID |
| `MCP_ACCESS_KEY` | Any string you choose — this is the shared secret for MCP auth |

### 4. Deploy Edge Functions

```bash
supabase functions deploy ingest-thought --no-verify-jwt
supabase functions deploy open-brain-mcp --no-verify-jwt
```

### 5. Set up Slack (optional)

Create a Slack app using the manifest in `slack/manifest.yml`. Update the `request_url` in the manifest to point to your own Supabase function:

```
https://<your-project-ref>.supabase.co/functions/v1/ingest-thought
```

Install the app to your workspace and invite it to your capture channel.

### 6. Connect MCP clients

Your MCP endpoint is:
```
https://<your-project-ref>.supabase.co/functions/v1/open-brain-mcp?key=<your-mcp-access-key>
```

**Claude.ai:** Settings → Connectors → Add custom connector → paste the URL above.

**Claude Desktop:** Add to `~/Library/Application Support/Claude/claude_desktop_config.json`.

**Claude Code (CLI):**
```bash
claude mcp add-json open-brain \
  '{"type":"http","url":"https://<your-project-ref>.supabase.co/functions/v1/open-brain-mcp?key=<your-mcp-access-key>"}' \
  --scope user
```

**Cursor:** Create or edit `~/.cursor/mcp.json`:
```json
{
  "mcpServers": {
    "open-brain": {
      "command": "npx",
      "args": [
        "-y", "mcp-remote",
        "https://<your-project-ref>.supabase.co/functions/v1/open-brain-mcp?key=<your-mcp-access-key>"
      ]
    }
  }
}
```

## WhatsApp Import

Import WhatsApp group exports into the knowledge base.

### Configure

Copy the example config and fill in your values:

```bash
cp scripts/whatsapp-config.example.json scripts/whatsapp-config.json
```

Edit `scripts/whatsapp-config.json`:

```json
{
  "supabase_url": "https://<your-project-ref>.supabase.co",
  "collection_name": "WhatsApp Groups",
  "defaults": {
    "gap": 10,
    "maxChars": 1500,
    "maxMsgs": 15,
    "overlap": 3,
    "merge": 300
  },
  "groups": [
    {
      "name": "My Group",
      "file": "~/path/to/exported-chat.txt"
    }
  ]
}
```

Your `whatsapp-config.json` is gitignored — it stays on your machine and never gets committed.

### Environment variables

The import script needs these in your shell:

```bash
export SUPABASE_SERVICE_ROLE_KEY=<your-service-role-key>
export OPENROUTER_API_KEY=<your-openrouter-key>
```

The `SUPABASE_URL` is read from the config file, so you don't need it as an env var.

### Run

```bash
# Dry run — preview chunking, no writes
node scripts/import-whatsapp.mjs --config scripts/whatsapp-config.json --dry-run

# Import one group
node scripts/import-whatsapp.mjs --config scripts/whatsapp-config.json --group "My Group"

# Import all groups
node scripts/import-whatsapp.mjs --config scripts/whatsapp-config.json
```

Features: 4-pass smart chunking, aggressive filtering (Hebrew + English), incremental import, message dedup.

## Running Cost

| Service | Cost |
|---------|------|
| Supabase (free tier) | $0.00 |
| Slack (free tier) | $0.00 |
| Embeddings (~20 thoughts/day) | ~$0.02/mo |
| Metadata extraction (~20/day) | ~$0.08–0.28/mo |
| WhatsApp import (one-time per group) | ~$0.01–0.04 per group |
| **Total ongoing** | **~$0.10–0.30/mo** |

## License

MIT — see [LICENSE](LICENSE).
