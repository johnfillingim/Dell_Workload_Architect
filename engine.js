/* ============================================================================
   Workload Architect AI — sizing engine (pure, no DOM)
   ----------------------------------------------------------------------------
   This file holds the recommendation math, the hardware/pricing catalogs, and
   the editable assumptions + their validation bounds. It is loaded as a plain
   <script> in index.html (everything below becomes a page global) AND required
   as a CommonJS module by engine.test.js so the math can be unit-tested.

   recommend() and tco() take optional (cfg, a) overrides; when omitted they
   fall back to the live page globals CONFIG / A, so existing call sites in the
   app keep working unchanged.
   ========================================================================== */

/* ============================ EDITABLE ASSUMPTIONS ============================ */
/* defaults — every one is exposed in the Assumptions panel and re-runs the engine on change */
const DEFAULTS = {
  // sizing — per-node capacity is DERIVED from the chosen CPU cores & RAM via these ratios
  vcpuPerVM:4, ramPerVMGB:12, vcpuPerSeat:1, ramPerVDIGB:4, vcpuPerCore:4,
  // storage
  drr:3, avgDriveTB:15.36, usableFactor:0.85,
  // energy & support
  powerRate:0.13, pue:1.5, circuitKW:4.9, supportPct:10, eduDiscount:35,
  // status-quo model
  sqPowerMult:2.1, sqBreakfixPct:18, sqRefreshFactor:0.6,
  // pricing — LIST $ (pre-discount). Servers/GPUs anchored to Dell.com (Jun 2026);
  // PowerStore & XE9680 are quote-only, so these are defensible street estimates.
  pR760:9000, pR660:7500, pAiInf:56000, pAiTrain:92000, pXE9680:400000,
  pNet:30000, pMgmt:9000,
  p500T:95000, p1200T:175000, p3200T:290000, p5200T:400000, p9200T:560000, pShelf:55000,
};
let A = {...DEFAULTS};

/* ---------------------------------------------------------------------------
   Assumption validation bounds. A stray keystroke (drr 0, usableFactor 5,
   eduDiscount 150, a negative price) used to flow straight into the engine and
   produce NaN/Infinity in the rack render. clampAssumption() pins every value
   into a defensible range; division-sensitive keys (drr, usableFactor,
   avgDriveTB, circuitKW, the per-VM/per-seat ratios, pue) have a
   strictly-positive minimum so they can never zero-divide.
   --------------------------------------------------------------------------- */
const ASSUMP_BOUNDS = {
  vcpuPerVM:[1,64], ramPerVMGB:[1,512], vcpuPerSeat:[0.25,16], ramPerVDIGB:[0.5,128],
  vcpuPerCore:[1,16],
  drr:[1,10], avgDriveTB:[0.5,100], usableFactor:[0.1,1],
  powerRate:[0,5], pue:[1,3], circuitKW:[0.5,50], supportPct:[0,100], eduDiscount:[0,90],
  sqPowerMult:[0,10], sqBreakfixPct:[0,100], sqRefreshFactor:[0,5],
};
/* fallback for every price key (p*) and anything not explicitly bounded above */
const PRICE_BOUNDS = [0, 100000000];

/* Returns the clamped numeric value, or null when the input isn't a finite
   number (so callers can leave the previous value in place while typing). */
function clampAssumption(key, raw){
  const v = parseFloat(raw);
  if(!isFinite(v)) return null;
  const b = ASSUMP_BOUNDS[key] || PRICE_BOUNDS;
  return Math.min(b[1], Math.max(b[0], v));
}

