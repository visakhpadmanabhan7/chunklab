"""Streaming RAG chat (Groq by default; any provider via get_llm).

Two personas share one streaming path:
- run / project / compare → the analyst assistant, grounded in experiment results
- about                   → the product assistant, grounded in chunklab's own docs
"""

from typing import AsyncIterator

from app.core.llm import get_llm
from app.prompts.prompt_texts import CHAT_ABOUT_SYSTEM_PROMPT, CHAT_SYSTEM_PROMPT


async def stream_answer(
    context: str,
    message: str,
    history: list[dict],
    scope: str = "run",
    provider: str | None = None,
    model: str | None = None,
    api_key: str | None = None,
) -> AsyncIterator[str]:
    base = CHAT_ABOUT_SYSTEM_PROMPT if scope == "about" else CHAT_SYSTEM_PROMPT
    system = f"{base}\n\nCONTEXT:\n{context}"
    messages = [{"role": "system", "content": system}]
    for turn in history[-8:]:
        messages.append({"role": turn["role"], "content": turn["content"]})
    messages.append({"role": "user", "content": message})

    llm = get_llm(provider=provider, model=model, api_key=api_key)
    async for token in llm.stream_chat(messages, temperature=0.3):
        yield token
