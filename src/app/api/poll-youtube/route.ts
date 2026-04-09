import { NextResponse } from 'next/server'
import { resolveChannel, getChannelVideos, ingestVideo } from '@/lib/youtube'

export const runtime = 'nodejs'
export const maxDuration = 300

// YOUTUBE_CHANNEL_IDS — comma-separated list of channel IDs, handles, or URLs
// YOUTUBE_LOOKBACK_DAYS — how far back to look for new videos (default 7)
//
// Call this route from a Vercel cron job:
//   vercel.json: { "crons": [{ "path": "/api/poll-youtube", "schedule": "0 6 * * *" }] }

export async function GET() {
  if (!process.env.YOUTUBE_API_KEY) {
    return NextResponse.json({ error: 'YOUTUBE_API_KEY not configured' }, { status: 503 })
  }

  const raw = process.env.YOUTUBE_CHANNEL_IDS ?? ''
  const channelInputs = raw.split(',').map((s) => s.trim()).filter(Boolean)

  if (channelInputs.length === 0) {
    return NextResponse.json({ error: 'YOUTUBE_CHANNEL_IDS not configured' }, { status: 503 })
  }

  const lookbackDays = parseInt(process.env.YOUTUBE_LOOKBACK_DAYS ?? '7', 10)
  const publishedAfter = new Date(Date.now() - lookbackDays * 24 * 60 * 60 * 1000)

  const channelResults = []

  for (const input of channelInputs) {
    let channelId: string
    let channelTitle: string
    let uploadsPlaylistId: string
    try {
      ;({ channelId, channelTitle, uploadsPlaylistId } = await resolveChannel(input))
    } catch (err) {
      channelResults.push({ channel: input, error: err instanceof Error ? err.message : String(err) })
      continue
    }

    let videos: Awaited<ReturnType<typeof getChannelVideos>>
    try {
      videos = await getChannelVideos(uploadsPlaylistId, publishedAfter)
    } catch (err) {
      channelResults.push({ channel: input, channelId, error: err instanceof Error ? err.message : String(err) })
      continue
    }

    const results = []
    for (const { videoId, title } of videos) {
      results.push(await ingestVideo(videoId, title, channelTitle))
    }

    const counts = results.reduce(
      (acc, r) => { acc[r.status]++; return acc },
      { ingested: 0, skipped: 0, no_transcript: 0, error: 0 },
    )

    channelResults.push({ channel: input, channelId, channelTitle, videos: videos.length, ...counts })
  }

  return NextResponse.json({ polledAt: new Date().toISOString(), lookbackDays, channels: channelResults })
}
