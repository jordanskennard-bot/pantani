"""
ingest.py — ingest a YouTube video or playlist into a local ChromaDB knowledge base.

Usage:
  python ingest.py <video_or_playlist_url>

Transcript strategy:
  1. Try youtube-transcript-api (free, no API quota).
  2. Fall back to yt-dlp audio download + OpenAI Whisper transcription.
"""

from __future__ import annotations

import os
import re
import sys
import logging
import tempfile
from pathlib import Path

import yt_dlp
from openai import OpenAI
from pydub import AudioSegment
from youtube_transcript_api import YouTubeTranscriptApi, NoTranscriptFound, TranscriptsDisabled
from langchain_text_splitters import RecursiveCharacterTextSplitter
import chromadb
import tiktoken

# ---------------------------------------------------------------------------
# Config
# ---------------------------------------------------------------------------
CHUNK_SIZE        = 500           # tokens
CHUNK_OVERLAP     = 50            # tokens
CHUNK_DURATION_MS = 10 * 60_000  # 10 minutes
OVERLAP_MS        = 30_000        # 30-second overlap between audio chunks
MAX_WHISPER_BYTES = 24 * 1024 * 1024  # 24 MB Whisper limit
EMBED_BATCH_SIZE  = 100
CHROMA_PATH       = "./chroma_db"
COLLECTION_NAME   = "youtube_knowledge"

openai_client = OpenAI(api_key=os.environ["OPENAI_API_KEY"])
logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger(__name__)


# ---------------------------------------------------------------------------
# ChromaDB
# ---------------------------------------------------------------------------
def get_collection():
    client = chromadb.PersistentClient(path=CHROMA_PATH)
    return client.get_or_create_collection(COLLECTION_NAME)


# ---------------------------------------------------------------------------
# URL helpers
# ---------------------------------------------------------------------------
def extract_video_id(url: str) -> str:
    for pattern in [
        r"(?:v=|/v/|youtu\.be/)([a-zA-Z0-9_-]{11})",
        r"(?:embed/)([a-zA-Z0-9_-]{11})",
    ]:
        m = re.search(pattern, url)
        if m:
            return m.group(1)
    raise ValueError(f"Cannot extract video ID from: {url}")


def is_playlist(url: str) -> bool:
    return "playlist" in url or "list=" in url


def get_playlist_urls(playlist_url: str) -> list[str]:
    with yt_dlp.YoutubeDL({"extract_flat": True, "quiet": True}) as ydl:
        info = ydl.extract_info(playlist_url, download=False)
    return [
        f"https://www.youtube.com/watch?v={e['id']}"
        for e in (info.get("entries") or [])
        if e and e.get("id")
    ]


def get_video_metadata(url: str) -> dict:
    with yt_dlp.YoutubeDL({"quiet": True}) as ydl:
        info = ydl.extract_info(url, download=False)
    return {
        "title":    info.get("title", "Unknown Title"),
        "duration": info.get("duration", 0),  # seconds
    }


# ---------------------------------------------------------------------------
# Transcript — youtube-transcript-api path
# ---------------------------------------------------------------------------
def fetch_yt_transcript(video_id: str) -> list[dict] | None:
    """Returns list of {text, start, duration} or None if unavailable."""
    try:
        return YouTubeTranscriptApi.get_transcript(video_id)
    except (NoTranscriptFound, TranscriptsDisabled):
        return None
    except Exception as e:
        log.warning(f"Transcript fetch error: {e}")
        return None


def transcript_to_text(entries: list[dict]) -> tuple[str, list[tuple[int, float]]]:
    """
    Convert transcript entries to plain text.
    Also returns a char_offset -> timestamp_sec mapping for approximate timestamps.
    """
    parts, mapping = [], []
    offset = 0
    for entry in entries:
        text = entry["text"].strip()
        mapping.append((offset, entry["start"]))
        parts.append(text)
        offset += len(text) + 1
    return " ".join(parts), mapping


def timestamp_for_offset(offset: int, mapping: list[tuple[int, float]]) -> float:
    for i in range(len(mapping) - 1, -1, -1):
        if mapping[i][0] <= offset:
            return mapping[i][1]
    return 0.0


