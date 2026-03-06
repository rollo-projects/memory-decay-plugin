import { Type, type Static } from "@sinclair/typebox";
import Database from "better-sqlite3";
import { createHash } from "node:crypto";
import { readFileSync, existsSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";

// ---------------------------------------------------------------------------
// Types — aligned with OpenClaw plugin SDK
// ---------------------------------------------------------------------------

/** Shape of MemorySearchResult from openclaw/plugin-sdk/memory/types */
interface MemorySearchResult {
  path: string;
  startLine: number;
  endLine: number;
  score: number;
  snippet: string;
  source: string;
  citation?: string;
}

/** Shape of AgentToolResult from @mariozechner/pi-agent-core */
interface AgentToolResult<T = unknown> {
  content: Array<{ type: "text"; text: string } | { type: "image"; source: unknown }>;
  details: T;
}

/** Shape of OpenClawPluginToolContext from openclaw/plugin-sdk/plugins/types */
interface ToolContext {
  config?: Record<string, unknown>;
  workspaceDir?: string;
  agentDir?: string;
  agentId?: string;
  sessionKey?: string;
  sessionId?: string;
  messageChannel?: string;
  agentAccountId?: string;
  requesterSenderId?: string;
  senderIsOwner?: boolean;
  sandboxed?: boolean;
}

/** Shape of OpenClawPluginApi (subset we use) */
interface PluginApi {
  id: string;
  name: string;
  config: Record<string, unknown>;
  pluginConfig?: Record<string, unknown>;
  runtime: {
    tools: {
      createMemorySearchTool: (opts: {
        config?: Record<string, unknown>;
        agentSessionKey?: string;
      }) => AgentTool | null;
      createMemoryGetTool: (opts: {
        config?: Record<string, unknown>;
        agentSessionKey?: string;
      }) => AgentTool | null;
    };
    state: {
      resolveStateDir: (scope: string) => string;
    };
  };
  logger: {
    debug?: (msg: string) => void;
    info: (msg: string) => void;
    warn: (msg: string) => void;
    error: (msg: string) => void;
  };
  registerTool: (
    tool: AgentTool | ToolFactory,
    opts?: { name?: string; names?: string[]; optional?: boolean },
  ) => void;
  resolvePath: (input: string) => string;
  on: (hookName: string, handler: (...args: unknown[]) => unknown, opts?: { priority?: number }) => void;
}

interface AgentTool {
  name: string;
  label: string;
  description: string;
  parameters: unknown;
  execute: (
    toolCallId: string,
    params: Record<string, unknown>,
    signal?: AbortSignal,
  ) => Promise<AgentToolResult>;
}

type ToolFactory = (ctx: ToolContext) => AgentTool | AgentTool[] | null | undefined;

// ---------------------------------------------------------------------------
// Ontology graph entry — supports name field for entity matching
// ---------------------------------------------------------------------------

interface OntologyEntry {
  source: string;
  target: string;
  relation: string;
  weight?: number;
  sourceName?: string;
  targetName?: string;
}

// ---------------------------------------------------------------------------
// Plugin configuration
// ---------------------------------------------------------------------------

export interface DecayPluginConfig {
  halfLifeDays: number;
  weights: {
    recency: number;
    importance: number;
    relevance: number;
    association: number;
  };
  activationThreshold: number;
  autoRateImportance: boolean;
  ontologyPath: string;
}

const DEFAULT_CONFIG: DecayPluginConfig = {
  halfLifeDays: 14,
  weights: { recency: 1.0, importance: 1.0, relevance: 1.0, association: 0.5 },
  activationThreshold: 0.05,
  autoRateImportance: false,
  ontologyPath: "memory/ontology/graph.jsonl",
};

// ---------------------------------------------------------------------------
// Chunk metadata (SQLite row)
// ---------------------------------------------------------------------------

interface ChunkMetadata {
  chunk_id: string;
  file_path: string;
  line_start: number | null;
  line_end: number | null;
  created_at: number;
  last_recalled_at: number | null;
  recall_count: number;
  importance: number;
  importance_rated: number;
  decay_score: number;
  entity_ids: string | null;
}

// ---------------------------------------------------------------------------
// Decay math — uses OpenClaw SDK's temporal-decay model + recall reinforcement
//
// NOTE: toDecayLambda, calculateTemporalDecayMultiplier, applyTemporalDecayToScore
// are duplicated from openclaw/dist/plugin-sdk/memory/temporal-decay.
// They are kept local to avoid a hard runtime dependency on SDK internals.
// If updating, verify parity with the SDK versions.
// ---------------------------------------------------------------------------

/**
 * Convert half-life in days to decay lambda.
 * Matches openclaw/plugin-sdk/memory/temporal-decay:toDecayLambda.
 */
export function toDecayLambda(halfLifeDays: number): number {
  return Math.LN2 / halfLifeDays;
}

/**
 * Exponential temporal decay multiplier based on age.
 * Matches openclaw/plugin-sdk/memory/temporal-decay:calculateTemporalDecayMultiplier.
 *
 * Returns e^(-lambda * ageInDays), a value in (0, 1].
 */
export function calculateTemporalDecayMultiplier(params: {
  ageInDays: number;
  halfLifeDays: number;
}): number {
  if (params.ageInDays <= 0) return 1;
  const lambda = toDecayLambda(params.halfLifeDays);
  return Math.exp(-lambda * params.ageInDays);
}

/**
 * Apply temporal decay to a base score.
 * Matches openclaw/plugin-sdk/memory/temporal-decay:applyTemporalDecayToScore.
 */
export function applyTemporalDecayToScore(params: {
  score: number;
  ageInDays: number;
  halfLifeDays: number;
}): number {
  return params.score * calculateTemporalDecayMultiplier(params);
}

/**
 * Recall reinforcement factor: memories accessed more often decay slower.
 *
 * Inspired by ACT-R base-level learning: frequent recall strengthens memory.
 * Factor is ln(n + 1) which gives diminishing returns for additional recalls.
 * n=0 → 0, n=1 → 0.69, n=5 → 1.79, n=20 → 3.04
 */
export function recallReinforcementFactor(recallCount: number): number {
  return Math.log(recallCount + 1);
}

/**
 * Compute recency score for a memory chunk.
 *
 * Combines OpenClaw's temporal decay (half-life exponential) with
 * recall reinforcement (ACT-R inspired). Uses last-access time rather
 * than creation time for decay, so recalling a memory resets its clock.
 *
 * Result is in [0, 1] via sigmoid normalization.
 */
export function calculateRecency(
  recallCount: number,
  lastRecalledAt: number | null,
  createdAt: number,
  now: number,
  halfLifeDays: number,
): number {
  const lastAccess = lastRecalledAt ?? createdAt;
  const ageInDays = Math.max((now - lastAccess) / 86_400_000, 0);

  // Base temporal decay from SDK formula
  const temporalDecay = calculateTemporalDecayMultiplier({ ageInDays, halfLifeDays });

  // Recall reinforcement boost (ACT-R)
  const reinforcement = recallReinforcementFactor(recallCount);

  // Combine: decay + reinforcement → sigmoid to [0, 1]
  // When temporalDecay=1 and reinforcement=0: raw=0 → sigmoid=0.5 (brand new)
  // When temporalDecay→0 and reinforcement=0: raw→-large → sigmoid→0 (forgotten)
  // When temporalDecay=1 and reinforcement=high: raw→+large → sigmoid→1 (well-known)
  const raw = Math.log(temporalDecay + 1e-10) + reinforcement;
  return 1 / (1 + Math.exp(-raw));
}

/**
 * Weighted activation score for a memory chunk.
 *
 * activation = (w_r * recency + w_i * importance + w_rel * relevance + w_a * association) / Σw
 */
export function computeActivation(
  recency: number,
  importance: number,
  relevance: number,
  associationBoost: number,
  weights: DecayPluginConfig["weights"],
): number {
  const { recency: wr, importance: wi, relevance: wrel, association: wa } = weights;
  const totalWeight = wr + wi + wrel + wa;
  if (totalWeight === 0) return 0;

  const raw = wr * recency + wi * importance + wrel * relevance + wa * associationBoost;
  return raw / totalWeight;
}

// ---------------------------------------------------------------------------
// Chunk ID generation
// ---------------------------------------------------------------------------

export function chunkId(filePath: string, lineStart?: number, lineEnd?: number): string {
  const key = `${filePath}:${lineStart ?? 0}:${lineEnd ?? 0}`;
  return createHash("sha256").update(key).digest("hex").slice(0, 16);
}

// ---------------------------------------------------------------------------
// Ontology graph loader
// ---------------------------------------------------------------------------

export class OntologyGraph {
  /** entityId → [{ target, relation, weight }] */
  private adjacency = new Map<string, OntologyEntry[]>();
  /** lowercased name → entityId */
  private nameToId = new Map<string, string>();

  load(graphPath: string): void {
    this.adjacency.clear();
    this.nameToId.clear();
    if (!existsSync(graphPath)) return;

    const raw = readFileSync(graphPath, "utf-8");
    for (const line of raw.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        const entry = JSON.parse(trimmed) as OntologyEntry;
        this.addEdge(entry.source, entry);
        this.addEdge(entry.target, {
          ...entry,
          source: entry.target,
          target: entry.source,
          sourceName: entry.targetName,
          targetName: entry.sourceName,
        });
        // Index entity names for text matching
        if (entry.sourceName) {
          this.nameToId.set(entry.sourceName.toLowerCase(), entry.source);
        }
        if (entry.targetName) {
          this.nameToId.set(entry.targetName.toLowerCase(), entry.target);
        }
      } catch {
        // skip malformed lines
      }
    }
  }

  private addEdge(node: string, entry: OntologyEntry): void {
    const existing = this.adjacency.get(node);
    if (existing) {
      existing.push(entry);
    } else {
      this.adjacency.set(node, [entry]);
    }
  }

  /**
   * Spreading activation: given active entity IDs, compute boost for a chunk's entities.
   */
  boost(chunkEntityIds: string[], activeEntities: string[]): number {
    if (!chunkEntityIds.length || !activeEntities.length) return 0;

    let boost = 0;
    const activeSet = new Set(activeEntities);

    for (const entityId of chunkEntityIds) {
      if (activeSet.has(entityId)) {
        boost += 0.5;
        continue;
      }
      const links = this.adjacency.get(entityId);
      if (!links) continue;
      for (const link of links) {
        if (activeSet.has(link.target)) {
          boost += link.weight ?? 0.3;
        }
      }
    }
    return Math.min(boost, 1.0);
  }

  /**
   * Extract entity IDs mentioned in text by matching on entity **names**, not IDs.
   * E.g. query "rent agreement" matches entity name "rent agreement" → id "doc_rent_2024_2027".
   */
  extractEntities(text: string): string[] {
    const found: string[] = [];
    const lower = text.toLowerCase();
    for (const [name, id] of this.nameToId) {
      // Word boundary check: avoid matching "go" inside "google"
      const idx = lower.indexOf(name);
      if (idx === -1) continue;
      const before = idx > 0 ? lower[idx - 1] : " ";
      const after = idx + name.length < lower.length ? lower[idx + name.length] : " ";
      const isWordBoundary = (ch: string) => !/[a-z0-9_]/.test(ch);
      if (isWordBoundary(before) && isWordBoundary(after)) {
        found.push(id);
      }
    }
    return [...new Set(found)];
  }
}

