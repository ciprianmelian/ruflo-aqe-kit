/**
 * Tests for tools/dashboard/triage.cjs (DASHBOARD-TRIAGE-V1).
 *
 * The three properties under test are the three design rules in the module,
 * each earned from a real defect in this kit:
 *
 *   1. ABSENT IS NOT OK        — a missing field yields `unknown`, never `ok`.
 *   2. DELIBERATE IS NOT BROKEN — documented "do NOT fix these" states stay calm.
 *   3. A FIX IS A COMMAND       — every actionable row carries a literal line.
 *
 * ANTI-GOODHART: every "X must not be ok" assertion is paired with a POSITIVE
 * CONTROL proving the same code path CAN produce `ok` when the field is
 * present. Without the control, a module that returned `unknown` for
 * everything — or a typo'd import returning undefined — would satisfy the
 * negative half of this suite perfectly.
 */

'use strict';

const path = require('path');
const { deriveRows, groupRows, rollup, RANK } = require(path.resolve(__dirname, '../tools/dashboard/triage.cjs'));

/** A fully-healthy status object: every field present and good. Individual
 *  tests clone this and remove/flip exactly ONE field, so any level change is
 *  attributable to that field alone. */
function healthyStatus() {
  return {
    // NOTE: `kit.dir` is the KIT CLONE's path, NOT the target's. It is
    // deliberately different from TARGET here so any code that mistakes one
    // for the other fails loudly instead of coinciding by accident.
    kit: { version: 'abc1234', date: '2026-08-02', dir: '/opt/ruflo-aqe-kit' },
    globals: {
      ruflo: '3.34.0',
      aqe: '3.13.3',
      agentdb: {
        standalone: '3.0.0-alpha.10', hoisted: '3.0.0-alpha.20',
        nested: '3.0.0-alpha.10', nestedExpected: '3.0.0-alpha.10',
        nestedPinned: true, shadow: true,
      },
    },
    sentinels: {
      present: 5, total: 5,
      items: [{ name: 'SONA-TRAIN-V1', present: true }],
      hookBlockExit2: true, dreamLockfix: 4,
    },
    daemon: { running: false, pids: [] },
    mcp: {
      servers: ['agentic-qe', 'agentdb', 'claude-flow', 'ruvnet-brain'],
      brainKb: { present: true, sizeBytes: 1834749952, kbVersion: '3.3.1' },
    },
    learning: {
      episodes: 2033, skills: 3, experiences: 2710, patterns: 181,
      captureInflowWired: true, sqlite: true,
      sqliteNativeVerdict: 'healthy', sqliteNativeGap: false, sqliteNativeRootsTotal: 6,
    },
    config: { daemonAutoStart: 'off', lastHealth: { iso: '2026-08-02T00:00:00Z' } },
  };
}

const NOW = Date.parse('2026-08-02T12:00:00Z');
const TARGET = '/tmp/target';
const derive = (s) => deriveRows(s, { now: NOW, target: TARGET });
const of = (rows, subsystem) => rows.filter((r) => r.subsystem === subsystem);
const levels = (rows, subsystem) => of(rows, subsystem).map((r) => r.level);

describe('triage: baseline positive control', () => {
  it('reports a fully-healthy stack with zero fail/warn/unknown rows', () => {
    const rows = derive(healthyStatus());
    // THE control for this whole suite. If this ever goes non-ok, every
    // "field X causes level Y" test below is measuring the wrong thing.
    expect(rows.filter((r) => r.level !== 'ok')).toEqual([]);
    expect(rollup(rows).verdict).toBe('healthy');
  });

  it('covers every subsystem it claims to cover', () => {
    const seen = new Set(derive(healthyStatus()).map((r) => r.subsystem));
    expect([...seen].sort()).toEqual(['daemon', 'health', 'learning', 'mcp', 'sentinels', 'versions']);
  });
});