# ---------------------------------------------------------------------------
# Transcript — Whisper fallback
# ---------------------------------------------------------------------------
def download_audio(url: str, out_stem: str) -> Path:
    """Download best audio as mp3. Returns path to the mp3 file."""
    ydl_opts = {
        "format": "bestaudio/best",
        "outtmpl": out_stem,
        "postprocessors": [{
            "key": "FFmpegExtractAudio",
            "preferredcodec": "mp3",
            "preferredquality": "128",
        }],
        "quiet": True,
    }
    with yt_dlp.YoutubeDL(ydl_opts) as ydl:
        ydl.download([url])
    # yt-dlp appends the codec extension
    mp3 = Path(out_stem + ".mp3")
    if not mp3.exists():
        # fallback: find any mp3 in the same directory
        candidates = list(Path(out_stem).parent.glob(Path(out_stem).name + "*.mp3"))
        if not candidates:
            raise FileNotFoundError(f"Audio download produced no mp3 near {out_stem}")
        mp3 = candidates[0]
    return mp3


def split_audio(
    audio: AudioSegment,
    chunk_ms: int,
    overlap_ms: int,
) -> list[tuple[AudioSegment, int]]:
    """Yield (chunk, start_ms) pairs with overlap."""
    result, start = [], 0
    total = len(audio)
    while start < total:
        end = min(start + chunk_ms, total)
        result.append((audio[start:end], start))
        if end == total:
            break
        start += chunk_ms - overlap_ms
    return result


def whisper_chunk(chunk: AudioSegment) -> str:
    """Export chunk to a temp file and transcribe with Whisper."""
    with tempfile.NamedTemporaryFile(suffix=".mp3", delete=False) as f:
        tmp = Path(f.name)
    try:
        chunk.export(str(tmp), format="mp3")
        size = tmp.stat().st_size
        if size > MAX_WHISPER_BYTES:
            raise ValueError(f"Chunk is {size / 1e6:.1f} MB — exceeds 24 MB limit")
        with open(tmp, "rb") as f:
            resp = openai_client.audio.transcriptions.create(model="whisper-1", file=f)
        return resp.text
    finally:
        tmp.unlink(missing_ok=True)


def stitch(texts: list[str]) -> str:
    """Concatenate transcription pieces, removing overlap duplicates."""
    if not texts:
        return ""
    result = texts[0]
    for nxt in texts[1:]:
        max_check = min(200, len(result), len(nxt))
        joined = False
        for length in range(max_check, 20, -1):
            if result.endswith(nxt[:length]):
                result += nxt[length:]
                joined = True
                break
        if not joined:
            result += " " + nxt
    return result


def transcribe_with_whisper(url: str) -> tuple[str, float]:
    """
    Download audio, split into chunks, transcribe via Whisper.
    Returns (full_text, total_duration_seconds).
    """
    with tempfile.TemporaryDirectory() as tmp_dir:
        audio_stem = str(Path(tmp_dir) / "audio")
        log.info("Downloading audio...")
        mp3_path = download_audio(url, audio_stem)

        log.info("Loading audio...")
        audio = AudioSegment.from_mp3(str(mp3_path))
        total_sec = len(audio) / 1000.0

        chunk_ms = CHUNK_DURATION_MS
        while True:
            chunks = split_audio(audio, chunk_ms, OVERLAP_MS)
            texts = []
            retry = False

            for i, (chunk, _start_ms) in enumerate(chunks):
                log.info(f"  Transcribing chunk {i + 1}/{len(chunks)}...")
                try:
                    texts.append(whisper_chunk(chunk))
                except ValueError as exc:
                    log.warning(f"  {exc} — reducing chunk size and retrying")
                    chunk_ms = int(chunk_ms * 0.7)
                    retry = True
                    break

            if not retry:
                break

        return stitch(texts), total_sec


# ---------------------------------------------------------------------------
# Embedding
# ---------------------------------------------------------------------------
def embed(texts: list[str]) -> list[list[float]]:
    resp = openai_client.embeddings.create(model="text-embedding-3-small", input=texts)
    return [item.embedding for item in resp.data]


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------
def fmt_ts(seconds: float) -> str:
    h, rem = divmod(int(seconds), 3600)
    m, s   = divmod(rem, 60)
    return f"{h}:{m:02d}:{s:02d}" if h else f"{m}:{s:02d}"


