"""Record audio from USB mic until silence detected (silero-vad)."""
import asyncio
import numpy as np
import sounddevice as sd
import torch

SAMPLE_RATE = 16000
# silero-vad requires exactly 512 samples per chunk at 16kHz (32ms)
CHUNK_MS   = 32
CHUNK_SIZE = 512

_vad_model = None


def _vad():
    global _vad_model
    if _vad_model is None:
        print('[recorder] loading silero-vad…')
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


class Recorder:
    def __init__(self, silence_sec: float = 0.8, max_sec: float = 12,
                 device: int | None = None):
        self._silence_sec = silence_sec
        self._max_sec = max_sec
        self._device = device
        _vad()  # warm up

    async def record_until_silence(
        self,
        initial_timeout_sec: float | None = None,
    ) -> np.ndarray:
        """Record speech and stop after silence_sec of silence.

        Args:
          initial_timeout_sec: if given and no speech is detected within this
            many seconds of starting, return an empty array. None = wait
            indefinitely for the first speech burst.

        Returns a float32 mono array at SAMPLE_RATE (empty if timeout fired).
        """
        loop = asyncio.get_event_loop()
        # Reset silero-vad RNN state so we don't carry false-positive momentum
        # from a prior recording / TTS playback into this turn.
        try:
            _vad().reset_states()
        except Exception:
            pass
        frames: list[np.ndarray] = []
        done = asyncio.Event()
        timed_out = False

        silence_chunks_needed = int(self._silence_sec * 1000 / CHUNK_MS)
        max_chunks = int(self._max_sec * 1000 / CHUNK_MS)
        initial_chunks_max = (
            int(initial_timeout_sec * 1000 / CHUNK_MS) if initial_timeout_sec else None
        )
        # Require this many consecutive "speech" chunks before declaring
        # the user has actually started talking. Filters out single-frame
        # VAD blips on TTS tail / fan noise / breathing.
        START_DEBOUNCE  = 5   # ~160ms at 32ms/chunk
        # Pre-buffer is intentionally LARGER than START_DEBOUNCE so that when
        # debounce fires we still have audio from before the onset.
        # Without this, the ring shifts during the debounce window and the
        # first syllable is already gone by the time we commit.
        PRE_BUFFER_SIZE = 12  # ~384ms lookback (debounce=160ms + 224ms headroom)
        silence_count = 0
        total_chunks  = 0
        speech_run    = 0      # consecutive speech chunks pre-start
        speech_started = False
        pre_buffer: list[np.ndarray] = []

        def cb(indata: np.ndarray, *_):
            nonlocal silence_count, total_chunks, speech_started, speech_run, timed_out
            chunk = indata[:, 0].copy()
            is_sp = _is_speech(chunk)

            if not speech_started:
                if is_sp:
                    speech_run += 1
                else:
                    speech_run = 0
                pre_buffer.append(chunk)
                if len(pre_buffer) > PRE_BUFFER_SIZE:
                    pre_buffer.pop(0)
                if speech_run >= START_DEBOUNCE:
                    # Extra energy gate: VAD can fire on fan/AC noise.
                    # Require the pre_buffer to have real speech energy
                    # before committing to speech_started.
                    pre_rms = float(np.sqrt(np.mean(
                        np.concatenate(pre_buffer).astype(np.float32) ** 2
                    )))
                    if pre_rms >= 0.004:
                        speech_started = True
                        frames.extend(pre_buffer)
                        pre_buffer.clear()
                        silence_count = 0
                    else:
                        # Noise blip — reset debounce, keep listening
                        speech_run = 0
            else:
                if is_sp:
                    silence_count = 0
                else:
                    silence_count += 1
                frames.append(chunk)

            total_chunks += 1

            if (speech_started and silence_count >= silence_chunks_needed) \
                    or total_chunks >= max_chunks:
                loop.call_soon_threadsafe(done.set)
            elif (not speech_started
                  and initial_chunks_max is not None
                  and total_chunks >= initial_chunks_max):
                timed_out = True
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

        if timed_out or not frames:
            return np.zeros(0, dtype=np.float32)
        return np.concatenate(frames)
