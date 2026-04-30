import express from "express";
import { createServer as createViteServer } from "vite";
import path from "path";
import { fileURLToPath } from "url";
import dotenv from "dotenv";
import { getSubtitles } from 'youtube-captions-scraper';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
dotenv.config({ path: path.join(process.cwd(), ".env.local") });
dotenv.config();

function toBasicAuthHeader(apiKey: string): string {
  return `Basic ${Buffer.from(`${apiKey}:`).toString("base64")}`;
}

function extractTextFromUnknown(value: unknown): string {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) {
    return value.map((v) => extractTextFromUnknown(v)).filter(Boolean).join("\n").trim();
  }
  if (value && typeof value === "object") {
    const obj = value as Record<string, unknown>;
    const candidates = [
      obj.text,
      obj.content,
      obj.message,
      obj.output,
      obj.answer,
      obj.result,
      obj.delta,
      obj.data,
    ];
    for (const c of candidates) {
      const text = extractTextFromUnknown(c);
      if (text) return text;
    }
  }
  return "";
}

function parseSseForBestText(sse: string): string {
  const lines = sse.split(/\r?\n/);
  const dataPayloads: string[] = [];
  for (const line of lines) {
    if (line.startsWith("data:")) {
      const data = line.slice(5).trim();
      if (data && data !== "[DONE]") dataPayloads.push(data);
    }
  }

  let bestText = "";
  for (const payload of dataPayloads) {
    try {
      const parsed = JSON.parse(payload);
      const text = extractTextFromUnknown(parsed).trim();
      if (text.length > bestText.length) bestText = text;
    } catch {
      // Some events can be plain text; keep best effort.
      if (payload.length > bestText.length) bestText = payload;
    }
  }
  return bestText;
}

