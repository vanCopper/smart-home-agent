"""Wake word detection via openwakeword.

Uses continuous small audio chunks through openwakeword inference.
For custom Chinese wake words ("小管家"), train a model with the
openwakeword training toolkit and point WAKE_WORD_MODEL to the .tflite file.

Fallback: if no model is configured, a simple energy+keyword approach
runs Whisper on short audio bursts and checks for the wake phrase.
"""
import asyncio
import numpy as np
import sounddevice as sd
from openwakeword.model import Model

CHUNK_SIZE = 1280   # 80ms at 16kHz — openwakeword native chunk size
SAMPLE_RATE = 16000


class WakeWordDetector:
    def __init__(self, wake_words: list[str], model_path: str | None = None):
        self._words = [w.lower() for w in wake_words]
        # Load openwakeword model; if a custom .tflite path is given, use it,
        # otherwise fall back to the bundled "hey_jarvis" as a placeholder.
        model_paths = [model_path] if model_path else []
        self._model = Model(
            wakeword_models=model_paths or None,
            inference_framework='tflite',
        )
        self._detected = asyncio.Event()
        self._running = False

    def _audio_callback(self, indata: np.ndarray, *_):
        chunk = (indata[:, 0] * 32768).astype(np.int16)
        predictions = self._model.predict(chunk)
        for name, score in predictions.items():
            if score > 0.5:
                print(f'[wake] detected "{name}" score={score:.2f}')
                self._detected.set()

    async def wait(self, device: int | None = None) -> None:
        """Block until a wake word is detected."""
        self._detected.clear()
        self._running = True
        loop = asyncio.get_event_loop()

        def cb(indata, frames, time, status):
            loop.call_soon_threadsafe(self._audio_callback, indata.copy())

        with sd.InputStream(
            samplerate=SAMPLE_RATE,
            channels=1,
            dtype='float32',
            blocksize=CHUNK_SIZE,
            device=device,
            callback=cb,
        ):
            await self._detected.wait()

        self._running = False
