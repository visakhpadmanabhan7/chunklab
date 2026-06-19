"""Streaming RAG chat over run results (Groq)."""

from typing import AsyncIterator

from app.core.llm import get_llm
from app.prompts.prompt_texts import CHAT_SYSTEM_PROMPT


async def stream_answer(
    context: str,
    message: str,
    history: list[dict],
    provider: str | None = None,
    model: str | None = None,
    api_key: str | None = None,
) -> AsyncIterator[str]:
    system = f"{CHAT_SYSTEM_PROMPT}\n\nCONTEXT:\n{context}"
    messages = [{"role": "system", "content": system}]
    for turn in history[-8:]:
        messages.append({"role": turn["role"], "content": turn["content"]})
    messages.append({"role": "user", "content": message})

    llm = get_llm(provider=provider, model=model, api_key=api_key)
    async for token in llm.stream_chat(messages, temperature=0.3):
        yield token
