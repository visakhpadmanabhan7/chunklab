"""arq tasks: parse a file, and run a full chunking experiment.

run_pipeline:  parse files → generate QA set (once) → per combination
{chunk → token-count → embed → store vectors} → {retrieve → judge → score} →
aggregate stats + metrics. Progress is published throughout.
"""

import asyncio
import time
import uuid
from datetime import datetime
from pathlib import Path
from statistics import fmean

from sqlalchemy import select

from app.core.config import get_settings
from app.core.embedding import count_tokens, embed_texts
from app.core.logging import get_logger
from app.core.pricing import embedding_cost, groq_cost
from app.db.models_core import File, ParsedDocument, Run, RunCombination
from app.db.models_results import (
    Chunk,
    CombinationStats,
    JudgeEvaluation,
    Metrics,
    QAPair,
    Retrieval,
)
from app.db.session import session_scope
from app.services.chunking import assemble, get_strategy
from app.services.eval import metrics as M
from app.services.eval.judge import judge
from app.services.eval.qa_generator import generate_qa_pairs
from app.services.eval.retriever import retrieve
from app.services.parsing.service import parse_file
from app.workers import progress as P

logger = get_logger(__name__)
settings = get_settings()


async def _ensure_parsed(session, file: File) -> ParsedDocument:
    existing = (
        await session.execute(
            select(ParsedDocument).where(ParsedDocument.file_id == file.id)
        )
    ).scalar_one_or_none()
    if existing:
        return existing
    parsed = await asyncio.to_thread(parse_file, file.storage_path, file.parse_options or {})
    doc = ParsedDocument(
        file_id=file.id,
        clean_text=parsed.clean_text,
        char_count=parsed.char_count,
        page_count=parsed.page_count,
    )
    session.add(doc)
    file.status = "parsed"
    file.parser_used = parsed.parser_used
    # We do NOT retain the original upload — only the extracted text is kept
    # (that's all chunking needs). Delete the raw file from disk after parsing.
    try:
        Path(file.storage_path).unlink(missing_ok=True)
    except OSError:
        pass
    file.storage_path = ""
    await session.commit()
    logger.info("parsed and discarded raw upload for file=%s (%s)", file.id, file.parser_used)
    return doc


async def parse_file_task(ctx, file_id: str) -> None:
    async with session_scope() as session:
        file = await session.get(File, uuid.UUID(file_id))
        if not file:
            return
        file.status = "parsing"
        await session.commit()
        try:
            await _ensure_parsed(session, file)
        except Exception as exc:  # pragma: no cover
            logger.exception("Parsing failed for %s", file_id)
            file.status = "failed"
            file.error = str(exc)
            await session.commit()


