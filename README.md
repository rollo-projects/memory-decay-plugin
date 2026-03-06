# memory-decay — Human-Like Memory for OpenClaw

An OpenClaw memory plugin that implements **gradual memory decay** inspired by cognitive science. Instead of binary remember/forget, memories fade naturally over time and can be "refreshed" through recall — just like human memory.

## The Problem

Current AI agent memory is binary:
- **Context window** = bright, vivid, but evaporates on session end
- **File storage** = permanent but flat, no notion of "freshness"

There's no gradient between these two states. A note from 3 months ago has the same weight as one from yesterday. Humans don't work this way — old memories fade but can resurface through associations.

## The Idea

Each memory entry gets a **decay score** that changes over time:
- New memories start bright
- Unused memories gradually fade (Ebbinghaus forgetting curve)
- Recalled memories get reinforced (spaced repetition effect)
- Associated memories get a boost when related topics come up (spreading activation)

When the agent retrieves memories, results are ranked by `decay_score × relevance`, so recent and frequently-used memories naturally surface first, while old unused ones fade into the background without being deleted.

## Status

🔬 **Research phase** — collecting papers, studying OpenClaw plugin architecture, planning implementation.

See `docs/plans/` for research notes and architecture plans.

## Key References

- [MemoryBank (AAAI 2024)](https://arxiv.org/abs/2305.10250) — Ebbinghaus forgetting curve for LLM memory
- [Generative Agents (Stanford, 2023)](https://arxiv.org/abs/2304.03442) — recency × importance × relevance scoring
- [ACT-R + LLM (HAI 2025)](https://dl.acm.org/doi/10.1145/3765766.3765803) — cognitive architecture for agent memory
- [Agent Memory Survey](https://github.com/Shichun-Liu/Agent-Memory-Paper-List) — comprehensive paper list

## License

MIT
