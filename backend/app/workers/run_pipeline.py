"""arq tasks: parse a file, and run a full chunking experiment.

run_pipeline parallelises aggressively while keeping each DB session
single-threaded:

  * files are parsed concurrently (one session each),
  * the shared QA set is generated concurrently across files,
  * combinations are processed concurrently (one session each), and
  * inside each combination the slow LLM-judge calls fan out together,
    bounded by a shared semaphore so we respect Groq rate limits.

Progress for every layer is published to Redis throughout, so the live UI
shows combinations advancing side-by-side.
"""

import asyncio
import time
import uuid
from dataclasses import dataclass
from datetime import datetime
from pathlib import Path
from statistics import fmean

from sqlalchemy import select

from app.core.config import get_settings
from app.core.embedding import count_tokens, embed_texts
from app.core.llm import get_llm
from app.core.logging import get_logger
from app.core.pricing import embedding_cost, llm_cost
from app.db.models_core import File, ParsedDocument, ProjectQAPair, Run, RunCombination
from app.db.models_results import (
    Chunk,
    CombinationStats,
    JudgeEvaluation,
    Metrics,
    QAPair,
    QueryMetric,
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


# --- plain, session-independent payloads shared across concurrent tasks ---
@dataclass
class FileSpec:
    id: uuid.UUID
    filename: str
    text: str


@dataclass
class QASpec:
    qa_id: uuid.UUID
    question: str
    reference_answer: str
    gold_text: str
    file_id: uuid.UUID


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


async def _fail(rid: uuid.UUID, run_id: str, message: str) -> None:
    async with session_scope() as session:
        run = await session.get(Run, rid)
        if run:
            run.status = "failed"
            run.error = message
            await session.commit()
    await P.emit_run(run_id, "failed", 0.0)
    await P.emit_log(run_id, f"Run failed: {message}", level="error")


async def _is_canceled(rid: uuid.UUID) -> bool:
    async with session_scope() as session:
        st = (
            await session.execute(select(Run.status).where(Run.id == rid))
        ).scalar_one_or_none()
    return st == "canceled"


async def run_pipeline(ctx, run_id: str, api_key: str | None = None) -> None:
    rid = uuid.UUID(run_id)
    try:
        # ---- load run + combinations + file list (short-lived session) ----
        async with session_scope() as session:
            run = await session.get(Run, rid)
            if not run:
                return
            run.status = "running"
            run.started_at = datetime.utcnow()
            run.progress = 0.0
            await session.commit()
            cfg = run.config if isinstance(run.config, dict) else {}
            project_id = run.project_id
            top_k = run.top_k
            combos = (
                await session.execute(
                    select(RunCombination).where(RunCombination.run_id == rid)
                )
            ).scalars().all()
            combo_specs = [(c.id, c.strategy, c.params, c.label) for c in combos]
            file_objs = await _load_files(session, run)
            file_ids = [f.id for f in file_objs]

        await P.emit_run(run_id, "running", 0.0)
        if not file_ids:
            await _fail(rid, run_id, "No files to process")
            return

        qa_per_file = int(cfg.get("qa_per_file") or settings.QA_PAIRS_PER_FILE)
        max_total = int(cfg.get("max_qa") or settings.MAX_QA_PAIRS_PER_RUN)
        enable_judge = bool(cfg.get("enable_judge", True))
        qa_source = cfg.get("qa_source", "auto")  # auto | mine | both
        # BYO LLM for this run (QA-gen + judge); falls back to the server Groq default.
        run_llm = get_llm(provider=cfg.get("provider"), model=cfg.get("model"), api_key=api_key)
        # shared cap on concurrent Groq calls (QA-gen + judge) across the whole run
        llm_sem = asyncio.Semaphore(settings.MAX_CONCURRENT_LLM)
        embed_sem = asyncio.Semaphore(settings.MAX_CONCURRENT_EMBED)
        # The FastEmbed/ONNX model is a single shared session and is NOT safe to
        # call from multiple threads at once — serialize all embedding/tokenizing
        # across the concurrently-running combinations. (This work is CPU-bound, so
        # serializing costs nothing; the real win is the parallel LLM judge calls.)
        embed_lock = asyncio.Lock()

        # ---- parse every file concurrently ----
        async def parse_one(fid: uuid.UUID) -> FileSpec:
            async with embed_sem:
                async with session_scope() as s:
                    f = await s.get(File, fid)
                    await P.emit_log(run_id, f"Parsing {f.filename}")
                    doc = await _ensure_parsed(s, f)
                    return FileSpec(id=fid, filename=f.filename, text=doc.clean_text)

        file_specs = list(await asyncio.gather(*(parse_one(fid) for fid in file_ids)))

        # ---- generate the shared QA evaluation set (concurrent across files) ----
        await P.emit_log(run_id, "Generating QA evaluation set")
        generated: dict[uuid.UUID, list] = {}
        if qa_source in ("auto", "both"):
            wants: dict[uuid.UUID, int] = {}
            remaining = max_total
            for fs in file_specs:
                w = min(qa_per_file, remaining)
                if w <= 0:
                    break
                wants[fs.id] = w
                remaining -= w

            async def gen_one(fs: FileSpec, want: int):
                async with llm_sem:
                    return fs.id, await generate_qa_pairs(fs.text, want, llm=run_llm)

            results = await asyncio.gather(
                *(gen_one(fs, wants[fs.id]) for fs in file_specs if fs.id in wants)
            )
            generated = dict(results)

        # persist the QA set (single session) and build session-independent specs
        qa_specs: list[QASpec] = []
        async with session_scope() as session:
            if qa_source in ("auto", "both"):
                for fs in file_specs:
                    for g in generated.get(fs.id, []):
                        if len(qa_specs) >= max_total:
                            break
                        qa = QAPair(
                            run_id=rid,
                            file_id=fs.id,
                            question=g.question,
                            reference_answer=g.reference_answer,
                            source_chunk_text=g.source_chunk_text,
                            source_offset_start=g.start,
                            source_offset_end=g.end,
                        )
                        session.add(qa)
                        await session.flush()
                        qa_specs.append(
                            QASpec(qa.id, g.question, g.reference_answer, g.source_chunk_text, fs.id)
                        )
            if qa_source in ("mine", "both"):
                user_rows = (
                    await session.execute(
                        select(ProjectQAPair).where(ProjectQAPair.project_id == project_id)
                    )
                ).scalars().all()
                by_name = {fs.filename: fs.id for fs in file_specs}
                default_fid = file_specs[0].id
                for r in user_rows:
                    if len(qa_specs) >= max_total:
                        break
                    fid = by_name.get(r.source_file or "", default_fid)
                    gold = r.source_chunk_text or r.reference_answer
                    qa = QAPair(
                        run_id=rid,
                        file_id=fid,
                        question=r.question,
                        reference_answer=r.reference_answer,
                        source_chunk_text=gold,
                        source_offset_start=0,
                        source_offset_end=len(gold),
                    )
                    session.add(qa)
                    await session.flush()
                    qa_specs.append(QASpec(qa.id, r.question, r.reference_answer, gold, fid))
            await session.commit()

        questions = [q.question for q in qa_specs]
        q_vectors = await asyncio.to_thread(embed_texts, questions) if questions else []
        await P.emit_log(run_id, f"{len(qa_specs)} QA pairs ready")
        if not enable_judge:
            await P.emit_log(run_id, "LLM judge disabled — computed metrics only (fast mode)")
        await P.emit_log(
            run_id,
            f"Running {len(combo_specs)} combinations "
            f"({settings.MAX_CONCURRENT_COMBINATIONS} at a time)",
        )

        # ---- process combinations concurrently ----
        combo_pct: dict[str, float] = {str(cid): 0.0 for (cid, _s, _p, _l) in combo_specs}
        agg_lock = asyncio.Lock()
        n_combos = max(len(combo_specs), 1)

        async def on_progress(cid: uuid.UUID, pct: float) -> None:
            combo_pct[str(cid)] = pct
            overall = sum(combo_pct.values()) / n_combos
            await P.emit_run(run_id, "running", overall)

        combo_sem = asyncio.Semaphore(settings.MAX_CONCURRENT_COMBINATIONS)

        async def run_one(spec) -> None:
            cid, strat, params, label = spec
            async with combo_sem:
                if await _is_canceled(rid):
                    return
                async with session_scope() as s:
                    await _process_combination(
                        s, run_id, cid, strat, params, label,
                        file_specs, qa_specs, q_vectors, top_k, enable_judge,
                        run_llm, llm_sem, embed_lock, on_progress,
                    )
                async with agg_lock:
                    async with session_scope() as s:
                        overall = sum(combo_pct.values()) / n_combos
                        await P.set_run_status(s, rid, "running", overall)

        await asyncio.gather(*(run_one(spec) for spec in combo_specs))

        # ---- finalize ----
        if await _is_canceled(rid):
            await P.emit_run(run_id, "canceled", min(sum(combo_pct.values()) / n_combos, 1.0))
            await P.emit_log(run_id, "Run canceled — stopping", level="warning")
            return
        async with session_scope() as session:
            run = await session.get(Run, rid)
            run.status = "completed"
            run.completed_at = datetime.utcnow()
            run.progress = 1.0
            await session.commit()
        await P.emit_run(run_id, "completed", 1.0)
        await P.emit_log(run_id, "Run complete")

    except Exception as exc:  # pragma: no cover
        logger.exception("run_pipeline failed for %s", run_id)
        await _fail(rid, run_id, str(exc))


async def _load_files(session, run: Run) -> list[File]:
    file_ids = run.config.get("file_ids") if isinstance(run.config, dict) else None
    if file_ids and file_ids != "all":
        ids = [uuid.UUID(str(x)) for x in file_ids]
        rows = await session.execute(select(File).where(File.id.in_(ids)))
    else:
        rows = await session.execute(select(File).where(File.project_id == run.project_id))
    return list(rows.scalars().all())


async def _process_combination(
    session,
    run_id: str,
    combo_id: uuid.UUID,
    strategy: str,
    params: dict,
    label: str,
    file_specs: list[FileSpec],
    qa_specs: list[QASpec],
    q_vectors: list,
    top_k: int,
    enable_judge: bool,
    llm,
    llm_sem: asyncio.Semaphore,
    embed_lock: asyncio.Lock,
    on_progress,
) -> None:
    strat = get_strategy(strategy)
    combo = await session.get(RunCombination, combo_id)
    combo.status = "chunking"
    await session.commit()
    cid = str(combo_id)
    await P.emit_combo(run_id, cid, label, "chunking", 0.0)
    await on_progress(combo_id, 0.0)

    # ---- chunk → embed → store, streamed per file ----
    # Embedding/tokenizing run under a shared lock (the FastEmbed/ONNX session is a
    # single shared instance, unsafe to call from multiple threads). We stream one
    # file at a time so peak memory stays bounded even with several combinations in
    # flight — collecting every file's vectors at once OOMs the worker.
    chunk_ms = embed_ms = total_tokens = chunk_count = 0
    n_files = max(len(file_specs), 1)
    for fi, fs in enumerate(file_specs):
        t0 = time.perf_counter()
        chunks = assemble(fs.text, strat.split(fs.text, params))
        chunk_ms += int((time.perf_counter() - t0) * 1000)
        if not chunks:
            continue
        contents = [c.content for c in chunks]
        async with embed_lock:
            token_counts = [count_tokens(x) for x in contents]
            t1 = time.perf_counter()
            vectors = await asyncio.to_thread(embed_texts, contents)
            embed_ms += int((time.perf_counter() - t1) * 1000)
        for c, tok, vec in zip(chunks, token_counts, vectors):
            session.add(
                Chunk(
                    combination_id=combo_id,
                    file_id=fs.id,
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
        pct = 0.5 * (fi + 1) / n_files
        await P.emit_combo(run_id, cid, label, "chunking", pct)
        await on_progress(combo_id, pct)
    await P.emit_log(run_id, f"{label} — {chunk_count} chunks embedded")

    # ---- evaluate: retrieve (DB, serial) → judge (LLM, parallel) → score ----
    combo.status = "evaluating"
    await session.commit()
    await P.emit_combo(run_id, cid, label, "evaluating", 0.5)

    # phase 1 — retrieve + per-query IR metrics (fast, needs the session serially)
    prepared = []
    latencies: list[int] = []
    eval_ms = 0
    for qa, qvec in zip(qa_specs, q_vectors):
        t2 = time.perf_counter()
        retrieved = await retrieve(session, combo_id, qvec, top_k)
        lat = int((time.perf_counter() - t2) * 1000)
        latencies.append(lat)
        eval_ms += lat
        ret = Retrieval(
            combination_id=combo_id,
            qa_pair_id=qa.qa_id,
            retrieved_chunk_ids=[r.id for r in retrieved],
            scores=[r.relevance for r in retrieved],
            latency_ms=lat,
        )
        session.add(ret)
        await session.flush()
        qm = M.compute_for_query(
            [(r.id, r.content, r.file_id) for r in retrieved], qa.gold_text, qa.file_id, top_k
        )
        prepared.append((qa, ret, retrieved, qm))
    await session.commit()

    # phase 2 — judge calls fan out together (bounded by the shared LLM semaphore)
    n_qa = max(len(prepared), 1)
    done = 0
    prog_lock = asyncio.Lock()

    async def judge_one(item):
        nonlocal done
        qa, _ret, retrieved, _qm = item
        jr = None
        if enable_judge:
            async with llm_sem:
                jr = await judge(
                    qa.question, qa.reference_answer, [r.content for r in retrieved], llm=llm
                )
        async with prog_lock:
            done += 1
            pct = 0.5 + 0.45 * done / n_qa
        await P.emit_combo(run_id, cid, label, "evaluating", pct)
        await on_progress(combo_id, pct)
        return jr

    judge_results = await asyncio.gather(*(judge_one(it) for it in prepared))

    # phase 3 — persist judge evaluations + per-query metrics (serial)
    judge_in = judge_out = 0
    judged: list[JudgeEvaluation] = []
    per_query: list[M.QueryMetrics] = []
    for (qa, ret, _retrieved, qm), jr in zip(prepared, judge_results):
        jr_dims = (0.0, 0.0, 0.0, 0.0)
        if jr is not None:
            judge_in += jr.prompt_tokens
            judge_out += jr.completion_tokens
            je = JudgeEvaluation(
                retrieval_id=ret.id,
                relevance=jr.relevance,
                faithfulness=jr.faithfulness,
                context_precision=jr.context_precision,
                context_recall=jr.context_recall,
                judge_feedback=jr.feedback,
                judge_model=getattr(llm, "model", settings.GROQ_MODEL),
                judge_tokens_in=jr.prompt_tokens,
                judge_tokens_out=jr.completion_tokens,
            )
            session.add(je)
            judged.append(je)
            jr_dims = (jr.relevance, jr.faithfulness, jr.context_precision, jr.context_recall)
        per_query.append(qm)
        session.add(
            QueryMetric(
                combination_id=combo_id,
                qa_pair_id=qa.qa_id,
                precision_at_k=qm.precision_at_k,
                recall_at_k=qm.recall_at_k,
                mrr=qm.mrr,
                ndcg_at_k=qm.ndcg_at_k,
                f2=qm.f2,
                relevance=jr_dims[0],
                faithfulness=jr_dims[1],
                context_precision=jr_dims[2],
                context_recall=jr_dims[3],
            )
        )
    await session.commit()

    # ---- aggregate stats + metrics ----
    e_cost = embedding_cost(total_tokens)
    j_cost = llm_cost(getattr(llm, "name", "groq"), getattr(llm, "model", ""), judge_in, judge_out)
    session.add(
        CombinationStats(
            combination_id=combo_id,
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
            combination_id=combo_id,
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
    await P.emit_combo(run_id, cid, label, "completed", 1.0)
    await on_progress(combo_id, 1.0)
    await P.emit_log(run_id, f"✓ {label} done")
