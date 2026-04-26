"""Accumulate streaming LLM tokens and yield sentence chunks for TTS.

Chunking strategy (three tiers):
  1. Hard boundary  (。！？.!?\\n)  → flush immediately once ≥ MIN_LEN chars
  2. Soft boundary  (，,；：)       → flush when buffer ≥ SOFT_FLUSH_CHARS
     Gets the first TTS chunk started earlier — critical for low-latency
     streaming TTS (CosyVoice2 first-chunk latency ~300ms, so we want to
     hand off text as early as possible).
  3. Force flush    (no boundary)  → flush when buffer ≥ FORCE_FLUSH_CHARS
     Prevents the last fragment of a very long sentence from being held back.
"""

_HARD_BOUNDARIES  = frozenset('。！？\n.!?')
_SOFT_BOUNDARIES  = frozenset('，,；：:')

_MIN_LEN          = 4    # chars: ignore boundaries in very short fragments
_SOFT_FLUSH_CHARS = 15   # flush on soft boundary once buffer reaches this
_FORCE_FLUSH_CHARS = 40  # flush unconditionally once buffer reaches this


class SentenceChunker:
    def __init__(self):
        self._buf = ''

    def feed(self, token: str) -> list[str]:
        """Append token, return any sentences ready for TTS."""
        self._buf += token
        out: list[str] = []

        while self._buf:
            # --- Tier 1: hard boundary ---
            hard_idx = -1
            for i, ch in enumerate(self._buf):
                if ch in _HARD_BOUNDARIES and i + 1 >= _MIN_LEN:
                    hard_idx = i
                    break
            if hard_idx >= 0:
                out.append(self._buf[:hard_idx + 1].strip())
                self._buf = self._buf[hard_idx + 1:]
                continue

            # --- Tier 2: soft boundary (only if buffer long enough) ---
            if len(self._buf) >= _SOFT_FLUSH_CHARS:
                soft_idx = -1
                for i, ch in enumerate(self._buf):
                    if ch in _SOFT_BOUNDARIES and i + 1 >= _MIN_LEN:
                        soft_idx = i
                        break
                if soft_idx >= 0:
                    out.append(self._buf[:soft_idx + 1].strip())
                    self._buf = self._buf[soft_idx + 1:]
                    continue

            # --- Tier 3: force flush (very long fragment, no boundary) ---
            if len(self._buf) >= _FORCE_FLUSH_CHARS:
                out.append(self._buf.strip())
                self._buf = ''
                continue

            break   # nothing to flush yet

        return [s for s in out if s]

    def flush(self) -> str | None:
        """Return any remaining buffered text (call at LLM stream end)."""
        s = self._buf.strip()
        self._buf = ''
        return s if s else None