describe('rule 1: absent is not ok', () => {
  // Each case: delete a field, assert `unknown`. The positive control above
  // already proved the SAME path yields `ok` when the field is present.
  const cases = [
    ['globals', 'versions'],
    ['sentinels', 'sentinels'],
    ['daemon', 'daemon'],
    ['mcp', 'mcp'],
    ['learning', 'learning'],
  ];

  for (const [field, subsystem] of cases) {
    it(`yields unknown (not ok) for ${subsystem} when status.${field} is missing`, () => {
      const s = healthyStatus();
      delete s[field];
      const rows = derive(s);
      const got = levels(rows, subsystem);
      expect(got.length).toBeGreaterThan(0);
      expect(got).toContain('unknown');

      // The card must stop reading "all clear". Note a subsystem may still
      // carry `ok` rows for facts measured from a DIFFERENT source that is
      // still present (daemon's autostart pin lives in status.config, not
      // status.daemon) — those remain legitimately assessed. What must never
      // happen is the group as a whole grading healthy.
      const group = groupRows(rows).find((g) => g.subsystem === subsystem);
      expect(group.level).toBe('unknown');
    });
  }

  it('yields unknown for individual booleans that are absent rather than false', () => {
    const s = healthyStatus();
    delete s.sentinels.hookBlockExit2;
    delete s.learning.captureInflowWired;
    const rows = derive(s);
    expect(rows.some((r) => r.level === 'unknown' && /hook block-exit-2/.test(r.message))).toBe(true);
    expect(rows.some((r) => r.level === 'unknown' && /capture inflow/.test(r.message))).toBe(true);
  });

  it('distinguishes absent from false: false is a FAIL, absent is UNKNOWN', () => {
    // This is the entire point of the third state. If these collapsed into one
    // level the module would be reporting "broken" and "unmeasured" alike.
    const absent = healthyStatus(); delete absent.learning.captureInflowWired;
    const explicitlyFalse = healthyStatus(); explicitlyFalse.learning.captureInflowWired = false;

    const a = derive(absent).find((r) => /capture inflow/.test(r.message));
    const f = derive(explicitlyFalse).find((r) => /capture inflow/i.test(r.message));
    expect(a.level).toBe('unknown');
    expect(f.level).toBe('fail');
    expect(a.level).not.toBe(f.level);
  });

  it('never returns an empty (falsely reassuring) result for junk input', () => {
    for (const junk of [null, undefined, 'a string', 42, [], true]) {
      const rows = deriveRows(junk, { now: NOW });
      expect(rows.length).toBeGreaterThan(0);
      expect(rows.every((r) => r.level === 'unknown')).toBe(true);
      expect(rollup(rows).verdict).not.toBe('healthy');
    }
  });
});

describe('rule 2: deliberate is not broken', () => {
  it('treats the agentdb hoisted/nested mismatch as correct, not drift', () => {
    // CLAUDE.md: the three-slot layout is MEANT to differ. Flagging it would
    // train the operator to ignore the versions card.
    const s = healthyStatus();
    expect(s.globals.agentdb.hoisted).not.toBe(s.globals.agentdb.nested); // premise
    const r = derive(s).find((x) => /agentdb/.test(x.message));
    expect(r.level).toBe('ok');
    expect(r.deliberate).toBe(true);
  });

  it('still FAILS when the nested pin genuinely drifts (control for the above)', () => {
    const s = healthyStatus();
    s.globals.agentdb.nestedPinned = false;
    s.globals.agentdb.nested = '3.0.0-alpha.20';
    const r = derive(s).find((x) => /agentdb/.test(x.message));
    expect(r.level).toBe('fail');
    expect(r.fix).toMatch(/fix-ruflo/);
  });

  it('treats an absent ruvnet-brain KB as an opt-in choice, not a defect', () => {
    const s = healthyStatus();
    s.mcp.brainKb = { present: false };
    const r = derive(s).find((x) => /ruvnet-brain KB/.test(x.message));
    expect(r.level).toBe('ok');
    expect(r.deliberate).toBe(true);
    expect(r.fix).toMatch(/fix-brain .*--download/);
  });

  it('treats a fresh empty store as primed, not hollow', () => {
    const s = healthyStatus();
    Object.assign(s.learning, { episodes: 0, skills: 0, experiences: 0, patterns: 0 });
    const r = derive(s).find((x) => /primed/.test(x.message));
    expect(r).toBeDefined();
    expect(r.level).toBe('ok');
  });

  it('does not let deliberate rows raise the rollup verdict', () => {
    const s = healthyStatus();
    s.mcp.brainKb = { present: false };
    expect(rollup(derive(s)).verdict).toBe('healthy');
  });
});

