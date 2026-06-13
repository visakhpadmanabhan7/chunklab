"""Download embedding + tokenizer (and docling) models at build time so the
first request doesn't pay the download cost. Failures are non-fatal."""


def main() -> None:
    from app.core.embedding import get_embedding_model, get_tokenizer

    print("Prefetching embedding model...")
    get_embedding_model()
    print("Prefetching tokenizer...")
    get_tokenizer()

    try:
        print("Prefetching docling models...")
        from docling.document_converter import DocumentConverter

        DocumentConverter()
    except Exception as exc:  # pragma: no cover
        print(f"docling prefetch skipped: {exc}")

    print("Model prefetch complete.")


if __name__ == "__main__":
    main()
