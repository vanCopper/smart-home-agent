"""TTS via mlx-audio Fish Speech S2 Pro (local, Apple Silicon).

Model: mlx-community/fishaudio-s2-pro-8bit-mlx
Voice cloning: supply a reference WAV + transcript text.

mlx-audio exposes a generate() function; this wrapper caches the loaded
model and handles async dispatch so the pipeline stays non-blocking.

Install: pip install mlx-audio soundfile
"""
import asyncio
import os
import numpy as np

_pipeline = None
_ref_audio_path: str | None = None
_ref_text: str | None = None


def init(model_repo: str, ref_audio_path: str | None = None, ref_text: str | None = None) -> None:
    global _pipeline, _ref_audio_path, _ref_text
    _ref_audio_path = ref_audio_path or None
    _ref_text = ref_text or None

    print(f'[tts] loading Fish Speech S2 Pro  model={model_repo}')
    # mlx-audio pipeline API — loads model weights into Metal memory
    import mlx_audio
    _pipeline = mlx_audio.load(model_repo)
    print('[tts] Fish Speech ready')


def _synthesize(text: str) -> np.ndarray:
    """Return float32 PCM array (24kHz mono)."""
    kwargs: dict = {}
    if _ref_audio_path and os.path.exists(_ref_audio_path):
        kwargs['ref_audio'] = _ref_audio_path
    if _ref_text:
        kwargs['ref_text'] = _ref_text

    audio = _pipeline.generate(text, **kwargs)

    # mlx-audio may return an mlx array or numpy array; normalise
    if hasattr(audio, 'tolist') and not isinstance(audio, np.ndarray):
        import mlx.core as mx
        audio = np.array(mx.eval(audio), dtype=np.float32)
    else:
        audio = np.asarray(audio, dtype=np.float32)

    # Normalise to [-1, 1]
    peak = np.abs(audio).max()
    if peak > 0:
        audio = audio / peak * 0.9
    return audio


async def synthesize(text: str) -> np.ndarray:
    """Non-blocking TTS synthesis — dispatched to thread executor."""
    loop = asyncio.get_event_loop()
    return await loop.run_in_executor(None, _synthesize, text)


# Sample rate Fish Speech S2 Pro outputs at
SAMPLE_RATE = 24000
