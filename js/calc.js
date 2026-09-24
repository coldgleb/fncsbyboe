/* Калькулятор прогнозов сокомандников (перенесён из fncs_calc без изменений логики).
   В IIFE — чтобы state/render/el не столкнулись с глобальными именами сайта;
   site — state сайта (внутри state — уже состояние калькулятора). */
((site) => {
// ===================== SCORING =====================
// Qualifying position points: P1=40, P2=35, P3-P36=37-p, P37+=0
function qualPoints(place){const p=parseInt(place,10);if(!p||p<1)return 0;if(p===1)return 40;if(p===2)return 35;const v=37-p;return v>0?v:0;}
function diffPoints(diff){const d=Math.abs(parseInt(diff,10));const s=[10,7,5,3,2,1,0];if(isNaN(d))return 0;return d>=6?0:s[d];}
function mfgPoints(place){const p=parseInt(place,10);if(!p||p<1||p>10)return 0;return 11-p;}
// NASCAR 2026 race points: P1=55, P2=35, P3=34 ... P36=1, P37+=0
function finishPoints(pos){const p=parseInt(pos,10);if(!p||p<1)return 0;if(p===1)return 55;if(p<=36)return 37-p;return 1;}
// Stage points from finishing_position within stage: P1=10, P2=9 ... P10=1, else 0
function stagePointFromPos(pos){const p=parseInt(pos,10);if(!p||p<1||p>10)return 0;return 11-p;}
// Normalise manufacturer name to internal key
const MFG_NORM={'chevrolet':'Chv','chevy':'Chv','chev':'Chv','ford':'Frd','toyota':'Tyt',
  'chv':'Chv','frd':'Frd','tyt':'Tyt'};
function normMfg(m){return MFG_NORM[String(m||'').trim().toLowerCase()]||m||'';}
// Место участника в квал-зачёте конкурса: 1→20, 2-3→19, 4-5→18, 6-7→17 ... пары вниз до 0
function qualResultPoints(place){const p=parseInt(place,10);if(!p||p<1)return 0;if(p===1)return 20;const v=19-Math.floor((p-2)/2);return v>0?v:0;}
const MFG_NAMES={Chv:'Chevrolet',Frd:'Ford',Tyt:'Toyota'};
const num=x=>x==null?'':String(x);
function normName(s){return (s||'').toLowerCase().replace(/[^a-zа-я0-9]+/gi,' ').trim();}

// ===================== STORAGE =====================
// Два калькулятора — Open и Star — со своими участниками и сохранением; какой из них —
// решает дивизион, выбранный в шапке сайта. У Open ключ прежний, чтобы сохранённое не потерялось
let calcKind=site.division==='star'?'star':'open';
const storeKey=()=>calcKind==='star'?'nascar_pred_star_v1':'nascar_pred_v5';
const isStar=()=>calcKind==='star';
async function loadState(){try{const r=localStorage.getItem(storeKey());return r?JSON.parse(r):null;}catch(e){return null;}}
async function saveState(s){try{localStorage.setItem(storeKey(),JSON.stringify(s));}catch(e){}}

const DUEL_COUNT=5;
function newParticipant(name){return {name:name||'Участник',carNum:'',team:'',drivers:[null,null,null,null],qualResultPlace:'',predCaution:'',predRet:'',mfg:'',duelPicks:Array(DUEL_COUNT).fill(null)};}
const DEFAULT={
  raceName:'', weekendRaw:'', feedRaw:'', pointsRaw:'',
  year:'2026', series:'1', raceId:'',
  qualRoster:[], raceRoster:[], pointsByNum:{}, raceLists:{},
  cautionSegmentsRace:null, stageNumRace:null,
  weekendCautions:null, weekendRet:null,
  sort:{key:null,dir:'desc'},               // сортировка таблицы по клику на заголовок; key null — исходный порядок
  team:'',                                  // выбранная команда — её пилоты подставлены в участники
  actualCaution:'', actualRet:'',           // shared actuals (auto from feed, editable)
  duelPairs:Array.from({length:DUEL_COUNT},()=>[null,null]),   // Star: пары пилотов этапа (номера машин), общие на всех
  participants:[newParticipant('Участник 1'),newParticipant('Участник 2')]
};
let state=null;
let raceListCache=null;let raceListCacheKey='';let raceListErr='';let fillRaceSelNow=null;

// ===================== PARSERS =====================
function cleanName(s){return (s||'').replace(/^[*#\s]+/,'').replace(/\s*[#(].*$/,'').trim();}

function parseFeed(raw){
  let j=JSON.parse(raw);
  if(j && !Array.isArray(j.vehicles)){
    if(j.feed&&Array.isArray(j.feed.vehicles)) j=j.feed;
    else if(j.data&&Array.isArray(j.data.vehicles)) j=j.data;
  }
  const vehicles=Array.isArray(j.vehicles)?j.vehicles:[];
  const isQual=j.run_type===2||/qualifying|pole/i.test(j.run_name||'');
  const roster=vehicles.map(v=>({
    num:String(v.vehicle_number),
    name:cleanName(v.driver&&v.driver.full_name)||('#'+v.vehicle_number),
    mfg:v.vehicle_manufacturer,
    running:v.running_position,
    status:(v.status!=null?v.status:null),
    onTrack:(v.is_on_track===true),
  }));
  return {roster,feedType:isQual?'qual':'race',
    raceName:(j.run_name||'').replace(/\s*(Busch Pole|Qualifying|Pole).*$/i,'').trim()||j.track_name||'',
    raceId:(j.race_id!=null?String(j.race_id):''),
    series:(j.series_id!=null?String(j.series_id):''),
    cautionSegments:(typeof j.number_of_caution_segments==='number')?j.number_of_caution_segments:null,
    stageNum:(j.stage&&typeof j.stage.stage_num==='number')?j.stage.stage_num:null};
}

function parseSchedule(raw){
  let j=JSON.parse(raw);let races=null;
  if(Array.isArray(j))races=j;else if(Array.isArray(j.races))races=j.races;else if(Array.isArray(j.schedule))races=j.schedule;
  else if(typeof j==='object'){for(const k in j){if(Array.isArray(j[k])){races=j[k];break;}}}
  if(!races||!races.length)throw new Error('массив гонок не найден');
  const now=Date.now();
  const norm=races.map(r=>{const id=r.race_id??r.RaceID??r.id??r.raceId;const dStr=r.race_date??r.date_scheduled??r.scheduled??r.start_time??r.date;const t=dStr?Date.parse(dStr):NaN;return {id:(id!=null?Number(id):NaN),t:isNaN(t)?null:t,name:(r.race_name??r.name??'')};}).filter(r=>!isNaN(r.id));
  if(!norm.length)throw new Error('race_id не найден');
  const past=norm.filter(r=>r.t!=null&&r.t<=now).sort((a,b)=>b.t-a.t);
  if(past.length)return past[0];
  return norm.slice().sort((a,b)=>b.id-a.id)[0];
}

function parseRaceList(raw){
  let j=JSON.parse(raw);let races=null;
  if(Array.isArray(j))races=j;else if(Array.isArray(j.races))races=j.races;
  else if(Array.isArray(j.schedule))races=j.schedule;
  else if(typeof j==='object'){for(const k in j){if(Array.isArray(j[k])){races=j[k];break;}}}
  if(!races||!races.length)throw new Error('массив гонок не найден');
  return races.map(r=>{
    const id=r.race_id??r.RaceID??r.id??r.raceId;
    const dStr=r.race_date??r.date_scheduled??r.scheduled??r.start_time??r.date;
    const t=dStr?Date.parse(dStr):NaN;
    return {id:(id!=null?Number(id):NaN),t:isNaN(t)?null:t,name:(r.race_name??r.name??'')};
  }).filter(r=>!isNaN(r.id)).sort((a,b)=>(a.t||0)-(b.t||0));
}

function parsePoints(raw){
  const j=JSON.parse(raw);
  const arr=Array.isArray(j)?j:(j.vehicles||j.drivers||j.points||[]);
  const map={};
  (arr||[]).forEach(e=>{const cn=e.vehicle_number??e.car_number??e.number;const pts=e.points_earned_this_race;if(cn!=null&&pts!=null&&!isNaN(+pts))map[String(cn)]=+pts;});
  return map;
}

function parseWeekendFeed(raw){
  const j=JSON.parse(raw);
  const wr=(Array.isArray(j.weekend_race)&&j.weekend_race[0])||j;
  const results=Array.isArray(wr.results)?wr.results:[];

  // Qualifying positions from weekend_runs where run_type=2
  const qualRun=(j.weekend_runs||[]).find(r=>r.run_type===2);
  const qualPosMap={};
  if(qualRun&&Array.isArray(qualRun.results)){
    qualRun.results.forEach(r=>{
      const n=String(r.car_number||r.vehicle_number);
      qualPosMap[n]=r.finishing_position;
    });
  }

  // Stage points per car: finishing_position within each stage → P1=10..P10=1
  const stagePts={};
  (wr.stage_results||[]).forEach(stage=>{
    (stage.results||[]).forEach(sr=>{
      const n=String(sr.car_number);
      stagePts[n]=(stagePts[n]||0)+stagePointFromPos(sr.finishing_position);
    });
  });

  // Build rosters and compute combined points
  const pointsByNum={};
  const raceRoster=[];
  const qualRoster=[];
  results.forEach(r=>{
    const num=String(r.car_number);
    const name=r.driver_fullname||('#'+num);
    const mfg=normMfg(r.car_make);
    const isRunning=(r.finishing_status||'').toLowerCase()==='running';
    raceRoster.push({num,name,mfg,running:r.finishing_position,status:isRunning?1:0,onTrack:false});
    const qpos=qualPosMap[num]??null;
    if(qpos!=null) qualRoster.push({num,name,mfg,running:qpos,status:1,onTrack:false});
    pointsByNum[num]=(stagePts[num]||0)+finishPoints(r.finishing_position);
  });

  // Cautions: caution_segments where reason != "Competition"
  const cautions=(wr.caution_segments||[]).filter(c=>c.reason!=='Competition').length;

  // Retirements: results where finishing_status != "Running"
  const ret=results.filter(r=>(r.finishing_status||'').toLowerCase()!=='running').length;

  return {raceRoster,qualRoster,pointsByNum,
    raceName:wr.race_name||'',
    raceId:wr.race_id!=null?String(wr.race_id):'',
    series:wr.series_id!=null?String(wr.series_id):'',
    cautions,ret};
}
function applyWeekendFeed(raw){
  const p=parseWeekendFeed(raw);
  if(!state.raceName&&p.raceName)state.raceName=p.raceName;
  if(p.raceId)state.raceId=p.raceId;
  if(p.series)state.series=p.series;
  state.raceRoster=p.raceRoster;
  state.qualRoster=p.qualRoster;
  state.pointsByNum=p.pointsByNum;
  if(p.cautions!=null)state.weekendCautions=p.cautions;
  state.weekendRet=p.ret;
}

function feedLinks(year,series,raceId){
  const base=`https://cf.nascar.com/live/feeds/series_${series}/${raceId}`;
  return {schedule:`https://cf.nascar.com/cacher/${year}/${series}/race_list_basic.json`,
    weekend:`https://cf.nascar.com/cacher/${year}/${series}/${raceId}/weekend-feed.json`,
    live:`${base}/live_feed.json`,livePoints:`${base}/live-points.json`,livePage:`https://www.nascar.com/live-results/`};
}
// cached=true → отдаём браузеру кэшировать (расписание меняется редко и весит много)
async function fetchFeed(url,cached){
  const res=await fetch(url,{cache:cached?'default':'no-store',signal:AbortSignal.timeout(20000)});
  if(!res.ok)throw new Error('HTTP '+res.status);
  return await res.text();
}

function applyFeed(raw){
  const p=parseFeed(raw);
  if(!state.raceName&&p.raceName)state.raceName=p.raceName;
  if(p.raceId)state.raceId=p.raceId; if(p.series)state.series=p.series;
  if(p.feedType==='qual'){ state.qualRoster=p.roster; }
  else { state.raceRoster=p.roster; state.cautionSegmentsRace=p.cautionSegments; state.stageNumRace=p.stageNum; }
  return p.feedType;
}

// ===================== DATA LOOKUPS =====================
// combined roster of drivers (race preferred, qual fallback), unique by num
function combinedRoster(){const m={};state.raceRoster.forEach(d=>m[d.num]=d);state.qualRoster.forEach(d=>{if(!m[d.num])m[d.num]=d;});return Object.values(m);}
// driver chosen by num -> {qualPlace, racePlace, points, mfg, name, onTrack}
function driverData(numv){
  if(!numv) return null;
  const q=state.qualRoster.find(d=>d.num===numv);
  const r=state.raceRoster.find(d=>d.num===numv);
  const base=r||q||combinedRoster().find(d=>d.num===numv);
  if(!base){
    // ростер не загружен — показываем хотя бы номер машины, чтобы выбор не пропадал
    return {num:numv,name:'#'+numv,mfg:null,qualPlace:null,racePlace:null,
      points:(state.pointsByNum&&state.pointsByNum[numv]!=null)?state.pointsByNum[numv]:null,onTrack:null};
  }
  return {num:numv,name:base.name,mfg:base.mfg,
    qualPlace:q?q.running:null,
    racePlace:r?r.running:null,
    points:(state.pointsByNum&&state.pointsByNum[numv]!=null)?state.pointsByNum[numv]:null,
    onTrack:r?r.onTrack:null};
}
// auto actuals from race feed
function autoCautions(){ if(state.weekendCautions!=null)return state.weekendCautions; if(state.cautionSegmentsRace!=null&&state.stageNumRace!=null) return state.cautionSegmentsRace-state.stageNumRace+1; return null; }
function autoRetirements(){ if(state.weekendRet!=null)return state.weekendRet; if(!state.raceRoster.length) return null; let n=0; state.raceRoster.forEach(d=>{if(d.status!=null && Number(d.status)!==1)n++;}); return n; }
function effCaution(){ return state.actualCaution!==''?+state.actualCaution:(autoCautions()!=null?autoCautions():null); }
function effRet(){ return state.actualRet!==''?+state.actualRet:(autoRetirements()!=null?autoRetirements():null); }
// best finish for a manufacturer (race feed)
function mfgBestFinish(mfgCode){ if(!mfgCode||!state.raceRoster.length)return null; let best=null; state.raceRoster.forEach(d=>{if(d.mfg===mfgCode&&d.running>0){if(best===null||d.running<best)best=d.running;}}); return best; }

// Star, дуэли: +2 за пару, если выбранный пилот выше соперника по месту (placeKey — 'qualPlace' в квале,
// 'racePlace' в гонке). Пара не задана, выбор не из пары или у кого-то нет места — пара не считается
function duelWinner(pair,placeKey){
  if(!pair[0]||!pair[1]||pair[0]===pair[1])return null;
  const a=driverData(pair[0])?.[placeKey], b=driverData(pair[1])?.[placeKey];
  return a>0&&b>0?(a<b?pair[0]:pair[1]):null;
}
function duelPts(p,placeKey){
  if(!isStar())return 0;
  return (state.duelPairs||[]).reduce((sum,pair,i)=>{
    const pick=p.duelPicks?.[i];
    return pick&&pick===duelWinner(pair,placeKey)?sum+2:sum;
  },0);
}

// ===================== PER-PARTICIPANT SCORING =====================
// Competition ranking (1-2-2-4): ties share the same rank
function computeRanks(scores){
  const sorted=[...scores].sort((a,b)=>b-a);
  return scores.map(s=>sorted.indexOf(s)+1);
}

function computeAllScores(participants){
  const ec=effCaution(), er=effRet();
  // Pass 1: qual sums + driver rows
  const pass1=participants.map(p=>{
    const dueQual=duelPts(p,'qualPlace');
    let qualSum=dueQual;   // в Star DUE квалы входит в очки квалы (лист Star Quals), значит и в ранг
    const rows=p.drivers.map(numv=>{
      const d=driverData(numv);
      const qp=d&&d.qualPlace?d.qualPlace:'';
      const qpts=qualPoints(qp);
      qualSum+=qpts;
      return {name:d?d.name:'',qualPlace:qp,qualPts:qpts,
        racePlace:d&&d.racePlace?d.racePlace:'',
        racePts:(d&&d.points!=null)?d.points:''};
    });
    return {qualSum,rows,dueQual};
  });
  // Pass 2: rank participants by qual score → qual result points
  const qualRanks=computeRanks(pass1.map(q=>q.qualSum));
  // Pass 3: full scores
  return participants.map((p,i)=>{
    const {qualSum,rows,dueQual}=pass1[i];
    // место с листа Open Quals, если этап выбран и участник в протоколе; иначе — ранг по сумме квал-очков
    const sheetPlace=sheetQualPlace(p);
    const missedRace=qualMissedRace(p);
    const qualRank=missedRace?null:(sheetPlace??qualRanks[i]);
    const manual=p.qualResultPlace!==''&&!isNaN(+p.qualResultPlace);
    const effectiveRank=manual?+p.qualResultPlace:qualRank;
    const qrPts=effectiveRank==null?0:qualResultPoints(effectiveRank);
    let raceDriverSum=0;
    rows.forEach(r=>{raceDriverSum+=(r.racePts!==''?+r.racePts:0);});
    const cauPts=(p.predCaution===''||ec==null)?0:diffPoints(p.predCaution-ec);
    const retPts=(p.predRet===''||er==null)?0:diffPoints(p.predRet-er);
    const mfgFin=mfgBestFinish(p.mfg);
    const mPts=mfgPoints(mfgFin);
    const dueRace=duelPts(p,'racePlace');
    const raceTotal=raceDriverSum+cauPts+retPts+mPts+dueRace;
    return {rows,qualSum,qualRank,missedRace,qualFromSheet:sheetPlace!=null,qrPts,raceDriverSum,cauPts,retPts,mfgFin,mPts,dueQual,dueRace,raceTotal,
      grand:qrPts+raceTotal,ec,er};
  });
}

// ===================== UI HELPERS =====================
function el(t,a={},...k){const e=document.createElement(t);for(const x in a){if(x==='class')e.className=a[x];else if(x==='html')e.innerHTML=a[x];else if(x.startsWith('on'))e.addEventListener(x.slice(2).toLowerCase(),a[x]);else if(a[x]!=null)e.setAttribute(x,a[x]);}k.flat().forEach(c=>{if(c==null)return;e.appendChild(typeof c==='string'?document.createTextNode(c):c);});return e;}

// ===================== UI HELPERS =====================
let openCombo=null;

// compact driver combo: small input (#NUM lastName), dropdown on focus
function driverComboCompact(pi,di,srow){
  const cur=state.participants[pi].drivers[di];
  const curD=cur?driverData(cur):null;
  function shortName(d){if(!d)return '';const parts=(d.name||'').split(' ');return '#'+d.num+' '+(parts[parts.length-1]||'');}
  const wrap=el('div',{class:'combo-c'});
  const input=el('input',{class:'cinput-c',placeholder:'—',
    value:shortName(curD),title:curD?curD.name:'',
    onfocus:e=>{e.target.select();showList('');},
    oninput:e=>{showList(e.target.value);}});
  const list=el('div',{class:'clist',style:'display:none'});
  function pick(d){state.participants[pi].drivers[di]=d?d.num:null;saveState(state);render();}
  function showList(filter){
    if(openCombo&&openCombo!==list)openCombo.style.display='none';
    openCombo=list;list.innerHTML='';list.style.display='block';
    const raw=filter.replace(/^#/,'').trim();
    const f=normName(raw);
    const items=combinedRoster().filter(d=>!f||normName(d.name).includes(f)||d.num.startsWith(raw)||d.num===raw)
      .sort((a,b)=>+a.num-+b.num).slice(0,60);
    if(!items.length)list.appendChild(el('div',{class:'cempty'},'нет'));
    items.forEach(d=>list.appendChild(el('div',{class:'citem',onmousedown:ev=>{ev.preventDefault();pick(d);}},`#${d.num} ${d.name}`)));
    if(cur)list.insertBefore(el('div',{class:'citem clear',onmousedown:ev=>{ev.preventDefault();pick(null);}},'× очистить'),list.firstChild);
  }
  input.addEventListener('blur',()=>{setTimeout(()=>{list.style.display='none';
    const d=cur?driverData(cur):null;input.value=shortName(d);input.title=d?d.name:'';},150);});
  // score meta line
  const meta=[];
  if(srow.qualPlace!=='')meta.push('Q'+srow.qualPlace+' +'+srow.qualPts);
  if(srow.racePts!=='')meta.push(srow.racePts+'п');
  wrap.appendChild(input);wrap.appendChild(list);
  if(meta.length)wrap.appendChild(el('div',{class:'cmeta'},meta.join(' · ')));
  return wrap;
}

function mfgSelect(pi){
  const cur=state.participants[pi].mfg;
  return el('select',{class:'msel',onchange:e=>{state.participants[pi].mfg=e.target.value;saveState(state);render();}},
    el('option',{value:''},'—'),
    ...['Chv','Frd','Tyt'].map(m=>el('option',{value:m,...(cur===m?{selected:'selected'}:{})},MFG_NAMES[m])));
}

// Столбец → значение для сортировки по клику на заголовок (по посчитанным очкам, не по тексту ячеек)
const SORT_KEYS={
  name:p=>p.name||'',
  ...Object.fromEntries([0,1,2,3].map(i=>['drv'+i,(p,s)=>s.rows[i].racePts===''?null:+s.rows[i].racePts])),
  qrank:(p,s)=>p.qualResultPlace!==''&&!isNaN(+p.qualResultPlace)?+p.qualResultPlace:s.qualRank,
  cau:(p,s)=>s.cauPts, ret:(p,s)=>s.retPts, mfg:(p,s)=>s.mPts, duel:(p,s)=>s.dueQual+s.dueRace,
  qual:(p,s)=>s.qualSum, race:(p,s)=>s.raceTotal, total:(p,s)=>s.grand,
};
const SORT_ASC=new Set(['name','qrank']);   // первый клик — по возрастанию; остальные — очки, сначала больше

// ===================== RENDER =====================
function render(){
  const root=document.getElementById('calc-root');root.innerHTML='';
  // дивизион выбирается в шапке сайта
  root.appendChild(el('div',{class:'round-bar'},el('label',{class:'round-label'},'Калькулятор · '+DIVISIONS[calcKind].label)));
  const P=state.participants;
  const ec=effCaution(),er=effRet();

  const scores=computeAllScores(P);
  // не прошедшие в гонку этапа в таблицу не выводятся (остаются в сохранении — вернутся при другом этапе)
  const missed=P.filter(p=>qualMissedRace(p));
  let ranked=P.map((_,i)=>i).filter(i=>!qualMissedRace(P[i]));
  const sortFn=SORT_KEYS[state.sort?.key];
  if(sortFn){
    const k=state.sort.dir==='asc'?1:-1;
    ranked.sort((a,b)=>{
      const va=sortFn(P[a],scores[a]),vb=sortFn(P[b],scores[b]);
      // пустые всегда внизу — и при возрастании, и при убывании
      if(va==null||va===''||vb==null||vb==='')return (va==null||va==='')===(vb==null||vb==='')?0:(va==null||va==='')?1:-1;
      return typeof va==='string'?k*va.localeCompare(vb,'ru'):k*(va-vb);
    });
  }
  const sortTh=(key,cls,label,title,...extra)=>el('th',{class:cls,'data-k':key,title,onclick:()=>{
      const cur=state.sort||(state.sort={key:null,dir:'desc'});
      if(key==='#'){cur.key=null;}
      else if(cur.key===key){cur.dir=cur.dir==='asc'?'desc':'asc';}
      else{cur.key=key;cur.dir=SORT_ASC.has(key)?'asc':'desc';}
      saveState(state);render();
    }},label,...extra,state.sort?.key===key?el('span',{class:'sort-arrow'},state.sort.dir==='asc'?' ▲':' ▼'):null);

  // header: название гонки и справа «?» — как пользоваться (текст — в calc-help.html)
  const help=el('div',{class:'calc-help',style:helpOpen?'':'display:none'});
  root.appendChild(el('div',{class:'hd'},
    el('input',{class:'race',placeholder:'Название гонки',value:state.raceName,
      oninput:e=>{state.raceName=e.target.value;saveState(state);}}),
    el('button',{class:'page-btn icon-btn',title:'Как пользоваться калькулятором',onclick:()=>{
      helpOpen=!helpOpen;help.style.display=helpOpen?'':'none';if(helpOpen)fillHelp(help);}},'?')));
  root.appendChild(help);
  if(helpOpen)fillHelp(help);

  renderSources(root);
  if(isStar())renderDuelPairs(root);

  // ---- participants table ----
  const card=el('section',{class:'table-card'});

  // шапка карточки: заголовок слева, факты гонки справа
  const sumbar=el('div',{class:'table-controls sumbar'});
  if(ec!=null)sumbar.appendChild(el('span',{class:'sumitem fact-hd'},'Жёлтые: '+ec));
  if(er!=null)sumbar.appendChild(el('span',{class:'sumitem fact-hd'},'Сходы: '+er));
  card.appendChild(el('div',{class:'table-header'},
    el('h3',{},'Участники · '+ranked.length),sumbar));

  const wrap=el('div',{class:'table-scroll tscroll'});
  const tbl=el('table',{class:'standings-table ptbl'});

  // thead
  const htr=el('tr',{},
    sortTh('#','th-rank','#','Исходный порядок'),
    sortTh('name','th-name','Имя'),
    ...[0,1,2,3].map(i=>sortTh('drv'+i,'th-drv','Пилот '+(i+1),'Сортировка по очкам пилота')),
    sortTh('qrank','th-n','Ркв.','Место в квалификации → очки'),
    sortTh('cau','th-n','Жёлт.','Жёлтые флаги'+(ec!=null?' (факт '+ec+')':''),ec!=null?el('span',{class:'fact-hd'},' '+ec):null),
    sortTh('ret','th-n','Сходы','Сходы'+(er!=null?' (факт '+er+')':''),er!=null?el('span',{class:'fact-hd'},' '+er):null),
    isStar()?sortTh('duel','th-duel','Дуэли','Кто в паре выше: +2 за угаданную пару в квале и в гонке'):null,
    sortTh('mfg','th-mfg','Произв.'),
    sortTh('qual','th-pts','Кв.','Очки за квалификацию'),
    sortTh('race','th-pts','Гонка','Очки за гонку'),
    sortTh('total','th-total','Итого'),
    el('th',{class:'th-del'})
  );
  tbl.appendChild(el('thead',{},htr));

  const tbody=el('tbody');
  ranked.forEach((pi,rank)=>{
    const p=P[pi];const s=scores[pi];
    const racePtsTot=s.raceTotal;
    const tr=el('tr',{class:'prow'+(rank===0&&s.grand>0?' p1':'')+(rank%2===1?' alt':'')});

    tr.appendChild(el('td',{class:'td-rank'},String(rank+1)));

    // name
    const ntd=el('td',{class:'td-name'});
    ntd.appendChild(nameCombo(p));
    ntd.appendChild(el('div',{class:'pmeta'},
      el('input',{class:'pnum-c',placeholder:'#',value:p.carNum,title:'Номер машины',
        oninput:e=>{p.carNum=e.target.value;saveState(state);}}),
      el('input',{class:'pteam-c',placeholder:'команда',value:p.team,title:'Команда',
        oninput:e=>{p.team=e.target.value;saveState(state);}})));
    tr.appendChild(ntd);

    // 4 drivers
    for(let di=0;di<4;di++){
      const td=el('td',{class:'td-drv'});
      td.appendChild(driverComboCompact(pi,di,s.rows[di]));
      tr.appendChild(td);
    }

    // qual rank (auto) with manual override
    const qrtd=el('td',{class:'td-n'});
    const autoRank=s.qualRank;
    const overrideVal=p.qualResultPlace;
    const effectiveRank=overrideVal!==''&&!isNaN(+overrideVal)?+overrideVal:autoRank;
    // в поле — место: ручное, если задано, иначе посчитанное по данным квалификации; очистить поле — вернуть авто
    const ovr=el('input',{class:'n-inp'+(overrideVal!==''?' qrank-manual':''),type:'number',min:'1',
      value:effectiveRank==null?'':effectiveRank,
      title:s.missedRace&&overrideVal===''
        ? 'Не прошёл в гонку этапа — очки за квалификацию не начисляются. Можно задать место вручную'
        : (s.qualFromSheet?'Протокол квалификации: #':'Расчёт: #')+(autoRank??'—')
          +(overrideVal!==''?' → ручной #'+overrideVal:'')+'. Очистите поле, чтобы вернуть авто',
      onchange:e=>{p.qualResultPlace=e.target.value;saveState(state);render();}});
    qrtd.appendChild(ovr);
    const effectivePts=effectiveRank==null?0:qualResultPoints(effectiveRank);
    if(effectivePts)qrtd.appendChild(el('div',{class:'bpts-s'},'+'+effectivePts));
    tr.appendChild(qrtd);

    // cautions
    const ctd=el('td',{class:'td-n'});
    ctd.appendChild(el('input',{class:'n-inp',type:'number',min:'0',placeholder:'—',value:p.predCaution,
      oninput:e=>{p.predCaution=e.target.value;saveState(state);},
      onchange:e=>{p.predCaution=e.target.value;saveState(state);render();}}));
    if(s.cauPts)ctd.appendChild(el('div',{class:'bpts-s'},'+'+s.cauPts));
    tr.appendChild(ctd);

    // retirements
    const rtd=el('td',{class:'td-n'});
    rtd.appendChild(el('input',{class:'n-inp',type:'number',min:'0',placeholder:'—',value:p.predRet,
      oninput:e=>{p.predRet=e.target.value;saveState(state);},
      onchange:e=>{p.predRet=e.target.value;saveState(state);render();}}));
    if(s.retPts)rtd.appendChild(el('div',{class:'bpts-s'},'+'+s.retPts));
    tr.appendChild(rtd);

    if(isStar())tr.appendChild(duelCell(p,s));

    // mfg
    const mtd=el('td',{class:'td-mfg'});
    mtd.appendChild(mfgSelect(pi));
    if(s.mPts)mtd.appendChild(el('div',{class:'bpts-s'},'+'+s.mPts+(s.mfgFin?' P'+s.mfgFin:'')));
    tr.appendChild(mtd);

    tr.appendChild(el('td',{class:'td-pts'},String(s.qualSum)));
    tr.appendChild(el('td',{class:'td-pts'},String(racePtsTot)));
    tr.appendChild(el('td',{class:'td-total'},String(s.grand)));

    const dtd=el('td',{class:'td-del'});
    if(P.length>1)dtd.appendChild(el('button',{class:'xdel',title:'удалить',onclick:()=>{
      if(confirm('Удалить?')){state.participants.splice(pi,1);saveState(state);render();}
    }},'×'));
    tr.appendChild(dtd);
    tbody.appendChild(tr);
  });
  tbl.appendChild(tbody);
  wrap.appendChild(tbl);
  card.appendChild(wrap);
  if(missed.length)card.appendChild(el('div',{class:'sub'},
    `Не прошли в гонку этапа ${state.round} и скрыты: ${missed.map(p=>p.name).join(', ')}`));
  root.appendChild(card);

  root.appendChild(el('div',{class:'addrow'},
    el('button',{class:'add',onclick:()=>{state.participants.push(newParticipant('Участник '+(P.length+1)));saveState(state);render();}},'+ участник'),
    el('button',{class:'io',onclick:()=>exportData()},'⤓ Экспорт JSON'),
    el('button',{class:'io',onclick:()=>importData()},'⤒ Импорт JSON'),
    el('button',{class:'reset',onclick:async()=>{if(confirm('Очистить всё?')){state=JSON.parse(JSON.stringify(DEFAULT));await saveState(state);render();}}},'Очистить всё')));
}

// ===================== EXPORT / IMPORT =====================
function safeName(){return (state.raceName||'nascar').replace(/[^a-zа-я0-9]+/gi,'_').slice(0,40)||'nascar';}
function download(fname,text,mime){
  const url=URL.createObjectURL(new Blob([text],{type:mime}));
  const a=document.createElement('a');
  a.href=url; a.download=fname;
  document.body.appendChild(a); a.click();
  setTimeout(()=>{document.body.removeChild(a);URL.revokeObjectURL(url);},100);
}
function exportData(){
  const payload={
    _type:'nascar_pred', _version:6,
    raceName:state.raceName, year:state.year, series:state.series, raceId:state.raceId,
    actualCaution:state.actualCaution, actualRet:state.actualRet,
    duelPairs:state.duelPairs,
    participants:state.participants
  };
  download(`${safeName()}_прогнозы.json`,JSON.stringify(payload,null,2),'application/json');
}

function importData(){
  const inp=document.createElement('input');
  inp.type='file'; inp.accept='application/json,.json';
  inp.onchange=e=>{
    const file=e.target.files&&e.target.files[0]; if(!file)return;
    const reader=new FileReader();
    reader.onload=()=>{
      try{
        const d=JSON.parse(reader.result);
        if(!d||!Array.isArray(d.participants)) throw new Error('нет участников');
        if(d.raceName!=null)state.raceName=d.raceName;
        if(d.year!=null)state.year=d.year;
        if(d.series!=null)state.series=d.series;
        if(d.raceId!=null)state.raceId=d.raceId;
        if(d.actualCaution!=null)state.actualCaution=d.actualCaution;
        if(d.actualRet!=null)state.actualRet=d.actualRet;
        if(Array.isArray(d.duelPairs))state.duelPairs=Array.from({length:DUEL_COUNT},(_,i)=>
          Array.isArray(d.duelPairs[i])?[d.duelPairs[i][0]??null,d.duelPairs[i][1]??null]:[null,null]);
        // Сброс результатов — данные загрузятся автоматически по raceId
        state.weekendRaw=''; state.feedRaw=''; state.pointsRaw='';
        state.qualRoster=[]; state.raceRoster=[]; state.pointsByNum={};
        state.weekendCautions=null; state.weekendRet=null;
        state.cautionSegmentsRace=null; state.stageNumRace=null;
        if(state.raceId&&state.year&&state.series){
          const wurl=feedLinks(state.year,state.series,state.raceId).weekend;
          fetchFeed(wurl).then(wraw=>{
            applyWeekendFeed(wraw); state.weekendRaw=wraw; saveState(state); render();
          }).catch(()=>{});
        }
        // normalize participants (fill missing fields)
        state.participants=d.participants.map(p=>{
          const base=newParticipant(p.name);
          base.drivers=Array.isArray(p.drivers)?p.drivers.slice(0,4):[null,null,null,null];
          while(base.drivers.length<4)base.drivers.push(null);
          base.carNum=p.carNum??'';
          base.team=p.team??'';
          base.qualResultPlace=p.qualResultPlace??'';
          base.predCaution=p.predCaution??'';
          base.predRet=p.predRet??'';
          base.mfg=normMfg(p.mfg);   // принимаем и «Chevrolet»/«Chevy»/«Toyota»
          if(Array.isArray(p.duelPicks))base.duelPicks=Array.from({length:DUEL_COUNT},(_,i)=>p.duelPicks[i]??null);
          return base;
        });
        saveState(state); render();
        alert('Импорт выполнен: участников '+state.participants.length);
      }catch(err){ alert('Не удалось импортировать файл: '+err.message); }
    };
    reader.readAsText(file);
  };
  inp.click();
}

function renderSources(root){
  const L=feedLinks(state.year,state.series,state.raceId||'{race_id}');
  const src=el('section',{class:'table-card'});
  src.appendChild(el('div',{class:'table-header'},el('h3',{},'Источники данных'),
    el('div',{class:'table-controls'},
      el('span',{class:'badge'+(state.raceId?' ok':'')}, state.raceId?('race_id '+state.raceId):'race_id не задан'))));
  const params=el('div',{class:'params'});
  params.appendChild(el('div',{class:'pgrp'},el('label',{},'Год'),
    el('input',{class:'pin',value:state.year,oninput:e=>{state.year=e.target.value.trim();},onchange:e=>{state.year=e.target.value.trim();saveState(state);render();}})));
  // серия одна — Кубок, выбирать нечего
  state.series='1';
  // Race dropdown — auto-loads when year/series changes
  const raceKey=state.year+'|'+state.series;
  const raceGrp=el('div',{class:'pgrp'});
  raceGrp.appendChild(el('label',{},'Гонка'));
  const rSel=el('select',{class:'pin chart-select',style:'width:320px',
    onchange:e=>{const v=e.target.value;if(!v)return;state.raceId=v;saveState(state);render();}});
  const fillRaceSel=()=>{
    while(rSel.firstChild)rSel.removeChild(rSel.firstChild);
    if(!raceListCache||!raceListCache.length){
      rSel.appendChild(el('option',{value:''},raceListErr?('Ошибка: '+raceListErr):'Загрузка…'));
    } else {
      rSel.appendChild(el('option',{value:''},'— выберите гонку —'));
      raceListCache.forEach(r=>{
        const d=r.t?new Date(r.t).toLocaleDateString('ru-RU',{day:'2-digit',month:'2-digit',year:'numeric'}):'???';
        const opt=el('option',{value:String(r.id),...(String(r.id)===state.raceId?{selected:'selected'}:{})},d+' – '+r.name);
        rSel.appendChild(opt);
      });
    }
  };
  fillRaceSelNow=fillRaceSel;   // ответ может прийти после нового рендера
  // Фид cf.nascar.com часто зависает на середине тела — держим последний удачный список
  // в state и показываем его сразу, обновление идёт фоном (ручной повтор — кнопкой ⟳).
  const loadRaceList=()=>{
    raceListErr='';raceListCacheKey=raceKey;fillRaceSel();
    fetchFeed(L.schedule,true).then(raw2=>{
      raceListCache=parseRaceList(raw2);
      (state.raceLists||(state.raceLists={}))[raceKey]=raceListCache;
      saveState(state);
    }).catch(e=>{
      raceListErr=e.name==='TimeoutError'?'таймаут — повторите ⟳':(e.message||'сеть');
    }).finally(()=>{ fillRaceSelNow&&fillRaceSelNow(); });
  };
  if(raceListCacheKey!==raceKey){
    raceListCache=(state.raceLists||{})[raceKey]||null;
    loadRaceList();
  } else fillRaceSel();
  raceGrp.appendChild(el('div',{class:'rrow'},rSel,
    el('button',{class:'rlbtn',title:'Перезагрузить список гонок',onclick:loadRaceList},'⟳')));
  params.appendChild(raceGrp);
  params.appendChild(roundSelect());
  params.appendChild(teamSelect());
  src.appendChild(params);

  const ready=!!state.raceId;
  function linkRow(label,url,note,rdy){return el('div',{class:'lrow'},el('div',{class:'lhd'},el('span',{class:'lname'},label),note?el('span',{class:'lnote'},note):null,el('button',{class:'copy',onclick:()=>{navigator.clipboard&&navigator.clipboard.writeText(url);}},'копировать')),el('a',{class:'lnk'+(rdy?'':' dim2'),href:url,target:'_blank',rel:'noopener'},url));}
  src.appendChild(linkRow('Weekend Feed',L.weekend,'квалификация · стейджи · финиш · жёлтые · сходы',ready));

  const loadBtn=el('button',{class:'parse page-btn',disabled:ready?null:'disabled',onclick:async(ev)=>{
    const btn=ev.target,old=btn.textContent;btn.textContent='Загрузка…';btn.disabled=true;
    try{
      const t=await fetchFeed(L.weekend);
      state.weekendRaw=t;
      applyWeekendFeed(t);
      state.actualCaution='';state.actualRet='';
      saveState(state);render();
      alert(`Загружено: пилотов ${state.raceRoster.length}, стейджей ${JSON.parse(t).weekend_race&&JSON.parse(t).weekend_race[0]&&(JSON.parse(t).weekend_race[0].stage_results||[]).length}`);
    }catch(e){btn.textContent=old;btn.disabled=false;alert('Ошибка загрузки: '+e.message);}
  }},'⤓ Загрузить weekend-feed');
  src.appendChild(el('div',{class:'btnrow'},loadBtn));

  // manual paste
  src.appendChild(el('label',{class:'flbl'},'Weekend Feed — вставить вручную'));
  src.appendChild(el('textarea',{class:'ta',placeholder:'Скопируйте содержимое weekend-feed.json и вставьте сюда',oninput:e=>{state.weekendRaw=e.target.value;},onchange:e=>{state.weekendRaw=e.target.value;if(state.weekendRaw.trim()){try{applyWeekendFeed(state.weekendRaw);state.actualCaution='';state.actualRet='';saveState(state);render();}catch(err){alert('Ошибка: '+err.message);}}}},state.weekendRaw));

  // shared actual overrides
  const ov=el('div',{class:'params',style:'margin-top:10px;'});
  ov.appendChild(el('div',{class:'pgrp'},el('label',{},'Жёлтые (факт)'),el('input',{class:'pin',type:'number',placeholder:autoCautions()!=null?('авто '+autoCautions()):'—',value:state.actualCaution,oninput:e=>{state.actualCaution=e.target.value;saveState(state);},onchange:e=>{state.actualCaution=e.target.value;saveState(state);render();}})));
  ov.appendChild(el('div',{class:'pgrp'},el('label',{},'Сходы (факт)'),el('input',{class:'pin',type:'number',placeholder:autoRetirements()!=null?('авто '+autoRetirements()):'—',value:state.actualRet,oninput:e=>{state.actualRet=e.target.value;saveState(state);},onchange:e=>{state.actualRet=e.target.value;saveState(state);render();}})));
  src.appendChild(ov);
  src.appendChild(el('div',{class:'sub'},'Жёлтые и сходы подставляются из данных гонки автоматически. Заполните поле, только если хотите задать своё число.'));
  root.appendChild(src);
}

/* ── Листы дивизиона калькулятора: Races — подсказки участников, Quals — место в квалификации.
   Грузим сами: скрипт стартует раньше, чем сайт загрузит свои листы, и дивизион может быть другим ── */
const sheetCache={open:null,star:null};   // kind → {drivers, qualRows}
const sheets=()=>sheetCache[calcKind]||{drivers:{},qualRows:[]};
/* Данные могут приехать раньше, чем калькулятор получит своё состояние (switchCalc
   загружает его асинхронно) — тогда просто помечаем, что надо перерисовать. */
function sheetsArrived(kind){
  if(calcKind!==kind)return;
  if(state)render();
  else pendingRender=true;
}

function loadSheets(kind){
  if(sheetCache[kind])return;
  sheetCache[kind]={drivers:{},qualRows:[]};   // заглушка — повторно не грузим
  const div=DIVISIONS[kind];
  legacySheet(`${site.year} ${div.races}`).then(rows=>{
    const m={};
    rows.forEach(r=>{
      if(!r['Driver']||r['Round']==null)return;
      if(!(m[r['Driver']]?.rnd>r['Round']))m[r['Driver']]={rnd:r['Round'],
        car:r['#']==null||r['#']==='-'?'':String(r['#']),team:r['Team']&&r['Team']!=='—'?r['Team']:'',mfg:r['M.']||''};
    });
    sheetCache[kind].drivers=m;
    sheetCache[kind].raceRows=rows;
    sheetsArrived(kind);
  }).catch(e=>console.error(`Калькулятор: лист ${div.races}`,e));
  legacySheet(`${site.year} ${div.quals}`).then(q=>{
    sheetCache[kind].qualRows=q;
    sheetsArrived(kind);
  }).catch(e=>console.error(`Калькулятор: лист ${div.quals}`,e));
  // места в чемпионате этого дивизиона — посчитанный зачёт из базы (с Чейзом, цензом, гостями)
  if(kind!==site.division)rpc('slice',{season:site.year,division:kind,session:'races'}).then(r=>{
    sheetCache[kind].standings=r.standings;
    sheetsArrived(kind);
  }).catch(e=>console.error('Калькулятор: зачёт дивизиона',e));
}

/* ── Участники: имя → #, команда, производитель по последнему этапу ── */
function fillFromOpen(p){
  const d=sheets().drivers[p.name];
  if(!d)return;   // имя не из списка — оставляем как ввели
  p.carNum=d.car; p.team=d.team;
  if(!p.mfg)p.mfg=normMfg(d.mfg);   // производитель — прогноз, введённый не затираем
}
// Имя участника: выпадающий список с листа Races, как у пилотов; свободный ввод тоже можно
function nameCombo(p){
  const wrap=el('div',{class:'combo-c'});
  const list=el('div',{class:'clist',style:'display:none'});
  const input=el('input',{class:'pname-c',value:p.name,
    onfocus:e=>{e.target.select();showList('');},
    oninput:e=>{p.name=e.target.value;saveState(state);showList(e.target.value);}});
  function pick(name){p.name=name;fillFromOpen(p);saveState(state);render();}
  function showList(filter){
    if(openCombo&&openCombo!==list)openCombo.style.display='none';
    openCombo=list;list.innerHTML='';list.style.display='block';
    const raw=filter.replace(/^#/,'').trim(), f=normName(raw);
    const drivers=sheets().drivers;
    const items=Object.keys(drivers).filter(n=>!f||normName(n).includes(f)||normName(drivers[n].team).includes(f)||drivers[n].car===raw)
      .sort((a,b)=>a.localeCompare(b,'ru')).slice(0,60);
    if(!items.length)list.appendChild(el('div',{class:'cempty'},Object.keys(drivers).length?'нет':'список загружается…'));
    items.forEach(n=>list.appendChild(el('div',{class:'citem',onmousedown:ev=>{ev.preventDefault();pick(n);}},
      n,el('span',{class:'cmeta-i'},[drivers[n].car&&' #'+drivers[n].car,drivers[n].team].filter(Boolean).join(' · ')))));
  }
  // перерисовка — только если имя изменилось, иначе сбросит фокус с поля, куда перешли
  const initial=p.name;
  input.addEventListener('blur',()=>{setTimeout(()=>{list.style.display='none';
    if(p.name!==initial&&list.isConnected){fillFromOpen(p);saveState(state);render();}},150);});
  wrap.appendChild(input);wrap.appendChild(list);
  return wrap;
}

/* ── Команда: подставить всех её пилотов в участники, по месту в личном зачёте ── */
// Место в чемпионате дивизиона калькулятора: в дивизионе, открытом на сайте, — готовый
// зачёт сайта; в другом — тот же зачёт из базы (api.driver_standings), он догружается
// вместе с листами калькулятора (sheetCache[kind].standings)
function driverRanks(){
  const st=calcKind===site.division&&site.races.standings.length
    ?site.races.standings:(sheets().standings||[]);
  return Object.fromEntries(st.filter(s=>s.rank!=null).map(s=>[s.driver,s.rank]));
}
function hasPredictions(p){
  return p.drivers.some(Boolean)||p.predCaution!==''||p.predRet!==''||p.mfg!==''||p.qualResultPlace!==''||(p.duelPicks||[]).some(Boolean);
}
function setTeam(team){
  const drivers=sheets().drivers, ranks=driverRanks();
  const starters=raceStarters();
  // протокол гонки этапа есть — берём только прошедших в гонку
  const names=Object.keys(drivers).filter(n=>drivers[n].team===team&&(!starters||starters.has(n)))
    // гости и пилоты вне зачёта — в конец, по алфавиту
    .sort((a,b)=>(ranks[a]??Infinity)-(ranks[b]??Infinity)||a.localeCompare(b,'ru'));
  const lost=state.participants.filter(p=>!names.includes(p.name)&&hasPredictions(p));
  if(lost.length&&!confirm(`Заменить участников пилотами «${team}»? Прогнозы ${lost.map(p=>p.name).join(', ')} будут удалены.`)){render();return;}
  const byName=Object.fromEntries(state.participants.map(p=>[p.name,p]));
  state.team=team;
  state.participants=names.map(n=>{const p=byName[n]||newParticipant(n);fillFromOpen(p);return p;});
  if(!state.participants.length)state.participants=[newParticipant('Участник 1')];
  state.sort={key:null,dir:'desc'};   // показываем порядок по месту в чемпионате
  saveState(state);render();
}
function teamSelect(){
  const teams=[...new Set(Object.values(sheets().drivers).map(d=>d.team).filter(Boolean))].sort((a,b)=>a.localeCompare(b,'ru'));
  return el('div',{class:'pgrp'},el('label',{},'Команда'),
    el('select',{class:'pin chart-select',style:'width:220px',title:'Подставить всех пилотов команды — по месту в чемпионате',
      onchange:e=>{if(e.target.value)setTeam(e.target.value);}},
      el('option',{value:''},teams.length?'— команда —':'Загрузка…'),
      ...teams.map(t=>el('option',{value:t,...(t===state.team?{selected:'selected'}:{})},t))));
}

/* ── Место в квалификации с листа Quals дивизиона: этап (state.round) + имя участника ── */
let calendar=[];
// null — этап не выбран или участника нет в протоколе этапа: тогда место считается по данным фида
function sheetQualPlace(p){
  if(!state||state.round==null||state.round==='')return null;
  const r=sheets().qualRows.find(x=>x['Round']===+state.round&&x['Driver']===p.name&&x['Pos.']!=null);
  return r?r['Pos.']:null;
}

/* Непроходное место: участник квалифицировался, но в гонку этапа не попал — очки за
   результат квалификации ему не идут. Пока протокол гонки не загружен, никого не отсекаем. */
// Стартовавшие в гонке выбранного этапа; null — этап не выбран или протокола гонки ещё нет
function raceStarters(){
  if(!state||state.round==null||state.round==='')return null;
  const rows=sheets().raceRows;
  if(!rows||!rows.length)return null;
  const set=new Set(rows.filter(r=>r['Round']===+state.round&&r['Driver']).map(r=>r['Driver']));
  return set.size?set:null;
}
function qualMissedRace(p){
  const starters=raceStarters();
  return !!starters&&!starters.has(p.name);
}
function roundSelect(){
  const q=DIVISIONS[calcKind].quals;
  return el('div',{class:'pgrp'},el('label',{},`Этап (${q})`),
    el('select',{class:'pin chart-select',title:`Место в квалификации берётся с листа ${q} для этого этапа`,
      onchange:e=>{state.round=e.target.value;saveState(state);render();}},
      el('option',{value:''},calendar.length?'— не выбран —':'Загрузка…'),
      ...calendar.map(c=>el('option',{value:String(c.n),...(String(c.n)===String(state.round)?{selected:'selected'}:{})},c.n+' · '+c.name))));
}

legacySheet(`${site.year} Calendar`).then(cal=>{
  // дуэли (1.1, 1.2) — часть первого этапа, отдельно не выбираются; этап 0 — вне зачёта
  calendar=cal.filter(c=>Number.isInteger(c['#'])&&c['#']>0).map(c=>({n:c['#'],name:c['Name']||''}));
  if(state)render();
}).catch(e=>console.error('Калькулятор: лист Calendar',e));

/* ── Star: пары дуэлей ── */
// «#5 Larson»; без ростера имя — сам номер, не дублируем
const shortDrv=numv=>{const d=driverData(numv);if(!d)return '—';const last=(d.name||'').split(' ').pop();return '#'+d.num+(last&&last[0]!=='#'?' '+last:'');};
function renderDuelPairs(root){
  const card=el('section',{class:'table-card'});
  card.appendChild(el('div',{class:'table-header'},el('h3',{},'Пары дуэлей'),
    el('span',{class:'badge'},'+2 за угаданную пару · квала и гонка отдельно')));
  const roster=combinedRoster().sort((a,b)=>+a.num-+b.num);
  state.duelPairs.forEach((pair,i)=>{
    const sel=j=>el('select',{class:'msel duel-pair-sel',onchange:e=>{pair[j]=e.target.value||null;saveState(state);render();}},
      el('option',{value:''},'—'),
      // выбранный пилот мог не попасть в ростер (фид ещё не загружен) — не теряем его
      ...(pair[j]&&!roster.some(d=>d.num===pair[j])?[el('option',{value:pair[j],selected:'selected'},'#'+pair[j])]:[]),
      ...roster.map(d=>el('option',{value:d.num,...(d.num===pair[j]?{selected:'selected'}:{})},`#${d.num} ${d.name}`)));
    const res=[['Кв.','qualPlace'],['Гонка','racePlace']].map(([lbl,k])=>{const w=duelWinner(pair,k);return w?`${lbl}: ${shortDrv(w)}`:null;}).filter(Boolean);
    card.appendChild(el('div',{class:'duel-pair'},el('span',{class:'duel-n'},String(i+1)),sel(0),el('span',{class:'duel-vs'},'vs'),sel(1),
      res.length?el('span',{class:'duel-res'},res.join(' · ')):null));
  });
  root.appendChild(card);
}
function duelCell(p,s){
  const td=el('td',{class:'td-duel'});
  // одна строка: «5 9 | 12 22 | …»; клик по номеру — выбор (рамка), повторный — снять
  if(state.duelPairs.some(pair=>pair[0]&&pair[1])){
    const row=el('div',{class:'duel-row'});
    state.duelPairs.forEach((pair,i)=>{
      if(i)row.appendChild(el('span',{class:'duel-sep'},'|'));
      if(!pair[0]||!pair[1]){row.appendChild(el('span',{class:'duel-sep',title:`Пара ${i+1} не задана`},'—'));return;}
      const pick=p.duelPicks?.[i]??null;
      pair.forEach(n=>row.appendChild(el('button',{class:'duel-num'+(n===pick?' sel':''),
        title:`Пара ${i+1}: ${driverData(n)?.name||'#'+n}`,
        onclick:()=>{(p.duelPicks||(p.duelPicks=Array(DUEL_COUNT).fill(null)))[i]=n===pick?null:n;saveState(state);render();}},n)));
    });
    td.appendChild(row);
  } else td.appendChild(el('div',{class:'cmeta'},'пары не заданы'));
  const pts=[s.dueQual&&'Кв +'+s.dueQual,s.dueRace&&'Гн +'+s.dueRace].filter(Boolean);
  if(pts.length)td.appendChild(el('div',{class:'bpts-s'},pts.join(' · ')));
  return td;
}

/* ── Справка «?»: текст лежит в calc-help.html рядом с index.html — его можно править
   без кода. Грузим один раз при первом открытии. ── */
let helpOpen=false, helpHtml=null;
function fillHelp(box){
  if(helpHtml!=null){box.innerHTML=helpHtml;return;}
  box.textContent='Загрузка…';
  fetch('calc-help.html',{cache:'no-cache'}).then(r=>{if(!r.ok)throw new Error(r.status);return r.text();})
    .then(t=>{helpHtml=t;box.innerHTML=t;})
    .catch(()=>{box.textContent='Не удалось загрузить справку (calc-help.html).';});
}

/* ── Переключение калькулятора: у каждого своё сохранение ── */
let pendingRender=false;

async function switchCalc(kind,withSheets=true){
  if(state){ if(kind===calcKind)return; await saveState(state); }
  calcKind=kind;
  if(withSheets)loadSheets(kind);
  const l=await loadState();
  state=l||JSON.parse(JSON.stringify(DEFAULT));
  for(const k in DEFAULT){if(!(k in state))state[k]=JSON.parse(JSON.stringify(DEFAULT[k]));}
  if(!state.participants||!state.participants.length)state.participants=[newParticipant('Участник 1')];
  pendingRender=false;
  render();
}
// протоколы калькулятору нужны только когда вкладку открыли — их дёргает ensureTab
window.calcLoadSheets=()=>{loadSheets(calcKind);if(pendingRender&&state){pendingRender=false;render();}};
// Страница открыта сразу на калькуляторе (#tab=calc): с кэшем листов сайт успевает открыть
// вкладку до загрузки этого файла — тогда ensureTab не нашёл calcLoadSheets, грузим сами
if(typeof tabReady!=='undefined'&&tabReady.calc)window.calcLoadSheets();
switchCalc(calcKind,false);
})(state);
