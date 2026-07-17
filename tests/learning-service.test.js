/**
 * Tests for .claude/helpers/learning-service.mjs
 *
 * learning-service.mjs has external dependencies (better-sqlite3, ONNX) that
 * are not installed in this project, so we cannot import the module directly.
 * Instead we inline-copy the pure, dependency-free components and test them.
 *
 * Inline tested:
 *  - CONFIG: value constraints and type correctness
 *  - HNSWIndex: add/search/remove/size, cosine similarity, dedup threshold
 *
 * Integration skeletons (marked .skip — enable when better-sqlite3 is installed):
 *  - LearningService.initialize: session bootstrap, short/long-term index counts
 *  - LearningService.storePattern: insertion, dedup on high similarity
 *  - LearningService.consolidate: short→long-term promotion at usage_count threshold
 *  - LearningService.endSession: archiving session state
 */

'use strict';

// ── Inline re-implementation of CONFIG ───────────────────────────────────────
// Mirrors the CONFIG object in learning-service.mjs exactly.

const CONFIG = {
  hnsw: { M: 16, efConstruction: 200, efSearch: 100, metric: 'cosine' },
  patterns: {
    shortTermMaxAge: 24 * 60 * 60 * 1000,
    promotionThreshold: 3,
    qualityThreshold: 0.6,
    maxShortTerm: 500,
    maxLongTerm: 2000,
    dedupThreshold: 0.95,
  },
  embedding: { dimension: 384, model: 'all-MiniLM-L6-v2', batchSize: 32 },
  consolidation: {
    interval: 30 * 60 * 1000,
    pruneAge: 30 * 24 * 60 * 60 * 1000,
    minUsageForKeep: 2,
  },
};

// ── Inline re-implementation of HNSWIndex ────────────────────────────────────

class HNSWIndex {
  constructor(config) {
    this.config = config;
    this.vectors = new Map();
    this.idToVector = new Map();
    this.vectorToId = new Map();
    this.nextVectorId = 0;
    this.dimension = config.embedding.dimension;
    this.layers = [];
    this.entryPoint = null;
    this.maxLevel = 0;
  }

  add(patternId, embedding) {
    const vectorId = this.nextVectorId++;
    const vector = embedding instanceof Float32Array ? embedding : new Float32Array(embedding);
    this.vectors.set(vectorId, vector);
    this.idToVector.set(patternId, vectorId);
    this.vectorToId.set(vectorId, patternId);
    this._insertIntoGraph(vectorId, vector);
    return vectorId;
  }

  search(queryEmbedding, k = 5) {
    const query = queryEmbedding instanceof Float32Array ? queryEmbedding : new Float32Array(queryEmbedding);
    if (this.vectors.size === 0) return { results: [], searchTimeMs: 0 };
    const candidates = this._searchGraph(query, k * 2);
    const results = candidates
      .map(({ vectorId, distance }) => ({
        patternId: this.vectorToId.get(vectorId),
        similarity: 1 - distance,
        vectorId,
      }))
      .sort((a, b) => b.similarity - a.similarity)
      .slice(0, k);
    return { results, searchTimeMs: 0 };
  }

  remove(patternId) {
    const vectorId = this.idToVector.get(patternId);
    if (vectorId === undefined) return false;
    this.vectors.delete(vectorId);
    this.idToVector.delete(patternId);
    this.vectorToId.delete(vectorId);
    return true;
  }

  size() { return this.vectors.size; }

  _cosineSimilarity(a, b) {
    let dot = 0, normA = 0, normB = 0;
    for (let i = 0; i < a.length; i++) {
      dot += a[i] * b[i];
      normA += a[i] * a[i];
      normB += b[i] * b[i];
    }
    const denom = Math.sqrt(normA) * Math.sqrt(normB);
    return denom > 0 ? dot / denom : 0;
  }

  _cosineDistance(a, b) { return 1 - this._cosineSimilarity(a, b); }

