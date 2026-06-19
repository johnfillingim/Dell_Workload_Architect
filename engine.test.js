/* ============================================================================
   Unit tests for the Workload Architect sizing engine (engine.js).
   Run with:  npm test   (which runs `node --test`)

   recommend() / tco() / clampAssumption() are pure given their inputs, so each
   test passes explicit config/assumptions and never mutates shared globals.
   ========================================================================== */
const test = require('node:test');
const assert = require('node:assert');
const E = require('./engine.js');

const { recommend, tco, clampAssumption, DEFAULTS, STORE } = E;

/* default build config used by the live app */
const baseCfg = () => ({ cpu:'g6430', ram:512, os:'none', nic:'25g', local:'boot',
  storeTargetTB:0, inclStorage:true, inclNetwork:true });
const A = () => ({ ...DEFAULTS });

/* a representative medium-public-sector workload (the app's default profile) */
const baseInp = () => ({ vms:90, users:750, data:50, vdi:0, growth:20,
  ai:'none', db:'standard', res:'n1' });

const tierOf = rec => rec.store ? STORE.findIndex(s => s.model === rec.store.model) : -1;
const itemTypes = rec => rec.items.map(i => i.type);

/* ----------------------------------------------------------------------------
   Compute sizing
   -------------------------------------------------------------------------- */
test('default profile produces at least one compute node and finite metrics', () => {
  const rec = recommend(baseInp(), baseCfg(), A());
  assert.ok(rec.metrics.computeNodes >= 1, 'expected >=1 compute node');
  for (const k of ['totU','totKW','totLbs','btu','racks','circuits','capex']) {
    assert.ok(Number.isFinite(rec.metrics[k]), `${k} should be finite, got ${rec.metrics[k]}`);
  }
  assert.ok(rec.metrics.totU > 0 && rec.metrics.totKW > 0);
});

test('N+1 resilience adds exactly one node beyond the bare load', () => {
  const single = recommend({ ...baseInp(), res:'single' }, baseCfg(), A());
  const n1     = recommend({ ...baseInp(), res:'n1' },     baseCfg(), A());
  assert.strictEqual(n1.metrics.computeNodes, single.metrics.computeNodes + 1);
});

test('dual-site resilience doubles compute nodes and replicates storage', () => {
  const single = recommend({ ...baseInp(), res:'single' }, baseCfg(), A());
  const dual   = recommend({ ...baseInp(), res:'dual' },   baseCfg(), A());
  assert.strictEqual(dual.metrics.computeNodes, single.metrics.computeNodes * 2);
  // storage is mirrored across the two sites → at least double the appliance count
  assert.ok(dual.store.qty >= single.store.qty * 2,
    `dual store qty ${dual.store.qty} should be >= 2x single ${single.store.qty}`);
  assert.match(dual.items.find(i => i.type === 'store').desc, /replicated/);
});

test('a small single-site workload can land on a single server', () => {
  const rec = recommend({ vms:4, users:20, data:5, vdi:0, growth:10,
    ai:'none', db:'none', res:'single' }, baseCfg(), A());
  assert.strictEqual(rec.metrics.computeNodes, 1);
  // and the engine should flag the no-failover reality
  assert.ok(rec.warnings.some(w => /no failover/i.test(w.t)));
});

test('large fleets switch to the dense 1U R660 chassis', () => {
  const rec = recommend({ ...baseInp(), vms:2000, res:'single' }, baseCfg(), A());
  assert.ok(rec.metrics.computeNodes >= 6);
  assert.strictEqual(rec.items.find(i => i.type === 'compute').model, 'PowerEdge R660');
});

test('per-node VM density is bound by RAM vs cores as configured', () => {
  // tiny RAM forces a RAM-bound cluster: 256GB / 12GB-per-VM = 21 VMs/node
  const ramBound = recommend({ ...baseInp(), res:'single' },
    { ...baseCfg(), ram:256, cpu:'p8480' }, A());
  // expected nodes = ceil(90 / 21) = 5
  assert.strictEqual(ramBound.metrics.computeNodes, 5);
});

/* ----------------------------------------------------------------------------
   AI tiers
   -------------------------------------------------------------------------- */
test('AI ambition adds the right GPU platform', () => {
  const inf  = recommend({ ...baseInp(), ai:'inference' }, baseCfg(), A());
  const trn  = recommend({ ...baseInp(), ai:'training'  }, baseCfg(), A());
  const big  = recommend({ ...baseInp(), ai:'serious'   }, baseCfg(), A());
  assert.strictEqual(inf.items.find(i => i.type === 'ai').model, 'PowerEdge R760xa');
  assert.strictEqual(trn.items.find(i => i.type === 'ai').qty, 2);
  assert.strictEqual(big.items.find(i => i.type === 'ai').model, 'PowerEdge XE9680');
  // the XE9680 must trigger the cooling/critical warnings
  assert.ok(big.warnings.some(w => w.lvl === 'crit' && /heat exchanger|hot-aisle/i.test(w.t)));
});

/* ----------------------------------------------------------------------------
   Storage tiering & capacity
   -------------------------------------------------------------------------- */
test('heavy database forces storage tier >= 3200T', () => {
  const rec = recommend({ ...baseInp(), db:'heavy' }, baseCfg(), A());
  assert.ok(tierOf(rec) >= 2, `expected tier >=2 (3200T+), got ${rec.store.model}`);
});

