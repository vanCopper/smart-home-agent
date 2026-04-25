"""Smart Home Voice Agent — main pipeline.

Pipeline per turn:
  1. Wake word detected
  2. Show "listening" on iPad
  3. Record until silence (silero-vad)
  4. ASR (mlx-whisper)
  5. Show "said" on iPad
  6. Stream LLM reply from OpenClaw via Node.js SSE proxy
  7. Per sentence: TTS → play audio + update "reply" on iPad
  8. Send "end" to iPad

Usage:
  cp .env.example .env   # fill in your config
  pip install -r requirements.txt
  python main.py
"""
import asyncio
import os
import numpy as np
from dotenv import load_dotenv

load_dotenv()

HUB_URL        = os.getenv('HUB_URL',        'http://127.0.0.1:3300')
OPENCLAW_SESSION = os.getenv('OPENCLAW_SESSION', 'agent:main:main')
WAKE_WORDS     = [w.strip() for w in os.getenv('WAKE_WORDS', '小管家,hey home').split(',')]
WHISPER_MODEL  = os.getenv('WHISPER_MODEL',  'mlx-community/whisper-large-v3-mlx')
WAKE_WHISPER   = os.getenv('WAKE_WHISPER_MODEL', 'mlx-community/whisper-small-mlx')
TTS_MODEL      = os.getenv('TTS_MODEL',      'mlx-community/IndexTTS')
REF_VOICE_PATH = os.getenv('REF_VOICE_PATH', '') or None
REF_VOICE_TEXT = os.getenv('REF_VOICE_TEXT', '') or None
MIC_DEVICE     = int(os.getenv('MIC_DEVICE_INDEX')) if os.getenv('MIC_DEVICE_INDEX') else None
VAD_SILENCE    = float(os.getenv('VAD_SILENCE_SEC', '0.8'))
MAX_RECORD     = float(os.getenv('MAX_RECORD_SEC',  '12'))
# After a turn finishes, stay listening (no wake word required) for this
# long; if no speech, fall back to wake-word state.
FOLLOWUP_SEC   = float(os.getenv('FOLLOWUP_SEC',   '5'))

import re as _re_main
import asr as asr_mod
import tts as tts_mod

# Whisper hallucinations seen on silence / very quiet audio. Any transcript
# matching one of these is treated as empty.
_HALLUCINATION_PATTERNS = [
    _re_main.compile(p) for p in [
        r'请不吝.*(点赞|订阅|转发|打赏|关注)',
        r'(明镜|点点)栏目',
        r'^字幕(由|.*提供|组|志愿者)',
        r'(谢谢|感谢)(大家)?(收看|观看|聆听)',
        r'^请(订阅|关注|点赞)',
        r'下期再见',
        r'^Thanks for watching',
        r'^Subscribe',
    ]
]


def _looks_like_hallucination(text: str) -> bool:
    s = text.strip()
    if not s:
        return True
    return any(p.search(s) for p in _HALLUCINATION_PATTERNS)
from wake_word       import WakeWordDetector
from recorder        import Recorder
from player          import AudioPlayer
from hub_client      import HubClient
from sentence_chunker import SentenceChunker


def _make_send_beep(sample_rate: int = 24000) -> np.ndarray:
    """Two-tone chirp signalling 'request forwarded to LLM'."""
    def tone(freq: float, dur: float, amp: float = 0.7) -> np.ndarray:
        t = np.linspace(0, dur, int(sample_rate * dur), endpoint=False)
        # Gentle attack + release so it sounds like a UI chime, not a click
        env = np.minimum(t * 80.0, 1.0) * np.exp(-t * 4.0)
        return (np.sin(2 * np.pi * freq * t) * env * amp).astype(np.float32)
    gap = np.zeros(int(sample_rate * 0.04), dtype=np.float32)
    return np.concatenate([tone(880, 0.14), gap, tone(1320, 0.18)])