  _insertIntoGraph(vectorId, vector) {
    if (this.entryPoint === null) {
      this.entryPoint = vectorId;
      this.layers.push(new Map([[vectorId, new Set()]]));
      return;
    }
    if (this.layers.length === 0) this.layers.push(new Map());
    const layer = this.layers[0];
    layer.set(vectorId, new Set());
    const neighbors = this._findNearest(vector, this.config.hnsw.M);
    for (const { vectorId: neighborId } of neighbors) {
      layer.get(vectorId).add(neighborId);
      layer.get(neighborId)?.add(vectorId);
    }
  }

  _findNearest(query, k) {
    return Array.from(this.vectors.entries())
      .map(([vectorId, vector]) => ({ vectorId, distance: this._cosineDistance(query, vector) }))
      .sort((a, b) => a.distance - b.distance)
      .slice(0, k);
  }

  _searchGraph(query, k) {
    return Array.from(this.vectors.entries())
      .map(([vectorId, vector]) => ({ vectorId, distance: this._cosineDistance(query, vector) }))
      .sort((a, b) => a.distance - b.distance);
  }
}

// ── Helper ───────────────────────────────────────────────────────────────────

function randVec(dim = 8, seed = 1) {
  // Deterministic pseudo-random vector for reproducible tests
  const v = new Float32Array(dim);
  let s = seed;
  for (let i = 0; i < dim; i++) {
    s = (s * 1664525 + 1013904223) >>> 0;
    v[i] = (s / 0xFFFFFFFF) * 2 - 1;
  }
  return v;
}

function normalise(v) {
  let norm = 0;
  for (let i = 0; i < v.length; i++) norm += v[i] * v[i];
  norm = Math.sqrt(norm);
  return v.map(x => x / norm);
}

// ── CONFIG validation ─────────────────────────────────────────────────────────

describe('learning-service CONFIG', () => {
  it('HNSW M is a positive integer', () => {
    expect(Number.isInteger(CONFIG.hnsw.M)).toBe(true);
    expect(CONFIG.hnsw.M).toBeGreaterThan(0);
  });

  it('HNSW metric is cosine', () => {
    expect(CONFIG.hnsw.metric).toBe('cosine');
  });

  it('promotionThreshold is a positive integer', () => {
    expect(Number.isInteger(CONFIG.patterns.promotionThreshold)).toBe(true);
    expect(CONFIG.patterns.promotionThreshold).toBeGreaterThan(0);
  });

  it('qualityThreshold is between 0 and 1', () => {
    expect(CONFIG.patterns.qualityThreshold).toBeGreaterThan(0);
    expect(CONFIG.patterns.qualityThreshold).toBeLessThan(1);
  });

  it('dedupThreshold is very high (near 1.0)', () => {
    expect(CONFIG.patterns.dedupThreshold).toBeGreaterThan(0.9);
    expect(CONFIG.patterns.dedupThreshold).toBeLessThanOrEqual(1.0);
  });

  it('maxShortTerm < maxLongTerm (short-term is eviction-bounded)', () => {
    expect(CONFIG.patterns.maxShortTerm).toBeLessThan(CONFIG.patterns.maxLongTerm);
  });

  it('embedding dimension is 384 (MiniLM-L6)', () => {
    expect(CONFIG.embedding.dimension).toBe(384);
  });

  it('consolidation interval is 30 minutes', () => {
    expect(CONFIG.consolidation.interval).toBe(30 * 60 * 1000);
  });

  it('shortTermMaxAge is 24 hours', () => {
    expect(CONFIG.patterns.shortTermMaxAge).toBe(24 * 60 * 60 * 1000);
  });
});

// ── HNSWIndex: add / size / remove ───────────────────────────────────────────