async def run_pipeline(ctx, run_id: str) -> None:
    rid = uuid.UUID(run_id)
    async with session_scope() as session:
        run = await session.get(Run, rid)
        if not run:
            return
        try:
            run.status = "running"
            run.started_at = datetime.utcnow()
            run.progress = 0.0
            await session.commit()
            await P.emit_run(run_id, "running", 0.0)

            combos = (
                (
                    await session.execute(
                        select(RunCombination).where(RunCombination.run_id == rid)
                    )
                )
                .scalars()
                .all()
            )
            files = await _load_files(session, run)
            top_k = run.top_k

            if not files:
                run.status = "failed"
                run.error = "No files to process"
                await session.commit()
                await P.emit_run(run_id, "failed", 0.0)
                return

            # ---- parse all files ----
            parsed_map: dict[uuid.UUID, ParsedDocument] = {}
            for f in files:
                await P.emit_log(run_id, f"Parsing {f.filename}")
                parsed_map[f.id] = await _ensure_parsed(session, f)

            # ---- generate the shared QA evaluation set (once per run) ----
            await P.emit_log(run_id, "Generating QA evaluation set")
            qa_records: list[tuple[QAPair, uuid.UUID, object]] = []
            max_total = settings.MAX_QA_PAIRS_PER_RUN
            for f in files:
                if len(qa_records) >= max_total:
                    break
                want = min(settings.QA_PAIRS_PER_FILE, max_total - len(qa_records))
                gen = await generate_qa_pairs(parsed_map[f.id].clean_text, want)
                for g in gen:
                    qa = QAPair(
                        run_id=rid,
                        file_id=f.id,
                        question=g.question,
                        reference_answer=g.reference_answer,
                        source_chunk_text=g.source_chunk_text,
                        source_offset_start=g.start,
                        source_offset_end=g.end,
                    )
                    session.add(qa)
                    qa_records.append((qa, f.id, g))
            await session.commit()

            questions = [qa.question for (qa, _f, _g) in qa_records]
            q_vectors = await asyncio.to_thread(embed_texts, questions) if questions else []
            await P.emit_log(run_id, f"{len(qa_records)} QA pairs ready")

            total = max(len(combos), 1)
            for ci, combo in enumerate(combos):
                await _process_combination(
                    session, run_id, combo, files, parsed_map, qa_records, q_vectors, top_k
                )
                pct = (ci + 1) / total
                run.progress = pct
                await session.commit()
                await P.emit_run(run_id, "running", pct)

            run.status = "completed"
            run.completed_at = datetime.utcnow()
            run.progress = 1.0
            await session.commit()
            await P.emit_run(run_id, "completed", 1.0)
            await P.emit_log(run_id, "Run complete")

        except Exception as exc:  # pragma: no cover
            logger.exception("run_pipeline failed for %s", run_id)
            run.status = "failed"
            run.error = str(exc)
            await session.commit()
            await P.emit_run(run_id, "failed", run.progress or 0.0)
            await P.emit_log(run_id, f"Run failed: {exc}", level="error")


async def _load_files(session, run: Run) -> list[File]:
    file_ids = run.config.get("file_ids") if isinstance(run.config, dict) else None
    if file_ids and file_ids != "all":
        ids = [uuid.UUID(str(x)) for x in file_ids]
        rows = await session.execute(select(File).where(File.id.in_(ids)))
    else:
        rows = await session.execute(select(File).where(File.project_id == run.project_id))
    return list(rows.scalars().all())


