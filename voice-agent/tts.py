"""TTS via f5-tts-mlx (local, Apple Silicon, voice cloning).

Speed-optimized wrapper:
  * Loads F5TTS once at init (the bundled `generate()` reloads on every call!)
  * Caches the reference audio as an mx.array (RMS-normalized)
  * Calls f5tts.sample() directly — no wav round-trip
  * Defaults to `steps=8, method='euler'` (vs original rk4×8 = 32 NFE)
"""
import asyncio
import os
import re
import numpy as np
import soundfile as sf

# --- Compatibility shim ----------------------------------------------------
# f5-tts-mlx 0.2.x passes `scale` as an mx.array (1/mx.sqrt(dim_head)) into
# mx.fast.scaled_dot_product_attention, but newer MLX (>=0.31) rejects that
# and demands a Python float.
def _patch_mlx_sdpa() -> None:
    try:
        import mlx.core as _mx
    except Exception:
        return
    fast = getattr(_mx, 'fast', None)
    if fast is None:
        return
    orig = getattr(fast, 'scaled_dot_product_attention', None)
    if orig is None or getattr(orig, '_voice_agent_patched', False):
        return

    def _sdpa(*args, scale=None, **kw):
        if scale is not None and not isinstance(scale, (int, float)):
            try:
                scale = float(scale)
            except Exception:
                pass
        return orig(*args, scale=scale, **kw)

    _sdpa._voice_agent_patched = True
    fast.scaled_dot_product_attention = _sdpa

_patch_mlx_sdpa()
# ---------------------------------------------------------------------------

SAMPLE_RATE = 24000
HOP_LENGTH  = 256
TARGET_RMS  = 0.1

_inited        = False
_f5tts         = None
_executor      = None   # dedicated single-thread executor (MLX is thread-local)
_ref_audio_mx  = None   # mx.array [T]
_ref_audio_len = 0
_ref_text: str = ''

# Speed knobs (overridable via env):
_STEPS  = int(os.getenv('F5_STEPS', '8'))
_METHOD = os.getenv('F5_METHOD', 'euler')   # euler|midpoint|rk4
_QBITS  = os.getenv('F5_QUANT_BITS')        # '4'|'8'|None

_CLEAN_RE = re.compile(
    r'[^\u4e00-\u9fff'
    r'a-zA-Z0-9'
    r'\s'
    r'，。！？、；：,.!?;:'
    r'\-_()（）""\'\'""]'
)
_MD_RE = re.compile(r'\*{1,3}(.+?)\*{1,3}')
_EMOJI_RE = re.compile(
    u'[\U00010000-\U0010ffff'
    u'\U0001F300-\U0001F9FF'
    u'\u2600-\u27BF'
    u'\uFE00-\uFE0F'
    u']', flags=re.UNICODE)


def _sanitize(text: str) -> str:
    text = _MD_RE.sub(r'\1', text)
    text = _EMOJI_RE.sub('', text)
    text = _CLEAN_RE.sub('', text)
    return re.sub(r'\s+', ' ', text).strip()


def _estimated_duration_frames(gen_text: str, speed: float = 1.0) -> int:
    zh_pause = r'。，、；：？！'
    ref_len = len(_ref_text.encode('utf-8')) + 3 * len(re.findall(zh_pause, _ref_text))
    gen_len = len(gen_text.encode('utf-8')) + 3 * len(re.findall(zh_pause, gen_text))
    if ref_len == 0:
        ref_len = 1
    ref_audio_frames = _ref_audio_len // HOP_LENGTH
    return ref_audio_frames + int(ref_audio_frames / ref_len * gen_len / speed)


