"""Groq LLM provider — async client used for QA generation, the LLM-as-judge,
and the RAG chatbot. Adapted from mindmate_proj/app/core/llm.py (Groq-only)."""

from dataclasses import dataclass
from typing import AsyncIterator

import groq

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


class GroqProvider:
    """Free, fast inference using open-source models (Llama 3.x, etc.)."""

    def __init__(self) -> None:
        settings = get_settings()
        # max_retries lets the SDK wait out transient 429s (per-minute TPM/RPM limits)
        # with backoff that respects the Retry-After header.
        self.client = groq.AsyncGroq(api_key=settings.GROQ_API_KEY, max_retries=6)
        self.model = settings.GROQ_MODEL

    @staticmethod
    def _usage(response) -> Usage:
        u = getattr(response, "usage", None)
        if u is None:
            return Usage()
        return Usage(
            prompt_tokens=getattr(u, "prompt_tokens", 0) or 0,
            completion_tokens=getattr(u, "completion_tokens", 0) or 0,
        )

    async def chat(self, messages: list[dict], temperature: float = 0.7) -> LLMResult:
        response = await self.client.chat.completions.create(
            model=self.model,
            messages=messages,
            temperature=temperature,
        )
        content = (response.choices[0].message.content or "").strip()
        return LLMResult(content=content, usage=self._usage(response))

    async def extract(self, system_prompt: str, user_input: str) -> LLMResult:
        """Deterministic completion for structured/JSON extraction (temp=0)."""
        response = await self.client.chat.completions.create(
            model=self.model,
            messages=[
                {"role": "system", "content": system_prompt},
                {"role": "user", "content": user_input},
            ],
            temperature=0.0,
        )
        content = (response.choices[0].message.content or "").strip()
        return LLMResult(content=content, usage=self._usage(response))

    async def stream_chat(
        self, messages: list[dict], temperature: float = 0.7
    ) -> AsyncIterator[str]:
        stream = await self.client.chat.completions.create(
            model=self.model,
            messages=messages,
            temperature=temperature,
            stream=True,
        )
        async for chunk in stream:
            if chunk.choices and chunk.choices[0].delta.content:
                yield chunk.choices[0].delta.content


_provider: GroqProvider | None = None


def get_llm() -> GroqProvider:
    global _provider
    if _provider is None:
        settings = get_settings()
        logger.info("Using Groq provider (%s)", settings.GROQ_MODEL)
        _provider = GroqProvider()
    return _provider
