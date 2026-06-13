import uuid

from app.services.eval import metrics as M


def test_is_relevant_overlap():
    gold = "The mitochondria is the powerhouse of the cell and produces ATP energy."
    assert M.is_relevant("The mitochondria is the powerhouse of the cell and produces ATP energy.", gold)
    assert not M.is_relevant("Completely unrelated text about weather and rain today.", gold)


def test_compute_for_query_perfect_at_rank1():
    fid = uuid.uuid4()
    gold = "alpha beta gamma delta epsilon zeta eta theta"
    retrieved = [
        (uuid.uuid4(), "alpha beta gamma delta epsilon zeta eta theta", fid),
        (uuid.uuid4(), "irrelevant filler content here", fid),
    ]
    m = M.compute_for_query(retrieved, gold, fid, k=2)
    assert m.recall_at_k == 1.0
    assert m.mrr == 1.0
    assert m.ndcg_at_k == 1.0
    assert m.precision_at_k == 0.5  # 1 of 2 relevant


def test_compute_for_query_no_relevant():
    fid = uuid.uuid4()
    gold = "alpha beta gamma delta epsilon zeta eta theta"
    retrieved = [(uuid.uuid4(), "nothing matches here at all", fid)]
    m = M.compute_for_query(retrieved, gold, fid, k=1)
    assert m.recall_at_k == 0.0
    assert m.mrr == 0.0
    assert m.f2 == 0.0


def test_macro_average():
    a = M.QueryMetrics(1.0, 1.0, 1.0, 1.0, 1.0)
    b = M.QueryMetrics(0.0, 0.0, 0.0, 0.0, 0.0)
    avg = M.macro_average([a, b])
    assert avg.precision_at_k == 0.5
    assert avg.ndcg_at_k == 0.5
