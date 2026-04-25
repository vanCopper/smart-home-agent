"""ASR — two backends:

  * main:  FunASR SenseVoiceSmall  — Chinese-specialized, fast, accurate
           Trained specifically on Mandarin; far fewer character substitutions
           than Whisper on Chinese speech.

  * wake:  mlx-whisper small       — short-burst wake-word detection
           Stays on MLX/Metal; fast enough for <1s clips and already reliable
           for the limited wake-word vocabulary.
"""
import asyncio
import re
import tempfile
import os
import numpy as np
import soundfile as sf

# ── SenseVoice (main ASR) ────────────────────────────────────────────────────
# SenseVoice output includes language/emotion tags, e.g.:
#   "<|zh|><|NEUTRAL|><|Speech|><|withitn|>背首唐诗"
# Strip them before returning.
_TAG_RE = re.compile(r'<\|[^|]*\|>')

def _strip_tags(text: str) -> str:
    return _TAG_RE.sub('', text).strip()


_sense_model = None
_sense_repo: str = 'iic/SenseVoiceSmall'


def _load_sense(model_repo: str) -> None:
    global _sense_model, _sense_repo
    from funasr import AutoModel
    _sense_repo = model_repo
    print(f'[asr] loading SenseVoice: {model_repo}')
    _sense_model = AutoModel(
        model=model_repo,
        trust_remote_code=True,
        # 'mps' for Apple Silicon GPU; falls back to cpu if unsupported
        device='mps',
        disable_log=True,
        disable_pbar=True,
    )


def _run_sense(audio: np.ndarray) -> str:
    """Run SenseVoice inference on a float32 16 kHz mono array."""
    # FunASR AutoModel.generate() accepts (numpy_array, sample_rate) tuple
    # or a file path. Use tuple form to avoid disk I/O.
    results = _sense_model.generate(
        input=(audio, 16000),
        cache={},
        language='zh',
        use_itn=True,       # inverse text normalization: digits, punctuation
        batch_size_s=60,
    )
    if not results:
        return ''
    text = results[0].get('text', '') if isinstance(results[0], dict) else str(results[0])
    return _strip_tags(text)


# ── mlx-whisper (wake-word ASR) ──────────────────────────────────────────────
_wake_repo: str | None = None


def _run_whisper(audio: np.ndarray, repo: str,
                 prompt: str | None = None,
                 language: str | None = None) -> str:
    import mlx_whisper
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
            temperature=0.0,
        )
        return (result.get('text') or '').strip()
    finally:
        os.unlink(path)


# ── Public API ───────────────────────────────────────────────────────────────

def init(model_repo: str, wake_model_repo: str | None = None) -> None:
    """Load and warm up both models.

    model_repo      — SenseVoice model (e.g. 'iic/SenseVoiceSmall')
    wake_model_repo — mlx-whisper repo for wake-word detection
    """
    global _wake_repo
    _wake_repo = wake_model_repo or 'mlx-community/whisper-small-mlx'

    # Load SenseVoice + warm-up pass
    _load_sense(model_repo)
    silent = np.zeros(8000, dtype=np.float32)
    _run_sense(silent)

    # Warm up wake-word whisper
    _run_whisper(silent, _wake_repo)

    print(f'[asr] ready  main=SenseVoice({model_repo})  wake={_wake_repo}')


async def transcribe(audio: np.ndarray,
                     prompt: str | None = None,      # unused by SenseVoice
                     language: str | None = None,    # unused (always zh)
                     temperature: float = 0.0) -> str:  # unused
    """Main-utterance transcription via SenseVoice."""
    loop = asyncio.get_event_loop()
    return await loop.run_in_executor(None, _run_sense, audio)


async def transcribe_wake(audio: np.ndarray,
                          prompt: str | None = None,
                          language: str | None = None,
                          temperature: float = 0.0) -> str:
    """Wake-word burst transcription via mlx-whisper small."""
    loop = asyncio.get_event_loop()
    return await loop.run_in_executor(
        None, _run_whisper, audio, _wake_repo, prompt, language)
