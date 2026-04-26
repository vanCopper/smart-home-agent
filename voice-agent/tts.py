"""TTS via CosyVoice2 — Chinese-optimized, streaming, voice cloning.

Installation (one-time):
    git clone --recursive https://github.com/FunAudioLLM/CosyVoice.git
    cd CosyVoice && pip install -e .
    pip install modelscope torchaudio
    # Model (~1.8 GB) downloads automatically on first init.

Config (.env):
    TTS_MODEL=iic/CosyVoice2-0.5B
    REF_VOICE_PATH=ref_voices/my_voice.wav   # 3–30s, any sample rate (auto-resampled)
    REF_VOICE_TEXT=参考音频的转录文字

Key improvement over F5-TTS:
    * Streaming inference: first audio chunk ready in ~300ms instead of ~2s
    * Chinese-specialized model, more natural prosody
    * Simpler threading model (PyTorch/MPS, no MLX thread locality issue)
"""
import asyncio
import os
import re
import numpy as np
import soundfile as sf
import torch

SAMPLE_RATE = 22050   # CosyVoice2 output sample rate

_model          = None
_ref_audio_path = None  # absolute path to reference wav (passed to CosyVoice2 directly)
_ref_text       = ''
_inited         = False

_CLEAN_RE = re.compile(
    r'[^\u4e00-\u9fff'
    r'a-zA-Z0-9'
    r'\s'
    r'，。！？、；：,.!?;:'
    r'\-_()（）""\'\'""]'
)

def _sanitize(text: str) -> str:
    text = _CLEAN_RE.sub(' ', text)
    return re.sub(r'\s+', ' ', text).strip()


class _OnnxEstimator(torch.nn.Module):
    """Drop-in replacement for the PyTorch flow-decoder estimator.

    Runs the ONNX model via onnxruntime CoreML EP (Apple Silicon) or CPU EP.
    Must be a torch.nn.Module so CosyVoice2 can assign it as a submodule.
    """
    def __init__(self, onnx_path: str):
        super().__init__()
        import onnxruntime as ort
        # Use CPU EP only — CoreML has too much per-call overhead for small batches
        ep_list = ['CPUExecutionProvider']
        # Store as plain attribute (not nn.Parameter) to avoid torch registration
        object.__setattr__(self, '_sess', ort.InferenceSession(onnx_path, providers=ep_list))
        object.__setattr__(self, '_ep', ep_list[0])
        print(f'[tts] onnx estimator loaded  ep={ep_list[0]}')

    def forward(self, x, mask, mu, t, spks, cond, **kwargs):
        def to_np(v):
            v = v.detach().float()
            return v.cpu().numpy() if v.device.type != 'cpu' else v.numpy()
        out = object.__getattribute__(self, '_sess').run(
            ['estimator_out'],
            {'x': to_np(x), 'mask': to_np(mask), 'mu': to_np(mu),
             't': to_np(t), 'spks': to_np(spks), 'cond': to_np(cond)}
        )[0]
        return torch.from_numpy(out).to(x.device)


def _try_install_onnx_estimator(cosyvoice_model, model_repo: str) -> None:
    """Try to replace the PyTorch flow estimator with a faster onnxruntime one."""
    import importlib, os
    try:
        import onnxruntime  # noqa: F401
    except ImportError:
        print('[tts] onnxruntime not found, skipping ONNX estimator')
        return

    # Locate onnx model — modelscope caches to ~/.cache/modelscope/hub/<repo>
    repo_dir = os.path.join(
        os.path.expanduser('~/.cache/modelscope/hub'),
        model_repo.replace('/', os.sep),
    )
    onnx_path = os.path.join(repo_dir, 'flow.decoder.estimator.fp32.onnx')
    if not os.path.exists(onnx_path):
        print(f'[tts] ONNX estimator not found at {onnx_path}, using PyTorch')
        return

    try:
        onnx_est = _OnnxEstimator(onnx_path)
        # The estimator lives at model.model.flow.decoder.estimator
        cosyvoice_model.model.flow.decoder.estimator = onnx_est
        print('[tts] ONNX estimator installed')
    except Exception as e:
        print(f'[tts] ONNX estimator install failed ({e}), using PyTorch')