describe('HNSWIndex.add() / size() / remove()', () => {
  it('starts at size 0', () => {
    const idx = new HNSWIndex(CONFIG);
    expect(idx.size()).toBe(0);
  });

  it('increments size on add', () => {
    const idx = new HNSWIndex(CONFIG);
    idx.add('p1', randVec(8, 1));
    idx.add('p2', randVec(8, 2));
    expect(idx.size()).toBe(2);
  });

  it('accepts plain arrays as well as Float32Arrays', () => {
    const idx = new HNSWIndex(CONFIG);
    idx.add('plain', [0.1, 0.2, 0.3, 0.4]);
    expect(idx.size()).toBe(1);
  });

  it('returns true when removing existing pattern', () => {
    const idx = new HNSWIndex(CONFIG);
    idx.add('rm1', randVec(8, 3));
    expect(idx.remove('rm1')).toBe(true);
    expect(idx.size()).toBe(0);
  });

  it('returns false when removing non-existent pattern', () => {
    const idx = new HNSWIndex(CONFIG);
    expect(idx.remove('ghost')).toBe(false);
  });

  it('entry point is set to first added vector', () => {
    const idx = new HNSWIndex(CONFIG);
    idx.add('first', randVec(8, 1));
    expect(idx.entryPoint).toBe(0);
  });
});

// ── HNSWIndex: search ─────────────────────────────────────────────────────────

describe('HNSWIndex.search()', () => {
  it('returns empty results for empty index', () => {
    const idx = new HNSWIndex(CONFIG);
    const { results } = idx.search(randVec(8, 1), 3);
    expect(results).toEqual([]);
  });

  it('returns at most k results', () => {
    const idx = new HNSWIndex(CONFIG);
    for (let i = 0; i < 10; i++) idx.add(`p${i}`, randVec(8, i + 1));
    const { results } = idx.search(randVec(8, 99), 3);
    expect(results.length).toBeLessThanOrEqual(3);
  });

  it('similarity scores are between -1 and 1', () => {
    const idx = new HNSWIndex(CONFIG);
    for (let i = 0; i < 5; i++) idx.add(`v${i}`, randVec(8, i + 1));
    const { results } = idx.search(randVec(8, 42), 5);
    for (const r of results) {
      expect(r.similarity).toBeGreaterThanOrEqual(-1);
      expect(r.similarity).toBeLessThanOrEqual(1);
    }
  });

  it('identical vector returns similarity ~1.0', () => {
    const idx = new HNSWIndex(CONFIG);
    const v = normalise(randVec(8, 7));
    idx.add('exact', v);
    const { results } = idx.search(v, 1);
    expect(results[0].similarity).toBeCloseTo(1.0, 5);
  });

  it('returns patternId string for each result', () => {
    const idx = new HNSWIndex(CONFIG);
    idx.add('pat-abc', randVec(8, 1));
    const { results } = idx.search(randVec(8, 2), 1);
    expect(results[0].patternId).toBe('pat-abc');
  });

  it('most similar result comes first (sorted descending)', () => {
    const idx = new HNSWIndex(CONFIG);
    // v1 is close to query, v2 is orthogonal
    const query = normalise(new Float32Array([1, 0, 0, 0, 0, 0, 0, 0]));
    const close  = normalise(new Float32Array([0.9, 0.1, 0, 0, 0, 0, 0, 0]));
    const far    = normalise(new Float32Array([0, 1, 0, 0, 0, 0, 0, 0]));
    idx.add('close', close);
    idx.add('far', far);
    const { results } = idx.search(query, 2);
    expect(results[0].patternId).toBe('close');
    expect(results[0].similarity).toBeGreaterThan(results[1].similarity);
  });
});

// ── HNSWIndex: cosine similarity ──────────────────────────────────────────────

