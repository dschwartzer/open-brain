# n8n Workflows
 
Exported n8n workflow definitions for the Open Brain project.
 
## Podcast Pipeline (`podcast-pipeline.json`)
 
Automated pipeline that processes Hebrew podcast episodes:
 
1. **Discovery** — Reads RSS feeds, tracks episode status in Google Sheets
2. **Audio Download** — Downloads MP3, uploads to Google Drive (CDN workaround)
3. **Transcription** — Submits to ivrit.ai on RunPod, polls until complete
4. **Speaker ID** — Uses Claude to identify speakers from transcript intro
5. **Summarization** — Generates structured summary via Claude API
6. **RAG Indexing** — Chunks transcript, embeds via OpenRouter, stores in Supabase
7. **Notification** — Sends email digest with episode summary
 
### Stats
 
- 47 nodes (21 Code, 10 HTTP Request, 7 Google Sheets, 3 IF, 2 Google Drive, 1 Gmail, 1 Loop, 1 Wait, 1 Trigger)
- Processes ~3 minutes per episode (mostly RunPod cold start)
- Total cost: ~$2.50 for 20 episodes
 
### Setup
 
1. Import `podcast-pipeline.json` into your n8n instance
2. Configure n8n variables:
   - `RUNPOD_API_KEY` — RunPod API key
   - `ANTHROPIC_API_KEY` — Anthropic API key
   - `SUPABASE_API_KEY` — Supabase service role key
   - `OPENROUTER_API_KEY` — OpenRouter API key
3. Connect OAuth credentials for Google Drive, Google Sheets, and Gmail
4. Replace placeholder values (search for `YOUR_`) with your own IDs:
   - `YOUR_RUNPOD_ENDPOINT_ID` — Your RunPod serverless endpoint
   - `YOUR_GOOGLE_SHEET_ID` — Your episode tracking spreadsheet
   - `YOUR_GDRIVE_FOLDER_ID` — Google Drive folder for audio files
   - `YOUR_PROJECT.supabase.co` — Your Supabase project URL
   - `YOUR_PODCASTS_COLLECTION_ID` — Your Supabase collection UUID
 
### Google Sheets Template
 
The pipeline expects a spreadsheet with two tabs:
 
**Feeds tab:** `feed_id`, `feed_name`, `rss_url`, `collection_name`, `language`, `active`
 
**Episodes tab:** `episode_id`, `feed_id`, `episode_number`, `title`, `pub_date`, `duration`, `audio_url`, `status`, `retry_count`, `runpod_job_id`, `gdrive_file_id`, `transcript_chars`, `openbrain_doc_id`, `started_at`, `completed_at`, `error_message`, `last_updated`
 
