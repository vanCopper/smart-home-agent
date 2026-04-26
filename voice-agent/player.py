"""Audio playback via sounddevice — continuous stream to avoid pops.

Uses a single persistent OutputStream so there is no stop/start gap between
chunks.  Each chunk gets a short fade-in and fade-out (5 ms) to eliminate the
click that occurs when the waveform jumps abruptly at a boundary.

The stream is opened lazily on first play() and stays open for the lifetime of
the process.  stop() drains the remaining samples, then closes the stream so
the next call re-opens it fresh (used after each turn to reset state).
"""
import asyncio
import threading
import numpy as np
import sounddevice as sd

_FADE_MS = 5   # ms of fade-in / fade-out per chunk


class AudioPlayer:
    def __init__(self, sample_rate: int = 24000, device: int | None = None):
        self._rate    = sample_rate
        self._device  = device
        self._stream: sd.OutputStream | None = None
        self._lock    = threading.Lock()

    # ------------------------------------------------------------------
    # Public API
    # ------------------------------------------------------------------

    async def play(self, audio: np.ndarray) -> None:
        """Write audio to the output stream (blocks until data is consumed)."""
        loop = asyncio.get_event_loop()
        await loop.run_in_executor(None, self._play_sync, audio)

    def stop(self) -> None:
        """Drain remaining samples and close the stream."""
        with self._lock:
            if self._stream is not None:
                try:
                    # Write a short silence so the stream drains cleanly
                    silence = np.zeros(int(self._rate * 0.05), dtype=np.float32)
                    self._stream.write(silence.reshape(-1, 1))
                    self._stream.stop()
                    self._stream.close()
                except Exception:
                    pass
                self._stream = None

    # ------------------------------------------------------------------
    # Internal
    # ------------------------------------------------------------------

    def _ensure_stream(self) -> sd.OutputStream:
        if self._stream is None or not self._stream.active:
            stream = sd.OutputStream(
                samplerate=self._rate,
                channels=1,
                dtype='float32',
                device=self._device,
                latency='low',
            )
            stream.start()
            self._stream = stream
        return self._stream

    def _play_sync(self, audio: np.ndarray) -> None:
        audio = np.asarray(audio, dtype=np.float32).ravel()
        if len(audio) == 0:
            return

        # Apply fade-in / fade-out to smooth chunk boundaries
        fade_samples = min(int(self._rate * _FADE_MS / 1000), len(audio) // 4)
        if fade_samples > 1:
            fade = np.linspace(0.0, 1.0, fade_samples, dtype=np.float32)
            audio = audio.copy()
            audio[:fade_samples]  *= fade
            audio[-fade_samples:] *= fade[::-1]

        with self._lock:
            stream = self._ensure_stream()
            # write() blocks until the data fits in the device buffer — this
            # gives natural back-pressure so we never get ahead of playback.
            stream.write(audio.reshape(-1, 1))
