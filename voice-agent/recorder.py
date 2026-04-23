"""Record audio from USB mic until silence detected (silero-vad)."""
import asyncio
import numpy as np
import sounddevice as sd
import torch

SAMPLE_RATE = 16000
CHUNK_MS    = 96       # silero-vad works best with 32/64/96ms chunks at 16kHz
CHUNK_SIZE  = int(SAMPLE_RATE * CHUNK_MS / 1000)


def _load_vad():
    model, utils = torch.hub.load(
        repo_or_dir='snakers4/silero-vad',
        model='silero_vad',
        force_reload=False,
        trust_repo=True,
    )
    (get_speech_timestamps, _, _, _, _) = utils
    return model, get_speech_timestamps


_vad_model = None
_get_ts = None

def _vad():
    global _vad_model, _get_ts
    if _vad_model is None:
        print('[recorder] loading silero-vad…')
        _vad_model, _get_ts = _load_vad()
    return _vad_model


def _is_speech(chunk: np.ndarray) -> bool:
    t = torch.from_numpy(chunk.astype(np.float32))
    conf = _vad().audio_forward(t, sr=SAMPLE_RATE)
    return float(conf) > 0.5


class Recorder:
    def __init__(self, silence_sec: float = 0.8, max_sec: float = 12,
                 device: int | None = None):
        self._silence_sec = silence_sec
        self._max_sec = max_sec
        self._device = device
        _vad()  # warm up

    async def record_until_silence(self) -> np.ndarray:
        """Record speech and stop after silence_sec of silence.

        Returns a float32 mono array at SAMPLE_RATE.
        """
        loop = asyncio.get_event_loop()
        frames: list[np.ndarray] = []
        done = asyncio.Event()

        silence_chunks_needed = int(self._silence_sec * 1000 / CHUNK_MS)
        max_chunks = int(self._max_sec * 1000 / CHUNK_MS)
        silence_count = 0
        total_chunks  = 0
        speech_started = False

        def cb(indata: np.ndarray, *_):
            nonlocal silence_count, total_chunks, speech_started
            chunk = indata[:, 0].copy()
            is_sp = _is_speech(chunk)

            if is_sp:
                speech_started = True
                silence_count = 0
            elif speech_started:
                silence_count += 1

            frames.append(chunk)
            total_chunks += 1

            if (speech_started and silence_count >= silence_chunks_needed) \
                    or total_chunks >= max_chunks:
                loop.call_soon_threadsafe(done.set)

        with sd.InputStream(
            samplerate=SAMPLE_RATE,
            channels=1,
            dtype='float32',
            blocksize=CHUNK_SIZE,
            device=self._device,
            callback=cb,
        ):
            await done.wait()

        audio = np.concatenate(frames) if frames else np.zeros(SAMPLE_RATE, dtype=np.float32)
        return audio
