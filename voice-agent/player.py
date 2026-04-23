"""Audio playback via sounddevice."""
import asyncio
import numpy as np
import sounddevice as sd


class AudioPlayer:
    def __init__(self, sample_rate: int = 24000, device: int | None = None):
        self._rate   = sample_rate
        self._device = device

    async def play(self, audio: np.ndarray) -> None:
        """Play a float32 PCM array, blocking until playback finishes."""
        loop = asyncio.get_event_loop()
        await loop.run_in_executor(None, self._play_sync, audio)

    def _play_sync(self, audio: np.ndarray) -> None:
        sd.play(audio, samplerate=self._rate, device=self._device)
        sd.wait()

    def stop(self) -> None:
        sd.stop()