def init(model_repo: str,
         ref_audio_path: str | None = None,
         ref_text: str | None = None) -> None:
    global _inited, _f5tts, _ref_audio_mx, _ref_audio_len, _ref_text, _executor

    if not ref_audio_path or not os.path.exists(ref_audio_path):
        raise RuntimeError(f'F5-TTS requires REF_VOICE_PATH. Got: {ref_audio_path!r}')
    if not ref_text:
        raise RuntimeError('F5-TTS requires REF_VOICE_TEXT.')

    print(f'[tts] loading f5-tts-mlx  ref={ref_audio_path}  steps={_STEPS}  method={_METHOD}  q={_QBITS}')

    # All MLX operations must run on the same thread (MLX streams are thread-local).
    from concurrent.futures import ThreadPoolExecutor
    _executor = ThreadPoolExecutor(max_workers=1, thread_name_prefix='f5tts')

    def _load():
        global _f5tts, _ref_audio_mx, _ref_audio_len, _ref_text
        import mlx.core as mx
        from f5_tts_mlx.cfm import F5TTS

        qbits = int(_QBITS) if _QBITS else None
        _f5tts = F5TTS.from_pretrained(
            model_repo or 'lucasnewman/f5-tts-mlx',
            quantization_bits=qbits,
        )

        # Coerce any mx.array _scale_factor to Python float (belt-and-suspenders)
        def _coerce(obj, seen=None):
            if seen is None:
                seen = set()
            if id(obj) in seen:
                return
            seen.add(id(obj))
            sf_attr = getattr(obj, '_scale_factor', None)
            if sf_attr is not None and not isinstance(sf_attr, (int, float)):
                try:
                    obj._scale_factor = float(sf_attr)
                except Exception:
                    pass
            for v in list((getattr(obj, '__dict__', None) or {}).values()):
                if hasattr(v, '_scale_factor') or hasattr(v, '__dict__'):
                    _coerce(v, seen)
        _coerce(_f5tts)

        audio_np, sr = sf.read(ref_audio_path)
        if sr != SAMPLE_RATE:
            # Auto-resample to 24 kHz
            import torchaudio, torch
            t = torch.from_numpy(audio_np.mean(axis=1) if audio_np.ndim > 1 else audio_np)
            t = torchaudio.functional.resample(t.unsqueeze(0), sr, SAMPLE_RATE).squeeze(0)
            audio_np = t.numpy().astype(np.float32)
        else:
            if audio_np.ndim > 1:
                audio_np = audio_np.mean(axis=1)
            audio_np = audio_np.astype(np.float32)

        a = mx.array(audio_np)
        rms = mx.sqrt(mx.mean(mx.square(a)))
        if rms < TARGET_RMS:
            a = a * TARGET_RMS / rms
        mx.eval(a)
        _ref_audio_mx  = a
        _ref_audio_len = audio_np.shape[0]
        _ref_text      = ref_text

    _executor.submit(_load).result()
    _inited = True
    print(f'[tts] f5-tts-mlx ready  ref_dur={_ref_audio_len/SAMPLE_RATE:.2f}s')


def _synthesize_sync(text: str) -> np.ndarray:
    if not _inited:
        return np.zeros(int(SAMPLE_RATE * 0.2), dtype=np.float32)

    clean = _sanitize(text)
    if not clean:
        return np.zeros(int(SAMPLE_RATE * 0.2), dtype=np.float32)

    import mlx.core as mx
    from f5_tts_mlx.utils import convert_char_to_pinyin
    import time as _t

    duration   = _estimated_duration_frames(clean)
    pinyin     = convert_char_to_pinyin([_ref_text + ' ' + clean])

    use_steps  = _STEPS
    use_method = _METHOD
    visible    = re.sub(r'[\s\W_]+', '', clean)
    if len(visible) <= 3:
        use_steps  = max(use_steps, 16)
        use_method = 'rk4'

    t0 = _t.monotonic()
    wave, _ = _f5tts.sample(
        mx.expand_dims(_ref_audio_mx, axis=0),
        text=pinyin,
        duration=duration,
        steps=use_steps,
        method=use_method,
        speed=1.0,
        cfg_strength=2.0,
        sway_sampling_coef=-1.0,
        seed=None,
    )
    wave = wave[_ref_audio_len:]
    mx.eval(wave)
    audio = np.array(wave, copy=False, dtype=np.float32)

    dt      = _t.monotonic() - t0
    gen_dur = audio.shape[0] / SAMPLE_RATE
    print(f'[tts] {gen_dur:.2f}s audio in {dt:.2f}s  rtf={dt/max(gen_dur,1e-3):.2f}')

    peak = float(np.abs(audio).max()) if audio.size else 0.0
    if peak > 0.95:
        audio = audio / peak * 0.9
    return audio


async def synthesize(text: str) -> np.ndarray:
    """Full synthesis — returns complete audio array."""
    loop = asyncio.get_event_loop()
    return await loop.run_in_executor(_executor, _synthesize_sync, text)


async def synthesize_stream(text: str):
    """Async generator interface (F5-TTS generates all at once, yields single chunk)."""
    audio = await synthesize(text)
    if audio.size > 0:
        yield audio