async function startServer() {
  const app = express();
  const PORT = Number(process.env.PORT || "3000");
  const HOST = process.env.HOST || "0.0.0.0";

  app.use(express.json());

  // API Routes
  app.get("/api/health", (req, res) => {
    res.json({ status: "ok" });
  });

  app.post("/api/transcript", async (req, res) => {
    const { videoId } = req.body;
    if (!videoId) {
      return res.status(400).json({ error: "videoId is required" });
    }

    let transcriptText = "";
    let sourceType = "";
    let detailLog = "";

    try {
      console.log(`[SERVER] Attempting transcript for: ${videoId}`);
      // Try to get any English captions (en, en-US, en-GB, etc.)
      const transcript = await getSubtitles({
        videoID: videoId,
        lang: 'en'
      });
      transcriptText = transcript.map((t: any) => t.text).join(" ");
      sourceType = 'transcript-en';
    } catch (error: any) {
      detailLog += `EN failed: ${error.message.substring(0, 30)}. `;
      console.warn(`[SERVER] EN transcript failed for ${videoId}, trying more fallbacks...`);
      
      // Try a few common languages
      const langs = ['es', 'it', 'fr', 'pt'];
      for (const l of langs) {
        try {
          const t = await getSubtitles({ videoID: videoId, lang: l });
          transcriptText = t.map((it: any) => it.text).join(" ");
          sourceType = `transcript-${l}`;
          break;
        } catch (e) { /* continue */ }
      }
    }

    if (!transcriptText) {
      try {
        console.log(`[SERVER] Robust scraping fallback for: ${videoId}`);
        const watchUrl = `https://www.youtube.com/watch?v=${videoId}`;
        const fetchRes = await fetch(watchUrl, {
           headers: { 
             'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/115.0.0.0 Safari/537.36',
             'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
             'Accept-Language': 'en-US,en;q=0.5'
           }
        });

        if (fetchRes.ok) {
          const html = await fetchRes.text();
          
          // Try to find the JSON-LD or ytInitialPlayerResponse
          let title = "";
          let description = "";

          // 1. JSON-LD
          const jsonLdMatch = html.match(/<script type="application\/ld\+json">([\s\S]+?)<\/script>/);
          if (jsonLdMatch) {
            try {
              const data = JSON.parse(jsonLdMatch[1]);
              title = data.name || "";
              description = data.description || "";
            } catch (e) {}
          }

          // 2. ytInitialPlayerResponse
          if (!title) {
            const playerResponseMatch = html.match(/var ytInitialPlayerResponse = ({.+?});/);
            if (playerResponseMatch) {
              try {
                const data = JSON.parse(playerResponseMatch[1]);
                title = data.videoDetails?.title || "";
                description = data.videoDetails?.shortDescription || "";
              } catch (e) {}
            }
          }

          // 3. Simple meta tags
          if (!title) {
            const tMatch = html.match(/<title>([^<]+)<\/title>/);
            if (tMatch) title = tMatch[1].replace(' - YouTube', '');
            const dMatch = html.match(/meta name="description" content="([^"]+)"/);
            if (dMatch) description = dMatch[1];
          }

          if (title) {
            transcriptText = `VIDEO TITLE: ${title}\n\nDESCRIPTION: ${description || "No description available."}`;
            sourceType = 'scraped-full';
          }
        }
      } catch (fallbackErr: any) {
        detailLog += `Scraping failed: ${fallbackErr.message}. `;
      }
    }

    if (!transcriptText) {
      try {
        const yts = (await import('yt-search')).default;
        console.log(`[SERVER] Last attempt with yt-search: ${videoId}`);
        const video = await yts({ videoId: videoId });
        if (video && video.title) {
          transcriptText = `VIDEO TITLE: ${video.title}\n\nDESCRIPTION: ${video.description || video.summary || ""}`;
          sourceType = 'metadata-yts';
        }
      } catch (e: any) {
        detailLog += `YTS failed. `;
      }
    }

    if (transcriptText) {
      res.json({ transcript: transcriptText, sourceType, details: detailLog });
    } else {
      res.status(500).json({ 
        error: "Failed to extract content.",
        details: detailLog
      });
    }
  });

  app.post("/api/channel-videos", async (req, res) => {
    const { channelUrl } = req.body;
    if (!channelUrl) {
      return res.status(400).json({ error: "channelUrl is required" });
    }

    try {
      const yts = (await import('yt-search')).default;
      
      const trimmedUrl = channelUrl.trim().replace(/\/$/, '');
      if (!trimmedUrl) {
        return res.status(400).json({ error: "La URL está vacía." });
      }

      let videoIds: string[] = [];
      let query = "";

      // 1. Precise ID extraction
      const handleMatch = trimmedUrl.match(/@([^/?#]+)/);
      const channelMatch = trimmedUrl.match(/channel\/([^/?#]+)/);
      const cMatch = trimmedUrl.match(/\/c\/([^/?#]+)/);
      const userMatch = trimmedUrl.match(/\/user\/([^/?#]+)/);

      if (handleMatch) query = '@' + handleMatch[1];
      else if (channelMatch) query = channelMatch[1];
      else if (cMatch) query = cMatch[1];
      else if (userMatch) query = userMatch[1];
      else {
        // Handle names that aren't URLs
        if (!trimmedUrl.includes('youtube.com') && !trimmedUrl.includes('youtu.be')) {
          query = trimmedUrl;
        } else {
          // If it is a URL but no pattern matched, try the last segment
          const segments = trimmedUrl.split('/').filter(Boolean);
          const last = segments[segments.length - 1];
          if (last && !['videos', 'shorts', 'live', 'featured'].includes(last)) {
            query = last;
          }
        }
      }

      console.log(`Processing channel search for query: "${query || 'EMPTY'}"`);

      // 2. yt-search attempt (only if we have a valid, non-empty query)
      if (query && query.trim().length > 0) {
        try {
          // Use search as the primary way to find the channel
          const r = await yts({ search: query, category: 'channel' });
          const channels = r.channels || [];
          
          if (channels.length > 0) {
            const channel = channels[0];
            console.log(`Found via yt-search: ${channel.name} (${channel.id})`);
            
            // 2a. Try fetching channel directly
            try {
              const channelResult = await yts({ channelId: channel.id });
              if (channelResult && channelResult.videos) {
                videoIds = [...new Set([...videoIds, ...channelResult.videos.map((v: any) => v.videoId)])];
              }
            } catch (ce) { console.warn("Channel ID fetch failed:", ce.message); }

            // 2b. Try fetching Uploads playlist (UU + ID suffix)
            const uploadsPlaylistId = channel.id.replace(/^UC/, 'UU');
            console.log(`Attempting uploads playlist: ${uploadsPlaylistId}`);
            try {
              const playlistResult = await yts({ listId: uploadsPlaylistId });
              if (playlistResult && playlistResult.videos) {
                videoIds = [...new Set([...videoIds, ...playlistResult.videos.map((v: any) => v.videoId)])];
              }
            } catch (pe) { console.warn("Playlist fetch failed:", pe.message); }
          }
        } catch (ytsErr: any) {
          console.warn("yt-search discovery failed or skipped:", ytsErr.message);
        }
      }

      // 3. HTML Extraction as primary/fallback (more robust for Shorts and full lists)
      console.log("Attempting direct HTML extraction...");
      let videosTabUrl = trimmedUrl;
      const hasTab = trimmedUrl.endsWith('/videos') || trimmedUrl.endsWith('/shorts') || trimmedUrl.endsWith('/live');
      
      if (!hasTab) {
        videosTabUrl = `${trimmedUrl.split('?')[0]}/videos`;
      }
      
      try {
        const fetchRes = await fetch(videosTabUrl, {
          headers: { 
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36',
            'Accept-Language': 'en-US,en;q=0.9'
          }
        });
        const html = await fetchRes.text();
        
        const idPatterns = [
          /"videoId":"([^"]{11})"/g,
          /videoRenderer":{"videoId":"([^"]{11})"/g,
          /shortVideoRenderer":{"videoId":"([^"]{11})"/g,
          /reelItemRenderer":{"videoId":"([^"]{11})"/g,
          /gridVideoRenderer":{"videoId":"([^"]{11})"/g,
          /playlistVideoRenderer":{"videoId":"([^"]{11})"/g,
          /"watchEndpoint":{"videoId":"([^"]{11})"/g,
          /commandMetadata":\{"webCommandMetadata":\{"url":"\/(?:watch\?v=|shorts\/)([^"]{11})"/g
        ];

        let extractedIds: string[] = [];
        idPatterns.forEach(pattern => {
          const matches = html.match(pattern) || [];
          matches.forEach(m => {
            // Try to find the 11-char ID in the match
            const innerMatch = m.match(/(?:videoId":"|shorts\/|v=)([^"&?]{11})/);
            if (innerMatch && innerMatch[1]) extractedIds.push(innerMatch[1]);
          });
        });

        // Use a set to get unique IDs, then filter out potential false positives (though 11 chars is usually safe)
        videoIds = [...new Set([...videoIds, ...extractedIds])];
        console.log(`Extraction Phase: Found ${extractedIds.length} raw matches, ${videoIds.length} unique total.`);
      } catch (fetchErr) {
        console.error("HTML Extraction failed:", fetchErr);
      }

      if (videoIds.length === 0) {
        return res.status(404).json({ error: "No se encontraron videos. Asegúrate de que el canal sea público." });
      }

      console.log(`Final video count discovered: ${videoIds.length}`);
      res.json({ videoIds });
    } catch (error: any) {
      console.error("Channel error:", error);
      res.status(500).json({ error: `Error procesando el canal: ${error.message || "Error desconocido"}` });
    }
  });

  app.post("/api/llm", async (req, res) => {
    const { prompt, jsonMode } = req.body ?? {};
    if (!prompt || typeof prompt !== "string") {
      return res.status(400).json({ error: "prompt is required" });
    }

    const apiKey = process.env.CURSOR_API_KEY;
    const model = process.env.CURSOR_MODEL || "";
    const rawBaseUrl = process.env.CURSOR_API_BASE_URL || "https://api.cursor.com";
    const repoUrl = process.env.CURSOR_AGENT_REPO_URL || "";
    const startingRef = process.env.CURSOR_AGENT_STARTING_REF || "main";

    if (!apiKey) {
      return res.status(500).json({ error: "Missing CURSOR_API_KEY on server env" });
    }

    try {
      const normalizedBase = rawBaseUrl.replace(/\/+$/, "");
      const baseWithoutV1 = normalizedBase.replace(/\/v1$/i, "");
      const isCursorCloudAgentsApi =
        /api\.cursor\.com\/?$/i.test(baseWithoutV1) || /api\.cursor\.com\/v1$/i.test(normalizedBase);

      if (isCursorCloudAgentsApi) {
        if (!repoUrl) {
          return res.status(400).json({
            error: "Missing CURSOR_AGENT_REPO_URL",
            details:
              "Cursor Cloud Agents API requiere un repo de GitHub. Define CURSOR_AGENT_REPO_URL en .env.local (ej: https://github.com/org/repo).",
          });
        }

        const authHeader = toBasicAuthHeader(apiKey);
        const createAgentBody: Record<string, unknown> = {
          prompt: { text: prompt },
          repos: [{ url: repoUrl, startingRef }],
          autoCreatePR: false,
          autoGenerateBranch: true,
        };
        if (model) createAgentBody.model = { id: model };

        const createRes = await fetch(`${baseWithoutV1}/v1/agents`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: authHeader,
          },
          body: JSON.stringify(createAgentBody),
        });

        if (!createRes.ok) {
          const errorText = await createRes.text();
          return res.status(createRes.status).json({
            error: `Cursor Agents create failed ${createRes.status}`,
            details: errorText.slice(0, 500),
          });
        }

        const created = (await createRes.json()) as {
          agent?: { id?: string };
          run?: { id?: string };
        };
        const agentId = created.agent?.id;
        const runId = created.run?.id;
        if (!agentId || !runId) {
          return res.status(502).json({
            error: "Cursor Agents response missing ids",
            details: JSON.stringify(created).slice(0, 500),
          });
        }

        const streamRes = await fetch(`${baseWithoutV1}/v1/agents/${agentId}/runs/${runId}/stream`, {
          method: "GET",
          headers: {
            Authorization: authHeader,
            Accept: "text/event-stream",
          },
        });

        if (!streamRes.ok) {
          const errorText = await streamRes.text();
          return res.status(streamRes.status).json({
            error: `Cursor Agents stream failed ${streamRes.status}`,
            details: errorText.slice(0, 500),
          });
        }

        const streamText = await streamRes.text();
        const bestText = parseSseForBestText(streamText);
        if (!bestText) {
          return res.status(502).json({
            error: "Cursor Agents stream returned no text",
            details: streamText.slice(0, 500),
          });
        }

        return res.json({ text: bestText });
      }

      const endpointCandidates = [
        `${baseWithoutV1}/chat/completions`,
        `${baseWithoutV1}/v1/chat/completions`,
        `${normalizedBase}/chat/completions`,
      ];
      const uniqueEndpoints = [...new Set(endpointCandidates)];

      let llmRes: Response | null = null;
      let lastErrorText = "";
      for (const endpoint of uniqueEndpoints) {
        const currentRes = await fetch(endpoint, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${apiKey}`,
          },
          body: JSON.stringify({
            model,
            temperature: 0.2,
            messages: [{ role: "user", content: prompt }],
            response_format: jsonMode ? { type: "json_object" } : undefined,
          }),
        });

        if (currentRes.ok) {
          llmRes = currentRes;
          break;
        }

        const errorText = await currentRes.text();
        lastErrorText = errorText;

        // Retry with next candidate only on route-not-found.
        if (currentRes.status !== 404) {
          return res.status(currentRes.status).json({
            error: `Cursor API error ${currentRes.status}`,
            details: errorText.slice(0, 500),
          });
        }
      }

      if (!llmRes) {
        return res.status(404).json({
          error: "Cursor API endpoint not found",
          details: lastErrorText.slice(0, 500),
        });
      }

      const data = (await llmRes.json()) as {
        choices?: Array<{ message?: { content?: string } }>;
      };
      const text = data.choices?.[0]?.message?.content;
      if (!text) return res.status(502).json({ error: "Cursor API returned empty content" });
      return res.json({ text });
    } catch (error: any) {
      return res.status(500).json({ error: error.message || "LLM request failed" });
    }
  });

  // Vite middleware for development
  if (process.env.NODE_ENV !== "production") {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: "spa",
    });
    app.use(vite.middlewares);
  } else {
    // Production setup
    const distPath = path.join(process.cwd(), 'dist');
    app.use(express.static(distPath));
    app.get('*', (req, res) => {
      res.sendFile(path.join(distPath, 'index.html'));
    });
  }

  app.listen(PORT, HOST, () => {
    console.log(`Server running on http://${HOST}:${PORT}`);
  });
}

startServer();
