// core/legacy.js — behaviour-identical copy of the pure tournament logic in app.js.
//
// Purpose: characterize today's live behaviour (see tests/legacy.test.mjs) so app.js
// internals can later be swapped for core/ without changing results on live events.
//
// Rules for this file:
//  - Function bodies are copied VERBATIM from app.js (each marked `// from app.js:<line>`).
//    Known bugs are kept on purpose; they are documented as `KNOWN BUG:` tests.
//  - Only the way inputs arrive differs. Stateless helpers are plain exports. Functions
//    that read app.js module globals (categories, state, meta, registrations) live in
//    createLegacy(ctx) and read them from `ctx` at call time (one added destructuring
//    line per function), so `ctx` can be a live holder whose fields get reassigned.
//  - Mutations happen exactly as in app.js: on ctx.state[catId] / ctx.meta in place.
//
// No DOM, no Firebase. ES module, no dependencies.

// ============ HELPERS (stateless) ============

// from app.js:62
export const dn = s => {
  if (!s || s.startsWith('Winner') || /^[A-Z]\d+$/.test(s)) return s;
  return s.replace(/\sו([^\s])/g, ' $1');
};

// from app.js:69
export const DEF_KO_RULES = {
  pool:   { pts: 15, change: 5 },
  r16:    { pts: 18, change: 6 },
  qf:     { pts: 18, change: 5 },
  sf:     { pts: 18, change: 5 },
  final:  { pts: 21, change: 7 },
  third:  { pts: 15, change: 6 },
};

// from app.js:95
export const DEF_CAT_CFG = {
  courts: 2, gameDur: 30, breakDur: 0, numGroups: 2, advPerGroup: 2,
  pointsToWin: 21, sets: 1, pointsThirdSet: 15, startTime: '08:00'
};

// from app.js:108
export function koToFB(ko) {
  const obj = {};
  ko.forEach((round, ri) => { obj[`r${ri}`] = round; });
  return obj;
}
// from app.js:113
export function koFromFB(obj) {
  if (!obj) return [];
  return Object.keys(obj).sort((a,b) => parseInt(a.slice(1)) - parseInt(b.slice(1))).map(k => obj[k]);
}
// from app.js:117
export function catStateToFB(cs) {
  return { roster: cs.roster||[], groups: cs.groups||[], sched: cs.sched||[], ko: koToFB(cs.ko||[]) };
}
// from app.js:120
export function catStateFromFB(data) {
  return {
    roster: data.roster||[],
    groups: data.groups||[],
    sched:  data.sched||[],
    ko:     koFromFB(data.ko)
  };
}

// from app.js:1198
export function t2m(t) { const [h,m] = (t||'00:00').split(':').map(Number); return h*60+m; }
// from app.js:1199
export function m2t(m) { return `${String(Math.floor(m/60)%24).padStart(2,'0')}:${String(m%60).padStart(2,'0')}`; }
// from app.js:1200
export function addM(t, m) { return m2t(t2m(t)+m); }

// from app.js:1202
export function rr(teams) {
  if (teams.length < 2) return [];
  const list = teams.length % 2 === 0 ? [...teams] : [...teams, 'BYE'];
  const half = list.length / 2;
  const games = [];
  for (let r = 0; r < list.length - 1; r++) {
    for (let i = 0; i < half; i++) {
      const a = list[i], b = list[list.length-1-i];
      if (a !== 'BYE' && b !== 'BYE') games.push([a,b]);
    }
    list.splice(1, 0, list.pop());
  }
  return games;
}

// from app.js:1217
export function distributeGroups(nc, ng) {
  const base = Math.floor(nc/ng), extra = nc % ng;
  return Array.from({length:ng}, (_,i) => base + (i<extra?1:0));
}

// from app.js:1225
// Serpentine ("snake") seeding for ranking tournaments: the roster is assumed
// sorted best-first, and is dealt into pools A→…→last, then back.
export function snakeDistribute(roster, ng) {
  const groups = Array.from({length:ng}, (_,i) => ({ name:String.fromCharCode(65+i), teams:[] }));
  let g = 0, dir = 1;
  for (let i = 0; i < roster.length; i++) {
    groups[g].teams.push(roster[i]);
    if (dir === 1) { if (g === ng-1) dir = -1; else g++; }
    else           { if (g === 0)    dir = 1;  else g--; }
  }
  return groups;
}

// from app.js:1237
// Lexicographic tuple compare (higher is better). Returns >0 if a beats b.
export function cmpScore(a, b) {
  for (let i = 0; i < a.length; i++) { if (a[i] !== b[i]) return a[i] - b[i]; }
  return 0;
}