// ---------------------------------------------------------------------------
// Metadata database
// ---------------------------------------------------------------------------

export class MetadataStore {
  private db: Database.Database;
  private stmts!: {
    upsert: Database.Statement;
    get: Database.Statement;
    getByFile: Database.Statement;
    updateRecall: Database.Statement;
    updateImportance: Database.Statement;
    updateEntities: Database.Statement;
  };

  constructor(dbPath: string) {
    this.db = new Database(dbPath);
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("synchronous = NORMAL");
    this.migrate();
    this.prepareStatements();
  }

  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS memory_chunks (
        chunk_id TEXT PRIMARY KEY,
        file_path TEXT NOT NULL,
        line_start INTEGER,
        line_end INTEGER,
        created_at INTEGER NOT NULL,
        last_recalled_at INTEGER,
        recall_count INTEGER DEFAULT 0,
        importance REAL DEFAULT 0.5,
        importance_rated INTEGER DEFAULT 0,
        decay_score REAL DEFAULT 1.0,
        entity_ids TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_chunks_file ON memory_chunks(file_path);
      CREATE INDEX IF NOT EXISTS idx_chunks_decay ON memory_chunks(decay_score);
    `);
  }

  private prepareStatements(): void {
    this.stmts = {
      upsert: this.db.prepare(`
        INSERT INTO memory_chunks (chunk_id, file_path, line_start, line_end, created_at, importance)
        VALUES (@chunk_id, @file_path, @line_start, @line_end, @created_at, @importance)
        ON CONFLICT(chunk_id) DO NOTHING
      `),
      get: this.db.prepare(`SELECT * FROM memory_chunks WHERE chunk_id = ?`),
      getByFile: this.db.prepare(`SELECT * FROM memory_chunks WHERE file_path = ?`),
      updateRecall: this.db.prepare(`
        UPDATE memory_chunks
        SET last_recalled_at = @now, recall_count = recall_count + 1, decay_score = @decay_score
        WHERE chunk_id = @chunk_id
      `),
      updateImportance: this.db.prepare(`
        UPDATE memory_chunks SET importance = @importance, importance_rated = 1
        WHERE chunk_id = @chunk_id
      `),
      updateEntities: this.db.prepare(`
        UPDATE memory_chunks SET entity_ids = @entity_ids
        WHERE chunk_id = @chunk_id
      `),
    };
  }

  ensureChunk(
    id: string,
    filePath: string,
    lineStart?: number,
    lineEnd?: number,
  ): ChunkMetadata {
    const existing = this.stmts.get.get(id) as ChunkMetadata | undefined;
    if (existing) return existing;

    const now = Date.now();
    this.stmts.upsert.run({
      chunk_id: id,
      file_path: filePath,
      line_start: lineStart ?? null,
      line_end: lineEnd ?? null,
      created_at: now,
      importance: 0.5,
    });
    return this.stmts.get.get(id) as ChunkMetadata;
  }

  recordRecall(id: string, decayScore: number): void {
    this.stmts.updateRecall.run({
      chunk_id: id,
      now: Date.now(),
      decay_score: decayScore,
    });
  }

  setImportance(id: string, importance: number): void {
    this.stmts.updateImportance.run({ chunk_id: id, importance });
  }

  updateEntities(id: string, entityIds: string[]): void {
    this.stmts.updateEntities.run({
      chunk_id: id,
      entity_ids: entityIds.length ? entityIds.join(",") : null,
    });
  }

  getByFile(filePath: string): ChunkMetadata[] {
    return this.stmts.getByFile.all(filePath) as ChunkMetadata[];
  }

  close(): void {
    this.db.close();
  }
}

// ---------------------------------------------------------------------------
// Tool result helpers
// ---------------------------------------------------------------------------

function jsonToolResult<T>(payload: T): AgentToolResult<T> {
  return {
    content: [{ type: "text", text: JSON.stringify(payload, null, 2) }],
    details: payload,
  };
}

function textToolResult(text: string): AgentToolResult<{ text: string }> {
  return {
    content: [{ type: "text", text }],
    details: { text },
  };
}

// ---------------------------------------------------------------------------
// Plugin definition — OpenClawPluginDefinition format
// ---------------------------------------------------------------------------

const memoryDecayPlugin = {
  id: "memory-decay",
  name: "Memory Decay",
  description:
    "Human-like memory with gradual decay (Ebbinghaus curve), recall reinforcement, and associative activation via knowledge graph",
  kind: "memory" as const,

  register(api: PluginApi) {
    const rawConfig = api.pluginConfig ?? {};
    const config: DecayPluginConfig = {
      halfLifeDays: (rawConfig.halfLifeDays as number) ?? DEFAULT_CONFIG.halfLifeDays,
      weights: { ...DEFAULT_CONFIG.weights, ...(rawConfig.weights as object) },
      activationThreshold:
        (rawConfig.activationThreshold as number) ?? DEFAULT_CONFIG.activationThreshold,
      autoRateImportance:
        (rawConfig.autoRateImportance as boolean) ?? DEFAULT_CONFIG.autoRateImportance,
      ontologyPath: (rawConfig.ontologyPath as string) ?? DEFAULT_CONFIG.ontologyPath,
    };

    const workspaceDir: string = api.resolvePath(".");
    const dbDir = resolve(workspaceDir, ".memory-decay");

    let store: MetadataStore;
    try {
      mkdirSync(dbDir, { recursive: true });
      const dbPath = resolve(dbDir, "metadata.db");
      store = new MetadataStore(dbPath);
    } catch (err) {
      api.logger.warn(
        `memory-decay: SQLite init failed (${err instanceof Error ? err.message : err}), plugin disabled — falling through to base memory tools`,
      );
      return;
    }

    const graph = new OntologyGraph();

    try {
      graph.load(resolve(workspaceDir, config.ontologyPath));
    } catch {
      api.logger.warn("memory-decay: ontology graph not loaded, association boost disabled");
    }

    // -----------------------------------------------------------------
    // Tool factory: wraps memory-core tools with decay scoring
    // -----------------------------------------------------------------

    const toolFactory: ToolFactory = (ctx: ToolContext) => {
      // Create base memory-core tools we're wrapping
      const baseSearchTool = api.runtime.tools.createMemorySearchTool({
        config: ctx.config,
        agentSessionKey: ctx.sessionKey,
      });
      const baseGetTool = api.runtime.tools.createMemoryGetTool({
        config: ctx.config,
        agentSessionKey: ctx.sessionKey,
      });

      if (!baseSearchTool || !baseGetTool) {
        api.logger.warn("memory-decay: base memory tools unavailable, plugin disabled");
        return null;
      }

      // --- memory_search with decay re-ranking ---

      const memorySearchTool: AgentTool = {
        name: "memory_search",
        label: "Memory Search (decay-weighted)",
        description:
          "Search memories with decay-weighted ranking. Recent, important, and frequently-recalled memories score higher. Associated memories get a boost when related topics are active.",
        parameters: Type.Object({
          query: Type.String({ description: "Natural language search query" }),
          maxResults: Type.Optional(
            Type.Number({ description: "Max results to return", default: 10 }),
          ),
        }),
        async execute(toolCallId: string, params: Record<string, unknown>) {
          const query = params.query as string;
          const maxResults = (params.maxResults as number) ?? 10;
          const now = Date.now();

          // Step 1: Get base results from memory-core (request 3x for headroom)
          const baseResult = await baseSearchTool.execute(toolCallId, {
            query,
            maxResults: maxResults * 3,
          });

          const details = baseResult.details as Record<string, unknown> | undefined;
          const baseResults: MemorySearchResult[] =
            (details?.results as MemorySearchResult[])
            ?? (details as unknown as MemorySearchResult[])
            ?? [];

          if (!baseResults.length) {
            api.logger.info(`memory-decay: search query="${query}" baseResults=0 decayFiltered=0 threshold=${config.activationThreshold} activeEntities=[]`);
            return jsonToolResult({ results: [], message: "No memories found." });
          }

          // Decay scoring pipeline — wrapped for fallback safety
          try {
            // Step 2: Extract active entities from query for spreading activation
            let activeEntities: string[] = [];
            try {
              activeEntities = graph.extractEntities(query);
            } catch (err) {
              api.logger.warn(`memory-decay: entity extraction failed for query, continuing with empty entities. Error: ${err instanceof Error ? err.message : err}`);
            }

            // Step 3: Score each result with decay weighting
            const scored = baseResults.map((result) => {
              const id = chunkId(result.path, result.startLine, result.endLine);
              const meta = store.ensureChunk(
                id,
                result.path,
                result.startLine,
                result.endLine,
              );

              // Populate entity_ids if not yet extracted
              if (meta.entity_ids == null && result.snippet) {
                try {
                  const extracted = graph.extractEntities(result.snippet);
                  if (extracted.length) {
                    api.logger.debug?.(`memory-decay: entities extracted chunk=${id} entities=[${extracted.join(",")}] from snippet`);
                    try {
                      store.updateEntities(id, extracted);
                    } catch (err) {
                      api.logger.warn(`memory-decay: updateEntities failed for chunk=${id}. Error: ${err instanceof Error ? err.message : err}`);
                    }
                    meta.entity_ids = extracted.join(",");
                  }
                } catch (err) {
                  api.logger.warn(`memory-decay: entity extraction failed for chunk=${id}, continuing. Error: ${err instanceof Error ? err.message : err}`);
                }
              }

              const recency = calculateRecency(
                meta.recall_count,
                meta.last_recalled_at,
                meta.created_at,
                now,
                config.halfLifeDays,
              );

              const importance = meta.importance;
              const relevance = result.score;
              const chunkEntities = meta.entity_ids?.split(",").filter(Boolean) ?? [];
              const associationBoost = graph.boost(chunkEntities, activeEntities);

              const activation = computeActivation(
                recency,
                importance,
                relevance,
                associationBoost,
                config.weights,
              );

              api.logger.debug?.(`memory-decay: scored chunk=${id} path=${result.path} baseScore=${result.score} → activation=${activation.toFixed(4)} (recency=${recency.toFixed(4)} importance=${importance} association=${associationBoost.toFixed(4)} recalls=${meta.recall_count})`);

              return {
                ...result,
                chunkId: id,
                activation,
                recency,
                importance,
                associationBoost,
                recallCount: meta.recall_count,
              };
            });

            // Step 4: Filter by activation threshold
            const filtered = scored.filter(
              (r) => r.activation >= config.activationThreshold,
            );

            // Step 5: Sort by activation (descending) and take top N
            filtered.sort((a, b) => b.activation - a.activation);
            const topResults = filtered.slice(0, maxResults);

            // Step 6: Reinforcement — update recall metadata for returned results
            for (const result of topResults) {
              const newRecency = calculateRecency(
                result.recallCount + 1,
                now,
                now,
                now,
                config.halfLifeDays,
              );
              store.recordRecall(result.chunkId, newRecency);
              api.logger.debug?.(`memory-decay: recall chunk=${result.chunkId} path=${result.path} newRecallCount=${result.recallCount + 1}`);
            }

            api.logger.info(`memory-decay: search query="${query}" baseResults=${baseResults.length} decayFiltered=${filtered.length} threshold=${config.activationThreshold} activeEntities=[${activeEntities.join(",")}]`);

            const output = {
              results: topResults.map((r) => ({
                path: r.path,
                snippet: r.snippet,
                score: r.activation,
                baseRelevance: r.score,
                recency: Math.round(r.recency * 100) / 100,
                importance: Math.round(r.importance * 100) / 100,
                recallCount: r.recallCount + 1,
                startLine: r.startLine,
                endLine: r.endLine,
                source: r.source,
                citation: r.citation,
              })),
            };

            return jsonToolResult(output);
          } catch (err) {
            api.logger.warn(`memory-decay: FALLBACK scoring failed for query="${query}", returning base results. Error: ${err instanceof Error ? err.message : err}`);
            return jsonToolResult({
              results: baseResults.slice(0, maxResults).map((r) => ({
                path: r.path,
                snippet: r.snippet,
                score: r.score,
                startLine: r.startLine,
                endLine: r.endLine,
                source: r.source,
                citation: r.citation,
              })),
            });
          }
        },
      };

      // --- memory_get with recall tracking ---

      const memoryGetTool: AgentTool = {
        name: "memory_get",
        label: "Memory Get (recall-tracked)",
        description: "Read a memory file. Tracks recall for decay scoring.",
        parameters: Type.Object({
          path: Type.String({ description: "File path relative to workspace" }),
          from: Type.Optional(Type.Number({ description: "Start line number" })),
          lines: Type.Optional(Type.Number({ description: "Number of lines to read" })),
        }),
        async execute(toolCallId: string, params: Record<string, unknown>) {
          const result = await baseGetTool.execute(toolCallId, params);

          try {
            const path = params.path as string;
            const from = params.from as number | undefined;
            const lines = params.lines as number | undefined;

            // Only track line range when both from and lines are known,
            // so chunk IDs can match what memory_search produces
            const startLine = from != null && lines != null ? from : undefined;
            const endLine = from != null && lines != null ? from + lines - 1 : undefined;

            const id = chunkId(path, startLine, endLine);
            const now = Date.now();
            const meta = store.ensureChunk(id, path, startLine, endLine);
            const recency = calculateRecency(
              meta.recall_count + 1,
              now,
              meta.created_at,
              now,
              config.halfLifeDays,
            );
            store.recordRecall(id, recency);
            api.logger.debug?.(`memory-decay: recall chunk=${id} path=${path} newRecallCount=${meta.recall_count + 1}`);
          } catch (err) {
            api.logger.warn(`memory-decay: recall tracking failed, returning base result. Error: ${err instanceof Error ? err.message : err}`);
          }

          return result;
        },
      };

      // --- memory_decay_status (diagnostic) ---

      const memoryDecayStatusTool: AgentTool = {
        name: "memory_decay_status",
        label: "Memory Decay Status",
        description:
          "Show decay status for memories in a file. Useful for understanding which memories are fading and which are strong.",
        parameters: Type.Object({
          path: Type.String({ description: "File path to inspect" }),
        }),
        async execute(_toolCallId: string, params: Record<string, unknown>) {
          const path = params.path as string;
          const chunks = store.getByFile(path);
          const now = Date.now();

          return jsonToolResult({
            file: path,
            halfLifeDays: config.halfLifeDays,
            chunks: chunks.map((c) => {
              const recency = calculateRecency(
                c.recall_count,
                c.last_recalled_at,
                c.created_at,
                now,
                config.halfLifeDays,
              );
              const hoursSinceRecall = c.last_recalled_at
                ? Math.round((now - c.last_recalled_at) / 3_600_000)
                : null;
              const daysSinceCreation = Math.round(
                (now - c.created_at) / 86_400_000,
              );

              return {
                chunkId: c.chunk_id,
                lines:
                  c.line_start != null
                    ? `${c.line_start}-${c.line_end}`
                    : "whole file",
                recency: Math.round(recency * 1000) / 1000,
                importance: c.importance,
                importanceRated: !!c.importance_rated,
                recallCount: c.recall_count,
                hoursSinceLastRecall: hoursSinceRecall,
                daysSinceCreation,
                decayScore: Math.round(c.decay_score * 1000) / 1000,
              };
            }),
          });
        },
      };

      // --- memory_set_importance ---

      const memorySetImportanceTool: AgentTool = {
        name: "memory_set_importance",
        label: "Set Memory Importance",
        description:
          "Set the importance score for a memory chunk. Scale: 0.0 (trivial) to 1.0 (critical).",
        parameters: Type.Object({
          path: Type.String({ description: "File path" }),
          importance: Type.Number({
            description: "Importance score 0.0-1.0",
            minimum: 0,
            maximum: 1,
          }),
          startLine: Type.Optional(Type.Number()),
          endLine: Type.Optional(Type.Number()),
        }),
        async execute(_toolCallId: string, params: Record<string, unknown>) {
          const path = params.path as string;
          const importance = params.importance as number;
          const startLine = params.startLine as number | undefined;
          const endLine = params.endLine as number | undefined;

          const id = chunkId(path, startLine, endLine);
          store.ensureChunk(id, path, startLine, endLine);
          store.setImportance(id, importance);
          api.logger.info(`memory-decay: importance set chunk=${id} path=${path} importance=${importance}`);
          return jsonToolResult({ chunkId: id, importance, updated: true });
        },
      };

      return [memorySearchTool, memoryGetTool, memoryDecayStatusTool, memorySetImportanceTool];
    };

    api.registerTool(toolFactory, {
      names: ["memory_search", "memory_get", "memory_decay_status", "memory_set_importance"],
    });

    // Cleanup on gateway stop
    api.on("gateway_stop", () => {
      store.close();
    });
  },
};

export default memoryDecayPlugin;
