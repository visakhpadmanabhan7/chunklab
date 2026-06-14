# Frequently Asked Questions

**Q: What is chunking?**
Chunking is the process of splitting a document into smaller passages so each can
be embedded and retrieved independently in a RAG pipeline.

**Q: Why does chunk size matter?**
Large chunks mix several ideas into one vector, which lowers retrieval precision.
Small chunks may not contain a complete answer, which lowers recall. The right
size balances the two for your content.

**Q: What is chunk overlap?**
Overlap repeats some text between consecutive chunks so an idea that straddles a
boundary still appears whole in at least one chunk.

**Q: What is an embedding?**
An embedding is a fixed-length vector of numbers that represents the meaning of a
piece of text. Similar texts have vectors that are close together.

**Q: What does top-k mean?**
Top-k is the number of nearest chunks the retriever returns for a query. A larger
k increases the chance of finding the answer but adds noise and cost.

**Q: What is nDCG?**
Normalized Discounted Cumulative Gain measures how well a ranking places relevant
results near the top. It ranges from 0 to 1, where 1 is a perfect ranking.

**Q: What is an LLM-as-judge?**
It is using a language model to score the quality of retrieved context or an
answer against criteria such as relevance and faithfulness.

**Q: Should I always use the largest embedding model?**
No. Larger models cost more and are slower. Many small models (like bge-small)
are excellent for retrieval; measure before upgrading.