def init(model_repo: str,
         ref_audio_path: str | None = None,
         ref_text: str | None = None) -> None:
    global _model, _ref_audio_path, _ref_text, _inited

    if not ref_audio_path or not os.path.exists(ref_audio_path):
        raise RuntimeError(
            f'CosyVoice2 requires REF_VOICE_PATH (any sample-rate mono/stereo wav). '
            f'Got: {ref_audio_path!r}')
    if not ref_text:
        raise RuntimeError('CosyVoice2 requires REF_VOICE_TEXT.')

    print(f'[tts] loading CosyVoice2: {model_repo}')
    from cosyvoice.cli.cosyvoice import CosyVoice2 as _CV2
    _model = _CV2(model_repo, load_jit=False, load_trt=False)

    # ONNX estimator benchmarked: PyTorch outperforms both ONNX-CPU and
    # ONNX-CoreML on Apple Silicon for this model — leave disabled.
    # _try_install_onnx_estimator(_model, model_repo)

    # Store the absolute path — CosyVoice2 loads it internally via load_wav()
    # which handles resampling to both 16 kHz (speaker embedding) and 24 kHz (feat).
    _ref_audio_path = os.path.abspath(ref_audio_path)
    _ref_text       = ref_text
    _inited         = True

    # Print duration from file header
    audio_np, sr = sf.read(_ref_audio_path)
    dur = len(audio_np) / sr
    print(f'[tts] CosyVoice2 ready  ref_dur={dur:.2f}s  model={model_repo}')


def _iter_chunks(text: str):
    """Synchronous generator: run CosyVoice2 zero-shot, yield float32 numpy chunks."""
    import time as _t
    t0 = _t.monotonic()
    first = True
    total = 0
    for chunk in _model.inference_zero_shot(
        text, _ref_text, _ref_audio_path, stream=True
    ):
        audio = chunk['tts_speech']
        if hasattr(audio, 'numpy'):
            audio = audio.numpy()
        audio = audio.flatten().astype(np.float32)
        if first:
            print(f'[tts] first chunk in {_t.monotonic()-t0:.2f}s  '
                  f'samples={len(audio)}')
            first = False
        total += len(audio)
        yield audio
    dur = total / SAMPLE_RATE
    dt  = _t.monotonic() - t0
    print(f'[tts] {dur:.2f}s audio  total={dt:.2f}s  rtf={dt/max(dur,1e-3):.2f}')


async def synthesize_stream(text: str):
    """Async generator: yield audio chunks as CosyVoice2 streams them.

    The synthesis runs in a thread-pool thread; chunks arrive on an asyncio
    Queue so the caller can play them without blocking the event loop.
    """
    if not _inited:
        yield np.zeros(int(SAMPLE_RATE * 0.1), dtype=np.float32)
        return

    clean = _sanitize(text)
    if not clean:
        return

    loop  = asyncio.get_running_loop()
    queue: asyncio.Queue[np.ndarray | None] = asyncio.Queue()

    def _run() -> None:
        try:
            for chunk in _iter_chunks(clean):
                loop.call_soon_threadsafe(queue.put_nowait, chunk)
        except Exception as e:
            print(f'[tts] synthesis error: {e}')
        finally:
            loop.call_soon_threadsafe(queue.put_nowait, None)   # sentinel

    # Fire-and-forget into the default thread pool; chunks arrive via queue.
    loop.run_in_executor(None, _run)

    while True:
        chunk = await queue.get()
        if chunk is None:
            break
        yield chunk


async def synthesize(text: str) -> np.ndarray:
    """Full-sentence synthesis — collects all streaming chunks (compatibility API)."""
    chunks = []
    async for chunk in synthesize_stream(text):
        chunks.append(chunk)
    if not chunks:
        return np.zeros(int(SAMPLE_RATE * 0.1), dtype=np.float32)
    audio = np.concatenate(chunks)
    peak = float(np.abs(audio).max())
    if peak > 0.95:
        audio = audio / peak * 0.9
    return audio
