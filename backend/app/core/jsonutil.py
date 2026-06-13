"""Tolerant JSON extraction for LLM outputs."""

import json
import re


def parse_json(text: str) -> dict | list | None:
    text = text.strip()
    # Strip ```json fences if present
    if text.startswith("```"):
        text = re.sub(r"^```(?:json)?", "", text).rstrip("`").strip()
    try:
        return json.loads(text)
    except json.JSONDecodeError:
        pass
    match = re.search(r"(\{.*\}|\[.*\])", text, re.DOTALL)
    if match:
        try:
            return json.loads(match.group(1))
        except json.JSONDecodeError:
            return None
    return None