/* ============================ HARDWARE FACTS (verified Jun 2026) ============================ */
/* U-height, power & weight from Dell datasheets; prices come from editable A.* at build time */
const HW = {
  compute:  {model:'PowerEdge R760',  u:2, kw:1.2, lbs:75,  pk:'pR760'},
  computeSm:{model:'PowerEdge R660',  u:1, kw:0.8, lbs:55,  pk:'pR660'},
  aiInf:    {model:'PowerEdge R760xa',u:2, kw:1.6, lbs:80,  pk:'pAiInf',  gpu:'2× NVIDIA L40S 48GB'},
  aiTrain:  {model:'PowerEdge R760xa',u:2, kw:2.4, lbs:85,  pk:'pAiTrain',gpu:'4× NVIDIA L40S 48GB'},
  aiBig:    {model:'PowerEdge XE9680',u:6, kw:10.2,lbs:238, pk:'pXE9680', gpu:'8× NVIDIA H200 141GB (NVLink)'},
  net:      {model:'PowerSwitch S5248F-ON', u:1, kw:0.3, lbs:22, pk:'pNet'},
  mgmt:     {model:'PowerSwitch N3248 (mgmt)', u:1, kw:0.12, lbs:18, pk:'pMgmt'},
};
/* PowerStore Gen-2 controllers: tier = performance class (capacity added via shared ENS24 enclosures) */
const STORE = [
  {model:'PowerStore 500T', cores:24,  u:2, kw:1.0, lbs:80, pk:'p500T'},
  {model:'PowerStore 1200T',cores:24,  u:2, kw:1.2, lbs:82, pk:'p1200T'},
  {model:'PowerStore 3200T',cores:40,  u:2, kw:1.4, lbs:84, pk:'p3200T'},
  {model:'PowerStore 5200T',cores:64,  u:2, kw:1.6, lbs:86, pk:'p5200T'},
  {model:'PowerStore 9200T',cores:112, u:2, kw:1.8, lbs:88, pk:'p9200T'},
];
const SHELF = {u:2, kw:0.4, lbs:60, drives:24}; // ENS24 expansion enclosure
const BASE_SLOTS = 25, SHELF_SLOTS = SHELF.drives, MAX_SHELVES = 3, MIN_DRIVES = 6;

/* ============================ COMPONENT CATALOGS ============================ */
/* Customer-selectable internals for the compute cluster. Prices = Dell list $ (per node).
   CPU upgrade deltas & drive/GPU $ anchored to Dell.com (Jun 2026); RAM/OS/NIC are list estimates. */
const CPUS = [ // priceEach = per processor; node = 2×
  {id:'s4410', label:'2× Xeon Silver 4410Y — 12C, 150W',     coresEach:12, kwEach:0.15, priceEach:700},
  {id:'g6430', label:'2× Xeon Gold 6430 — 32C, 270W',        coresEach:32, kwEach:0.27, priceEach:1900},
  {id:'g6442y',label:'2× Xeon Gold 6442Y — 24C, 225W (fast)', coresEach:24, kwEach:0.22, priceEach:3900},
  {id:'g6548n',label:'2× Xeon Gold 6548N — 32C, 250W',       coresEach:32, kwEach:0.25, priceEach:3900},
  {id:'p8462y',label:'2× Xeon Platinum 8462Y+ — 32C, 300W',  coresEach:32, kwEach:0.30, priceEach:5500},
  {id:'p8480', label:'2× Xeon Platinum 8480+ — 56C, 350W',   coresEach:56, kwEach:0.35, priceEach:8500},
];
const RAMS = [
  {gb:256,  label:'256 GB DDR5', price:1400},
  {gb:512,  label:'512 GB DDR5', price:2800},
  {gb:1024, label:'1 TB DDR5',   price:5800},
  {gb:2048, label:'2 TB DDR5',   price:13000},
];
const OSES = [
  {id:'none',    label:'No OS / Ubuntu LTS',            price:0},
  {id:'rhel',    label:'Red Hat Enterprise Linux (1yr)', price:899},
  {id:'winstd',  label:'Windows Server 2022 Standard',   price:1069},
  {id:'windc',   label:'Windows Server 2022 Datacenter', price:6155},
  {id:'vsphere', label:'VMware vSphere (per node, est.)', price:5000},
];
const NICS = [
  {id:'10g', label:'2× 10GbE (onboard LOM)',      speed:'10GbE',  price:0},
  {id:'25g', label:'2× 25GbE adapter',            speed:'25GbE',  price:600},
  {id:'100g',label:'2× 100GbE adapter',           speed:'100GbE', price:1500},
  {id:'dpu', label:'BlueField-3 DPU 2× 200GbE',   speed:'200GbE', price:8137},
];
const LOCALS = [ // per-node local storage (primary data lives on PowerStore)
  {id:'boot', label:'Boot only (SAN/vSAN-backed)', tb:0,    price:500},
  {id:'2x192',label:'2× 1.92TB SAS SSD (RAID1)',   tb:1.92, price:4866},
  {id:'4x384',label:'4× 3.84TB NVMe',              tb:15.4, price:19464},
  {id:'8x768',label:'8× 7.68TB NVMe',              tb:61.4, price:73600},
];
const find=(arr,id)=>arr.find(x=>x.id===id)||arr[0];

