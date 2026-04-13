import { NextRequest, NextResponse } from 'next/server'
import { resolveChannel, getChannelVideos, ingestVideo } from '@/lib/youtube'

export const runtime = 'nodejs'
export const maxDuration = 300 // large channels need time; dedup makes retries safe

function extractVideoId(url: string): string | null {
  const m = url.match(/(?:v=|youtu\.be\/)([a-zA-Z0-9_-]{11})/)
  return m ? m[1] : null
}

export async function POST(request: NextRequest) {
  if (!process.env.YOUTUBE_API_KEY) {
    return NextResponse.json({ error: 'YOUTUBE_API_KEY not configured' }, { status: 503 })
  }

  const body = await request.json().catch(() => null)
  const channelInput: string | undefined = body?.channel
  if (!channelInput || typeof channelInput !== 'string') {
    return NextResponse.json({ error: 'channel is required (URL, @handle, or channel ID)' }, { status: 400 })
  }

  // Single video URL — look up title then ingest
  const videoId = extractVideoId(channelInput)
  if (videoId) {
    let title = videoId
    let channelTitle = 'unknown'
    try {
      const metaRes = await fetch(
        `https://www.googleapis.com/youtube/v3/videos?part=snippet&id=${videoId}&key=${process.env.YOUTUBE_API_KEY}`
      )
      if (metaRes.ok) {
        const meta = await metaRes.json()
        const snippet = meta?.items?.[0]?.snippet
        if (snippet?.title) title = snippet.title
        if (snippet?.channelTitle) channelTitle = snippet.channelTitle
      }
    } catch { /* fall back to videoId as title */ }
    const result = await ingestVideo(videoId, title, channelTitle)
    return NextResponse.json({ total: 1, results: [result], ...countResults([result]) })
  }

  // Channel URL / handle
  let channelId: string
  let channelTitle: string
  let uploadsPlaylistId: string
  try {
    ;({ channelId, channelTitle, uploadsPlaylistId } = await resolveChannel(channelInput))
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'Failed to resolve channel' },
      { status: 422 },
    )
  }

  let videos: Awaited<ReturnType<typeof getChannelVideos>>
  try {
    const oneYearAgo = new Date()
    oneYearAgo.setFullYear(oneYearAgo.getFullYear() - 1)
    videos = await getChannelVideos(uploadsPlaylistId, oneYearAgo)
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'Failed to fetch video list' },
      { status: 422 },
    )
  }

  const results = []
  for (const { videoId, title } of videos) {
    results.push(await ingestVideo(videoId, title, channelTitle))
  }

  return NextResponse.json({ channelId, channelTitle, total: videos.length, ...countResults(results), results })
}

function countResults(results: { status: string }[]) {
  return results.reduce(
    (acc, r) => { acc[r.status as keyof typeof acc]++; return acc },
    { ingested: 0, skipped: 0, no_transcript: 0, error: 0 },
  )
}
