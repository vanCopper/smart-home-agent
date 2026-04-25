"""Wake word detection via silero-vad + mlx-whisper.

Architecture:
  1. silero-vad runs continuously on 512-sample (32ms) chunks at 16kHz
  2. When speech burst ends (0.4s silence after voice), buffer is sent to Whisper
  3. Transcript is checked against configured wake phrases (substring match)
  4. Match → trigger; no match → clear buffer and keep listening

This supports arbitrary Chinese / multilingual wake words with no model training,
at the cost of ~0.3-1s Whisper latency per speech burst.
"""
import asyncio
import re
import numpy as np
import sounddevice as sd
import torch

from pypinyin import lazy_pinyin, Style

import asr as asr_mod

SAMPLE_RATE = 16000
CHUNK_SIZE  = 512          # silero-vad requirement at 16kHz
CHUNK_MS    = 32

MIN_SPEECH_MS  = 600        # ignore bursts shorter than this (total incl. trailing silence)
MIN_VOICED_MS  = 320        # minimum *actual* VAD-positive frames within a burst
                            # cough/laugh: ~3-6 voiced frames; '小新': ~10+ frames
MAX_SPEECH_MS = 3000        # cap each burst length
SILENCE_END_MS = 400        # silence needed to close a burst

_vad_model = None


def _vad():
    global _vad_model
    if _vad_model is None:
        _vad_model, _ = torch.hub.load(
            repo_or_dir='snakers4/silero-vad',
            model='silero_vad',
            force_reload=False,
            trust_repo=True,
        )
    return _vad_model


def _is_speech(chunk: np.ndarray) -> bool:
    t = torch.from_numpy(chunk.astype(np.float32))
    return _vad()(t, SAMPLE_RATE).item() > 0.5


def _normalize(s: str) -> str:
    # drop punctuation/whitespace for robust matching
    return re.sub(r'[\s\.,;:!?，。！？、；：]+', '', s).lower()


def _to_pinyin(s: str) -> str:
    """Convert to concatenated pinyin (no tones). 'xiaoxin' etc."""
    return ''.join(lazy_pinyin(s, style=Style.NORMAL))


class WakeWordDetector:
    def __init__(self, wake_words: list[str], model_path: str | None = None):
        self._orig_words = [w.strip() for w in wake_words if w.strip()]
        # Match against both normalized characters and pinyin (robust to homophones)
        self._words_norm = [_normalize(w) for w in self._orig_words]
        self._words_py   = [_to_pinyin(w) for w in self._orig_words]
        # SenseVoice handles Chinese short bursts directly — no prompt needed.
        self._detected = asyncio.Event()
        _vad()  # warm up
        print(f'[wake] VAD+Whisper  wake_words={self._orig_words}  pinyin={self._words_py}')

    def _match(self, transcript: str) -> str | None:
        norm = _normalize(transcript)
        py   = _to_pinyin(transcript)
        for orig, w, wpy in zip(self._orig_words, self._words_norm, self._words_py):
            if w and w in norm:
                return orig
            if wpy and wpy in py:
                return orig + f'(~{wpy})'
        return None

    async def wait(self, device: int | None = None, cooldown_sec: float = 3.0) -> None:
        """Block until a wake word is detected."""
        self._detected.clear()
        loop = asyncio.get_event_loop()
        # Reset silero-vad internal RNN state between turns; stale state causes
        # spurious 'speech' detections right after TTS playback.
        try:
            _vad().reset_states()
        except Exception:
            pass

        import time as _time
        start_at = _time.monotonic()

        silence_chunks_needed = SILENCE_END_MS  // CHUNK_MS
        min_speech_chunks     = MIN_SPEECH_MS   // CHUNK_MS
        min_voiced_chunks     = MIN_VOICED_MS   // CHUNK_MS
        max_speech_chunks     = MAX_SPEECH_MS   // CHUNK_MS

        buf: list[np.ndarray] = []
        silence_run  = 0
        in_speech    = False
        voiced_count = 0   # VAD-positive frames accumulated in current burst
        # queue of audio blobs ready for Whisper (processed on the asyncio loop)
        ready_q: asyncio.Queue[np.ndarray] = asyncio.Queue()

        def _emit_if_ok():
            nonlocal buf, in_speech, silence_run, voiced_count
            if len(buf) >= min_speech_chunks and voiced_count >= min_voiced_chunks:
                audio = np.concatenate(buf).astype(np.float32)
                loop.call_soon_threadsafe(ready_q.put_nowait, audio)
            buf          = []
            in_speech    = False
            silence_run  = 0
            voiced_count = 0

        def cb(indata: np.ndarray, frames, time, status):
            nonlocal silence_run, in_speech, buf, voiced_count
            if _time.monotonic() - start_at < cooldown_sec:
                return
            chunk = indata[:, 0].copy()
            is_sp = _is_speech(chunk)

            if is_sp:
                buf.append(chunk)
                voiced_count += 1
                silence_run   = 0
                in_speech     = True
                if len(buf) >= max_speech_chunks:
                    _emit_if_ok()
            elif in_speech:
                buf.append(chunk)
                silence_run += 1
                if silence_run >= silence_chunks_needed:
                    _emit_if_ok()

        stream = sd.InputStream(
            samplerate=SAMPLE_RATE, channels=1, dtype='float32',
            blocksize=CHUNK_SIZE, device=device, callback=cb,
        )
        stream.start()
        try:
            while not self._detected.is_set():
                audio = await ready_q.get()
                burst_rms    = float(np.sqrt(np.mean(audio ** 2)))
                burst_dur_ms = len(audio) / SAMPLE_RATE * 1000
                print(f'[wake] burst {burst_dur_ms:.0f}ms rms={burst_rms:.4f}')
                # Normalize loudness before ASR — same as main pipeline.
                # SenseVoice accuracy degrades on low-level audio (rms ~0.008).
                _TARGET_RMS = 0.05
                if burst_rms > 0.001:
                    audio_asr = np.clip(audio * (_TARGET_RMS / burst_rms), -1.0, 1.0)
                else:
                    audio_asr = audio
                text = await asr_mod.transcribe(audio_asr)
                if not text:
                    continue
                match = self._match(text)
                if match:
                    print(f'[wake] ✓ matched {match!r} in: {text!r}')
                    self._detected.set()
                else:
                    print(f'[wake] heard: {text!r}  (no match)')
        finally:
            stream.stop()
            stream.close()
