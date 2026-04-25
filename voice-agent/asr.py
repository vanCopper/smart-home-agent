"""ASR via mlx-whisper (Apple Silicon Metal GPU).

Two models are kept loaded:
  * main model  — high-quality model used for the user's actual utterance
  * wake model  — small fast model used by the wake-word detector on short bursts;
                  large-v3 is unstable on <1s clips, small is more reliable + faster
"""
import asyncio
import tempfile
import os
import numpy as np
import soundfile as sf
import mlx_whisper

_main_repo: str | None = None
_wake_repo: str | None = None


def init(model_repo: str, wake_model_repo: str | None = None) -> None:
    global _main_repo, _wake_repo
    _main_repo = model_repo
    _wake_repo = wake_model_repo or model_repo
    silent = np.zeros(8000, dtype=np.float32)
    _run(silent, _main_repo)
    if _wake_repo != _main_repo:
        _run(silent, _wake_repo)
    print(f'[asr] mlx-whisper ready  main={_main_repo}  wake={_wake_repo}')


def _run(audio: np.ndarray, repo: str, prompt: str | None = None,
         language: str | None = None) -> str:
    with tempfile.NamedTemporaryFile(suffix='.wav', delete=False) as f:
        path = f.name
    try:
        sf.write(path, audio, 16000)
        result = mlx_whisper.transcribe(
            path,
            path_or_hf_repo=repo,
            language=language,
            verbose=False,
            initial_prompt=prompt,
        )
        return (result.get('text') or '').strip()
    finally:
        os.unlink(path)


async def transcribe(audio: np.ndarray, prompt: str | None = None,
                     language: str | None = None) -> str:
    """Main-utterance transcription."""
    loop = asyncio.get_event_loop()
    return await loop.run_in_executor(None, _run, audio, _main_repo, prompt, language)


async def transcribe_wake(audio: np.ndarray, prompt: str | None = None,
                          language: str | None = None) -> str:
    """Wake-word burst transcription — uses the small/fast model."""
    loop = asyncio.get_event_loop()
    return await loop.run_in_executor(None, _run, audio, _wake_repo, prompt, language)
