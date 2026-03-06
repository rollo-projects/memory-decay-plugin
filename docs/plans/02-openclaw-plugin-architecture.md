# OpenClaw Plugin Architecture — How to Build a Memory Plugin

## Plugin System Overview

OpenClaw plugins are TypeScript modules loaded at runtime via `jiti`.
They run **in-process** with the Gateway (trusted code).

### Plugin Structure

```
memory-decay-plugin/
├── openclaw.plugin.json    # Manifest (required)
├── src/
│   └── index.ts            # Plugin entry point
├── package.json
└── tsconfig.json
```

### Manifest (`openclaw.plugin.json`)

```json
{
  "id": "memory-decay",
  "kind": "memory",
  "name": "Memory Decay",
  "description": "Human-like memory with gradual decay and associative recall",
  "version": "0.1.0",
  "configSchema": {
    "type": "object",
    "additionalProperties": false,
    "properties": {
      "decayRate": {
        "type": "number",
        "default": 0.5,
        "description": "Base decay rate (higher = faster forgetting)"
      },
      "recencyWeight": {
        "type": "number",
        "default": 1.0
      },
      "importanceWeight": {
        "type": "number",
        "default": 1.0
      },
      "relevanceWeight": {
        "type": "number",
        "default": 1.0
      },
      "activationThreshold": {
        "type": "number",
        "default": 0.1,
        "description": "Memories below this activation are excluded from results"
      }
    }
  }
}
```

**Key:** `"kind": "memory"` — this registers it as a memory slot plugin.

### Plugin Entry Point

```typescript
import { Type } from "@sinclair/typebox";

export default function (api) {
  // Register tools that replace memory-core tools
  api.registerTool({
    name: "memory_search",
    description: "Semantic search with decay-weighted ranking",
    parameters: Type.Object({
      query: Type.String(),
      maxResults: Type.Optional(Type.Number()),
      minScore: Type.Optional(Type.Number()),
    }),
    async execute(_id, params) {
      // 1. Get vector search results (base relevance)
      // 2. Load decay metadata for each chunk
      // 3. Calculate activation = f(recency, importance, relevance, associations)
      // 4. Filter by activation threshold
      // 5. Return sorted by activation score
      // 6. Update lastRecalled timestamp for returned results
    },
  });

  api.registerTool({
    name: "memory_get",
    description: "Read memory file with recall tracking",
    parameters: Type.Object({
      path: Type.String(),
      from: Type.Optional(Type.Number()),
      lines: Type.Optional(Type.Number()),
    }),
    async execute(_id, params) {
      // Read file + update recall metadata
    },
  });
}
```

### Installation & Configuration

```bash
# Install plugin
openclaw plugins install memory-decay

# Configure in openclaw.json
{
  "plugins": {
    "slots": {
      "memory": "memory-decay"  // replaces memory-core
    },
    "entries": {
      "memory-decay": {
        "enabled": true,
        "config": {
          "decayRate": 0.5,
          "recencyWeight": 1.0,
          "importanceWeight": 1.0,
          "relevanceWeight": 1.0
        }
      }
    }
  }
}
```

## Existing Memory Plugins (for reference)

### memory-core (bundled, default)
- Vector search over MEMORY.md + memory/*.md
- ~400 token chunks, 80 token overlap
- SQLite + sqlite-vec for embeddings
- FTS5 for full-text search
- No decay, no recall tracking, flat ranking

### memory-lancedb (bundled, alternative)
- LanceDB backend
- Auto-recall: injects relevant memories before each agent run
- Auto-capture: saves new memories after each run
- Set via `plugins.slots.memory = "memory-lancedb"`

### Third-party examples
- **Mem0** (`@mem0/openclaw-mem0`) — external memory API, auto-recall/capture
- **Supermemory** (`openclaw-supermemory`) — container-based memory routing
- **MemOS Cloud** — lifecycle hooks for recall/save
- **openclaw-mem** — sidecar adapter with SQLite receipts

## Plugin SDK Import Paths

```typescript
// For memory plugins specifically:
import { ... } from "openclaw/plugin-sdk/memory-core";
// or
import { ... } from "openclaw/plugin-sdk/memory-lancedb";
// Generic plugin APIs:
import { ... } from "openclaw/plugin-sdk/core";
```

## Key Technical Questions (TBD)

1. **Can we wrap memory-core?** Instead of replacing it entirely, can we intercept its results and apply decay scoring on top? This would be much simpler — we keep the indexing/embedding logic and just modify ranking.

2. **Where to store metadata?** Decay scores, recall counts, importance ratings need storage. Options:
   - Separate SQLite DB in workspace
   - JSON sidecar files alongside memory markdown
   - Extend the existing sqlite-vec DB

3. **How does the slot system work internally?** When `plugins.slots.memory = "memory-decay"`, does OpenClaw completely delegate `memory_search` and `memory_get` to our plugin, or does it layer on top?

4. **Auto-recall integration:** If we replace the memory slot, do we also need to handle auto-recall (injecting memories into system prompt), or does OpenClaw core handle that separately?

5. **Embedding access:** Can we reuse memory-core's embedding pipeline, or do we need our own? Ideally we'd use the same embeddings and just modify the scoring/ranking layer.