/* current build selections */
let CONFIG = { cpu:'g6430', ram:512, os:'none', nic:'25g', local:'boot', storeTargetTB:0, inclStorage:true, inclNetwork:true };

/* ============================ ENGINE ============================ */
function recommend(inp, cfg, a){
  cfg = cfg || CONFIG; a = a || A;
  const out={items:[], warnings:[], notes:[]};

  // ---- compute sizing (internals from cfg) ----
  const cpu=find(CPUS,cfg.cpu), ram=RAMS.find(r=>r.gb===+cfg.ram)||RAMS[1],
        os=find(OSES,cfg.os), nic=find(NICS,cfg.nic), local=find(LOCALS,cfg.local);
  const nodeCores = cpu.coresEach*2, nodeRamGB = ram.gb, nodeRamTB = ram.gb/1024;
  // per-node capacity follows the ACTUAL build: bounded by either cores (with oversubscription) or RAM
  const vmCoreCap  = Math.floor(nodeCores * a.vcpuPerCore / a.vcpuPerVM);
  const vmRamCap   = Math.floor(nodeRamGB / a.ramPerVMGB);
  const vmsPerNode = Math.max(1, Math.min(vmCoreCap, vmRamCap));
  const seatCoreCap= Math.floor(nodeCores * a.vcpuPerCore / a.vcpuPerSeat);
  const seatRamCap = Math.floor(nodeRamGB / a.ramPerVDIGB);
  const vdiPerNode = Math.max(1, Math.min(seatCoreCap, seatRamCap));
  let nodesVM  = inp.vms>0 ? Math.ceil(inp.vms / vmsPerNode) : 0;
  let nodesVDI = inp.vdi>0 ? Math.ceil(inp.vdi / vdiPerNode) : 0;
  let computeNodes = nodesVM + nodesVDI;
  const anyWorkload = inp.vms>0||inp.users>0||inp.vdi>0;
  if(anyWorkload && computeNodes<1) computeNodes=1;                         // any workload needs ≥1 node
  // resilience target drives the HA floor — a small single-site workload can land on ONE server
  if(inp.res==='n1')        computeNodes = Math.max(computeNodes,1) + 1;    // N+1: one spare beyond the load
  else if(inp.res==='dual') computeNodes = Math.max(computeNodes,1) * 2;    // mirrored across two sites
  const cm = computeNodes>=6 ? HW.computeSm : HW.compute;                   // dense 1U for big fleets
  if(computeNodes>0){
    const nodeKw = 0.55 + cpu.kwEach*2;                                     // chassis/mem/fans + CPUs
    const nodePrice = a[cm.pk] + cpu.priceEach*2 + ram.price + os.price + nic.price + local.price;
    out.items.push({...cm, type:'compute', qty:computeNodes, kw:+nodeKw.toFixed(2), price:nodePrice,
      desc:`${cpu.label.replace('2× ','2× ')} · ${ram.label} · ${nic.speed}${local.tb?` · ${local.tb}TB local`:' · boot-only'} · ${os.label}`,
      role: inp.vdi>0 ? 'Compute + VDI host cluster' : 'Compute / virtualization cluster'});
  }

  // ---- AI ----
  if(inp.ai==='inference'){ out.items.push({...HW.aiInf,type:'ai',qty:1,desc:HW.aiInf.gpu+' · low-latency inference',role:'AI inference node'}); }
  if(inp.ai==='training'){ out.items.push({...HW.aiTrain,type:'ai',qty:2,desc:HW.aiTrain.gpu+' each · fine-tuning capable',role:'AI training pair'}); }
  if(inp.ai==='serious'){ out.items.push({...HW.aiBig,type:'ai',qty:1,desc:HW.aiBig.gpu+' · GenAI / HPC',role:'GenAI training platform'}); }

  // ---- storage: tier by PERFORMANCE, capacity by ENCLOSURES ----
  const iops = inp.vms*250 + inp.users*30 + inp.vdi*15 + (inp.db==='heavy'?200000:inp.db==='standard'?40000:0);
  let tier;
  if(iops<=40000 && inp.data<40) tier=0;          // 500T
  else if(iops<=90000) tier=1;                     // 1200T
  else if(iops<=190000) tier=2;                    // 3200T
  else if(iops<=330000) tier=3;                    // 5200T
  else tier=4;                                     // 9200T
  if(inp.db==='heavy') tier=Math.max(tier,2);      // heavy DB → 3200T+
  if(inp.ai==='serious') tier=Math.max(tier,3);    // HPC data pipeline → 5200T+
  let pick = STORE[tier];

  const grow = Math.pow(1+inp.growth/100, 4);
  const autoUsableTB = ((inp.data + inp.vdi*0.05) * grow * 1.3) / a.drr;   // workload-derived usable need @ yr4
  const targetUsableTB = cfg.storeTargetTB>0 ? cfg.storeTargetTB : autoUsableTB;
  // size the DRIVE COUNT to the actual need (not a fixed full base), then place drives across enclosures
  const physPerDrive = a.avgDriveTB * a.usableFactor;
  const slotsPerAppliance = BASE_SLOTS + MAX_SHELVES*SHELF_SLOTS;          // 25 in-chassis + 3×24 = 97
  const drivesNeeded = Math.max(MIN_DRIVES, Math.ceil(targetUsableTB / physPerDrive));
  let appliances = Math.max(1, Math.ceil(drivesNeeded / slotsPerAppliance));
  const drivesPer = Math.max(MIN_DRIVES, Math.ceil(drivesNeeded / appliances));
  let shelves = drivesPer>BASE_SLOTS ? Math.ceil((drivesPer-BASE_SLOTS)/SHELF_SLOTS) : 0;
  const dual = inp.res==='dual';
  const storeQty = (dual?2:1)*appliances;
  const totalDrives = drivesPer*appliances;
  const usableTB = drivesPer * physPerDrive * appliances;
  const effectiveTB = usableTB * a.drr;

  const hasStore = cfg.inclStorage !== false;
  out.store = hasStore ? {tier, model:pick.model, qty:storeQty, shelves, effectiveTB, usableTB, iops, drives:totalDrives} : null;
  if(hasStore){
    out.items.push({...pick, type:'store', qty:storeQty,
      u:pick.u + shelves*SHELF.u, kw:pick.kw + shelves*SHELF.kw, lbs:pick.lbs + shelves*SHELF.lbs,
      desc:`~${Math.round(usableTB).toLocaleString()}TB usable / ~${Math.round(effectiveTB).toLocaleString()}TB effective @ ${a.drr}:1 · ${totalDrives}× ${a.avgDriveTB}TB NVMe${dual?' · async replicated':''}${shelves?` · +${shelves} ENS24`:''}`,
      role:'Primary unified storage (NVMe)',
      price: a[pick.pk] + shelves*a.pShelf });
  }

  // ---- networking: scale leaf pairs to port count (48×25G per S5248F), min a redundant pair ----
  const hasNet = cfg.inclNetwork !== false;
  const aiNodes = out.items.filter(i=>i.type==='ai').reduce((s,i)=>s+i.qty,0);
  const portsNeeded = (computeNodes + aiNodes + (hasStore?storeQty:0)) * 2; // dual-homed for redundancy
  let leaves = Math.max(2, Math.ceil(portsNeeded/48));
  if(leaves%2) leaves++;                                                   // keep leaves in redundant pairs
  if(hasNet){
    out.items.push({...HW.net, type:'net', qty:leaves, desc:`25/100GbE leaf fabric · ${leaves/2} redundant pair${leaves>2?'s':''}`, role:'Data fabric', price:a.pNet});
    out.items.push({...HW.mgmt, type:'net', qty:1, desc:'iDRAC / out-of-band management', role:'Management', price:a.pMgmt});
  }

  // resolve prices for compute/ai items (they used pk keys)
  out.items.forEach(i=>{ if(i.price===undefined && i.pk) i.price=a[i.pk]; });

  // ---- mechanical totals ----
  let totU=0, totKW=0, totLbs=0, capex=0;
  out.items.forEach(i=>{ totU+=i.u*i.qty; totKW+=i.kw*i.qty; totLbs+=i.lbs*i.qty; capex+=(i.price||0)*i.qty; });
  const racks = Math.max(1, Math.ceil(totU/40));
  const btu = Math.round(totKW*a.pue*3412);
  const circuits = Math.ceil(totKW/a.circuitKW);

  /* ---- reality check ---- */
  const W=out.warnings;
  if(totKW>5){ W.push({lvl:'crit', t:`<b>${totKW.toFixed(1)} kW</b> draw exceeds a standard wiring-closet circuit (~5 kW). Plan <b>${circuits*2} dedicated 208V/30A feeds</b> (${circuits} + redundant) — loop facilities in before this hits a dock.`}); }
  else { W.push({lvl:'ok', t:`Power envelope is <b>${totKW.toFixed(1)} kW</b> — fits a redundant pair of standard 208V circuits. No electrical retrofit required.`}); }

  if(inp.ai==='serious'){ W.push({lvl:'crit', t:`The XE9680 runs hot — at <b>${btu.toLocaleString()} BTU/hr</b> total you need a <b>rear-door heat exchanger or hot-aisle containment</b>. A standard CRAC closet will thermal-throttle the GPUs.`}); }
  else if(inp.ai!=='none' && totKW>4){ W.push({lvl:'warn', t:`GPU nodes raise thermal load to <b>${btu.toLocaleString()} BTU/hr</b>. Confirm cooling headroom or add a supplemental in-row unit.`}); }
  else { W.push({lvl:'ok', t:`Thermal load <b>${btu.toLocaleString()} BTU/hr</b> sits within a typical conditioned server room. Verify supply temp at the rack face.`}); }

  if(racks>1){ W.push({lvl:'warn', t:`At <b>${totU}U</b> this won't fit one cabinet — plan <b>${racks} racks</b> with cross-rack cabling and a ladder-rack run.`}); }
  else { W.push({lvl:'ok', t:`Footprint is <b>${totU}U of 42U</b> — single cabinet with ${42-totU}U headroom for growth.`}); }

  if(totLbs>1500){ W.push({lvl:'warn', t:`Loaded weight ≈ <b>${Math.round(totLbs).toLocaleString()} lbs</b>. Check floor loading / raised-floor tile rating before delivery${inp.ai==='serious'?' — the XE9680 alone is ~238 lbs and needs a lift table':''}.`}); }

  if(inp.res==='n1'){ W.push({lvl:'ok', t:`<b>N+1 satisfied:</b> one compute node can fail with zero workload impact. Dual PSUs and dual switches remove single points of failure.`}); }
  if(inp.res==='dual'){ W.push({lvl:'warn', t:`Two-site replication needs a <b>WAN link of 1–10 Gbps</b> sized to your change rate. Confirm circuit and RPO/RTO before choosing async vs. sync (PowerStore Metro).`}); }
  if(inp.res==='single' && computeNodes<=1){ W.push({lvl:'warn', t:`<b>Single server — no failover.</b> A hardware fault is an outage until it's repaired (dual PSUs/fans and ProSupport next-business-day help, but won't keep workloads running). Sensible for a small or non-critical site; for SIS/EHR/911, step up to N+1 to add a spare node.`}); }
  else if(inp.res==='single'){ W.push({lvl:'warn', t:`Single-site cluster of <b>${computeNodes} nodes</b> with basic HA — a node failure degrades capacity but stays up. For SIS/EHR/911 workloads, N+1 adds a dedicated spare so there's zero impact.`}); }

  if(!hasStore){
    W.push({lvl:'warn', t:`<b>Primary storage excluded</b> — this quote assumes you reuse an existing SAN/array. Confirm it has headroom for ~<b>${Math.round(autoUsableTB).toLocaleString()}TB usable</b> (~${Math.round(autoUsableTB*a.drr).toLocaleString()}TB effective) and ~<b>${(iops/1000).toFixed(0)}k IOPS</b> by year 4, and that the fabric reaches every new node — shared storage is required for HA / live migration.`});
  } else if(appliances>1){ W.push({lvl:'warn', t:`Capacity exceeds a single appliance (base + 3 enclosures). Modeled as <b>${appliances} clustered appliances</b> — or raise avg drive size in Assumptions to consolidate.`}); }
  else if(autoUsableTB > usableTB*0.9){ W.push({lvl:'warn', t:`At ${inp.growth}%/yr you'll approach this array's usable capacity by year 4. Size the next enclosure now, or revisit the ${a.drr}:1 reduction assumption.`}); }
  if(!hasNet){ W.push({lvl:'warn', t:`<b>Network fabric excluded</b> — assumes existing leaf/spine. You'll need about <b>${portsNeeded} free ${nic.speed} ports</b> (redundant) for these nodes, plus an out-of-band path for iDRAC. Confirm available switch capacity before quoting.`}); }

  // node density — the cluster is already sized to the chosen build, so report what bounds each node
  if(inp.vms>0){
    const bind = vmRamCap<=vmCoreCap ? `RAM (${ram.label} ÷ ${a.ramPerVMGB}GB/VM)` : `cores (${nodeCores} ÷ ${a.vcpuPerVM} vCPU/VM at ${a.vcpuPerCore}:1)`;
    const perNode = Math.ceil(inp.vms/Math.max(1,nodesVM));
    W.push({lvl:'ok', t:`The selected build holds ~<b>${vmsPerNode} VMs/node</b> (bound by ${bind}); your ${inp.vms} VMs land at ~${perNode}/node. Change CPU or RAM and the cluster re-sizes automatically.`});
  }
  if(inp.vdi>0){
    W.push({lvl:'ok', t:`Each node hosts ~<b>${vdiPerNode} VDI seats</b> on this build (${a.ramPerVDIGB}GB & ${a.vcpuPerSeat} vCPU per seat) — ${nodesVDI} node${nodesVDI>1?'s':''} for ${inp.vdi} seats.`});
  }
  // explicit storage target vs workload need
  if(hasStore && cfg.storeTargetTB>0 && cfg.storeTargetTB < autoUsableTB){
    W.push({lvl:'warn', t:`Your <b>${cfg.storeTargetTB}TB</b> target is below the ~${Math.round(autoUsableTB).toLocaleString()}TB the workload projects to need by year 4 at ${inp.growth}% growth. Confirm that's intentional.`});
  }
  // licensing nudge
  if((cfg.os==='winstd'||cfg.os==='windc') && nodeCores>16){
    W.push({lvl:'warn', t:`Windows Server is licensed per physical core (16-core base). At ${nodeCores} cores/node you'll need <b>${nodeCores-16} extra core packs per node</b> — factor that into licensing.`});
  }

  if(inp.vdi>0 && inp.ai==='none'){ W.push({lvl:'warn', t:`${inp.vdi} VDI seats with no GPU — fine for browser/office, but CAD, GIS, or video desktops need GPU acceleration (add an R760xa with L40S).`}); }

  out.metrics={ totU, totKW, totLbs, btu, racks, circuits, capex, iops,
    cores:computeNodes*nodeCores, ram:+(computeNodes*nodeRamTB).toFixed(1),
    computeNodes, effectiveTB:hasStore?effectiveTB:0, usableTB:hasStore?usableTB:0,
    hasStore, hasNet, nodeCores, nodeRamTB, vdi:inp.vdi,
    fabric:nic.speed, storeTarget:cfg.storeTargetTB };
  return out;
}

