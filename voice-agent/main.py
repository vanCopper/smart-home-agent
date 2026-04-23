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
from dotenv import load_dotenv

load_dotenv()

HUB_URL        = os.getenv('HUB_URL',        'http://127.0.0.1:3300')
OPENCLAW_SESSION = os.getenv('OPENCLAW_SESSION', 'agent:main:main')
WAKE_WORDS     = [w.strip() for w in os.getenv('WAKE_WORDS', '小管家,hey home').split(',')]
WHISPER_MODEL  = os.getenv('WHISPER_MODEL',  'mlx-community/whisper-large-v3-mlx')
TTS_MODEL      = os.getenv('TTS_MODEL',      'mlx-community/fishaudio-s2-pro-8bit-mlx')
REF_VOICE_PATH = os.getenv('REF_VOICE_PATH', '') or None
REF_VOICE_TEXT = os.getenv('REF_VOICE_TEXT', '') or None
MIC_DEVICE     = int(os.getenv('MIC_DEVICE_INDEX')) if os.getenv('MIC_DEVICE_INDEX') else None
VAD_SILENCE    = float(os.getenv('VAD_SILENCE_SEC', '0.8'))
MAX_RECORD     = float(os.getenv('MAX_RECORD_SEC',  '12'))

import asr as asr_mod
import tts as tts_mod
from wake_word       import WakeWordDetector
from recorder        import Recorder
from player          import AudioPlayer
from hub_client      import HubClient
from sentence_chunker import SentenceChunker


async def run_turn(hub: HubClient, recorder: Recorder, player: AudioPlayer) -> None:
    """Execute one full voice interaction turn."""
    # 1. Listening state
    await hub.voice_event('listening')

    # 2. Record
    print('[main] recording…')
    audio = await recorder.record_until_silence()

    # 3. ASR
    print('[main] transcribing…')
    text = await asr_mod.transcribe(audio)
    if not text:
        print('[main] empty transcript, aborting turn')
        await hub.voice_event('end')
        return
    print(f'[main] said: {text}')
    await hub.voice_event('said', text)

    # 4. Stream LLM reply, TTS sentence-by-sentence
    chunker = SentenceChunker()
    full_reply: list[str] = []

    async def tts_and_play(sentence: str) -> None:
        """Synthesize and play one sentence."""
        audio_arr = await tts_mod.synthesize(sentence)
        await player.play(audio_arr)

    pending_tts: asyncio.Task | None = None

    async def flush_sentence(sentence: str) -> None:
        nonlocal pending_tts
        full_reply.append(sentence)
        # Update iPad text immediately
        await hub.voice_event('reply', ' '.join(full_reply))
        # Wait for the previous sentence to finish playing, then start this one
        if pending_tts:
            await pending_tts
        pending_tts = asyncio.create_task(tts_and_play(sentence))

    print('[main] sending to LLM…')
    async for token in hub.send_to_llm(text, session_key=OPENCLAW_SESSION):
        for sentence in chunker.feed(token):
            await flush_sentence(sentence)

    # Flush any remaining partial sentence
    leftover = chunker.flush()
    if leftover:
        await flush_sentence(leftover)

    # Wait for the last TTS task to finish
    if pending_tts:
        await pending_tts

    await hub.voice_event('end')
    print('[main] turn complete')


async def main() -> None:
    print('[main] initialising models…')
    asr_mod.init(WHISPER_MODEL)
    tts_mod.init(TTS_MODEL, ref_audio_path=REF_VOICE_PATH, ref_text=REF_VOICE_TEXT)

    hub      = HubClient(HUB_URL)
    recorder = Recorder(silence_sec=VAD_SILENCE, max_sec=MAX_RECORD, device=MIC_DEVICE)
    player   = AudioPlayer(sample_rate=tts_mod.SAMPLE_RATE)
    detector = WakeWordDetector(wake_words=WAKE_WORDS)

    print(f'[main] ready — wake words: {WAKE_WORDS}')
    print('[main] say the wake word to start…\n')

    try:
        while True:
            await detector.wait(device=MIC_DEVICE)
            print('[main] wake word detected!')
            try:
                await run_turn(hub, recorder, player)
            except Exception as e:
                print(f'[main] turn error: {e}')
                await hub.voice_event('end')
    finally:
        await hub.close()


if __name__ == '__main__':
    asyncio.run(main())