async def run_turn(
    hub: HubClient,
    recorder: Recorder,
    player: AudioPlayer,
    ack_audio: np.ndarray | None,
    send_beep: np.ndarray,
    *,
    play_ack: bool = True,
    initial_timeout_sec: float | None = None,
) -> bool:
    """Execute one full voice interaction turn.

    Returns True if a turn was actually processed, False if the recorder
    timed out waiting for speech (caller should drop back to wake-word state).
    """
    # 1. Listening state + spoken ack (only on the first turn after wake)
    await hub.voice_event('listening')
    if play_ack and ack_audio is not None and len(ack_audio) > 0:
        await player.play(ack_audio)

    # 2. Record
    print(f'[main] recording…  (follow-up timeout={initial_timeout_sec}s)')
    audio = await recorder.record_until_silence(initial_timeout_sec=initial_timeout_sec)
    if audio.size == 0:
        print('[main] no speech in follow-up window, going back to wake mode')
        await hub.voice_event('end')
        return False

    # Energy / duration gate to prevent feeding noise-only bursts (TTS tail,
    # door slam, fan) to Whisper, which loves to hallucinate YouTube spam.
    dur_sec = audio.size / 16000
    rms = float(np.sqrt(np.mean(audio.astype(np.float32) ** 2)))
    print(f'[main] captured {dur_sec:.2f}s rms={rms:.4f}')
    if dur_sec < 0.5 or rms < 0.005:
        print('[main] audio too short/quiet, ignoring')
        await hub.voice_event('end')
        return False

    # 3. ASR — normalize loudness before sending to Whisper.
    # Mic input is often recorded at low levels (rms ~0.006); Whisper accuracy
    # degrades noticeably on quiet audio. Scale to a target RMS of 0.05 so the
    # model sees consistently loud speech regardless of hardware gain.
    _TARGET_RMS = 0.05
    if rms > 0.001:
        audio_asr = audio * (_TARGET_RMS / rms)
        audio_asr = np.clip(audio_asr, -1.0, 1.0)
    else:
        audio_asr = audio
    print('[main] transcribing…')
    # initial_prompt: prime Whisper with Chinese conversational context so it
    # prefers Mandarin vocabulary and punctuation over other languages.
    text = await asr_mod.transcribe(
        audio_asr, language='zh',
        prompt='以下是普通话日常对话。用户正在和智能家居语音助手说话。',
    )
    if not text or _looks_like_hallucination(text):
        if text:
            print(f'[main] dropping hallucinated transcript: {text!r}')
        else:
            print('[main] empty transcript, aborting turn')
        await hub.voice_event('end')
        # Treat as "no real speech" so caller decides whether to keep listening
        return False
    print(f'[main] said: {text}')
    await hub.voice_event('said', text)

    # 4. Stream LLM reply with pipelined TTS:
    #    LLM tokens → SentenceChunker → synth chain (sequential synth) →
    #    play queue → playback loop (sequential play).
    #    Decoupling synth from playback lets sentence N+1 synthesize while
    #    sentence N is still being played, eliminating the inter-sentence gap.
    chunker = SentenceChunker()
    full_reply: list[str] = []
    play_queue: asyncio.Queue = asyncio.Queue()
    _STOP = object()

    async def player_loop():
        while True:
            item = await play_queue.get()
            if item is _STOP:
                return
            audio_arr, label = item
            try:
                print(f'[main] playing: {label!r} samples={len(audio_arr)}')
                await player.play(audio_arr)
            except Exception as e:
                print(f'[main] playback error: {e}')

    player_task = asyncio.create_task(player_loop())

    synth_chain: asyncio.Task | None = None

    async def _synth_and_enqueue(sentence: str, prev: asyncio.Task | None):
        # Wait for the prior synth to finish so audio lands on the play queue
        # in order (TTS executor itself is single-threaded too).
        if prev is not None:
            try:
                await prev
            except Exception:
                pass
        print(f'[main] TTS synth start: {sentence!r}')
        try:
            audio_arr = await tts_mod.synthesize(sentence)
        except Exception as e:
            print(f'[main] TTS error: {e}')
            return
        await play_queue.put((audio_arr, sentence))

    async def flush_sentence(sentence: str) -> None:
        nonlocal synth_chain
        import re as _re
        sentence = _re.sub(r'(?i)\s*audio\s*reply\s*', '', sentence).strip()
        if not sentence:
            return
        print(f'[main] sentence: {sentence!r}')
        full_reply.append(sentence)
        await hub.voice_event('reply', ' '.join(full_reply))
        # Schedule synth immediately — it runs concurrently with any in-flight
        # playback. Order is preserved by chaining each new synth on the prev.
        prev = synth_chain
        synth_chain = asyncio.create_task(_synth_and_enqueue(sentence, prev))

    print('[main] sending to LLM…')
    await player.play(send_beep)
    token_count = 0
    async for token in hub.send_to_llm(text, session_key=OPENCLAW_SESSION):
        token_count += 1
        if token_count == 1:
            print(f'[main] first token: {token!r}')
        for sentence in chunker.feed(token):
            await flush_sentence(sentence)
    print(f'[main] LLM stream done, {token_count} tokens')

    leftover = chunker.flush()
    if leftover:
        await flush_sentence(leftover)

    # Wait for all synth to finish, then stop the player loop after queue drains
    if synth_chain:
        try:
            await synth_chain
        except Exception:
            pass
    await play_queue.put(_STOP)
    await player_task

    await hub.voice_event('end')
    print('[main] turn complete')
    return True


async def main() -> None:
    print('[main] initialising models…')
    asr_mod.init(WHISPER_MODEL, wake_model_repo=WAKE_WHISPER)
    tts_mod.init(TTS_MODEL, ref_audio_path=REF_VOICE_PATH, ref_text=REF_VOICE_TEXT)

    hub      = HubClient(HUB_URL)
    recorder = Recorder(silence_sec=VAD_SILENCE, max_sec=MAX_RECORD, device=MIC_DEVICE)
    player   = AudioPlayer(sample_rate=tts_mod.SAMPLE_RATE)
    detector = WakeWordDetector(wake_words=WAKE_WORDS)

    # Pre-synthesize the wake-ack audio once (cloned voice). Skip on failure.
    ack_audio: np.ndarray | None = None
    try:
        print('[main] pre-synthesizing wake ack…')
        ack_audio = await tts_mod.synthesize('我在。')
        print(f'[main] wake ack ready  samples={len(ack_audio)}')
    except Exception as e:
        print(f'[main] wake ack synth failed, skipping: {e}')

    send_beep = _make_send_beep(tts_mod.SAMPLE_RATE)

    print(f'[main] ready — wake words: {WAKE_WORDS}')
    print('[main] say the wake word to start…\n')

    try:
        while True:
            await detector.wait(device=MIC_DEVICE)
            print('[main] wake word detected!')
            first_turn = True
            while True:
                try:
                    processed = await run_turn(
                        hub, recorder, player, ack_audio, send_beep,
                        play_ack=first_turn,
                        initial_timeout_sec=None if first_turn else FOLLOWUP_SEC,
                    )
                except Exception as e:
                    print(f'[main] turn error: {e}')
                    await hub.voice_event('end')
                    break
                if not processed:
                    break  # follow-up window expired → back to wake word
                first_turn = False
    finally:
        await hub.close()


if __name__ == '__main__':
    asyncio.run(main())
