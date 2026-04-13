import { google } from 'googleapis'
import { getSupabase } from './supabase'
import { ingest } from './ingest'

function getYouTube() {
  return google.youtube({ version: 'v3', auth: process.env.YOUTUBE_API_KEY })
}

type ResolvedChannel = { channelId: string; channelTitle: string; uploadsPlaylistId: string }

// Accept a full YouTube channel URL, @handle, or bare channel ID.
// Fetches snippet + contentDetails in one API call so we have both the title
// and uploads playlist ID without a second round-trip.
export async function resolveChannel(input: string): Promise<ResolvedChannel> {
  const yt = getYouTube()
  let normalised = input.trim()

  // Extract from URL
  const handleMatch = normalised.match(/youtube\.com\/@([\w-]+)/)
  if (handleMatch) normalised = `@${handleMatch[1]}`
  const idMatch = normalised.match(/youtube\.com\/channel\/(UC[\w-]+)/)
  if (idMatch) normalised = idMatch[1]

  const parts = ['id', 'snippet', 'contentDetails']

  // Try as @handle or bare handle word
  if (!normalised.startsWith('UC')) {
    const handle = normalised.startsWith('@') ? normalised.slice(1) : normalised
    const { data } = await yt.channels.list({ forHandle: handle, part: parts })
    const ch = data.items?.[0]
    if (ch?.id && ch.contentDetails?.relatedPlaylists?.uploads) {
      return {
        channelId: ch.id,
        channelTitle: ch.snippet?.title ?? handle,
        uploadsPlaylistId: ch.contentDetails.relatedPlaylists.uploads,
      }
    }
  }

  // Try as raw channel ID
  const { data } = await yt.channels.list({ id: [normalised], part: parts })
  const ch = data.items?.[0]
  if (ch?.id && ch.contentDetails?.relatedPlaylists?.uploads) {
    return {
      channelId: ch.id,
      channelTitle: ch.snippet?.title ?? normalised,
      uploadsPlaylistId: ch.contentDetails.relatedPlaylists.uploads,
    }
  }

  throw new Error(`Could not resolve YouTube channel: ${input}`)
}

export type VideoInfo = {
  videoId: string
  title: string
  publishedAt: string
}

// List videos from a channel's uploads playlist (newest first).
// If publishedAfter is set, stops paginating once videos are older than that date.
export async function getChannelVideos(uploadsPlaylistId: string, publishedAfter?: Date): Promise<VideoInfo[]> {
  const yt = getYouTube()
  const uploadsId = uploadsPlaylistId

  const videos: VideoInfo[] = []
  let pageToken: string | undefined

  do {
    const { data } = await yt.playlistItems.list({
      playlistId: uploadsId,
      part: ['snippet', 'contentDetails'],
      maxResults: 50,
      pageToken,
    })

    for (const item of data.items ?? []) {
      const videoId = item.contentDetails?.videoId
      const title = item.snippet?.title
      const publishedAt = item.contentDetails?.videoPublishedAt ?? item.snippet?.publishedAt
      if (!videoId || !title || !publishedAt) continue

      // Uploads playlist is newest-first — once we cross the cutoff we can stop
      if (publishedAfter && new Date(publishedAt) < publishedAfter) return videos

      videos.push({ videoId, title, publishedAt })
    }

    pageToken = data.nextPageToken ?? undefined
  } while (pageToken)

  return videos
}

function videoUrl(videoId: string): string {
  return `https://www.youtube.com/watch?v=${videoId}`
}

async function isVideoIngested(videoId: string): Promise<boolean> {
  const { data } = await getSupabase()
    .from('documents')
    .select('id')
    .eq('source_ref', videoUrl(videoId))
    .maybeSingle()
  return !!data
}

type CaptionTrack = { baseUrl: string; languageCode: string; kind?: string }