describe('cost: the daemon is the only row that can spend money', () => {
  it('warns with a stop command when the daemon is running', () => {
    const s = healthyStatus();
    s.daemon = { running: true, pids: [99552] };
    const r = derive(s).find((x) => /daemon RUNNING/.test(x.message));
    expect(r.level).toBe('warn');
    expect(r.message).toMatch(/99552/);
    expect(r.message).toMatch(/billed/);
    expect(r.fix).toBe('ruflo daemon stop');
  });

  it('is calm when stopped (control) and warns when autostart is not off', () => {
    expect(derive(healthyStatus()).find((x) => /daemon stopped/.test(x.message)).level).toBe('ok');

    const s = healthyStatus();
    s.config.daemonAutoStart = 'auto';
    const r = derive(s).find((x) => /autostart is/.test(x.message));
    expect(r.level).toBe('warn');
  });
});

describe('rule 3: a fix is a literal command', () => {
  it('gives every actionable row a runnable command, never an adjective', () => {
    // Sweep many broken shapes so the property is tested broadly, not on one row.
    const broken = [
      (s) => { s.globals.agentdb.nestedPinned = false; },
      (s) => { s.sentinels.present = 3; s.sentinels.items = [{ name: 'SONA-TRAIN-V1', present: false }]; },
      (s) => { s.sentinels.hookBlockExit2 = false; },
      (s) => { s.sentinels.dreamLockfix = 2; },
      (s) => { s.daemon = { running: true, pids: [1] }; },
      (s) => { s.config.daemonAutoStart = 'auto'; },
      (s) => { s.mcp.servers = ['claude-flow']; },
      (s) => { s.learning.captureInflowWired = false; },
      (s) => { s.learning.sqlite = false; },
      (s) => { s.learning.sqliteNativeGap = true; },
      (s) => { s.config.lastHealth = { iso: '2026-01-01T00:00:00Z' }; },
      (s) => { delete s.globals.ruflo; },
    ];

    let actionable = 0;
    for (const mutate of broken) {
      const s = healthyStatus(); mutate(s);
      for (const r of derive(s)) {
        if (r.level === 'fail' || r.level === 'warn') {
          expect(r.fix, `no fix on: ${r.message}`).toBeTruthy();
          // A command starts with a known binary — not "check" or "review".
          expect(r.fix, `not a command: ${r.fix}`).toMatch(/^(ruflo-kit|ruflo|npm|aqe) /);
          actionable++;
        }
      }
    }
    // Positive control: prove the loop actually inspected rows. Without this
    // a derive() that returned [] would pass the assertions above vacuously.
    expect(actionable).toBeGreaterThanOrEqual(broken.length);
  });

  it('names the concrete target directory in the fix, not a placeholder', () => {
    const s = healthyStatus();
    s.learning.captureInflowWired = false;
    const r = derive(s).find((x) => x.level === 'fail');
    expect(r.fix).toBe('ruflo-kit fix-aqe /tmp/target');
    expect(r.fix).not.toMatch(/<target>/);
  });

  it('falls back to a placeholder only when the caller supplies no target', () => {
    const s = healthyStatus();
    s.learning.captureInflowWired = false;
    const rows = deriveRows(s, { now: NOW }); // no target
    expect(rows.find((x) => x.level === 'fail').fix).toBe('ruflo-kit fix-aqe <target>');
  });

  it('NEVER uses status.kit.dir as the target (it is the kit clone, not the target)', () => {
    // Regression: the first implementation preferred status.kit.dir, which is
    // the path of the KIT CHECKOUT. On the kit's own repo the two coincide, so
    // it looked correct; on every other target it emitted fix commands naming
    // the wrong directory.
    const s = healthyStatus();
    s.learning.captureInflowWired = false;
    s.globals.agentdb.nestedPinned = false;
    s.daemon = { running: true, pids: [1] };

    const fixes = derive(s).filter((r) => r.fix).map((r) => r.fix);
    expect(fixes.length).toBeGreaterThan(0);
    for (const fix of fixes) {
      expect(fix, `fix names the kit clone: ${fix}`).not.toContain('/opt/ruflo-aqe-kit');
    }
    // Positive control: the caller's target IS what gets used.
    expect(fixes.some((f) => f.includes(TARGET))).toBe(true);
  });
});

