"""HTTP client for the smart-home-hub internal voice API."""
import json
import httpx

class HubClient:
    def __init__(self, base_url: str):
        self._base = base_url.rstrip('/')
        self._client = httpx.AsyncClient(timeout=60.0)

    async def voice_event(self, type_: str, text: str = '') -> None:
        try:
            await self._client.post(
                f'{self._base}/internal/voice/event',
                json={'type': type_, 'text': text},
            )
        except Exception as e:
            print(f'[hub] voice_event failed: {e}')

    async def send_to_llm(self, text: str, session_key: str = 'agent:main:main'):
        """Stream LLM reply tokens. Yields str chunks."""
        url = f'{self._base}/internal/voice/send'
        try:
            async with self._client.stream(
                'POST', url,
                json={'text': text, 'sessionKey': session_key},
                headers={'Accept': 'text/event-stream'},
            ) as resp:
                resp.raise_for_status()
                async for line in resp.aiter_lines():
                    if not line.startswith('data: '):
                        continue
                    try:
                        ev = json.loads(line[6:])
                    except json.JSONDecodeError:
                        continue
                    if ev.get('type') == 'delta':
                        yield ev.get('text', '')
                    elif ev.get('type') in ('done', 'error'):
                        return
        except Exception as e:
            print(f'[hub] send_to_llm error: {e}')

    async def close(self) -> None:
        await self._client.aclose()
