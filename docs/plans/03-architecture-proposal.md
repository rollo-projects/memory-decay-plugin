# Architecture Proposal — memory-decay plugin

## Overview

A memory plugin for OpenClaw that wraps the default memory-core with a decay-weighted scoring layer, inspired by:
- **Ebbinghaus Forgetting Curve** — exponential decay over time
- **ACT-R Base-Level Activation** — frequency × recency
- **Generative Agents (Stanford)** — recency × importance × relevance
- **Spreading Activation** — boost related memories via association graph

## Core Formula

```
activation(memory_i) = α₁ × recency(i) + α₂ × importance(i) + α₃ × relevance(i, query) + α₄ × association_boost(i, context)
```

Where:
- **recency(i)** = exponential decay since last access: `e^(-λ × hours_since_last_recall)`
- **importance(i)** = LLM-rated importance score (1-10) at write time, normalized to [0,1]
- **relevance(i, query)** = cosine similarity from vector search (already provided by memory-core)
- **association_boost(i, context)** = sum of activation spreading from related entities in ontology graph
- **α₁..α₄** = configurable weights (default all 1.0)

## Data Model

### Metadata Store (SQLite)

```sql
CREATE TABLE memory_chunks (
    chunk_id TEXT PRIMARY KEY,          -- hash of file_path + line_range
    file_path TEXT NOT NULL,
    line_start INTEGER,
    line_end INTEGER,
    created_at INTEGER NOT NULL,        -- unix timestamp
    last_recalled_at INTEGER,           -- updated on each access
    recall_count INTEGER DEFAULT 0,     -- total times recalled
    importance REAL DEFAULT 0.5,        -- LLM-rated [0,1]
    importance_rated BOOLEAN DEFAULT 0, -- has LLM rated this?
    decay_score REAL DEFAULT 1.0,       -- current activation level
    entity_ids TEXT                     -- comma-separated ontology entity IDs
);

CREATE INDEX idx_chunks_file ON memory_chunks(file_path);
CREATE INDEX idx_chunks_decay ON memory_chunks(decay_score);
```

### Decay Calculation

```typescript
function calculateDecay(chunk: MemoryChunk, now: number): number {
    const hoursSinceRecall = (now - (chunk.lastRecalledAt || chunk.createdAt)) / 3600000;
    
    // ACT-R inspired: base-level activation
    // B = ln(n) - d × ln(T)
    // where n = recall count, T = time since last recall, d = decay rate
    const baseLevelActivation = Math.log(chunk.recallCount + 1) - 
                                 config.decayRate * Math.log(hoursSinceRecall + 1);
    
    // Normalize to [0, 1] via sigmoid
    return 1 / (1 + Math.exp(-baseLevelActivation));
}
```

### Importance Rating

On first retrieval of an unrated chunk, ask the LLM to rate importance:

```
Rate the importance of this memory on a scale of 1-10.
1 = trivial routine info (ate breakfast, weather check)
5 = useful context (project status, meeting notes)  
10 = critical personal info (passwords, deadlines, relationships)
Reply with just the number.
```

This is a cheap one-shot call. Cache the result — importance rarely changes.

### Spreading Activation (via Ontology Graph)

```typescript
function associationBoost(chunk: MemoryChunk, activeEntities: string[]): number {
    if (!chunk.entityIds?.length || !activeEntities.length) return 0;
    
    let boost = 0;
    for (const entityId of chunk.entityIds) {
        // Check if any active entity is linked to this chunk's entities
        const links = ontologyGraph.getLinks(entityId);
        for (const link of links) {
            if (activeEntities.includes(link.targetId)) {
                boost += link.weight || 0.3; // default association strength
            }
        }
    }
    return Math.min(boost, 1.0); // cap at 1.0
}
```

## Pipeline

### On `memory_search(query)`:
1. Run base vector search (from memory-core) → get `[{chunk, relevanceScore}]`
2. For each result, load metadata from SQLite
3. Calculate `activation = weighted_sum(recency, importance, relevance, association)`
4. Filter out chunks below `activationThreshold`
5. Re-sort by activation score
6. **Update `lastRecalledAt` and `recallCount`** for returned results (reinforcement!)
7. Return top-N

### On `memory_get(path, lines)`:
1. Read file (pass-through)
2. Update recall metadata for the accessed chunks
3. Return content

### On file change (watcher):
1. Detect new/modified chunks
2. For new chunks: create metadata entry, optionally rate importance
3. For modified chunks: update content hash, keep existing decay data
4. Link entities from ontology graph if mentioned

### Periodic consolidation (optional, via heartbeat):
1. Scan all chunks
2. Recalculate decay scores
3. Chunks that have been "dead" (score < 0.01) for 30+ days → archive
4. Generate consolidation summary of fading memories → write to MEMORY.md

## Architecture Options

### Option A: Wrapper Plugin (recommended for MVP)
- Install as `plugins.slots.memory = "memory-decay"`
- Internally use memory-core's vector search as base
- Add decay scoring layer on top
- Store metadata in separate SQLite DB
- **Pro:** Minimal code, reuse existing indexing
- **Con:** Depends on memory-core internals

### Option B: Standalone Plugin
- Full replacement of memory-core
- Own embedding pipeline + vector index + decay scoring
- **Pro:** Full control, no internal dependencies
- **Con:** Much more code, duplicating existing functionality

### Option C: Sidecar Plugin
- Don't replace memory slot at all
- Run alongside memory-core as a regular plugin
- Intercept via lifecycle hooks (pre-run/post-run)
- **Pro:** Zero risk, additive only
- **Con:** Can't modify memory_search ranking directly

**Recommendation:** Start with **Option A** (wrapper). If memory-core internals are too hard to wrap, fall back to **Option C** (sidecar).

## Configuration

```json
{
  "plugins": {
    "slots": {
      "memory": "memory-decay"
    },
    "entries": {
      "memory-decay": {
        "enabled": true,
        "config": {
          "decayRate": 0.5,
          "weights": {
            "recency": 1.0,
            "importance": 1.0,
            "relevance": 1.0,
            "association": 0.5
          },
          "activationThreshold": 0.05,
          "autoRateImportance": true,
          "consolidation": {
            "enabled": true,
            "archiveAfterDays": 90,
            "minDecayScore": 0.01
          },
          "ontologyPath": "memory/ontology/graph.jsonl"
        }
      }
    }
  }
}
```

## Open Questions

1. **Performance:** How much latency does the decay scoring add to each memory_search? SQLite lookup should be <1ms, but importance rating (if unrated) requires an LLM call.

2. **Cold start:** When first installed, all existing memories have no metadata. Batch-process on first run? Or lazy-rate on first recall?

3. **Multi-session:** If multiple sessions recall the same memory simultaneously, do we need locking on the recall counter?

4. **Observability:** Should we expose decay scores to the agent? ("This memory is fading, importance: 3/10, last recalled 45 days ago") — could help the agent decide whether to refresh/consolidate.

5. **Graph integration:** Our ontology graph is JSONL-based. Should we index it into the same SQLite DB for faster association lookups?

6. **Emotional valence:** Some research suggests emotionally charged memories decay slower. Could we add a "valence" score alongside importance?