test('serious AI forces storage tier >= 5200T', () => {
  const rec = recommend({ ...baseInp(), ai:'serious' }, baseCfg(), A());
  assert.ok(tierOf(rec) >= 3, `expected tier >=3 (5200T+), got ${rec.store.model}`);
});

test('low IOPS + small dataset lands on the entry 500T', () => {
  const rec = recommend({ vms:5, users:10, data:10, vdi:0, growth:10,
    ai:'none', db:'none', res:'single' }, baseCfg(), A());
  assert.strictEqual(tierOf(rec), 0);
});

test('higher growth projects more usable capacity', () => {
  const slow = recommend({ ...baseInp(), growth:5  }, baseCfg(), A());
  const fast = recommend({ ...baseInp(), growth:60 }, baseCfg(), A());
  assert.ok(fast.metrics.usableTB >= slow.metrics.usableTB,
    `fast-growth usable ${fast.metrics.usableTB} should be >= slow ${slow.metrics.usableTB}`);
});

test('IOPS demand follows the documented formula', () => {
  const inp = { ...baseInp() }; // 90 vms, 750 users, 0 vdi, standard db
  const expected = 90*250 + 750*30 + 0*15 + 40000; // = 84,500
  const rec = recommend(inp, baseCfg(), A());
  assert.strictEqual(rec.metrics.iops, expected);
});

/* ----------------------------------------------------------------------------
   Include / exclude toggles
   -------------------------------------------------------------------------- */
test('excluding primary storage drops the array and warns', () => {
  const rec = recommend(baseInp(), { ...baseCfg(), inclStorage:false }, A());
  assert.strictEqual(rec.store, null);
  assert.strictEqual(rec.metrics.usableTB, 0);
  assert.ok(!itemTypes(rec).includes('store'));
  assert.ok(rec.warnings.some(w => /storage excluded/i.test(w.t)));
});

test('excluding network fabric drops the switches and warns', () => {
  const rec = recommend(baseInp(), { ...baseCfg(), inclNetwork:false }, A());
  assert.ok(!itemTypes(rec).includes('net'));
  assert.ok(rec.warnings.some(w => /network fabric excluded/i.test(w.t)));
});

/* ----------------------------------------------------------------------------
   TCO
   -------------------------------------------------------------------------- */
test('TCO applies the SLED/EDU discount to list capex', () => {
  const a = A();
  const rec = recommend(baseInp(), baseCfg(), a);
  const t = tco(rec, a);
  assert.strictEqual(t.listCap, rec.metrics.capex);
  assert.ok(Math.abs(t.netCap - t.listCap * (1 - a.eduDiscount/100)) < 1e-6);
  assert.ok(t.netCap < t.listCap, 'net should be below list with a positive discount');
});

test('TCO shows a positive 4-year advantage vs the modeled status quo', () => {
  const a = A();
  const rec = recommend(baseInp(), baseCfg(), a);
  const t = tco(rec, a);
  assert.ok(t.dell.total > 0 && t.sq.total > 0);
  assert.ok(t.sq.total - t.dell.total > 0, 'expected Dell TCO below status-quo TCO');
  // every TCO figure must be finite
  for (const v of [t.dell.total, t.sq.total, t.powerYr, t.sqPowerYr, t.netCap]) {
    assert.ok(Number.isFinite(v));
  }
});

/* ----------------------------------------------------------------------------
   Assumption validation (clampAssumption)
   -------------------------------------------------------------------------- */
test('clampAssumption pins out-of-range values into safe bounds', () => {
  assert.strictEqual(clampAssumption('drr', 0), 1);          // never < 1 (would expand data)
  assert.strictEqual(clampAssumption('drr', 999), 10);       // capped
  assert.strictEqual(clampAssumption('usableFactor', 5), 1); // 0..1
  assert.strictEqual(clampAssumption('usableFactor', 0), 0.1);
  assert.strictEqual(clampAssumption('pue', 0.5), 1);        // PUE can't be < 1
  assert.strictEqual(clampAssumption('eduDiscount', 150), 90);
  assert.strictEqual(clampAssumption('pR760', -500), 0);     // price floor
});

test('clampAssumption returns null for non-numeric input (keep previous value)', () => {
  assert.strictEqual(clampAssumption('drr', ''), null);
  assert.strictEqual(clampAssumption('drr', 'abc'), null);
  assert.strictEqual(clampAssumption('drr', NaN), null);
});

test('clamped division-sensitive assumptions keep the engine finite', () => {
  // simulate what the UI does: clamp first, then run. drr/usableFactor=0 would
  // otherwise zero-divide into Infinity inside the storage sizing.
  const a = { ...DEFAULTS,
    drr: clampAssumption('drr', 0),
    usableFactor: clampAssumption('usableFactor', 0),
    avgDriveTB: clampAssumption('avgDriveTB', 0),
    circuitKW: clampAssumption('circuitKW', 0),
    vcpuPerVM: clampAssumption('vcpuPerVM', 0),
    ramPerVMGB: clampAssumption('ramPerVMGB', 0),
  };
  const rec = recommend(baseInp(), baseCfg(), a);
  assert.ok(Number.isFinite(rec.metrics.usableTB));
  assert.ok(Number.isFinite(rec.metrics.circuits));
  assert.ok(Number.isFinite(rec.metrics.computeNodes));
  assert.ok(Number.isFinite(rec.metrics.capex));
});