async def _process_combination(
    session, run_id, combo, files, parsed_map, qa_records, q_vectors, top_k
) -> None:
    strat = get_strategy(combo.strategy)
    combo.status = "chunking"
    await session.commit()
    await P.emit_combo(run_id, str(combo.id), combo.label, "chunking", 0.0)

    chunk_ms = embed_ms = eval_ms = 0
    total_tokens = chunk_count = 0
    n_files = max(len(files), 1)

    # ---- chunk → embed → store, per file ----
    for fi, f in enumerate(files):
        doc = parsed_map[f.id]
        await P.emit_file(run_id, str(combo.id), str(f.id), "chunk", fi / n_files)
        t0 = time.perf_counter()
        pieces = strat.split(doc.clean_text, combo.params)
        chunks = assemble(doc.clean_text, pieces)
        chunk_ms += int((time.perf_counter() - t0) * 1000)
        if not chunks:
            continue

        contents = [c.content for c in chunks]
        token_counts = [count_tokens(c) for c in contents]
        await P.emit_file(run_id, str(combo.id), str(f.id), "embed", fi / n_files)
        t1 = time.perf_counter()
        vectors = await asyncio.to_thread(embed_texts, contents)
        embed_ms += int((time.perf_counter() - t1) * 1000)

        for c, tok, vec in zip(chunks, token_counts, vectors):
            session.add(
                Chunk(
                    combination_id=combo.id,
                    file_id=f.id,
                    chunk_index=c.index,
                    content=c.content,
                    token_count=tok,
                    char_count=len(c.content),
                    embedding=vec,
                )
            )
            total_tokens += tok
            chunk_count += 1
        await session.commit()
        await P.emit_file(run_id, str(combo.id), str(f.id), "embed", (fi + 1) / n_files, "completed")
        # chunking/embedding occupies the first half of the combo's progress bar
        await P.emit_combo(run_id, str(combo.id), combo.label, "chunking", 0.5 * (fi + 1) / n_files)

    # ---- evaluate: retrieve → judge → score, per QA pair ----
    combo.status = "evaluating"
    await session.commit()
    await P.emit_combo(run_id, str(combo.id), combo.label, "evaluating", 0.5)

    judge_in = judge_out = 0
    per_query: list[M.QueryMetrics] = []
    judged: list[JudgeEvaluation] = []
    latencies: list[int] = []

    n_qa = max(len(qa_records), 1)
    for qi, ((qa, fid, g), qvec) in enumerate(zip(qa_records, q_vectors)):
        t2 = time.perf_counter()
        retrieved = await retrieve(session, combo.id, qvec, top_k)
        lat = int((time.perf_counter() - t2) * 1000)
        latencies.append(lat)
        eval_ms += lat

        ret = Retrieval(
            combination_id=combo.id,
            qa_pair_id=qa.id,
            retrieved_chunk_ids=[r.id for r in retrieved],
            scores=[r.relevance for r in retrieved],
            latency_ms=lat,
        )
        session.add(ret)
        await session.flush()

        jr = await judge(qa.question, qa.reference_answer, [r.content for r in retrieved])
        judge_in += jr.prompt_tokens
        judge_out += jr.completion_tokens
        je = JudgeEvaluation(
            retrieval_id=ret.id,
            relevance=jr.relevance,
            faithfulness=jr.faithfulness,
            context_precision=jr.context_precision,
            context_recall=jr.context_recall,
            judge_feedback=jr.feedback,
            judge_model=settings.GROQ_MODEL,
            judge_tokens_in=jr.prompt_tokens,
            judge_tokens_out=jr.completion_tokens,
        )
        session.add(je)
        judged.append(je)

        qm = M.compute_for_query(
            [(r.id, r.content, r.file_id) for r in retrieved],
            g.source_chunk_text,
            fid,
            top_k,
        )
        per_query.append(qm)
        # evaluation occupies the second half of the combo's progress bar
        await P.emit_combo(run_id, str(combo.id), combo.label, "evaluating", 0.5 + 0.5 * (qi + 1) / n_qa)

    await session.commit()

    # ---- aggregate stats + metrics ----
    e_cost = embedding_cost(total_tokens)
    j_cost = groq_cost(judge_in, judge_out)
    session.add(
        CombinationStats(
            combination_id=combo.id,
            chunk_count=chunk_count,
            total_tokens=total_tokens,
            avg_tokens_per_chunk=(total_tokens / chunk_count) if chunk_count else 0.0,
            embedding_cost_usd=e_cost,
            judge_cost_usd=j_cost,
            total_cost_usd=e_cost + j_cost,
            chunk_latency_ms=chunk_ms,
            embed_latency_ms=embed_ms,
            eval_latency_ms=eval_ms,
        )
    )

    comp = M.macro_average(per_query)
    session.add(
        Metrics(
            combination_id=combo.id,
            relevance=round(fmean(j.relevance for j in judged), 4) if judged else 0.0,
            faithfulness=round(fmean(j.faithfulness for j in judged), 4) if judged else 0.0,
            context_precision=round(fmean(j.context_precision for j in judged), 4) if judged else 0.0,
            context_recall=round(fmean(j.context_recall for j in judged), 4) if judged else 0.0,
            precision_at_k=comp.precision_at_k,
            recall_at_k=comp.recall_at_k,
            mrr=comp.mrr,
            ndcg_at_k=comp.ndcg_at_k,
            f2=comp.f2,
            avg_retrieval_latency_ms=round(fmean(latencies), 2) if latencies else 0.0,
        )
    )
    combo.status = "completed"
    combo.progress = 1.0
    await session.commit()
    await P.emit_combo(run_id, str(combo.id), combo.label, "completed", 1.0)
