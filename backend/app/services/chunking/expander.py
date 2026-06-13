"""Expand a run's combination specs into concrete (strategy, params, label) cells.

Each spec is either a single combination ``{strategy, params}`` or a matrix
``{strategy, params: {sizes: [...], ...}}`` which fans out one combination per
size. Duplicates (by label) are dropped.
"""

from dataclasses import dataclass

from app.services.chunking.registry import get_strategy


@dataclass
class ExpandedCombination:
    strategy: str
    params: dict
    label: str


def expand(combinations: list[dict]) -> list[ExpandedCombination]:
    out: list[ExpandedCombination] = []
    seen: set[str] = set()

    for spec in combinations:
        strategy = spec["strategy"]
        base = dict(spec.get("params", {}))
        sizes = base.pop("sizes", None)

        param_sets = [{**base, "size": s} for s in sizes] if sizes else [base]

        for params in param_sets:
            strat = get_strategy(strategy)  # validates strategy name
            label = strat.label(params)
            if label in seen:
                continue
            seen.add(label)
            out.append(ExpandedCombination(strategy=strategy, params=params, label=label))

    return out
