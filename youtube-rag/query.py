"""
query.py — query the YouTube knowledge base with a natural language question.

Usage:
  python query.py "what did they say about CPM floors?"
  python query.py          # interactive mode
"""

from __future__ import annotations

import os
import sys

import anthropic
from openai import OpenAI
import chromadb

# ---------------------------------------------------------------------------
# Config
# ---------------------------------------------------------------------------
TOP_K           = 5
CHROMA_PATH     = "./chroma_db"
COLLECTION_NAME = "youtube_knowledge"
CLAUDE_MODEL    = "claude-sonnet-4-20250514"

openai_client    = OpenAI(api_key=os.environ["OPENAI_API_KEY"])
anthropic_client = anthropic.Anthropic(api_key=os.environ["ANTHROPIC_API_KEY"])


# ---------------------------------------------------------------------------
# ChromaDB
# ---------------------------------------------------------------------------
def get_collection():
    client = chromadb.PersistentClient(path=CHROMA_PATH)
    return client.get_or_create_collection(COLLECTION_NAME)


# ---------------------------------------------------------------------------
# Embed
# ---------------------------------------------------------------------------
def embed_question(question: str) -> list[float]:
    resp = openai_client.embeddings.create(
        model="text-embedding-3-small",
        input=[question],
    )
    return resp.data[0].embedding


# ---------------------------------------------------------------------------
# Query
# ---------------------------------------------------------------------------
def query(question: str) -> str:
    collection = get_collection()

    if collection.count() == 0:
        return "The knowledge base is empty. Run ingest.py first."

    embedding = embed_question(question)

    results = collection.query(
        query_embeddings=[embedding],
        n_results=min(TOP_K, collection.count()),
        include=["documents", "metadatas", "distances"],
    )

    chunks    = results["documents"][0]
    metadatas = results["metadatas"][0]

    if not chunks:
        return "No relevant content found for that question."

    # Build context block for Claude
    context_sections = []
    for i, (chunk, meta) in enumerate(zip(chunks, metadatas), start=1):
        context_sections.append(
            f"[Source {i}]\n"
            f"Video: {meta['video_title']}\n"
            f"Timestamp: {meta['timestamp_str']} — {meta['timestamp_url']}\n"
            f"Excerpt:\n{chunk}"
        )

    context = "\n\n---\n\n".join(context_sections)

    prompt = f"""You are a research assistant answering questions from a YouTube knowledge base.

Below are the most relevant excerpts retrieved for the question. Each excerpt includes the video title, a timestamp, and a direct link to that moment in the video.

{context}

---

Question: {question}

Instructions:
- Answer clearly and directly based only on the sources above.
- After your answer, include a "Sources" section listing each source you drew from, with its video title, timestamp, and URL.
- If the sources do not contain enough information to answer the question, say so clearly rather than speculating."""

    response = anthropic_client.messages.create(
        model=CLAUDE_MODEL,
        max_tokens=1024,
        messages=[{"role": "user", "content": prompt}],
    )

    return response.content[0].text


# ---------------------------------------------------------------------------
# Entry point
# ---------------------------------------------------------------------------
def main():
    if len(sys.argv) >= 2:
        # Single question from args
        question = " ".join(sys.argv[1:])
        print(query(question))
    else:
        # Interactive REPL
        print("YouTube knowledge base — ask a question (Ctrl+C or 'quit' to exit)\n")
        while True:
            try:
                question = input("> ").strip()
            except (KeyboardInterrupt, EOFError):
                print()
                break
            if not question:
                continue
            if question.lower() in ("quit", "exit", "q"):
                break
            print("\n" + query(question) + "\n")


if __name__ == "__main__":
    main()
