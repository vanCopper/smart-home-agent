"""Accumulate streaming LLM tokens and yield complete sentences for TTS."""

_BOUNDARIES = frozenset('。！？\n.!?')
# Minimum chars before treating a boundary as a real sentence end
_MIN_LEN = 4


class SentenceChunker:
    def __init__(self):
        self._buf = ''

    def feed(self, token: str) -> list[str]:
        """Return any complete sentences found after appending token."""
        self._buf += token
        sentences: list[str] = []
        while True:
            for i, ch in enumerate(self._buf):
                if ch in _BOUNDARIES and i + 1 >= _MIN_LEN:
                    sentence = self._buf[:i + 1].strip()
                    self._buf = self._buf[i + 1:]
                    if sentence:
                        sentences.append(sentence)
                    break
            else:
                break
        return sentences

    def flush(self) -> str | None:
        """Return any remaining buffered text (call at stream end)."""
        s = self._buf.strip()
        self._buf = ''
        return s if s else None