// Fetch transcript by extracting ytInitialPlayerResponse embedded in the watch page.
// This is more reliable than the InnerTube player API for anonymous server requests
// because YouTube serves the full player data (including captions) in the page HTML
// for any logged-out viewer — no separate API call needed.
async function fetchTranscript(videoId: string): Promise<string> {
  console.log(`[fetchTranscript] Starting for videoId=${videoId}`)

  // 1. Fetch the watch page — CONSENT cookie skips EU consent wall
  let pageRes: Response
  try {
    pageRes = await fetch(`https://www.youtube.com/watch?v=${videoId}`, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept-Language': 'en-US,en;q=0.9',
        'Cookie': 'CONSENT=YES+42; SOCS=CAI',
      },
      signal: AbortSignal.timeout(15_000),
    })
  } catch (err) {
    console.error(`[fetchTranscript] Page fetch threw: ${err}`)
    throw err
  }
  console.log(`[fetchTranscript] Page fetch status=${pageRes.status} ok=${pageRes.ok}`)
  if (!pageRes.ok) throw new Error(`YouTube page fetch failed: ${pageRes.status}`)
  const html = await pageRes.text()
  console.log(`[fetchTranscript] Page HTML length=${html.length}`)

  // 2. Extract ytInitialPlayerResponse — YouTube embeds full player data in the page
  //    as a JS variable assignment. We use bracket-depth tracking to extract the JSON
  //    object reliably without regex greediness issues on large nested payloads.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let playerData: any = null

  const marker = 'ytInitialPlayerResponse = '
  const markerIdx = html.indexOf(marker)
  if (markerIdx !== -1) {
    const objStart = html.indexOf('{', markerIdx + marker.length)
    if (objStart !== -1) {
      let depth = 0
      let objEnd = -1
      for (let i = objStart; i < html.length; i++) {
        if (html[i] === '{') depth++
        else if (html[i] === '}') {
          depth--
          if (depth === 0) { objEnd = i + 1; break }
        }
      }
      if (objEnd !== -1) {
        try {
          playerData = JSON.parse(html.slice(objStart, objEnd))
          console.log(`[fetchTranscript] Parsed ytInitialPlayerResponse from page HTML (${objEnd - objStart} chars)`)
        } catch (err) {
          console.warn(`[fetchTranscript] Failed to JSON.parse ytInitialPlayerResponse: ${err}`)
        }
      } else {
        console.warn(`[fetchTranscript] Could not find closing brace for ytInitialPlayerResponse`)
      }
    }
  } else {
    console.warn(`[fetchTranscript] ytInitialPlayerResponse marker not found in page HTML`)
  }

  // 3. If page extraction failed, fall back to the InnerTube player API
  if (!playerData) {
    console.log(`[fetchTranscript] ytInitialPlayerResponse not in page — falling back to player API`)
    const keyMatch = html.match(/"INNERTUBE_API_KEY":\s*"([a-zA-Z0-9_-]+)"/)
    const apiKey = keyMatch?.[1]
    console.log(`[fetchTranscript] INNERTUBE_API_KEY ${apiKey ? `found: ${apiKey.slice(0, 8)}...` : 'NOT FOUND'}`)

    if (apiKey) {
      try {
        const playerRes = await fetch(
          `https://www.youtube.com/youtubei/v1/player?key=${apiKey}`,
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              context: { client: { clientName: 'WEB', clientVersion: '2.20240101' } },
              videoId,
            }),
            signal: AbortSignal.timeout(15_000),
          }
        )
        console.log(`[fetchTranscript] Player API (WEB) status=${playerRes.status}`)
        if (playerRes.ok) playerData = await playerRes.json()
      } catch (err) {
        console.error(`[fetchTranscript] Player API threw: ${err}`)
      }
    }

    if (!playerData) {
      const snippet = html.slice(0, 500).replace(/\n/g, ' ')
      console.error(`[fetchTranscript] Could not obtain playerData. HTML start: ${snippet}`)
      throw new Error('Could not extract player data from YouTube page')
    }
  }

  const playabilityStatus = playerData?.playabilityStatus?.status ?? 'unknown'
  const playabilityReason = playerData?.playabilityStatus?.reason ?? ''
  const tracks: CaptionTrack[] =
    playerData?.captions?.playerCaptionsTracklistRenderer?.captionTracks ?? []

  console.log(`[fetchTranscript] playabilityStatus=${playabilityStatus} reason="${playabilityReason}" trackCount=${tracks.length}`)

  if (tracks.length > 0) {
    console.log(`[fetchTranscript] Available tracks: ${tracks.map(t => `${t.languageCode}${t.kind ? `(${t.kind})` : ''}`).join(', ')}`)
  } else {
    const hasCaptionsKey = !!playerData?.captions
    const hasRenderer = !!playerData?.captions?.playerCaptionsTracklistRenderer
    console.error(`[fetchTranscript] No tracks. hasCaptionsKey=${hasCaptionsKey} hasRenderer=${hasRenderer}`)
  }

  if (!tracks.length) throw new Error(`No caption tracks (playability=${playabilityStatus}${playabilityReason ? ': ' + playabilityReason : ''})`)

  // 4. Pick best English track, fall back to anything available
  const track =
    tracks.find(t => t.languageCode === 'en' && t.kind !== 'asr') ??
    tracks.find(t => t.languageCode === 'en') ??
    tracks.find(t => t.kind === 'asr') ??
    tracks[0]
  console.log(`[fetchTranscript] Selected track: lang=${track.languageCode} kind=${track.kind ?? 'manual'}`)

  // 5. Download and parse the caption XML/JSON
  let captionRes: Response
  try {
    captionRes = await fetch(`${track.baseUrl}&fmt=json3`, { signal: AbortSignal.timeout(15_000) })
  } catch (err) {
    console.error(`[fetchTranscript] Caption download threw: ${err}`)
    throw err
  }
  console.log(`[fetchTranscript] Caption download status=${captionRes.status}`)
  if (!captionRes.ok) throw new Error(`Caption download failed: ${captionRes.status}`)

  const captionData = await captionRes.json() as { events: Array<{ segs?: Array<{ utf8: string }> }> }
  const text = captionData.events
    .filter(e => e.segs)
    .flatMap(e => e.segs!)
    .map(s => s.utf8)
    .filter(t => t !== '\n')
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim()
  console.log(`[fetchTranscript] Transcript length=${text.length} chars`)
  return text
}

export type IngestVideoResult = {
  videoId: string
  title: string
  status: 'ingested' | 'skipped' | 'no_transcript' | 'error'
  error?: string
}

export async function ingestVideo(
  videoId: string,
  title: string,
  channelTitle: string,
): Promise<IngestVideoResult> {
  if (await isVideoIngested(videoId)) {
    return { videoId, title, status: 'skipped' }
  }

  let transcript: string
  try {
    transcript = await fetchTranscript(videoId)
  } catch (err) {
    return { videoId, title, status: 'no_transcript', error: err instanceof Error ? err.message : String(err) }
  }

  if (!transcript.trim()) {
    return { videoId, title, status: 'no_transcript' }
  }

  try {
    await ingest({
      sourceType: 'youtube',
      sourceRef: videoUrl(videoId),
      title,
      text: `Channel: ${channelTitle}\nTitle: ${title}\n\n${transcript}`,
      metadata: { channelTitle, videoId },
    })
    return { videoId, title, status: 'ingested' }
  } catch (err) {
    return {
      videoId,
      title,
      status: 'error',
      error: err instanceof Error ? err.message : String(err),
    }
  }
}