describe('HNSWIndex._cosineSimilarity()', () => {
  const idx = new HNSWIndex(CONFIG);

  it('identical vectors → 1.0', () => {
    const v = new Float32Array([1, 2, 3]);
    expect(idx._cosineSimilarity(v, v)).toBeCloseTo(1.0, 5);
  });

  it('orthogonal vectors → 0.0', () => {
    const a = new Float32Array([1, 0]);
    const b = new Float32Array([0, 1]);
    expect(idx._cosineSimilarity(a, b)).toBeCloseTo(0.0, 5);
  });

  it('opposite vectors → -1.0', () => {
    const a = new Float32Array([1, 0]);
    const b = new Float32Array([-1, 0]);
    expect(idx._cosineSimilarity(a, b)).toBeCloseTo(-1.0, 5);
  });

  it('zero vector → 0.0 (safe divide)', () => {
    const z = new Float32Array([0, 0, 0]);
    const a = new Float32Array([1, 2, 3]);
    expect(idx._cosineSimilarity(z, a)).toBe(0);
  });

  it('cosineDistance = 1 - cosineSimilarity', () => {
    const a = new Float32Array([1, 2, 3]);
    const b = new Float32Array([4, 5, 6]);
    const sim = idx._cosineSimilarity(a, b);
    expect(idx._cosineDistance(a, b)).toBeCloseTo(1 - sim, 8);
  });
});

// ── Dedup threshold logic (mirrors storePattern dedup check) ─────────────────

describe('Dedup threshold (CONFIG.patterns.dedupThreshold = 0.95)', () => {
  it('near-identical vectors are flagged as duplicates', () => {
    const idx = new HNSWIndex(CONFIG);
    const base = normalise(randVec(32, 1));
    // Perturb slightly: similarity should remain > 0.95
    const perturbed = new Float32Array(base.map((x, i) => i === 0 ? x + 0.001 : x));
    const normPerturbed = normalise(perturbed);
    idx.add('original', base);
    const { results } = idx.search(normPerturbed, 1);
    expect(results[0].similarity).toBeGreaterThan(CONFIG.patterns.dedupThreshold);
  });

  it('unrelated vectors are NOT flagged as duplicates', () => {
    const idx = new HNSWIndex(CONFIG);
    idx.add('a', normalise(randVec(32, 1)));
    const { results } = idx.search(normalise(randVec(32, 9999)), 1);
    expect(results[0].similarity).toBeLessThan(CONFIG.patterns.dedupThreshold);
  });
});

// ── Integration skeletons (skipped — require better-sqlite3) ─────────────────

describe.skip('LearningService integration (requires better-sqlite3)', () => {
  it('initialize() returns sessionId and zero pattern counts', async () => {
    // const svc = new LearningService();
    // const r = await svc.initialize();
    // expect(typeof r.sessionId).toBe('string');
    // expect(r.shortTermPatterns).toBe(0);
    // expect(r.longTermPatterns).toBe(0);
    // await svc.endSession();
  });

  it('storePattern() inserts and returns the new pattern id', async () => {
    // const svc = new LearningService();
    // await svc.initialize();
    // const r = await svc.storePattern('use memoisation for repeated lookups', 'performance');
    // expect(typeof r.id).toBe('string');
    // expect(r.action).toBe('stored');
    // await svc.endSession();
  });

  it('storePattern() deduplicates near-identical strategies', async () => {
    // const svc = new LearningService();
    // await svc.initialize();
    // const r1 = await svc.storePattern('use memoisation for lookups');
    // const r2 = await svc.storePattern('use memoisation for lookups'); // identical
    // expect(r2.action).toBe('updated');
    // expect(r2.id).toBe(r1.id);
    // await svc.endSession();
  });

  it('consolidate() promotes a pattern used > promotionThreshold times', async () => {
    // const svc = new LearningService();
    // await svc.initialize();
    // const { id } = await svc.storePattern('promoted pattern', 'general');
    // // Simulate usage_count above threshold
    // for (let i = 0; i < CONFIG.patterns.promotionThreshold; i++) {
    //   svc.db.prepare('UPDATE short_term_patterns SET usage_count = usage_count + 1 WHERE id = ?').run(id);
    // }
    // const result = await svc.consolidate();
    // expect(result.promoted).toBeGreaterThanOrEqual(1);
    // await svc.endSession();
  });

  it('endSession() archives session_state entry', async () => {
    // const svc = new LearningService();
    // const { sessionId } = await svc.initialize();
    // await svc.endSession();
    // // Verify the session_state key was cleared
    // const state = svc.db.prepare("SELECT value FROM session_state WHERE key = 'current_session'").get();
    // expect(state).toBeUndefined();
  });
});
