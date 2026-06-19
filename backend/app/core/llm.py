"""LLM providers — async clients for QA generation, the LLM-as-judge, and chat.

A small provider registry: ``get_llm(provider, model, api_key)`` returns an adapter
exposing a common interface (``chat`` / ``extract`` / ``stream_chat``). Called with
no arguments it returns the default server-configured Groq provider (env key).
User-supplied keys are passed per request and are NEVER stored or logged.
"""

from dataclasses import dataclass
from typing import AsyncIterator

from app.core.config import get_settings
from app.core.logging import get_logger

logger = get_logger(__name__)


@dataclass
class Usage:
    prompt_tokens: int = 0
    completion_tokens: int = 0


@dataclass
class LLMResult:
    content: str
    usage: Usage


def _split_system(messages: list[dict]) -> tuple[str, list[dict]]:
    """Anthropic wants the system prompt separate from the user/assistant turns."""
    system = "\n\n".join(m["content"] for m in messages if m.get("role") == "system")
    convo = [m for m in messages if m.get("role") != "system"]
    return system, convo


class GroqProvider:
    """Groq — fast inference on open-weight models (Llama 3.x, etc.)."""

    name = "groq"

    def __init__(self, api_key: str, model: str) -> None:
        import groq

        # max_retries lets the SDK ride out transient 429s (per-minute limits).
        self.client = groq.AsyncGroq(api_key=api_key, max_retries=6)
        self.model = model

    @staticmethod
    def _usage(response) -> Usage:
        u = getattr(response, "usage", None)
        if u is None:
            return Usage()
        return Usage(getattr(u, "prompt_tokens", 0) or 0, getattr(u, "completion_tokens", 0) or 0)

    async def chat(self, messages: list[dict], temperature: float = 0.7) -> LLMResult:
        r = await self.client.chat.completions.create(
            model=self.model, messages=messages, temperature=temperature
        )
        return LLMResult((r.choices[0].message.content or "").strip(), self._usage(r))

    async def extract(self, system_prompt: str, user_input: str) -> LLMResult:
        r = await self.client.chat.completions.create(
            model=self.model,
            messages=[
                {"role": "system", "content": system_prompt},
                {"role": "user", "content": user_input},
            ],
            temperature=0.0,
        )
        return LLMResult((r.choices[0].message.content or "").strip(), self._usage(r))

    async def stream_chat(self, messages: list[dict], temperature: float = 0.7) -> AsyncIterator[str]:
        stream = await self.client.chat.completions.create(
            model=self.model, messages=messages, temperature=temperature, stream=True
        )
        async for chunk in stream:
            if chunk.choices and chunk.choices[0].delta.content:
                yield chunk.choices[0].delta.content


class OpenAIProvider:
    """OpenAI (and OpenAI-compatible) chat-completions models."""

    name = "openai"

    def __init__(self, api_key: str, model: str) -> None:
        from openai import AsyncOpenAI

        self.client = AsyncOpenAI(api_key=api_key, max_retries=4)
        self.model = model

    @staticmethod
    def _usage(r) -> Usage:
        u = getattr(r, "usage", None)
        if u is None:
            return Usage()
        return Usage(getattr(u, "prompt_tokens", 0) or 0, getattr(u, "completion_tokens", 0) or 0)

    async def chat(self, messages: list[dict], temperature: float = 0.7) -> LLMResult:
        r = await self.client.chat.completions.create(
            model=self.model, messages=messages, temperature=temperature
        )
        return LLMResult((r.choices[0].message.content or "").strip(), self._usage(r))

    async def extract(self, system_prompt: str, user_input: str) -> LLMResult:
        r = await self.client.chat.completions.create(
            model=self.model,
            messages=[
                {"role": "system", "content": system_prompt},
                {"role": "user", "content": user_input},
            ],
            temperature=0.0,
        )
        return LLMResult((r.choices[0].message.content or "").strip(), self._usage(r))

    async def stream_chat(self, messages: list[dict], temperature: float = 0.7) -> AsyncIterator[str]:
        stream = await self.client.chat.completions.create(
            model=self.model, messages=messages, temperature=temperature, stream=True
        )
        async for chunk in stream:
            if chunk.choices and chunk.choices[0].delta.content:
                yield chunk.choices[0].delta.content


class AnthropicProvider:
    """Anthropic Claude models (Messages API)."""

    name = "anthropic"

    def __init__(self, api_key: str, model: str) -> None:
        from anthropic import AsyncAnthropic

        self.client = AsyncAnthropic(api_key=api_key, max_retries=4)
        self.model = model

    @staticmethod
    def _text(r) -> str:
        return "".join(b.text for b in r.content if getattr(b, "type", None) == "text").strip()

    @staticmethod
    def _usage(r) -> Usage:
        u = getattr(r, "usage", None)
        if u is None:
            return Usage()
        return Usage(getattr(u, "input_tokens", 0) or 0, getattr(u, "output_tokens", 0) or 0)

    async def chat(self, messages: list[dict], temperature: float = 0.7) -> LLMResult:
        system, convo = _split_system(messages)
        r = await self.client.messages.create(
            model=self.model, max_tokens=2048, system=system or None, messages=convo, temperature=temperature
        )
        return LLMResult(self._text(r), self._usage(r))

    async def extract(self, system_prompt: str, user_input: str) -> LLMResult:
        r = await self.client.messages.create(
            model=self.model,
            max_tokens=1024,
            system=system_prompt,
            messages=[{"role": "user", "content": user_input}],
            temperature=0.0,
        )
        return LLMResult(self._text(r), self._usage(r))

    async def stream_chat(self, messages: list[dict], temperature: float = 0.7) -> AsyncIterator[str]:
        system, convo = _split_system(messages)
        async with self.client.messages.stream(
            model=self.model, max_tokens=2048, system=system or None, messages=convo, temperature=temperature
        ) as stream:
            async for text in stream.text_stream:
                yield text


_PROVIDERS = {"groq": GroqProvider, "openai": OpenAIProvider, "anthropic": AnthropicProvider}
_DEFAULT_MODELS = {"groq": None, "openai": "gpt-4o-mini", "anthropic": "claude-3-5-haiku-latest"}

_default_groq: GroqProvider | None = None


def get_llm(provider: str | None = None, model: str | None = None, api_key: str | None = None):
    """Return an LLM adapter. No args → default server Groq (env key, cached).

    With a provider/key, build a fresh adapter for that provider+model+key. The
    key is used transiently and never persisted.
    """
    settings = get_settings()
    provider = (provider or "groq").lower()

    # Default server Groq path (no user override) — cached singleton.
    if provider == "groq" and not api_key and not model:
        global _default_groq
        if _default_groq is None:
            logger.info("Using default Groq provider (%s)", settings.GROQ_MODEL)
            _default_groq = GroqProvider(api_key=settings.GROQ_API_KEY, model=settings.GROQ_MODEL)
        return _default_groq

    if provider not in _PROVIDERS:
        raise ValueError(f"Unknown LLM provider '{provider}'. Options: {sorted(_PROVIDERS)}")

    if provider == "groq":
        return GroqProvider(api_key=api_key or settings.GROQ_API_KEY, model=model or settings.GROQ_MODEL)

    if not api_key:
        raise ValueError(f"An API key is required for provider '{provider}'.")
    return _PROVIDERS[provider](api_key=api_key, model=model or _DEFAULT_MODELS[provider])