describe('grouping and rollup', () => {
  it('ranks unknown above ok but below warn', () => {
    expect(RANK.fail).toBeGreaterThan(RANK.warn);
    expect(RANK.warn).toBeGreaterThan(RANK.unknown);
    expect(RANK.unknown).toBeGreaterThan(RANK.ok);
  });

  it('sorts groups worst-first and takes the worst row as the card level', () => {
    const s = healthyStatus();
    s.learning.captureInflowWired = false; // one fail among ok rows
    const groups = groupRows(derive(s));
    expect(groups[0].subsystem).toBe('learning');
    expect(groups[0].level).toBe('fail');
    expect(groups[0].rows.some((r) => r.level === 'ok')).toBe(true); // worst wins, others kept
  });

  it('puts cost (daemon) first among equally-severe groups', () => {
    const s = healthyStatus();
    s.daemon = { running: true, pids: [1] };
    s.sentinels.dreamLockfix = 2; // also warn
    const groups = groupRows(derive(s));
    expect(groups[0].level).toBe('warn');
    expect(groups[0].subsystem).toBe('daemon');
  });

  it('reports partial — never healthy — when anything was unmeasurable', () => {
    const s = healthyStatus();
    delete s.mcp;
    const r = rollup(derive(s));
    expect(r.counts.unknown).toBeGreaterThan(0);
    expect(r.counts.fail).toBe(0);
    expect(r.counts.warn).toBe(0);
    expect(r.verdict).toBe('partial'); // NOT 'healthy'
  });

  it('escalates verdict by worst level present', () => {
    const warn = healthyStatus(); warn.daemon = { running: true, pids: [1] };
    const fail = healthyStatus(); fail.learning.captureInflowWired = false;
    expect(rollup(derive(warn)).verdict).toBe('degraded');
    expect(rollup(derive(fail)).verdict).toBe('attention');
  });

  it('counts actionable rows, excluding ok rows that merely carry a hint', () => {
    const s = healthyStatus();
    s.mcp.brainKb = { present: false }; // ok + deliberate, but HAS a fix hint
    const r = rollup(derive(s));
    expect(r.actionable).toBe(0);
  });

  it('survives malformed rows without throwing', () => {
    expect(() => groupRows([null, 'x', {}, { subsystem: 'a', level: 'ok' }])).not.toThrow();
    expect(groupRows([null, 'x', {}, { subsystem: 'a', level: 'ok' }])).toHaveLength(1);
    expect(() => rollup(null)).not.toThrow();
  });
});

describe('health freshness uses injected time (pure, no clock dependency)', () => {
  it('warns past 14 days and stays ok inside the window', () => {
    const fresh = healthyStatus();
    fresh.config.lastHealth.iso = '2026-07-30T00:00:00Z'; // 3d before NOW
    expect(derive(fresh).find((r) => r.subsystem === 'health').level).toBe('ok');

    const stale = healthyStatus();
    stale.config.lastHealth.iso = '2026-06-01T00:00:00Z'; // 62d
    const r = derive(stale).find((x) => x.subsystem === 'health');
    expect(r.level).toBe('warn');
    expect(r.message).toMatch(/62 days old/);
  });

  it('reports unknown for an unparseable or missing timestamp', () => {
    const bad = healthyStatus(); bad.config.lastHealth.iso = 'not-a-date';
    expect(derive(bad).find((r) => r.subsystem === 'health').level).toBe('unknown');

    const none = healthyStatus(); delete none.config.lastHealth;
    expect(derive(none).find((r) => r.subsystem === 'health').level).toBe('unknown');
  });
});
