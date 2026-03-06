# Prior Art — Existing Memory Plugins & How We Differ

## Existing OpenClaw Memory Solutions

| Plugin | Approach | Decay? | Associations? | Local? |
|--------|----------|--------|---------------|--------|
| **memory-core** (bundled) | Vector search over markdown files | ❌ | ❌ | ✅ |
| **memory-lancedb** (bundled) | LanceDB vectors + auto-recall/capture | ❌ | ❌ | ✅ |
| **Mem0** | External API, structured memory extraction | ❌ | ❌ | ❌ (cloud) |
| **Supermemory** | Container-based routing, auto-capture | ❌ | ❌ | ❌ (cloud) |
| **MemOS Cloud** | Lifecycle hooks, recall/save | ❌ | ❌ | ❌ (cloud) |
| **openclaw-mem** | SQLite receipts + LanceDB sidecar | ❌ | ❌ | ✅ |
| **KG plugin** (blog post) | Knowledge graph on top of memory | ❌ | ✅ (graph) | ✅ |
| **memory-decay (ours)** | Decay scoring + association boost | ✅ | ✅ (ontology) | ✅ |

### Key Differentiators

1. **Nobody does decay.** Every existing solution treats memory as permanent storage with flat ranking. We're the only ones modeling temporal decay.

2. **Nobody connects to a knowledge graph for association.** The blog post about KG describes building a graph FROM memories, but not using graph structure to BOOST memory retrieval. Our ontology graph already has entity relationships — we'd use those as spreading activation channels.

3. **Local-first.** Unlike Mem0/Supermemory which require cloud APIs, everything runs in SQLite on the same machine. No API keys, no latency, no data leaving the box.

4. **Wrapper approach.** We don't replace the indexing/embedding layer — we add a scoring layer on top of memory-core. Much simpler to build and maintain.

## Academic vs. Our Approach

| Paper | What they did | What we take |
|-------|---------------|--------------|
| **MemoryBank** | Ebbinghaus decay for chatbot companion | Decay formula, reinforcement on recall |
| **Generative Agents** | recency × importance × relevance scoring | The three-factor scoring model |
| **ACT-R + LLM** | Cognitive architecture activation levels | Base-level activation formula, spreading activation |
| **Memory Consolidation** | Periodic merging of episodic → semantic | Heartbeat-driven consolidation cycle |

## What Makes This Interesting (Pitch)

For OpenClaw community / potential blog post / GitHub readme:

> Every AI memory system today is a filing cabinet — things go in, things come out, nothing changes. Human memory is alive: yesterday's conversation is vivid, last month's is hazy, last year's is gone unless it was important or you keep thinking about it.
>
> memory-decay brings this to OpenClaw. Your agent naturally "forgets" trivial interactions while keeping important memories fresh. When you mention a topic, associated memories surface — not because of keyword matching, but because of learned connections. And when you revisit an old memory, it comes back to life.
>
> The science is solid (Ebbinghaus 1885, ACT-R from Carnegie Mellon, Stanford's Generative Agents). The implementation is new — nobody has shipped this in a production agent platform.

## Risks & Concerns

1. **Over-forgetting:** If decay is too aggressive, the agent loses useful context. Need careful tuning + user-visible controls.

2. **Importance rating quality:** LLM rating importance at write time might misjudge. Solution: allow manual overrides, re-rate periodically.

3. **Complexity tax:** More moving parts = more things that can break. The wrapper approach minimizes this but doesn't eliminate it.

4. **"Does it actually help?":** Hard to measure objectively. User perception matters more than benchmarks here. Need good before/after examples.

5. **memory-core API stability:** We depend on memory-core internals. If OpenClaw refactors memory architecture, we might break. Mitigated by the sidecar fallback (Option C).