/* ============================ TCO ============================ */
function tco(rec, a){
  a = a || A;
  const listCap = rec.metrics.capex;                 // sum of LIST prices
  const netCap = listCap*(1-a.eduDiscount/100);       // after SLED/EDU discount
  const supportYr = netCap*(a.supportPct/100);
  const powerYr = rec.metrics.totKW*24*365*a.pue*a.powerRate;
  const dell = { capex:netCap, support:supportYr*4, power:powerYr*4, risk:0 };
  dell.total = dell.capex+dell.support+dell.power;

  const sqPowerYr = powerYr*a.sqPowerMult;
  const sq = { capex:0, support:netCap*(a.sqBreakfixPct/100)*4, power:sqPowerYr*4, risk:netCap*a.sqRefreshFactor };
  sq.total = sq.support+sq.power+sq.risk;
  return {dell, sq, powerYr, sqPowerYr, listCap, netCap};
}

/* ============================ EXPORTS (Node test harness only) ============================ */
if(typeof module!=='undefined' && module.exports){
  module.exports = {
    DEFAULTS, ASSUMP_BOUNDS, PRICE_BOUNDS, clampAssumption,
    HW, STORE, SHELF, BASE_SLOTS, SHELF_SLOTS, MAX_SHELVES, MIN_DRIVES,
    CPUS, RAMS, OSES, NICS, LOCALS, find,
    recommend, tco,
  };
}
