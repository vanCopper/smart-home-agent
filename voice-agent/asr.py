"""ASR via mlx-whisper (Apple Silicon Metal GPU)."""
import tempfile
import os
import numpy as np
import soundfile as sf
import mlx_whisper

_model_repo: str | None = None


def init(model_repo: str) -> None:
    global _model_repo
    _model_repo = model_repo
    # Warm-up: transcribe a silent half-second so the model is loaded
    silent = np.zeros(8000, dtype=np.float32)
    _transcribe(silent)
    print(f'[asr] mlx-whisper ready  model={model_repo}')


def _transcribe(audio: np.ndarray) -> str:
    # mlx_whisper.transcribe accepts a file path or numpy array
    with tempfile.NamedTemporaryFile(suffix='.wav', delete=False) as f:
        path = f.name
    try:
        sf.write(path, audio, 16000)
        result = mlx_whisper.transcribe(
            path,
            path_or_hf_repo=_model_repo,
            language=None,      # auto-detect Chinese / English
            verbose=False,
        )
        return (result.get('text') or '').strip()
    finally:
        os.unlink(path)


async def transcribe(audio: np.ndarray) -> str:
    """Run Whisper transcription (CPU/GPU bound — runs in executor)."""
    import asyncio
    loop = asyncio.get_event_loop()
    return await loop.run_in_executor(None, _transcribe, audio)