// from app.js:1242
export function roundName(count) {
  if (count===2)  return 'Final';
  if (count===4)  return 'Semifinals';
  if (count===8)  return 'Quarterfinals';
  if (count===16) return 'Round of 16';
  if (count===32) return 'Round of 32';
  return `Round of ${count}`;
}

// from app.js:1504
// Normalize name for matching: "תום / מוריאל" ↔ "תום מוריאל" → same key
export const normName = s => (s||'').replace(/\s*\/\s*/g,' ').replace(/\s+/g,' ').trim().toLowerCase();

// ============ STATEFUL (factory over app.js globals) ============
//
// ctx = { categories:[{id,name,cfg}], state:{[catId]:{roster,groups,sched,ko}},
//         meta:{...}, registrations:[...] }
// Every function reads ctx.* at call time, so ctx may be a live holder.
export function createLegacy(ctx) {

  // from app.js:78
  function getRuleForGame(catId, g, isKO) {
    const { categories, state } = ctx;
    const cat = categories.find(c=>c.id===catId);
    const rules = { ...DEF_KO_RULES, ...(cat?.cfg?.koRules||{}) };
    if (!isKO) {
      if (g.gi === -1) return rules.third;
      return rules.pool;
    }
    const cs = state[catId];
    if (!cs?.ko?.length) return rules.pool;
    const fromEnd = cs.ko.length - 1 - (g.ri ?? 0);
    if (fromEnd === 0) return rules.final;
    if (fromEnd === 1) return rules.sf;
    if (fromEnd === 2) return rules.qf;
    return rules.r16;
  }

  // from app.js:995
  function coordCfg(){
    const { categories, meta } = ctx;
    const courts = Math.max(2, ...categories.map(c=>(c.cfg||DEF_CAT_CFG).courts||2));
    const c0 = (categories[0] && categories[0].cfg) || DEF_CAT_CFG;
    const slot = (c0.gameDur||20) + (c0.breakDur||0);
    const start = t2m(meta.startTime || c0.startTime || '17:00');
    const b = meta.base || null;
    const baseDurMin = (b && b.sharesCourt && (b.players|0) > 1) ? ((b.slotMin||slot) * (b.players - 1)) : 0;
    const baseRounds = baseDurMin > 0 ? Math.ceil(baseDurMin / slot) : 0;
    return { COURTS:courts, SLOT:slot, START:start, BASE_ROUNDS:baseRounds };
  }

  // from app.js:1008
  function buildCoordinatedGroups(){
    const { categories, state, registrations } = ctx;
    categories.forEach(cat=>{
      const cs=state[cat.id]; if(!cs) return;
      let roster = cs.roster.length ? cs.roster :
        registrations.filter(r=>r.status==='approved'&&r.category===cat.id).map(r=>r.p1+(r.p2?' / '+r.p2:''));
      if(!roster.length){ cs.groups=[]; cs.sched=[]; cs.ko=[]; return; }
      const cfg=cat.cfg||DEF_CAT_CFG; const ng=cfg.numGroups||2;
      let groups;
      if(cfg.seeding==='snake') groups=snakeDistribute(roster,ng);
      else { const sizes=distributeGroups(roster.length,ng); groups=[]; let idx=0;
        for(let g=0;g<ng;g++){groups.push({name:String.fromCharCode(65+g),teams:roster.slice(idx,idx+sizes[g])}); idx+=sizes[g];} }
      cs.roster=roster; cs.groups=groups; cs.sched=[]; cs.ko=[];
    });
  }

  // from app.js:1022
  function generateCoordinatedSchedule(){
    const { categories, state, meta } = ctx;
    const { COURTS, SLOT, START, BASE_ROUNDS } = coordCfg();
    const courtsAt = r => (r < BASE_ROUNDS ? Math.max(2, COURTS-1) : COURTS);
    const cats = categories.filter(c => state[c.id] && (state[c.id].groups||[]).length);
    if(!cats.length) return;
    const finaleCat = cats[cats.length-1].id;
    const parallel = !!meta.parallelCategories;
    const allPoolsFirst = !!meta.allPoolsBeforeKO;
    const games=[], koStruct={};
    cats.forEach((cat,ci)=>{
      const groups=state[cat.id].groups; const poolIds=[];
      groups.forEach((grp,gi)=>rr(grp.teams).forEach(([a,b])=>{
        const id=`${cat.id}:P:${gi}:${a}#${b}`; poolIds.push(id);
        games.push({id,catId:cat.id,ci,kind:'pool',gi,gn:grp.name,a,b,teams:[`${cat.id}~${a}`,`${cat.id}~${b}`]});
      }));
      const cfg=cat.cfg||DEF_CAT_CFG; const adv=cfg.advPerGroup||0, ng=groups.length;
      if(adv>=1 && ng>=1){
        const seeds=[]; for(let rank=1;rank<=adv;rank++) for(let g=0;g<ng;g++) seeds.push(`${String.fromCharCode(65+g)}${rank}`);
        let bs=1; while(bs<seeds.length) bs*=2; while(seeds.length<bs) seeds.push('TBD');
        const rounds=[], first=[];
        for(let i=0;i<bs/2;i++) first.push({a:seeds[i],b:seeds[bs-1-i],seedA:seeds[i],seedB:seeds[bs-1-i],sa:'',sb:'',catId:cat.id});
        rounds.push(first);
        let m=first.length/2;
        while(m>=1){const rd=[]; for(let i=0;i<m;i++) rd.push({a:`W${i*2+1}`,b:`W${i*2+2}`,sa:'',sb:'',catId:cat.id}); rounds.push(rd); m=Math.floor(m/2);}
        koStruct[cat.id]=rounds;
        rounds.forEach((rd,ri)=>rd.forEach((g,gi)=>games.push({id:`${cat.id}:K${ri}:${gi}`,catId:cat.id,ci,kind:'ko',ri,gi,ref:g,poolIds,lastRound:ri===rounds.length-1})));
        const sfRound=rounds.length-2;
        if(sfRound>=0) games.push({id:`${cat.id}:3P`,catId:cat.id,ci,kind:'ko3p',sfRound,
          ref:{catId:cat.id,gi:-1,isThirdPlace:true,a:'Loser of SF1',b:'Loser of SF2',sa:'',sb:''}});
      }
    });
    const koRoundIds={};
    games.forEach(g=>{ if(g.kind==='ko')(koRoundIds[`${g.catId}:${g.ri}`]=koRoundIds[`${g.catId}:${g.ri}`]||[]).push(g.id); });
    const allPoolIds = games.filter(g=>g.kind==='pool').map(g=>g.id);
    const ready=(g,done)=>{
      if(g.kind==='pool') return true;
      if(allPoolsFirst && !allPoolIds.every(id=>done.has(id))) return false;
      if(g.kind==='ko3p') return (koRoundIds[`${g.catId}:${g.sfRound}`]||[]).every(id=>done.has(id));
      if(!g.poolIds.every(id=>done.has(id))) return false;
      if(g.ri===0) return true;
      return (koRoundIds[`${g.catId}:${g.ri-1}`]||[]).every(id=>done.has(id));
    };
    const isFinaleLast=g=> !parallel && g.catId===finaleCat && ((g.kind==='ko'&&g.lastRound)||g.kind==='ko3p');
    const rankKind=g=>g.kind==='pool'?1:0, koOrder=g=>g.kind==='ko3p'?99:(g.kind==='ko'?g.ri:0);
    const rounds=[], done=new Set(); let rem=new Set(games.map(g=>g.id));
    const byId=Object.fromEntries(games.map(g=>[g.id,g])); const teamRounds={};
    const played=t=>teamRounds[t]||new Set();
    let guard=0;
    const poolPending=cid=>games.some(g=>g.catId===cid&&g.kind==='pool'&&rem.has(g.id));
    while(rem.size && guard++<500){
      const r=rounds.length;
      const courtsThisRound=courtsAt(r);
      const gateFinale = meta.blockFinaleUntilPoolsDone &&
        cats.some(c=>c.id!==finaleCat && poolPending(c.id));
      const cand=[...rem].map(id=>byId[id]).filter(g=>ready(g,done)&&!isFinaleLast(g)
        && !(gateFinale && g.catId===finaleCat));
      if(!cand.length){
        const fin=[...rem].map(id=>byId[id]).filter(g=>ready(g,done)&&isFinaleLast(g)).slice(0,courtsThisRound);
        if(fin.length){rounds.push(fin.map(g=>g.id)); fin.forEach(g=>{done.add(g.id);rem.delete(g.id);}); continue;}
        rounds.push([]); if(rounds.length>200) break; continue;
      }
      const lastPlayed=t=>{const s=played(t); return s.size?Math.max(...s):-99;};
      const phase=g=> parallel ? 0 : (g.catId===finaleCat?1:0);
      cand.sort((x,y)=>{
        if(phase(x)!==phase(y)) return phase(x)-phase(y);
        const kx=rankKind(x),ky=rankKind(y); if(kx!==ky) return kx-ky;
        if(kx===0) return (koOrder(x)-koOrder(y))||((x.gi||0)-(y.gi||0));
        const wx=Math.max(...x.teams.map(t=>r-lastPlayed(t))), wy=Math.max(...y.teams.map(t=>r-lastPlayed(t)));
        return wy-wx;
      });
      const chosen=[], usedTeams=new Set(), seenKO=new Set();
      for(const g of cand){
        if(chosen.length>=courtsThisRound) break;
        if(g.kind==='pool'){
          if(g.teams.some(t=>usedTeams.has(t))) continue;
          if(g.teams.some(t=>played(t).has(r-1)&&played(t).has(r-2))) continue;
          g.teams.forEach(t=>usedTeams.add(t)); chosen.push(g);
        } else if(g.kind==='ko3p'){ chosen.push(g); }
        else {
          const sk=`${g.catId}:${g.ri}`; if(seenKO.has(sk)) continue; seenKO.add(sk);
          const stage=(koRoundIds[sk]||[]).map(id=>byId[id]).filter(x=>rem.has(x.id)&&ready(x,done)&&!isFinaleLast(x));
          const free=courtsThisRound-chosen.length;
          stage.slice(0,Math.max(0,free)).forEach(x=>chosen.push(x));
        }
      }
      if(!chosen.length){rounds.push([]); continue;}
      rounds.push(chosen.map(g=>g.id));
      chosen.forEach(g=>{done.add(g.id);rem.delete(g.id); if(g.kind==='pool')g.teams.forEach(t=>{(teamRounds[t]=teamRounds[t]||new Set()).add(r);});});
    }
    if(meta.breakBeforeKO){
      let P=-1;
      for(let r=0;r<rounds.length;r++){ if(rounds[r].some(id=>byId[id]&&byId[id].kind!=='pool')){ P=r; break; } }
      meta.breaks = (P>0) ? [{atTime:m2t(START+P*SLOT), minutes:meta.breakBeforeKO}] : [];
    }
    const brs = (meta.breaks||[]).map(b=>({at:t2m(b.atTime), min:b.minutes||0})).sort((a,b)=>a.at-b.at);
    const roundTime = r => { let t=START+r*SLOT; for(const b of brs) if(t>=b.at) t+=b.min; return t; };
    cats.forEach(c=>{ state[c.id].sched=[]; state[c.id].ko=(koStruct[c.id]||[]).map(()=>[]); });
    rounds.forEach((ids,r)=>{ const time=m2t(roundTime(r));
      ids.forEach((id,ix)=>{ const g=byId[id], court=ix+1;
        if(g.kind==='pool') state[g.catId].sched.push({catId:g.catId,gi:g.gi,gn:g.gn,a:g.a,b:g.b,sa:'',sb:'',court,si:r,time});
        else if(g.kind==='ko3p') state[g.catId].sched.push({...g.ref,court,si:r,time});
        else state[g.catId].ko[g.ri][g.gi]={...g.ref,court,si:r,time};
      });
    });
    categories.forEach(c=>{ if(state[c.id]) updateKOForCat(c.id); });
  }

  // from app.js:1156 (pure part of buildTournament, non-coordinated branch:
  // no admin/phase guard, no alert, no pushToCloud/render). Returns false where
  // app.js would `return`/alert, true when a schedule was generated.
  function buildCategory(catId) {
    const { categories, state, registrations } = ctx;
    const cs  = state[catId];
    const cat = categories.find(c => c.id === catId);
    if (!cat || !cs) return false;

    let roster = cs.roster.length ? cs.roster :
      registrations.filter(r => r.status === 'approved' && r.category === catId)
        .map(r => r.p1 + (r.p2 ? ' / '+r.p2 : ''));

    if (!roster.length) return false;

    const cfg = cat.cfg || DEF_CAT_CFG;
    const ng  = cfg.numGroups || 2;
    let groups;
    if (cfg.seeding === 'snake') {
      groups = snakeDistribute(roster, ng);
    } else {
      const sizes = distributeGroups(roster.length, ng);
      groups = [];
      let idx = 0;
      for (let g = 0; g < ng; g++) {
        groups.push({ name: String.fromCharCode(65+g), teams: roster.slice(idx, idx+sizes[g]) });
        idx += sizes[g];
      }
    }
    cs.roster = roster;
    cs.groups = groups;
    cs.sched  = [];
    cs.ko     = [];
    generateScheduleForCat(catId);
    return true;
  }

  // from app.js:1250
  function getKORoundName(catId, ri) {
    const { state } = ctx;
    const cs = state[catId];
    if (!cs||!cs.ko[ri]) return '';
    const fromEnd = cs.ko.length - 1 - ri;
    if (fromEnd === 0) return 'Final';
    if (fromEnd === 1) return 'Semifinals';
    if (fromEnd === 2) return 'Quarterfinals';
    if (fromEnd === 3) return 'Round of 16';
    return `Round of ${Math.pow(2,fromEnd+1)}`;
  }

  // from app.js:1270
  function assignSlotTimes(catId) {
    const { categories, state } = ctx;
    const cs  = state[catId];
    const cat = categories.find(c => c.id === catId);
    if (!cs || !cat) return;
    const cfg   = cat.cfg || DEF_CAT_CFG;
    const rules = { ...DEF_KO_RULES, ...(cfg.koRules||{}) };
    const durOf = s => (rules[s] && rules[s].dur) || cfg.gameDur || 30;
    const brk   = cfg.breakDur || 0;

    const slotDur = {};
    const note = (si, d) => { if (si >= 0) slotDur[si] = Math.max(slotDur[si]||0, d); };
    (cs.sched||[]).forEach(g => note(g.si, g.isThirdPlace ? durOf('third') : durOf('pool')));
    (cs.ko||[]).forEach((round, ri) => round.forEach(g => {
      if (g.isBye) return;
      const fromEnd = cs.ko.length - 1 - ri;
      note(g.si, durOf(fromEnd===0 ? 'final' : fromEnd===1 ? 'sf' : fromEnd===2 ? 'qf' : 'r16'));
    }));

    const timeOf = {};
    let clock = t2m(cfg.startTime || '08:00');
    Object.keys(slotDur).map(Number).sort((a,b)=>a-b).forEach(si => {
      timeOf[si] = m2t(clock);
      clock += slotDur[si] + brk;
    });
    (cs.sched||[]).forEach(g => { if (timeOf[g.si] !== undefined) g.time = timeOf[g.si]; });
    (cs.ko||[]).forEach(round => round.forEach(g => {
      if (!g.isBye && timeOf[g.si] !== undefined) g.time = timeOf[g.si];
    }));
  }

  // from app.js:1300
  function genPoolSched(catId) {
    const { categories, state } = ctx;
    const cs  = state[catId];
    const cat = categories.find(c => c.id === catId);
    if (!cs || !cat) return [];
    const cfg = cat.cfg || DEF_CAT_CFG;
    const slotDur = (cfg.gameDur||30) + (cfg.breakDur||0);
    const nc = cfg.courts || 2;
    const courtList = []; for (let c = 0; c < nc; c++) courtList.push(c + 1);

    const scheduled = [];
    let psi = 0;
    for (let p = 0; p < cs.groups.length; p += nc) {
      const remaining = [];
      for (let gi = p; gi < Math.min(p + nc, cs.groups.length); gi++) {
        const grp = cs.groups[gi];
        const homeCourt = ((gi - p) % nc) + 1;
        rr(grp.teams).forEach(([a,b]) =>
          remaining.push({ catId, gi, gn:grp.name, a, b, sa:'', sb:'', homeCourt, court:homeCourt }));
      }
      const poolRem = {};
      remaining.forEach(g => { poolRem[g.gi] = (poolRem[g.gi]||0) + 1; });
      const lastSlot = {};
      while (remaining.length && psi < 1000) {
        const used = new Set();
        courtList.forEach(court => {
          let best = null, bestScore = null, bestIdx = -1;
          for (let i = 0; i < remaining.length; i++) {
            const g = remaining[i];
            if (used.has(g.a) || used.has(g.b)) continue;
            const home    = g.homeCourt === court ? 1 : 0;
            const restA   = psi - (g.a in lastSlot ? lastSlot[g.a] : psi - 3);
            const restB   = psi - (g.b in lastSlot ? lastSlot[g.b] : psi - 3);
            const minRest = Math.min(restA, restB, 2);
            const score   = [home, minRest, poolRem[g.gi] || 0];
            if (bestScore === null || cmpScore(score, bestScore) > 0) { best = g; bestScore = score; bestIdx = i; }
          }
          if (!best) return;
          best.si = psi; best.court = court;
          best.time = addM(cfg.startTime||'08:00', psi*slotDur);
          used.add(best.a); used.add(best.b);
          lastSlot[best.a] = psi; lastSlot[best.b] = psi;
          poolRem[best.gi]--;
          scheduled.push(best);
          remaining.splice(bestIdx, 1);
        });
        psi++;
      }
    }
    return scheduled;
  }

  // from app.js:1351
  function generateScheduleForCat(catId) {
    const { categories, state } = ctx;
    const cs  = state[catId];
    const cat = categories.find(c => c.id === catId);
    if (!cs || !cat) return;
    const cfg = cat.cfg || DEF_CAT_CFG;
    const slotDur = (cfg.gameDur||30) + (cfg.breakDur||0);
    const nc = cfg.courts || 2;

    const scheduled = genPoolSched(catId);
    cs.sched = scheduled;

    const adv = cfg.advPerGroup || 0;
    const ng  = cs.groups.length;
    if (adv < 1) { cs.ko = []; assignSlotTimes(catId); return; }

    if (cfg.koFormat === 'queen' && ng === 4) {
      const lastSiQ = scheduled.length ? Math.max(...scheduled.map(g=>g.si)) : 0;
      buildQueenKO(catId, cfg, nc, slotDur, cfg.startTime||'08:00', lastSiQ + 1);
      assignSlotTimes(catId);
      return;
    }

    const koSeeds = [];
    for (let rank=1; rank<=adv; rank++)
      for (let g=0; g<ng; g++)
        koSeeds.push(`${String.fromCharCode(65+g)}${rank}`);

    let bracketSize = 1;
    while (bracketSize < koSeeds.length) bracketSize *= 2;
    while (koSeeds.length < bracketSize) koSeeds.push('TBD');

    cs.ko = [];
    const lastSi = scheduled.length ? Math.max(...scheduled.map(g=>g.si)) : 0;
    let rs = lastSi + 1;

    const firstRound = [];
    for (let i=0; i<bracketSize/2; i++) {
      const aSeed = koSeeds[i], bSeed = koSeeds[bracketSize-1-i];
      firstRound.push({ a:aSeed, b:bSeed, seedA:aSeed, seedB:bSeed, sa:'', sb:'', catId });
    }
    firstRound.forEach((g, gi) => {
      g.court = (gi % nc) + 1;
      g.si    = rs + Math.floor(gi/nc);
      g.time  = addM(cfg.startTime||'08:00', g.si*slotDur);
    });
    rs += Math.ceil(firstRound.length / nc);
    cs.ko.push(firstRound);

    let matches = firstRound.length / 2;
    while (matches >= 1) {
      const prevName = getKORoundName(catId, cs.ko.length-1);
      const round = [];
      for (let i=0; i<matches; i++) {
        round.push({
          a: `Winner of ${prevName} ${i*2+1}`,
          b: `Winner of ${prevName} ${i*2+2}`,
          sa:'', sb:'', catId,
          court: (i%nc)+1,
          si: rs + Math.floor(i/nc),
          time: addM(cfg.startTime||'08:00', (rs+Math.floor(i/nc))*slotDur)
        });
      }
      rs += Math.ceil(round.length/nc);
      cs.ko.push(round);
      matches = Math.floor(matches/2);
    }
    assignSlotTimes(catId);
  }

  // from app.js:1427
  function buildQueenKO(catId, cfg, nc, slotDur, startTime, rs) {
    const { state } = ctx;
    const cs  = state[catId];
    const bye = s        => ({ isBye:true, a:s, b:'', seedA:s, seedB:'', sa:'', sb:'', catId });
    const r16 = (sa, sb) => ({ a:sa, b:sb, seedA:sa, seedB:sb, sa:'', sb:'', catId });
    const gp  = ()       => ({ a:'', b:'', sa:'', sb:'', catId });
    const r0  = [ bye('A1'), r16('B2','A3'), bye('B1'), r16('A2','B3'),
                  bye('C1'), r16('D2','C3'), bye('D1'), r16('C2','D3') ];
    const qf  = [gp(), gp(), gp(), gp()];
    const sf  = [gp(), gp()];
    const fin = [gp()];
    cs.ko = [r0, qf, sf, fin];

    const schedRound = games => {
      const real = games.filter(g => !g.isBye);
      real.forEach((g, i) => {
        g.court = (i % nc) + 1;
        g.si    = rs + Math.floor(i / nc);
        g.time  = addM(startTime, g.si * slotDur);
      });
      rs += Math.max(1, Math.ceil(real.length / nc));
    };
    schedRound(r0); schedRound(qf); schedRound(sf); schedRound(fin);

    const finGame  = fin[0];
    const parallel = nc >= 2;
    cs.sched.push({
      catId, gi:-1, isThirdPlace:true, a:'Loser of SF1', b:'Loser of SF2', sa:'', sb:'',
      court: parallel ? finGame.court + 1 : finGame.court,
      si:    parallel ? finGame.si       : finGame.si + 1,
      time:  parallel ? finGame.time     : addM(startTime, (finGame.si + 1) * slotDur)
    });
  }

  // from app.js:1463
  function isValidScore(sa, sb, catId, ptwOverride) {
    const { categories } = ctx;
    if (isNaN(sa)||isNaN(sb)||sa===''||sb==='') return false;
    if (sa < 0 || sb < 0) return false;
    const cat = categories.find(c=>c.id===catId);
    const cfg = cat?.cfg || DEF_CAT_CFG;
    if (cfg.sets === 3) {
      const hi = Math.max(sa,sb), lo = Math.min(sa,sb);
      return (hi===2 && lo>=0 && lo<=1);
    }
    const ptw = ptwOverride || cfg.pointsToWin || 21;
    if (sa===sb) return false;
    const hi = Math.max(sa,sb), lo = Math.min(sa,sb);
    if (hi < ptw) return false;
    if (hi===ptw) return hi-lo>=2;
    return hi-lo===2;
  }

  // from app.js:1480
  function scoreError(sa, sb, catId, ptwOverride) {
    const { categories } = ctx;
    if (sa===''||sb==='') return null;
    const a=parseInt(sa), b=parseInt(sb);
    if (isNaN(a)||isNaN(b)) return null;
    if (a < 0 || b < 0) return 'Scores must be 0 or higher';
    const cat = categories.find(c=>c.id===catId);
    const cfg = cat?.cfg || DEF_CAT_CFG;
    if (cfg.sets===3) {
      const hi=Math.max(a,b), lo=Math.min(a,b);
      if (hi>2||lo<0) return 'Sets won: 2:0 or 2:1';
      if (hi!==2) return 'Winner must have 2 sets';
      return null;
    }
    const ptw = ptwOverride || cfg.pointsToWin||21;
    const hi=Math.max(a,b), lo=Math.min(a,b);
    if (hi===lo) return `Scores can't be equal`;
    if (hi<ptw) return `Must reach ${ptw} · e.g. ${ptw}–${lo}`;
    if (hi===ptw && hi-lo<2) return `Need 2-point lead`;
    if (hi>ptw && hi-lo!==2) return `Above ${ptw}: exactly 2 apart`;
    return null;
  }

  // from app.js:1506
  function getStandings(catId, gi) {
    const { state } = ctx;
    const cs  = state[catId];
    if (!cs) return [];
    const grp = cs.groups[gi];
    const rec = {};
    const normMap = {};
    grp.teams.forEach(t => {
      rec[t] = {w:0,l:0,pts:0,scored:0,against:0};
      normMap[normName(t)] = t;
    });
    const resolve = s => normMap[normName(s)] || s;
    cs.sched.filter(g=>g.gi===gi).forEach(g => {
      const sa=parseInt(g.sa), sb=parseInt(g.sb);
      if (!isValidScore(sa, sb, catId, getRuleForGame(catId, g, false).pts)) return;
      const a=resolve(g.a), b=resolve(g.b);
      if (rec[a]) { rec[a].scored+=sa; rec[a].against+=sb; }
      if (rec[b]) { rec[b].scored+=sb; rec[b].against+=sa; }
      if (sa>sb) {
        if (rec[a]) { rec[a].w++; rec[a].pts+=2; }
        if (rec[b]) { rec[b].l++; rec[b].pts+=1; }
      } else {
        if (rec[b]) { rec[b].w++; rec[b].pts+=2; }
        if (rec[a]) { rec[a].l++; rec[a].pts+=1; }
      }
    });
    return grp.teams.map(t => ({name:t,...rec[t],diff:(rec[t].scored-rec[t].against)}))
      .sort((a,b) => b.pts-a.pts||b.w-a.w||b.diff-a.diff||b.scored-a.scored);
  }

  // from app.js:1731
  function resolvePoolSeed(catId, seed) {
    const { state } = ctx;
    const cs = state[catId];
    const m  = String(seed||'').match(/^([A-Z])(\d+)$/);
    if (!m) return { label:seed||'TBD', known:false };
    const gi   = m[1].charCodeAt(0)-65;
    const rank = parseInt(m[2],10);
    if (gi<0||gi>=cs.groups.length) return { label:seed, known:false };
    const grp = cs.groups[gi];
    const totalGames = (grp.teams.length*(grp.teams.length-1))/2;
    const done = cs.sched.filter(g=>g.gi===gi&&isValidScore(parseInt(g.sa),parseInt(g.sb),catId,getRuleForGame(catId,g,false).pts)).length;
    if (done!==totalGames) return { label:seed, known:false };
    const st = getStandings(catId, gi);
    if (!st[rank-1]) return { label:seed, known:false };
    return { label:st[rank-1].name, known:true };
  }

  // from app.js:1747
  function getKOLoser(game, catId) {
    if (!game || game.isBye) return null;
    const sa=parseInt(game.sa), sb=parseInt(game.sb);
    if (isValidScore(sa,sb,catId,getRuleForGame(catId,game,true).pts)) return sa>sb ? game.b : game.a;
    return null;
  }

  // from app.js:1754
  function getKOWinner(game, catId) {
    if (!game) return null;
    if (game.isBye) {
      const seed = game.seedA || game.a;
      if (!seed) return null;
      if (/^[A-Z]\d+$/.test(seed)) { const r=resolvePoolSeed(catId,seed); return r.known?r.label:seed; }
      return seed;
    }
    const sa=parseInt(game.sa), sb=parseInt(game.sb);
    if (isValidScore(sa,sb,catId,getRuleForGame(catId,game,true).pts)) return sa>sb?game.a:game.b;
    return null;
  }

  // from app.js:1768
  function updateKOForCat(catId) {
    const { state } = ctx;
    const cs = state[catId];
    if (!cs||!cs.ko.length) return;

    cs.ko.forEach((round, ri) => round.forEach(g => { if (g) g.ri = ri; }));

    if (cs.ko[0]) {
      cs.ko[0].forEach(g => {
        const seedA = g.seedA || (g.isBye ? g.a : '');
        const seedB = g.seedB || '';
        if (seedA) { const r=resolvePoolSeed(catId,seedA); if(r.known||/^[A-Z]\d+$/.test(seedA)) g.a=r.known?r.label:seedA; }
        if (seedB) { const r=resolvePoolSeed(catId,seedB); if(r.known||/^[A-Z]\d+$/.test(seedB)) g.b=r.known?r.label:seedB; }
      });
    }

    for (let ri=1; ri<cs.ko.length; ri++) {
      const prev = cs.ko[ri-1];
      const rndName = getKORoundName(catId, ri-1);
      const isCross = prev.length === 4 && cs.ko[ri].filter(g=>!g.isThirdPlace).length === 2;
      cs.ko[ri].forEach((g, gi) => {
        if (g.isThirdPlace) return;
        const idxA = isCross ? gi               : gi*2;
        const idxB = isCross ? prev.length-1-gi : gi*2+1;
        const seedLabel = src => {
          if (!src) return null;
          if (src.seedA && src.seedB && !src.isBye) return `${src.seedA}/${src.seedB}`;
          return null;
        };
        const wa = getKOWinner(prev[idxA], catId);
        const wb = getKOWinner(prev[idxB], catId);
        g.a = wa || seedLabel(prev[idxA]) || `Winner of ${rndName} ${idxA+1}`;
        g.b = wb || seedLabel(prev[idxB]) || `Winner of ${rndName} ${idxB+1}`;
      });
    }

    if (cs.ko.length >= 2) {
      const sfRound = cs.ko[cs.ko.length - 2];
      const thirdGame = cs.sched.find(g => g.isThirdPlace);
      if (thirdGame && sfRound) {
        thirdGame.a = getKOLoser(sfRound[0], catId) || 'Loser of SF1';
        thirdGame.b = getKOLoser(sfRound[1], catId) || 'Loser of SF2';
      }
    }
  }

  // from app.js:1817
  function koGameLabel(catId, ri, gi) {
    const { state } = ctx;
    const cs = state[catId];
    if (!cs?.ko?.[ri]) return '';
    const round = cs.ko[ri];
    if (round[gi]?.isBye) return '';
    const fromEnd = cs.ko.length - 1 - ri;
    const num = round.slice(0, gi).filter(g => !g.isBye).length + 1;
    if (fromEnd === 0) return 'Final';
    if (fromEnd === 1) return `SF${num}`;
    if (fromEnd === 2) return `QF${num}`;
    if (fromEnd === 3) return `R16-${num}`;
    return `G${num}`;
  }

  return {
    getRuleForGame, coordCfg, buildCoordinatedGroups, generateCoordinatedSchedule,
    buildCategory, getKORoundName, assignSlotTimes, genPoolSched, generateScheduleForCat,
    buildQueenKO, isValidScore, scoreError, getStandings, resolvePoolSeed,
    getKOLoser, getKOWinner, updateKOForCat, koGameLabel,
  };
}
