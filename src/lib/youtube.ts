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

// Fetch a YouTube transcript.
// Primary: Supadata API — handles bot detection proxy-side, works from datacenter IPs.
// Fallback: extract ytInitialPlayerResponse from the watch page HTML directly.
async function fetchTranscript(videoId: string): Promise<string> {
  // 1. Supadata (primary) — purpose-built transcript API, not subject to datacenter IP blocks
  const supadataKey = process.env.SUPADATA_API_KEY
  if (supadataKey) {
    try {
      const res = await fetch(
        `https://api.supadata.ai/v1/youtube/transcript?videoId=${videoId}&text=true`,
        {
          headers: { 'x-api-key': supadataKey },
          signal: AbortSignal.timeout(30_000),
        }
      )
      if (res.ok) {
        const text = await res.text()
        if (text.trim().length > 50) {
          return text.trim()
        }
        console.warn(`[fetchTranscript] Supadata returned very short text (${text.length} chars), trying fallback`)
      } else {
        const body = await res.text()
        console.warn(`[fetchTranscript] Supadata ${res.status}: ${body.slice(0, 200)}`)
        // 404 means no transcript available for this video — don't bother with fallback
        if (res.status === 404) throw new Error('No transcript available for this video')
      }
    } catch (err) {
      if (err instanceof Error && err.message.includes('No transcript')) throw err
      console.warn(`[fetchTranscript] Supadata threw: ${err}`)
    }
  }

  // 2. Fallback: parse ytInitialPlayerResponse from the watch page HTML
  //    YouTube embeds the full player data as a JS variable in the page.
  //    Use bracket-depth tracking to extract the JSON reliably.
  const pageRes = await fetch(`https://www.youtube.com/watch?v=${videoId}`, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      'Accept-Language': 'en-US,en;q=0.9',
      'Cookie': 'CONSENT=YES+42; SOCS=CAI',
    },
    signal: AbortSignal.timeout(15_000),
  })
  if (!pageRes.ok) throw new Error(`YouTube page fetch failed: ${pageRes.status}`)
  const html = await pageRes.text()

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let playerData: any = null
  const marker = 'ytInitialPlayerResponse = '
  const markerIdx = html.indexOf(marker)
  if (markerIdx !== -1) {
    const objStart = html.indexOf('{', markerIdx + marker.length)
    if (objStart !== -1) {
      let depth = 0, objEnd = -1
      for (let i = objStart; i < html.length; i++) {
        if (html[i] === '{') depth++
        else if (html[i] === '}' && --depth === 0) { objEnd = i + 1; break }
      }
      if (objEnd !== -1) {
        try { playerData = JSON.parse(html.slice(objStart, objEnd)) } catch { /* ignore */ }
      }
    }
  }

  if (!playerData) throw new Error('Could not extract player data from YouTube page')

  const playabilityStatus: string = playerData?.playabilityStatus?.status ?? 'unknown'
  const playabilityReason: string = playerData?.playabilityStatus?.reason ?? ''
  const tracks: CaptionTrack[] =
    playerData?.captions?.playerCaptionsTracklistRenderer?.captionTracks ?? []

  if (!tracks.length) {
    throw new Error(`No caption tracks (playability=${playabilityStatus}${playabilityReason ? ': ' + playabilityReason : ''})`)
  }

  const track =
    tracks.find(t => t.languageCode === 'en' && t.kind !== 'asr') ??
    tracks.find(t => t.languageCode === 'en') ??
    tracks.find(t => t.kind === 'asr') ??
    tracks[0]

  const captionRes = await fetch(`${track.baseUrl}&fmt=json3`, { signal: AbortSignal.timeout(15_000) })
  if (!captionRes.ok) throw new Error(`Caption download failed: ${captionRes.status}`)

  const captionData = await captionRes.json() as { events: Array<{ segs?: Array<{ utf8: string }> }> }
  return captionData.events
    .filter(e => e.segs)
    .flatMap(e => e.segs!)
    .map(s => s.utf8)
    .filter(t => t !== '\n')
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim()
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
