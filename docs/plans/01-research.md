# Research Notes — Memory Decay for LLM Agents

## Academic Papers

### 1. MemoryBank (AAAI 2024)
**"MemoryBank: Enhancing Large Language Models with Long-Term Memory"**
- Paper: https://arxiv.org/abs/2305.10250
- Published at AAAI 2024 (top AI conference)
- **Core idea:** Uses Ebbinghaus Forgetting Curve to model memory decay
- **How it works:**
  - Stores past interactions as embeddings
  - Each memory has a "strength" value that decays exponentially over time
  - Formula: `R = e^(-t/S)` where R = retention, t = time elapsed, S = stability
  - When a memory is recalled, its stability S increases (reinforcement)
  - LLM periodically summarizes and consolidates memories
- **Results:** More human-like behavior in AI companion scenarios
- **Limitation:** Designed for chatbot companions, not general agent memory

### 2. Generative Agents (Stanford/Google, 2023)
**"Generative Agents: Interactive Simulacra of Human Behavior"**
- Paper: https://arxiv.org/abs/2304.03442 (Park et al.)
- The famous "AI town" paper — 25 agents living in a virtual world
- **Memory retrieval scoring:**
  ```
  score = α_recency × recency + α_importance × importance + α_relevance × relevance
  ```
  - **Recency:** exponential decay based on last access time
  - **Importance:** LLM rates each memory 1-10 on creation ("just ate breakfast" = 1, "broke up with partner" = 8)
  - **Relevance:** cosine similarity between memory embedding and current query
  - All α weights set to 1 in their implementation
- **Key insight:** Recency decay is calculated on LAST ACCESS time, not creation time. So recalling a memory resets its decay — exactly like human memory!
- **Reflection:** Periodically, agent reflects on recent memories and generates higher-level insights (memory consolidation)

### 3. ACT-R + LLM (HAI Conference 2025)
**"Human-Like Remembering and Forgetting in LLM Agents: An ACT-R-Inspired Memory Architecture"**
- Paper: https://dl.acm.org/doi/10.1145/3765766.3765803
- **ACT-R** = Adaptive Control of Thought—Rational, cognitive architecture from Carnegie Mellon (since 1990s)
- **Base-level activation:**
  ```
  B_i = ln(Σ t_j^(-d))
  ```
  Where t_j = time since j-th access, d = decay rate (~0.5)
  - More accesses = higher activation
  - Recent accesses count more
  - Natural logarithmic decay
- **Spreading activation:** When topic X is active, related memories get a boost proportional to their associative strength
- **Retrieval threshold:** Memories below a certain activation level are effectively "forgotten" (not deleted, just inaccessible)
- **Key for us:** The spreading activation mechanism is exactly what our ontology graph could provide — entities linked in the graph boost each other's activation

### 4. "My agent understands me better" (2024)
**"Integrating Dynamic Human-like Memory Recall and Consolidation in LLM-Based Agents"**
- Paper: https://arxiv.org/abs/2404.00573
- Builds on Park et al. (Generative Agents) scoring
- Adds **memory consolidation** — periodic process where related short-term memories are merged into long-term summaries
- Similar to how humans consolidate memories during sleep
- **Relevant for our heartbeat system** — could consolidate during heartbeat cycles

### 5. Memory Survey (2025)
**"Memory in the Age of AI Agents: A Survey"**
- GitHub paper list: https://github.com/Shichun-Liu/Agent-Memory-Paper-List
- Comprehensive survey of 100+ papers on agent memory
- Key taxonomy: sensory → short-term → long-term (mirrors human memory)
- Identifies gap: most systems lack "coordinated forgetting protocols"

### 6. Multiple Memory Systems (2025)
**"Multiple Memory Systems for Enhancing the Long-term Memory of Agent"**
- Paper: https://arxiv.org/abs/2508.15294
- Uses exponential decay model mimicking Ebbinghaus
- Separates episodic (events) vs semantic (facts) memory — different decay rates
- Facts decay slower than episodes (as in humans)

## Key Insights

1. **The math is well-established** — Ebbinghaus curve + ACT-R activation are decades old, well-studied
2. **Recall = reinforcement** — accessing a memory makes it stronger (universally agreed)
3. **Importance scoring** — LLM can rate importance at write time (cheap, one-shot)
4. **Association boost** — related memories should activate together (spreading activation)
5. **Consolidation** — periodic merging of episodic → semantic memory (like human sleep)
6. **Nobody has shipped this in a production agent platform** — all papers are academic prototypes

## What We Already Have

Our current OpenClaw setup has building blocks:
- **Ontology graph** (`memory/ontology/graph.jsonl`) — entity relationships = association links
- **Daily logs** (`memory/YYYY-MM-DD.md`) — episodic memory with timestamps
- **MEMORY.md** — curated semantic memory (manually consolidated)
- **Vector search** (`memory_search`) — relevance scoring via embeddings
- **Heartbeat system** — natural consolidation cycle (every 30min)

What's missing:
- Decay scores per memory chunk
- Recall tracking (when was each chunk last accessed?)
- Importance scoring at write time
- Spreading activation via graph edges
- Decay-weighted retrieval ranking