def ts_url(video_url: str, seconds: float) -> str:
    t = int(seconds)
    sep = "&" if "?" in video_url else "?"
    return f"{video_url}{sep}t={t}"


# ---------------------------------------------------------------------------
# Core ingest
# ---------------------------------------------------------------------------
def ingest_video(url: str, collection) -> bool:
    try:
        video_id = extract_video_id(url)

        # Skip if already ingested
        existing = collection.get(where={"video_id": video_id}, limit=1)
        if existing["ids"]:
            log.info(f"Already ingested — skipping: {url}")
            return True

        log.info(f"Fetching metadata for {url}")
        meta = get_video_metadata(url)
        title    = meta["title"]
        duration = meta["duration"]  # seconds; 0 if unknown
        log.info(f"Title: {title}")

        # --- Transcript ---
        char_to_time: list[tuple[int, float]] | None = None
        total_duration_sec: float = float(duration)

        yt_entries = fetch_yt_transcript(video_id)
        if yt_entries:
            log.info("Using YouTube transcript")
            full_text, char_to_time = transcript_to_text(yt_entries)
        else:
            log.info("No transcript — falling back to Whisper")
            full_text, total_duration_sec = transcribe_with_whisper(url)

        if not full_text.strip():
            log.warning(f"No text extracted — skipping: {url}")
            return False

        # --- Chunk ---
        splitter = RecursiveCharacterTextSplitter.from_tiktoken_encoder(
            chunk_size=CHUNK_SIZE, chunk_overlap=CHUNK_OVERLAP
        )
        chunks = splitter.split_text(full_text)
        log.info(f"Split into {len(chunks)} chunks")

        # --- Embed in batches ---
        all_embeddings: list[list[float]] = []
        for i in range(0, len(chunks), EMBED_BATCH_SIZE):
            batch = chunks[i : i + EMBED_BATCH_SIZE]
            log.info(f"Embedding chunks {i + 1}–{i + len(batch)} / {len(chunks)}")
            all_embeddings.extend(embed(batch))

        # --- Build metadata and estimate timestamps ---
        ids, documents, embeddings, metadatas = [], [], [], []
        char_offset = 0

        for i, (chunk, embedding) in enumerate(zip(chunks, all_embeddings)):
            if char_to_time:
                ts_sec = timestamp_for_offset(char_offset, char_to_time)
            elif total_duration_sec > 0:
                ts_sec = (char_offset / max(len(full_text), 1)) * total_duration_sec
            else:
                ts_sec = 0.0

            ids.append(f"{video_id}_chunk_{i}")
            documents.append(chunk)
            embeddings.append(embedding)
            metadatas.append({
                "video_title":    title,
                "video_url":      url,
                "video_id":       video_id,
                "timestamp_sec":  round(ts_sec, 1),
                "timestamp_str":  fmt_ts(ts_sec),
                "timestamp_url":  ts_url(url, ts_sec),
                "chunk_index":    i,
            })
            char_offset += len(chunk)

        collection.add(
            ids=ids,
            documents=documents,
            embeddings=embeddings,
            metadatas=metadatas,
        )
        log.info(f"Ingested '{title}' — {len(chunks)} chunks stored")
        return True

    except Exception as exc:
        log.error(f"Failed to ingest {url}: {exc}", exc_info=True)
        return False


# ---------------------------------------------------------------------------
# Entry point
# ---------------------------------------------------------------------------
def main():
    if len(sys.argv) < 2:
        print("Usage: python ingest.py <youtube_url_or_playlist_url>")
        sys.exit(1)

    url        = sys.argv[1]
    collection = get_collection()

    if is_playlist(url):
        log.info("Playlist detected — extracting video URLs...")
        video_urls = get_playlist_urls(url)
        log.info(f"Found {len(video_urls)} videos")
        ok = sum(ingest_video(v, collection) for v in video_urls)
        log.info(f"Done: {ok}/{len(video_urls)} ingested successfully")
    else:
        success = ingest_video(url, collection)
        sys.exit(0 if success else 1)


if __name__ == "__main__":
    main()
