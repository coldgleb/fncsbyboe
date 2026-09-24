// СГЕНЕРИРОВАНО db/reference/build.js из db/reference/*.js — руками не править.

export function makeLogic() {
  // заглушки браузерного окружения: расчётный код их не использует
  const location = { hash: '', reload() { } };
  const noop = () => { };
  const document = {
    addEventListener: noop, querySelector: () => null, querySelectorAll: () => [],
    getElementById: () => null, createElement: () => ({ style: {}, dataset: {}, classList: { add: noop, remove: noop, toggle: noop } }),
  };
  const localStorage = { getItem: () => null, setItem: noop, removeItem: noop };
  const window = {};
  const URLSearchParams = globalThis.URLSearchParams;

/* Общее: конфиг, состояние, загрузка листов, хелперы разметки, вкладки, сортировка таблиц */

// Сезоны, которые есть в базе: при добавлении нового достаточно дописать год
const SEASONS = [2026];
const COLORS = [
  '#ffd23f', '#5aa9ff', '#5ed16a', '#c9a2ff', '#3ee0c5',
  '#ff8f5e', '#e0699b', '#89b4ff', '#d86c3c', '#4bbf8f',
  '#b06bd6', '#2f9bd8', '#e4c04a', '#9fb0c4', '#f5d90a'
];
const PAGE_SIZE = 20;

/* Дивизионы. Star лежит на своих листах; коалиций и зачёта им. Голубочкина в нём нет,
   а лист Round общий — календарь этапов один на оба дивизиона. */
const DIVISIONS = {
  open: { label: 'Open', races: 'Open Races', quals: 'Open Quals', coalitions: 'Open Coalition Teams', entries: 'Open Entries', golub: true },
  star: { label: 'Star', races: 'Star Races', quals: 'Star Quals', golub: false },
};

const YEARS = [...SEASONS].sort((a, b) => b - a);

const state = {
  year: (() => {
    const y = Number(new URLSearchParams(location.hash.slice(1)).get('year'));
    return SEASONS.includes(y) ? y : YEARS[0];
  })(),
  division: new URLSearchParams(location.hash.slice(1)).get('div') === 'star' ? 'star' : 'open',
  races: { standings: [], rounds: [], rows: [] },
  quals: { standings: [], rounds: [], rows: [] },
  indRaces: { standings: [] },
  indQuals: { standings: [] },
  filter: { races: '', quals: '', indRaces: '', indQuals: '' },
  pivot: { races: '', quals: '' },
  golubFilter: { races: '', quals: '' },
  page: { races: 1, quals: 1, indRaces: 1, indQuals: 1 },
  // Срез зачёта: этап, после которого показываем таблицу (null — последний, т.е. весь сезон)
  upTo: { races: null, quals: null, indRaces: null, indQuals: null, owners: null },
  // Переключатель «Регулярный сезон / Чейз»: 'auto' — с 27 этапа сам Чейз, до этого
  // обычный сезон; 'regular'/'chase' — явный выбор пользователя, виден с 26 этапа
  chaseView: { races: 'auto', quals: 'auto', owners: 'auto' },
  sort: { races: null, quals: null, indRaces: null, indQuals: null },
  // когда данные реально приехали с листов (у кэшированных — время их загрузки)
  dataTs: null,
  charts: {}
};

// Общий предикат поиска: пустой запрос пропускает всё, иначе — подстрока в любом из полей
function hit(q, ...fields) {
  const s = (q || '').trim().toLowerCase();
  return !s || fields.some(f => String(f ?? '').toLowerCase().includes(s));
}

// Гость — либо явно помечен «(i)» в имени, либо в этом сезоне сменил дивизион
// (лист Changes) и в ТЕКУЩЕМ дивизионе это — его старый, откуда он ушёл
const isGuestDriver = d => d.includes('(i)') || (state.guestByChange?.has(d) ?? false);

/* ── Числа ──
   Из базы числовые поля приходят числами, но приведение оставлено страховкой: если
   значение когда-нибудь окажется строкой («12.5» или «12,5»), расчёты не сломаются.
   Поля перечислены явно — «#» это номер машины со значащим нулём («09»). */
const NUM_KEYS = new Set(['Round', 'Pos.', 'QL', 'DR1', 'DR2', 'DR3', 'DR4', 'DUE', 'CAU', 'RET', 'MN', 'Points']);

function toNum(v) {
  if (typeof v !== 'string') return v;
  const s = v.replace(/[\s ]/g, '').replace(',', '.');
  if (!s || s === '—' || s === '–' || s === '-') return null;
  const n = Number(s);
  return isFinite(n) ? n : v;   // не число — оставляем как есть (метки вроде DQ)
}


/* ── Round view ── */
function fmtRoundNum(n) {
  return n % 1 === 0 ? String(Math.round(n)) : String(n);
}

// Полное название этапа («8 · Bristol»); там, где не влезает, — roundLabel
function roundFullName(n) {
  return state.roundNames?.[String(n)] || roundLabel(n);
}

// Сокращение этапа с листа Round; у дуэлей — с номером (DAY D1)
function roundLabel(n) {
  const abb = state.roundAbb?.[String(n)];
  if (!abb) return `Э${fmtRoundNum(n)}`;
  return n % 1 === 0 ? abb : `${abb} D${Math.round((n % 1) * 10)}`;
}

/* Дисквалификация. В листе стояло «DQ», а в базе место просто не заполнено.
   Значит DQ — это «строка на этап есть, а места нет»; «не участвовал»
   отличается тем, что строки нет вовсе. Этап в зачёт не идёт (0 очков, вне статистики),
   но в протоколе пилот показывается там, где был бы по очкам за прогноз. */
const DQ_MARK = '<span class="dq-mark" title="Дисквалификация: этап не в зачёт">DQ</span>';

function coalMark(team) {
  return state.coalitions?.has(team) ? ' <span class="coal-mark" title="В коалиции">🤝</span>' : '';
}

/* Штраф с листа Deductions: из очков он уже вычтен, метка идёт перед ними и показывает,
   сколько сняли; подсказка — причина из столбца Reason, пустой Reason оставляет метку без неё.
   Причина пишется руками, поэтому кавычки экранируем — иначе они рвут сам атрибут title. */
function penMark(t) {
  if (!t.penalty) return '';
  const why = [t.penaltyReason, t.penaltyRound != null ? `с ${fmtRoundNum(t.penaltyRound)} этапа` : '']
    .filter(Boolean).join(' · ').replace(/"/g, '&quot;');
  return `<span class="pen-mark"${why ? ` title="${why}"` : ''}>−${t.penalty}</span> `;
}

/* Накопительный итог команды: штраф входит в него начиная со своего этапа, до него
   кривая и сводные идут чистыми очками. Штраф без этапа считается сезонным — с первого. */
const penaltyBy = (t, round) =>
  t.penalty && (t.penaltyRound == null || t.penaltyRound <= round) ? t.penalty : 0;

/* Производителя в листах пишут по-разному (Chevrolet, Chevy, Chv) — цвет бейджа
   и линии графика один и тот же, поэтому приводим написание к классу из CSS. */
const MFR_MATCH = [[/^(toy|tyt)/i, 'Toyota'], [/^(chev|chv)/i, 'Chevy'], [/^(ford|frd)/i, 'Ford']];
const mfrKey = mfr => MFR_MATCH.find(([re]) => re.test(mfr || ''))?.[1] || mfr;

function mfrBadge(mfr) {
  if (!mfr || mfr === '-') return '';
  return `<span class="mfr-badge ${mfrKey(mfr)}">${mfr}</span>`;
}

// Общий блок страниц: onClick — функция, отдающая содержимое onclick для страницы p
function paginationHtml(page, pages, info, onClick) {
  let html = '<div class="pagination">';
  if (pages > 1) {
    if (page > 1) html += `<button class="page-btn" onclick="${onClick(page - 1)}">←</button>`;
    const lo = Math.max(1, page - 2), hi = Math.min(pages, page + 2);
    for (let p = lo; p <= hi; p++)
      html += `<button class="page-btn${p === page ? ' active' : ''}" onclick="${onClick(p)}">${p}</button>`;
    if (page < pages) html += `<button class="page-btn" onclick="${onClick(page + 1)}">→</button>`;
  }
  return html + `<span class="page-info">${info}</span></div>`;
}


// ── standings.js ──
/* Подсчёт зачётов: очки, личный, командный, владельцев */

function nascarPts(pos) {
  if (!pos || pos < 1) return 0;
  if (pos === 1) return 55;
  return Math.max(1, 37 - Math.round(pos));
}

const SPRINT_ROUNDS = new Set([1.1, 1.2]);
const DR_KEYS = ['DR1', 'DR2', 'DR3', 'DR4'];

// Регулярный сезон — 26 этапов, дальше начинается Чейз (плей-офф топ-16)
const CHASE_START = 26;
const CHASE_POINTS = [2100, 2075, 2065, 2060, 2055, 2050, 2045, 2040, 2035, 2030, 2025, 2020, 2015, 2010, 2005, 2000];

/* Очки в чемпионат (вторичные, п. 9.2). Дуэль формально внезачётная (п. 11.1), но её очки
   в зачёт идут — это подтверждено сверкой с официальными протоколами, как и формула ниже
   (она точнее таблицы из п. 11.4). */
function scorePts(pos, round) {
  if (round === 0) return 0; // этап 0 (The Clash) — контрольный, вне зачёта
  if (SPRINT_ROUNDS.has(round)) {
    if (!pos || pos > 10) return 0;
    return 11 - Math.round(pos); // P1→10, P2→9 … P10→1
  }
  return nascarPts(pos);
}

/* Порядок в зачёте — одинаковый для пилотов и для владельцев (п. 9.8).
   Шаг «очки регулярного сезона» пропущен: по п. 10.2.2 очки сбрасываются на 2000 + бонусы только
   с началом Чейза, а до этого регулярные очки равны общей сумме и ничего не решают.
   Столбец Points — это очки за прогноз, а не они (проверено на равенстве #17/#24/#95 после 20 этапа). */

function standingsCmp(a, b) {
  if (b.total !== a.total) return b.total - a.total;             // очки
  if (b.wins !== a.wins) return b.wins - a.wins;              // количество побед
  // количество вторых, третьих... мест (дуэли не в счёт)
  const maxPos = Math.max(2, ...Object.keys(a.posCounts).map(Number), ...Object.keys(b.posCounts).map(Number));
  for (let p = 2; p <= maxPos; p++) {
    const diff = (b.posCounts[p] || 0) - (a.posCounts[p] || 0);
    if (diff !== 0) return diff;
  }
  // более ранняя первая победа
  return a.firstWin - b.firstWin;
}

/* Команда пилота — по последней гонке, в которой он участвовал (в протоколе одного сезона
   пилот может сменить команду). Гонок не было вовсе — берём последнюю квалификацию. */
function computeTeamOf(raceRows, qualRows) {
  const latest = rows => {
    const m = {};
    for (const r of rows) {
      const d = r['Driver'], rnd = r['Round'], team = r['Team'];
      if (!d || !team || team === '—' || rnd == null) continue;
      if (!(m[d]?.rnd > rnd)) m[d] = { rnd, team };
    }
    return m;
  };
  const race = latest(raceRows), qual = latest(qualRows);
  return Object.fromEntries(
    [...new Set([...Object.keys(qual), ...Object.keys(race)])]
      .map(d => [d, (race[d] || qual[d]).team]));
}

const teamOf = driver => state.teamOf?.[driver] || '—';

/* Номер машины и марка — по последней проведённой гонке пилота (в сезоне номер меняется);
   гонок не было — по последней квалификации. Гостевые заявки не в счёт: в зачёте пилот
   показывается с номером своей команды. */
function computeCarOf(raceRows, qualRows) {
  const latest = rows => {
    const m = {};
    for (const r of rows) {
      const d = r['Driver'], rnd = r['Round'], car = r['#'];
      if (!d || r.guest || rnd == null || !car || car === '-' || car === '—') continue;
      if (!(m[d]?.rnd > rnd)) m[d] = { rnd, car: String(car), mfr: r['M.'] || '' };
    }
    return m;
  };
  const race = latest(raceRows), qual = latest(qualRows);
  return Object.fromEntries([...new Set([...Object.keys(qual), ...Object.keys(race)])]
    .map(d => [d, race[d] || qual[d]]));
}

const carOf = driver => state.carOf?.[driver] || null;

// Пересчитывает места 1..N, пропуская гостей: гость остаётся в списке на своём
// по очкам месте, но самого номера места у него нет — он вне зачёта
function renumber(list) {
  let place = 0;
  return list.map(s => {
    if (!s.isGuest) place++;
    return { ...s, rank: s.isGuest ? null : place };
  });
}

function computeStandings(rows) {
  const map = {};
  for (const r of rows) {
    const d = r['Driver'];
    if (!d) continue;
    if (!map[d]) map[d] = {
      driver: d, team: teamOf(d),
      car: carOf(d)?.car || r['#'] || '—', mfr: carOf(d)?.mfr || r['M.'] || '',
      isGuest: isGuestDriver(d),
      total: 0, sheetPts: 0, best: Infinity,
      wins: 0, firstWin: Infinity, posCounts: {}, roundPts: {},
      posSum: 0, finishes: 0, top5: 0, top10: 0, positions: []
    };
    const s = map[d];
    // гостевая заявка пилота, у которого есть свои, очков ему не даёт (п. 9.6: их получает машина);
    // гость (только гостевые заявки или сменил дивизион) очки копит как боевой — но вне зачёта
    const counted = !r.guest || s.isGuest;
    const pts = counted ? scorePts(r['Pos.'], r['Round']) : 0;
    s.total += pts;
    if (r['Round'] !== 0 && counted) s.sheetPts += r['Points'] || 0;
    // дуэль — не гонка: пилот без единой гонки в зачёт не попадает
    if (!SPRINT_ROUNDS.has(r['Round'])) s.raced = true;
    const pos = r['Pos.'];
    // Дуэль приносит очки, но гоночным результатом не считается: ни победа, ни место, ни статистика.
    // Этап 0 (The Clash) не в счёт вообще нигде.
    if (pos != null && !SPRINT_ROUNDS.has(r['Round']) && r['Round'] !== 0) {
      if (pos < s.best) s.best = pos;
      s.posSum += pos;
      s.finishes++;
      if (pos <= 5) s.top5++;
      if (pos <= 10) s.top10++;
      s.posCounts[pos] = (s.posCounts[pos] || 0) + 1;
      s.positions.push(pos);
      if (pos === 1) {
        s.wins++;
        const rnd = r['Round'];
        if (rnd != null && rnd < s.firstWin) s.firstWin = rnd;
      }
    }
    const rnd = r['Round'];
    if (rnd != null) s.roundPts[rnd] = (s.roundPts[rnd] || 0) + pts;
  }

  return renumber(Object.values(map).filter(s => s.raced).sort(standingsCmp)
    .map(s => ({
      ...s,
      bestPositions: [...s.positions].sort((a, b) => a - b),
      // сколько раз пилот показал свой лучший результат (для колонки «P1 (x1)»)
      bestCount: s.positions.filter(p => p === s.best).length,
    })));
}

function uniqueRounds(rows) {
  return [...new Set(rows.map(r => r['Round']).filter(x => x != null))].sort((a, b) => a - b);
}

/* ── Командный зачёт: сумма очков двух лучших представителей команды за этап (п. 9.7).
   withGuestOnly — вернуть и команды из одних гостей: в зачёте их нет (место = null),
   но в сводных по этапам они показываются. ── */
function computeTeamStandings(rows, withGuestOnly = false) {
  // срез: последний этап, попавший в расчёт — по нему решается, вступил ли уже штраф
  const at = Math.max(...rows.map(r => r['Round']).filter(x => x != null), 0);
  const teamMap = {};
  for (const r of rows) {
    const team = r['Team'];
    const rnd = r['Round'];
    const d = r['Driver'];
    // Гость личных очков не получает, но команде приносит и борется за зачётное место
    // наравне со своими (свои 5-е и 20-е + гость 10-й → в зачёт идут 5-е и 10-е).
    // «Guest entry» — гость без команды: очки не достаются никому.
    // Дуэль в командный зачёт не идёт (в личный — идёт); сверено с официальными итогами
    if (!team || team === '—' || team === 'Guest entry' || rnd == null || !d) continue;
    if (SPRINT_ROUNDS.has(rnd) || rnd === 0) continue; // этап 0 (The Clash) не в счёт
    if (!teamMap[team]) teamMap[team] = { team, roundMap: {}, drivers: new Set(), positions: [] };
    teamMap[team].drivers.add(d);
    if (!teamMap[team].roundMap[rnd]) teamMap[team].roundMap[rnd] = [];
    teamMap[team].roundMap[rnd].push({ driver: d, pos: r['Pos.'], pts: scorePts(r['Pos.'], rnd) });
    if (r['Pos.'] != null && !SPRINT_ROUNDS.has(rnd)) teamMap[team].positions.push(r['Pos.']);
  }

  const all = Object.values(teamMap).map(t => {
    let total = 0;
    const roundPts = {};
    const roundBest = {};  // этап → зачётные результаты (кто, какое место, сколько очков)
    const scorers = {}; // пилот → { этапов, очков } среди двух зачётных за этап
    for (const [rnd, results] of Object.entries(t.roundMap)) {
      const best2 = results.sort((a, b) => b.pts - a.pts).slice(0, 2);
      const top2 = best2.reduce((s, v) => s + v.pts, 0);
      total += top2;
      roundPts[parseFloat(rnd)] = top2;
      roundBest[parseFloat(rnd)] = best2;
      for (const { driver, pts } of best2) {
        const sc = scorers[driver] ||= { rounds: 0, pts: 0 };
        sc.rounds++;
        sc.pts += pts;
      }
    }
    // Штраф с листа Deductions уже сидит в total — по нему и место, и всё, что показывается.
    // Действует со своего этапа: на срезе до него команда идёт без штрафа
    const ded = state.deductions?.[t.team];
    const penalty = ded && (ded.round == null || ded.round <= at) ? ded.pts : 0;
    // накопительный итог по этапам: штраф вычитается начиная со своего этапа
    const cumPts = {};
    let run = 0;
    const cumRounds = state.races?.rounds?.length ? state.races.rounds
      : Object.keys(roundPts).map(Number).sort((x, y) => x - y);
    for (const rnd of cumRounds.filter(r => !SPRINT_ROUNDS.has(r))) {
      run += roundPts[rnd] || 0;
      cumPts[rnd] = run - (ded && (ded.round == null || ded.round <= rnd) ? ded.pts : 0);
    }
    return {
      team: t.team, total: total - penalty, penalty, penaltyRound: ded?.round ?? null,
      penaltyReason: ded?.reason || '',
      roundPts, cumPts, roundBest, scorers, drivers: [...t.drivers],
      // команда, за которую ездят одни гости, в командном зачёте не участвует
      entered: [...t.drivers].some(d => !isGuestDriver(d)),
      bestPositions: t.positions.sort((a, b) => a - b)
    };
  }).sort((a, b) => b.total - a.total);

  // Места нумеруются только среди зачётных; у команды из одних гостей места нет
  let place = 0;
  return all.map(t => ({ ...t, rank: t.entered ? ++place : null }))
    .filter(t => withGuestOnly || t.entered);
}

function computeOwnerStandings(rows) {
  const map = {};
  for (const r of rows) {
    const car = r['#'];
    // Гость очков себе не приносит, но машине — приносит; «-» значит «без номера»
    if (car == null || car === '' || car === '-') continue;
    if (!map[car]) map[car] = {
      car, total: 0, wins: 0, firstWin: Infinity, team: '—', mfr: '', lastRound: -Infinity,
      best: Infinity, posCounts: {}, positions: [], drivers: new Set()
    };
    const o = map[car];
    // команда и производитель машины — по её последней заявке в сезоне
    if (r['Round'] != null && r['Round'] >= o.lastRound) {
      o.lastRound = r['Round'];
      if (r['Team'] && r['Team'] !== '—' && r['Team'] !== 'Guest entry') o.team = r['Team'];
      if (r['M.']) o.mfr = r['M.'];
    }
    o.total += scorePts(r['Pos.'], r['Round']);
    if (r['Driver']) o.drivers.add(r['Driver']);
    const pos = r['Pos.'], rnd = r['Round'];
    // Как и у пилотов: дуэль даёт очки, но результатом не считается; этап 0 не в счёт вообще
    if (pos != null && !SPRINT_ROUNDS.has(rnd) && rnd !== 0) {
      if (pos < o.best) o.best = pos;
      if (pos === 1) {
        o.wins++;
        if (rnd != null && rnd < o.firstWin) o.firstWin = rnd;
      }
      o.posCounts[pos] = (o.posCounts[pos] || 0) + 1;
      o.positions.push(pos);
    }
  }
  return Object.values(map).sort(standingsCmp)
    .map(({ lastRound, ...o }, i) => ({
      ...o, rank: i + 1, drivers: [...o.drivers],
      top5: o.positions.sort((a, b) => a - b).slice(0, 5)
    }));
}

/* ── Зачёт им. Semen GOLUBOCHKIN: точка отсчёта — его позиция на этапе.
   Очки = сколько участников оказалось ниже него, но не ниже тебя (он 33, ты 37 → 4).
   Финишировал выше — 0. Этапы без него не считаются вовсе.
   Дуэли и квалификации по метрике не в счёт. ── */

// П. 10.3: в регулярном сезоне можно пропустить не более пяти квалификаций из
// проведённых К МОМЕНТУ at (по умолчанию — весь сезон, для реального Чейза на 26 этапе).
// Дуэли не этапы (п. 11.1). Без at после 1 этапа посчитало бы пропуски по всем 26 —
// тогда ценз рубил бы тех, кто пропустит квалы только в будущих этапах.
function qualEligible(driver, at = Infinity) {
  const attended = [...(state.qualsParticipation[driver] || [])].filter(r => r <= at).length;
  const heldRounds = state.quals.rounds.filter(r => !SPRINT_ROUNDS.has(r) && r <= at).length;
  return heldRounds - attended <= 5;
}

// Топ-16 и их стартовые баллы фиксируются на 26 этапе — не зависят от того, до какого
// этапа считается текущий срез (rows может включать и более поздние этапы).
function chaseSeedOrder(standingsAt26) {
  const seeds = {};
  let seed = 0;
  for (const s of standingsAt26) {
    if (seed >= 16) break;
    if (s.isGuest) continue; // гость не может занять место в Чейзе
    if (qualEligible(s.driver, CHASE_START)) seeds[s.driver] = { seed: ++seed, points: CHASE_POINTS[seed - 1] };
  }
  return seeds;
}

/* Зачёт с учётом Чейза: топ-16 берут стартовые баллы + очки, набранные строго после
   26 этапа; остальные копят очки как в обычном сезоне (computeStandings без изменений). */
function computeChaseStandings(rows) {
  const seeds = chaseSeedOrder(computeStandings(rows.filter(r => r['Round'] <= CHASE_START)));
  const base = computeStandings(rows);
  const postMap = Object.fromEntries(
    computeStandings(rows.filter(r => r['Round'] > CHASE_START)).map(s => [s.driver, s]));

  const empty = { wins: 0, firstWin: Infinity, posCounts: {} };
  // Статистика (победы, финиши, топ-5/10, очки по этапам) — за весь сезон, как у всех.
  // Меняются только total (сид + очки после 26 этапа) и тай-брейк: при равных очках
  // в Чейзе решают результаты Чейза (chase), а не сезона
  const merged = base.map(s => {
    const sd = seeds[s.driver];
    if (!sd) return s;
    const p = postMap[s.driver] || empty;
    return { ...s, total: sd.points + (p.total || 0), chaseSeed: sd.seed, chase: p };
  }).sort((a, b) => standingsCmp(
    { ...(a.chase || a), total: a.total }, { ...(b.chase || b), total: b.total }));

  return renumber(merged);
}

// standings — зачёт, по которому определяется топ-16 (по очкам НА ВЫБРАННЫЙ этап,
// а не по итоговому составу Чейза в конце сезона — иначе сравнение «на тот момент»
// сопоставляет очки одного этапа с составом, определившимся много позже)
function buildPlayoffSet(standings, at) {
  const playoffSet = new Set();
  let slots = 16;
  for (const s of standings) {
    if (slots <= 0) break;
    if (s.isGuest) continue; // гость не может занять место в Чейзе
    if (qualEligible(s.driver, at)) { playoffSet.add(s.driver); slots--; }
  }
  return playoffSet;
}

function chaseOwnerSeedOrder(standingsAt26) {
  const seeds = {};
  let seed = 0;
  for (const o of standingsAt26) {
    if (seed >= 16) break;
    seeds[o.car] = { seed: ++seed, points: CHASE_POINTS[seed - 1] };
  }
  return seeds;
}

function computeChaseOwnerStandings(rows) {
  const seeds = chaseOwnerSeedOrder(computeOwnerStandings(rows.filter(r => r['Round'] <= CHASE_START)));
  const base = computeOwnerStandings(rows);
  const postMap = Object.fromEntries(
    computeOwnerStandings(rows.filter(r => r['Round'] > CHASE_START)).map(o => [o.car, o]));

  const empty = { wins: 0, firstWin: Infinity, posCounts: {} };
  const merged = base.map(o => {
    const sd = seeds[o.car];
    if (!sd) return o;
    const p = postMap[o.car] || empty;
    return { ...o, total: sd.points + (p.total || 0), chaseSeed: sd.seed, chase: p };
  }).sort((a, b) => standingsCmp(
    { ...(a.chase || a), total: a.total }, { ...(b.chase || b), total: b.total }));

  return renumber(merged);
}

/* П. 8.8.2–8.8.3: место в чемпионате для метрики. Зачётные — своё место, гости и не выходившие
   на старт — последнее + 1. Не выходившие с непроходами на одних и тех же этапах разводятся
   лучшей квалой; с разными наборами этапов — делят место. */
function metricChampRanks(standings, qualRows) {
  const ranks = {};
  for (const s of standings) if (s.rank != null) ranks[s.driver] = s.rank;
  const base = Math.max(0, ...Object.values(ranks)) + 1;
  const noStart = {};
  for (const r of qualRows) {
    const d = r['Driver'], rnd = r['Round'];
    if (!d || d in ranks || rnd == null || rnd === 0 || SPRINT_ROUNDS.has(rnd)) continue;
    const g = noStart[d] ||= { rounds: new Set(), best: Infinity };
    g.rounds.add(rnd);
    if (r['Pos.'] != null && r['Pos.'] < g.best) g.best = r['Pos.'];
  }
  for (const s of standings) if (s.rank == null) ranks[s.driver] = base;
  const key = d => [...noStart[d].rounds].sort((a, b) => a - b).join(',');
  const rivals = Object.keys(noStart).filter(d => !isGuestDriver(d));
  for (const d of Object.keys(noStart)) {
    ranks[d] = isGuestDriver(d) ? base
      : base + rivals.filter(o => key(o) === key(d) && noStart[o].best < noStart[d].best).length;
  }
  return ranks;
}

// П. 8.8: 50% место в гонке, 25% место в чемпионате, 25% место машины у владельцев; равенство — по чемпионату
function computeNextMetric(people) {
  return people.map(p => ({ ...p, metric: p.place * 0.5 + p.champRank * 0.25 + p.ownerRank * 0.25 }))
    .sort((a, b) => a.metric - b.metric || a.champRank - b.champRank);
}

function avgPos(s) {
  return s.finishes ? (s.posSum / s.finishes).toFixed(1) : '—';
}

// ── drivers.js ──
/* Личные зачёты: итоговая таблица, сортировка, сводная Пилот · Этап · Позиция */

function driverTooltip(s) {
  // У чейзовых пилотов тай-брейк — по результатам Чейза (s.chase), статистика — за сезон
  const tb = s.chase || s;
  const winsLabel = s.chase ? `${tb.wins} побед в Чейзе (${s.wins} за сезон)` : `${s.wins} побед`;
  return [
    `Тай-брейк: ${winsLabel}` + (tb.firstWin !== Infinity ? ` · 1-я победа R${fmtRoundNum(tb.firstWin)}` : '') + ` · ${s.sheetPts} очков за прогноз`,
    `Сред. позиция: ${avgPos(s)}`,
    `Топ-5: ${s.top5} · Топ-10: ${s.top10}`,
  ].join('\n');
}

/* ── Срез зачёта после выбранного этапа ── */

// Этапы, доступные для среза; дуэли — часть первого этапа, отдельной строкой не нужны
const roundsOf = type => (/quals/i.test(type) ? state.quals : state.races).rounds
  .filter(r => !SPRINT_ROUNDS.has(r));

const isIndep = team => team && team !== '—' && !state.coalitions?.has(team);

// Реальный Чейз (очки сброшены на сетку) — только после 26 этапа: до этого ручной
// выбор «Чейз» не действует, сколько бы раз его ни включали на позднем срезе.
// Отсечка топ-16 при этом остаётся на любом этапе. У независимых Чейза нет вообще.
const isChaseMode = (type, n) => {
  if (type.startsWith('ind')) return false;
  if (n <= CHASE_START) return false;
  return state.chaseView[type] !== 'regular';
};

/* Срез зачёта на выбранный этап считает сервер (тем же кодом, что раньше работал
   здесь). Ответ кладём в state.slices — повторный показ той же таблицы мгновенный. */
function sliceKey(type, at) {
  return `${type}:${at}:${state.chaseView[type] || 'auto'}`;
}

async function fetchSlice(type, at, fresh) {
  const key = sliceKey(type, at);
  if (!fresh && state.slices[key]) return state.slices[key];
  const params = new URLSearchParams({ session: type, upto: String(at), chase: state.chaseView[type] || 'auto' });
  const url = `${API_BASE}/season/${state.year}/${state.division}/slice?${params}`;
  const data = await apiFetch(url, 'Зачёт');
  state.slices[key] = data;
  return data;
}

function setChaseView(type, val) {
  state.chaseView[type] = val;
  renderTable(type);
}

function setUpTo(type, val) {
  const rounds = roundsOf(type);
  const n = parseFloat(val);
  state.upTo[type] = n === rounds[rounds.length - 1] ? null : n;
  state.page[type] = 1;
  renderTable(type);
}

async function renderTable(type) {
  const wrap = document.getElementById(`table-${type}`);
  const rounds = roundsOf(type);
  const lastRound = rounds[rounds.length - 1];
  const at = state.upTo[type] ?? lastRound;
  const isLast = at === lastRound;

  const cut = state.slices[sliceKey(type, at)];
  if (!cut) {
    if (!wrap.innerHTML) wrap.innerHTML = '<div class="loading-state"><div class="spinner"></div> Загрузка…</div>';
    await fetchSlice(type, at);
    return renderTable(type);
  }
  const all = cut.standings;
  const prevRank = cut.prevRank;
  // участие считаем до выбранного этапа, иначе срез врёт про пропуски
  const starts = (kind, d) => [...(state.attendance[kind][d] || [])].filter(r => r <= at).length;
  const q = state.filter[type].toLowerCase();
  const filtered = q
    ? all.filter(s => s.driver.toLowerCase().includes(q) || s.team.toLowerCase().includes(q))
    : all;

  // Чейз считается только в общих зачётах, не в зачёте независимых; виден на любом
  // срезе сезона, начиная с 1 этапа (playoffSet — по текущему/итоговому зачёту,
  // а сам разрыв — по очкам на выбранный этап, как и обещает upto-note ниже)
  const withChase = !type.startsWith('ind');
  const playoffSet = withChase ? buildPlayoffSet(all, at) : new Set();
  const isChase = withChase && isChaseMode(type, at);

  const chase = all.filter(s => playoffSet.has(s.driver));   // чейзовые в порядке появления в all
  // Линия — всегда сразу после ПОСЛЕДНЕГО чейзового по факту появления, а не по позиции:
  // ценз квалификаций может выбить кого-то из топ-16 по очкам, тогда чейзовые идут не подряд.
  // Сам «после чейза» не может быть гостем — гость вне зачёта и границу не определяет
  let lastChaseIdx = -1;
  all.forEach((s, i) => { if (playoffSet.has(s.driver)) lastChaseIdx = i; });
  let afterChase = null;
  for (let j = lastChaseIdx + 1; j < all.length; j++) {
    if (!all[j].isGuest) { afterChase = all[j]; break; }
  }

  // Регулярный сезон (очки не сброшены) — старый расчёт «до отсечки»
  const cutoffDriver = all.find(s => !s.isGuest && !playoffSet.has(s.driver) && qualEligible(s.driver, at));
  const lastChase = chase[chase.length - 1];
  // Чейз (очки уже сброшены на сетку) — расчёт «внутри своей группы»
  const chaseLeader = chase[0];

  const gapCell = s => {
    const dash = '<span class="muted">—</span>';
    if (s.isGuest || !qualEligible(s.driver, at)) return dash;
    const ref = isChase
      ? (playoffSet.has(s.driver) ? chaseLeader : afterChase)
      : (playoffSet.has(s.driver) ? cutoffDriver : lastChase);
    if (!ref) return dash;
    if (s.driver === ref.driver) return '<span class="muted">0</span>';
    const d = s.total - ref.total;
    if (d === 0) return '<span class="muted" title="Равенство очков — решает тай-брейк">0</span>';
    return `<span class="${d > 0 ? 'up' : 'down'}">${d > 0 ? '+' : ''}${d}</span>`;
  };

  const sort = state.sort[type];
  const rows = sort
    ? [...filtered].sort((a, b) => {
      const va = SORT_KEYS[sort.key](a), vb = SORT_KEYS[sort.key](b);
      const d = typeof va === 'string' || typeof vb === 'string'
        ? String(va).localeCompare(String(vb), 'ru')
        : va - vb;
      return sort.dir === 'asc' ? d : -d;
    })
    : filtered;

  const sortTh = (key, label, attrs = '', cls = 'r') => {
    const arrow = sort && sort.key === key ? ` <span class="sort-arrow">${sort.dir === 'asc' ? '▲' : '▼'}</span>` : '';
    return `<th class="${cls} sortable" ${attrs} onclick="sortTable('${type}','${key}')">${label}${arrow}</th>`;
  };

  const page = state.page[type];
  const pages = Math.ceil(rows.length / PAGE_SIZE);
  const slice = rows.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE);

  // При своей сортировке места нумеруются 1..n заново (сквозной номер по всему rows,
  // не только по странице) — гостей при этом пропускаем, у них номера нет вообще
  let sortSeq = 0;
  const sortPlaceOf = sort ? rows.map(s => (s.isGuest ? null : ++sortSeq)) : null;

  const uptoHtml = `<div class="table-upto">
  <label>Зачёт после этапа:
    <select class="chart-select" onchange="setUpTo('${type}', this.value)">
      ${rounds.map(r => `<option value="${r}"${r === at ? ' selected' : ''}>${roundFullName(r)}</option>`).join('')}
    </select>
  </label>
  ${isLast ? '' : '<span class="upto-note">срез сезона: Чейз и тай-брейки — на этот этап</span>'}
  ${!type.startsWith('ind') && at > CHASE_START ? `
  <div class="round-toggle inline">
    <button class="rtog-btn${!isChase ? ' rtog-active' : ''}" onclick="setChaseView('${type}','regular')">Регулярный сезон</button>
    <button class="rtog-btn${isChase ? ' rtog-active' : ''}" onclick="setChaseView('${type}','chase')">Чейз</button>
  </div>` : ''}
</div>`;
  // Если в шапке карточки есть свой контейнер под этот блок — рендерим туда,
  // а не внутрь тела таблицы (пока используется только для «Квалификации»)
  const uptoContainer = document.getElementById(`upto-${type}`);

  let html = uptoContainer ? '' : uptoHtml;
  html += `<div class="table-scroll"><table class="standings-table"><thead><tr>
${sortTh('rank', '#', '', 'r w-40')}
<th class="r w-44" title="Изменение места к прошлому этапу">±</th>
${sortTh('driver', 'Гонщик', '', '')}
${sortTh('team', 'Команда', '', '')}
${sortTh('mfr', 'Авт.', '', '')}
${sortTh('total', 'Очки')}
${withChase ? sortTh('chase', '± Чейз', 'title="В Чейзе — преимущество над первым вне Чейза; вне Чейза — отставание от последнего из Чейза"') : ''}
${sortTh('wins', 'Победы', 'title="Количество побед (тай-брейк 1)"')}
${sortTh('starts', 'Гонок / Квал.', 'title="Проходов в гонку / участий в квалификации"')}
${sortTh('best', 'Лучш.')}
  </tr></thead><tbody>`;

  slice.forEach((s, i) => {
    // при своей сортировке места фиксированы: 1..n сверху вниз, место в зачёте — в тултипе;
    // у гостя (в т.ч. временного — сменил дивизион по листу Changes) места нет вообще
    const place = sort ? sortPlaceOf[(page - 1) * PAGE_SIZE + i] : s.rank;
    const inPlayoff = playoffSet.has(s.driver);
    const isCutoff = afterChase && s.driver === afterChase.driver;
    const rc = [
      place != null && place <= 3 ? `rank-${place}` : '',
      inPlayoff ? 'row-playoff' : '',
      isCutoff ? 'row-cutoff' : '',
    ].filter(Boolean).join(' ');

    const winsCell = s.wins > 0
      ? `<strong class="win">${s.wins}</strong>`
      : `<span class="muted">—</span>`;
    const tb = driverTooltip(s);
    html += `<tr class="${rc}" title="${tb}">
  <td class="r"><span class="pos-badge"${sort && place != null ? ` title="Место в зачёте: ${s.rank}"` : ''}>${place ?? '—'}</span></td>
  <td class="r">${s.isGuest ? '<span class="muted">—</span>' : deltaCell(prevRank[s.driver], s.rank)}</td>
  <td><strong class="driver-link" onclick="openDriver('${s.driver.replace(/'/g, "\\'").replace(/"/g, '&quot;')}'${/quals/i.test(type) ? ",'quals'" : ''})">${s.driver}</strong></td>
  <td class="team-text">${s.team}${coalMark(s.team)}</td>
  <td>${mfrBadge(s.mfr)}</td>
  <td class="r"><strong>${s.total}</strong></td>
  ${withChase ? `<td class="r">${gapCell(s)}</td>` : ''}
  <td class="r">${winsCell}</td>
  <td class="r muted">${starts('races', s.driver)} / ${starts('quals', s.driver)}</td>
  <td class="r muted">${s.best === Infinity ? '—' : 'P' + s.best}</td>
</tr>`;
  });

  html += '</tbody></table></div>'
    + paginationHtml(page, pages, `${rows.length} участников`, p => `goPage('${type}',${p})`);

  wrap.innerHTML = html;
  if (uptoContainer) uptoContainer.innerHTML = uptoHtml;
}

const SORT_KEYS = {
  rank: s => s.rank,
  driver: s => s.driver,
  team: s => s.team,
  mfr: s => s.mfr,
  total: s => s.total,
  chase: s => s.total,   // отрыв от границы Чейза — та же очерёдность, что и по очкам
  wins: s => s.wins,
  starts: s => state.attendance.races[s.driver]?.size || 0,
  best: s => s.best,
};

// Клик: по возрастанию, повторный — по убыванию, третий — назад к местам в чемпионате
function sortTable(type, key) {
  const cur = state.sort[type];
  state.sort[type] = !cur || cur.key !== key ? { key, dir: 'asc' }
    : cur.dir === 'asc' ? { key, dir: 'desc' }
      : null;
  state.page[type] = 1;
  renderTable(type);
}

function filterTable(type, val) {
  state.filter[type] = val;
  state.page[type] = 1;
  renderTable(type);
}

// Имя листа и часть имени файла для каждого из четырёх личных зачётов
const STANDINGS_SHEET = {
  races: 'Зачёт гонок', quals: 'Зачёт квалификаций',
  indRaces: 'Независимые гонки', indQuals: 'Независимые квалификации',
};

// Выгружает весь зачёт целиком (тот же срез по этапу, что и на экране), а не только
// текущую страницу и не только строки, прошедшие поиск.
async function exportStandingsXLSX(type) {
  const rounds = roundsOf(type);
  const lastRound = rounds[rounds.length - 1];
  const at = state.upTo[type] ?? lastRound;
  const isLast = at === lastRound;
  const all = (await fetchSlice(type, at)).standings;
  const starts = (kind, d) => [...(state.attendance[kind][d] || [])].filter(r => r <= at).length;

  // Тот же разрыв/запас Чейза, что и gapCell на экране (см. renderTable выше) —
  // виден на любом срезе, начиная с 1 этапа, не только на самом свежем
  const withChase = !type.startsWith('ind');
  const playoffSet = withChase ? buildPlayoffSet(all, at) : new Set();
  const isChase = withChase && isChaseMode(type, at);
  const chase = all.filter(s => playoffSet.has(s.driver));
  let lastChaseIdx = -1;
  all.forEach((s, i) => { if (playoffSet.has(s.driver)) lastChaseIdx = i; });
  let afterChase = null;
  for (let j = lastChaseIdx + 1; j < all.length; j++) {
    if (!all[j].isGuest) { afterChase = all[j]; break; }
  }
  const cutoffDriver = all.find(s => !s.isGuest && !playoffSet.has(s.driver) && qualEligible(s.driver, at));
  const lastChase = chase[chase.length - 1];
  const chaseLeader = chase[0];
  const chaseGap = s => {
    if (s.isGuest || !qualEligible(s.driver, at)) return '';
    const ref = isChase
      ? (playoffSet.has(s.driver) ? chaseLeader : afterChase)
      : (playoffSet.has(s.driver) ? cutoffDriver : lastChase);
    if (!ref) return '';
    const d = s.total - ref.total;
    return d > 0 ? `+${d}` : String(d);
  };

  downloadTableXLSX(all, [
    ['#', s => s.rank],
    ['Гонщик', s => s.driver],
    ['Команда', s => s.team],
    ['Авт.', s => s.mfr],
    ['Очки', s => s.total],
    ...(withChase ? [['± Чейз', chaseGap]] : []),
    ['Победы', s => s.wins],
    ['Гонок', s => starts('races', s.driver)],
    ['Квал.', s => starts('quals', s.driver)],
    ['Лучш.', s => s.best === Infinity ? '' : s.best],
  ], STANDINGS_SHEET[type], `${exportSeriesLabel()} ${STANDINGS_SHEET[type].toLowerCase()}${isLast ? '' : ` после ${fmtRoundNum(at)} этапа`}.xlsx`);
}

function goPage(type, p) {
  state.page[type] = p;
  renderTable(type);
}

/* Сводная «пилот × этап» приходит посчитанной с сервера (часть pivot). */
async function pivotOf(type) {
  if (!state.pivotData) state.pivotData = await seasonPart('pivot');
  return state.pivotData[type];
}

function buildPivotData(type) {
  const rows = state[type].rows;
  const rounds = state[type].rounds;
  const standings = state[type].standings;

  /* Ключ этапа заводится и без места: null здесь — это DQ (строка есть, места нет),
     отсутствие ключа — «не участвовал». Реальное место всегда перебивает null. */
  const posMap = src => {
    const m = {};
    for (const r of src) {
      const d = r['Driver'], rnd = r['Round'], pos = r['Pos.'];
      if (!d || rnd == null) continue;
      m[d] ||= {};
      const cur = m[d][rnd];
      if (pos != null && (cur == null || pos < cur)) m[d][rnd] = pos;
      else if (cur === undefined) m[d][rnd] = null;
    }
    return m;
  };

  const map = posMap(rows);
  // For races pivot: build qual map (round → driver → qual pos)
  const qualMap = type === 'races' ? posMap(state.quals.rows) : null;

  const order = standings.map(s => s.driver);
  // Место — из самого зачёта (у гостя оно null), а не из позиции в массиве
  const rankOf = Object.fromEntries(standings.map(s => [s.driver, s.rank]));
  return { map, rounds, order, qualMap, rankOf };
}

function renderPivot(type) {
  const wrap = document.getElementById(`pivot-${type}`);
  if (!state.pivotData) {
    pivotOf(type).then(() => renderPivot(type)).catch(err => console.error(err));
    return;
  }
  const { map, rounds, order, qualMap, rankOf } = state.pivotData[type];
  const q = state.pivot[type];
  const drivers = order.filter(d => hit(q, d, teamOf(d)));

  let html = `<table class="pivot-table" data-sort="auto"><thead><tr>
<th class="driver-col">Место · Пилот</th>
${rounds.map(r => `<th title="${roundFullName(r)}">${roundLabel(r)}</th>`).join('')}
<th>Итого</th>
  </tr></thead><tbody>`;

  for (const driver of drivers) {
    const rank = rankOf[driver];
    const dmap = map[driver] || {};
    const qmap = qualMap ? (qualMap[driver] || {}) : null;
    const total = rounds.reduce((s, r) => s + scorePts(dmap[r], r), 0);
    html += `<tr class="${rank != null && rank <= 3 ? 'rank-' + rank : ''}">
  <td class="driver-cell"><span class="pos-badge">${rank ?? '—'}</span> ${driver}${coalMark(teamOf(driver))}
  <div class="team-drivers">${teamOf(driver)}</div></td>`;
    for (const r of rounds) {
      const pos = dmap[r];
      const qpos = qmap ? qmap[r] : null;
      const maxPos = state.roundMaxPos[r] || 40;
      // ключ есть, а места нет — дисквалификация; ключа нет — этап пропущен
      const raceCell = pos != null
        ? `<span class="pos-cell ${posClass(pos, maxPos)}">${pos}</span>`
        : r in dmap ? DQ_MARK : `<span class="pos-cell pos-none">—</span>`;
      const qualCell = qmap == null ? '' : qpos != null
        ? `<span class="pivot-qpos ${qpos <= maxPos ? 'up' : 'down'}">${qpos}</span>`
        : r in qmap ? DQ_MARK : `<span class="pivot-qpos pos-none">—</span>`;
      html += `<td>${raceCell}${qualCell}</td>`;
    }
    html += `<td class="total-cell">${total}</td></tr>`;
  }

  html += '</tbody></table>';
  wrap.innerHTML = html;
}

/* Полный протокол сезона в .xlsx — как в официальной таблице: Pos/#/Пилот/Команда/Авт. + место
   на каждом этапе + итоговые очки, с заливкой ячеек по месту
   (жёлтый P1, серый топ-5, бронза топ-10, зелёный/фиолет ниже, красный — вне зачёта). */
const TOP3_FILL = ['FFE8A3', 'E0E0E0', 'EFD3B4'];

async function exportProtocolXLSX(type) {
  const { map, rounds } = await pivotOf(type);
  // Место и очки — по срезу, выбранному в интерфейсе («Зачёт после этапа» + Чейз),
  // а не всегда по итогу сезона; сетка позиций по этапам (map/rounds) при этом полная
  const roundsAvail = roundsOf(type);
  const at = state.upTo[type] ?? roundsAvail[roundsAvail.length - 1];
  const standings = (await fetchSlice(type, at)).standings;
  const maxPosOf = r => state.roundMaxPos[r] || 40;
  const cellFor = (s, r) => {
    const pos = (map[s.driver] || {})[r];
    return pos != null ? pos : r in (map[s.driver] || {}) ? 'DQ' : '';
  };

  // Третий элемент — номер этапа (только у колонок этапов); нужен и для чистки
  // пустых столбцов, и потом для заливки по месту в конкретном этапе
  let cols = [
    ['Pos.', s => s.rank],
    ['#', s => s.car],
    ['Driver', s => s.driver],
    ['Team', s => s.team],
    ['M.', s => s.mfr],
    ...rounds.map(r => [roundLabel(r), s => cellFor(s, r), r]),
    ['Points', s => s.total],
  ];
  cols = dropEmptyCols(cols, standings);
  const rows = dropEmptyRows(cols, standings);

  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet(type === 'quals' ? 'Quals' : 'Races', { views: [{ state: 'frozen', xSplit: 5, ySplit: 1 }] });

  ws.addRow(cols.map(([label]) => label));
  ws.getRow(1).eachCell(c => {
    c.font = { bold: true, color: { argb: 'FFFFFFFF' } };
    c.fill = solidFill('1A1A1A');
    c.alignment = { horizontal: 'center' };
  });

  // До какого столбца красим топ-3 сплошной заливкой — все «опознавательные» колонки
  // (Pos/#/Driver/Team/M.), сколько бы из них ни выжило после чистки пустых
  let idCols = cols.findIndex(([, , round]) => round != null);
  if (idCols === -1) idCols = cols.length - 1; // остался только Points
  if (idCols < 1) idCols = cols.length;

  for (const s of rows) {
    const dmap = map[s.driver] || {};
    const row = ws.addRow(cols.map(([, fn]) => fn(s)));
    if (s.rank != null && s.rank <= 3) for (let i = 1; i <= idCols; i++) row.getCell(i).fill = solidFill(TOP3_FILL[s.rank - 1]);
    cols.forEach(([, , round], i) => {
      if (round == null) return;
      const cell = row.getCell(i + 1);
      cell.alignment = { horizontal: 'center' };
      const pos = dmap[round];
      if (pos != null) cell.fill = solidFill(posFillHex(pos, maxPosOf(round)));
      else if (round in dmap) cell.fill = solidFill('E68A90');
    });
  }

  autoSizeColumns(ws);
  // вид в имени файла: иначе протоколы гонок и квалификаций сохраняются под одним именем
  downloadXLSX(wb, `${exportSeriesLabel()} протокол ${type === 'quals' ? 'квалификаций' : 'гонок'}.xlsx`);
}

function filterPivot(type, val) {
  state.pivot[type] = val;
  renderPivot(type);
}

/* ── Отыгранные / потерянные позиции: старт (квала) − финиш (гонка) за весь сезон.
   Дуэли не в счёт: своей квалификации у них нет. Этапы без одной из двух позиций пропускаются. ── */
function computeGains() {
  const posByRound = rows => {
    const m = {};
    for (const r of rows) {
      const d = r['Driver'], rnd = r['Round'], pos = r['Pos.'];
      if (!d || isGuestDriver(d) || r.guest || rnd == null || pos == null || SPRINT_ROUNDS.has(rnd) || rnd === 0) continue;
      // как в карточке пилота: если строк на этап несколько, берём лучшую
      if (m[d]?.[rnd] == null || pos < m[d][rnd]) (m[d] ||= {})[rnd] = pos;
    }
    return m;
  };
  const race = posByRound(state.races.rows);
  const qual = posByRound(state.quals.rows);

  return Object.keys(race).map(d => {
    const cells = {};
    let gained = 0, lost = 0;
    for (const [rnd, rp] of Object.entries(race[d])) {
      const qp = qual[d]?.[rnd];
      if (qp == null) continue;
      const diff = qp - rp;
      cells[rnd] = { diff, qp, rp };
      if (diff > 0) gained += diff; else lost -= diff;
    }
    const n = Object.keys(cells).length;
    return { driver: d, team: teamOf(d), cells, gained, lost, net: gained - lost, n };
  })
    .filter(g => g.n)
    .sort((a, b) => b.net - a.net || b.gained - a.gained)
    .map((g, i) => ({ ...g, rank: i + 1 }));
}

const gainClass = v => v > 0 ? 'up' : v < 0 ? 'down' : '';
const signed = v => (v > 0 ? '+' : '') + v;

function renderGainPivot() {
  const rounds = state.races.rounds.filter(r => !SPRINT_ROUNDS.has(r));
  const list = state.gains.filter(g => hit(state.gainFilter, g.driver, g.team));

  let html = `<table class="pivot-table" data-sort="auto"><thead><tr>
<th class="driver-col">Место · Пилот</th>
${rounds.map(r => `<th title="${roundFullName(r)}">${roundLabel(r)}</th>`).join('')}
<th title="Сумма отыгранных позиций">Отыграно</th>
<th title="Сумма потерянных позиций">Потеряно</th>
<th title="Отыграно минус потеряно">Итого</th>
<th title="В среднем за этап">Сред.</th>
  </tr></thead><tbody>`;

  for (const g of list) {
    html += `<tr class="${g.rank <= 3 ? 'rank-' + g.rank : ''}">
  <td class="driver-cell"><span class="pos-badge">${g.rank}</span> ${g.driver}${coalMark(g.team)}
  <div class="team-drivers">${g.team}</div></td>`;
    for (const r of rounds) {
      const c = g.cells[r];
      html += c == null
        ? '<td><span class="pos-none">—</span></td>'
        : `<td title="${roundFullName(r)}: старт P${c.qp} → финиш P${c.rp}"><span class="${gainClass(c.diff)}">${signed(c.diff)}</span></td>`;
    }
    html += `<td class="up">+${g.gained}</td>
  <td class="down">${g.lost ? '-' + g.lost : 0}</td>
  <td class="total-cell"><span class="${gainClass(g.net)}">${signed(g.net)}</span></td>
  <td><span class="${gainClass(g.net)}">${signed(+(g.net / g.n).toFixed(1))}</span></td></tr>`;
  }
  document.getElementById('pivot-gains').innerHTML = html + '</tbody></table>';
}

function filterGains(val) {
  state.gainFilter = val;
  renderGainPivot();
}

// ── teams.js ──
/* Командный зачёт: таблица, зачёт владельцев, сводные по этапам */

// Кто приносил очки: в зачёт идут 2 лучших результата команды за этап
function scorersTooltip(t) {
  const top = Object.entries(t.scorers || {})
    .sort((a, b) => b[1].pts - a[1].pts)
    .slice(0, 3)
    .map(([d, sc]) => `${d} — ${sc.pts} очк. за ${sc.rounds} эт.`);
  return top.length ? 'Зачётные результаты:\n' + top.join('\n') : '';
}

function teamTableHtml(standings, q) {
  const starts = (t, kind) => t.drivers.reduce((n, d) => n + (state.attendance[kind][d]?.size || 0), 0);
  const rows = standings.filter(t => hit(q, t.team, ...t.drivers));
  let html = `<div class="table-scroll"><table class="standings-table" data-sort="auto"><thead><tr>
<th class="r w-40">#</th>
<th>Команда</th>
<th class="r">Очки</th>
<th class="r" title="Участий пилотов команды: в гонках / в квалификациях (максимум — пилотов × этапов)">Гонок / Квал.</th>
<th class="r">Пилотов</th>
  </tr></thead><tbody>`;

  for (const t of rows) {
    const rc = t.rank <= 3 ? `rank-${t.rank}` : '';
    html += `<tr class="${rc}">
  <td class="r"><span class="pos-badge">${t.rank}</span></td>
  <td>
    <strong>${teamLink(t.team)}</strong>${coalMark(t.team)}
    <div class="team-drivers">${t.drivers.sort().join(' · ')}</div>
  </td>
  <td class="r" title="${scorersTooltip(t)}">${penMark(t)}<strong>${t.total}</strong></td>
  <td class="r muted">${starts(t, 'races')} / ${starts(t, 'quals')}</td>
  <td class="r muted">${t.drivers.length}</td>
</tr>`;
  }
  return html + '</tbody></table></div>';
}

function renderTeams() {
  document.getElementById('table-teams').innerHTML = teamTableHtml(state.teamStandings, state.teamFilter);
}

function renderIndTeams() {
  document.getElementById('table-indTeams').innerHTML = teamTableHtml(state.indTeams, state.indTeamFilter);
}

// Полный зачёт, без учёта поискового фильтра на экране
function exportTeamsXLSX(indep) {
  const list = indep ? state.indTeams : state.teamStandings;
  const starts = (t, kind) => t.drivers.reduce((n, d) => n + (state.attendance[kind][d]?.size || 0), 0);
  downloadTableXLSX(list, [
    ['#', t => t.rank],
    ['Команда', t => t.team],
    ['Очки', t => t.total],
    ['Гонок', t => starts(t, 'races')],
    ['Квал.', t => starts(t, 'quals')],
    ['Пилотов', t => t.drivers.length],
  ], indep ? 'Независимые команды' : 'Командный зачёт',
    `${exportSeriesLabel()} ${indep ? 'независимые команды' : 'командный зачёт'}.xlsx`);
}

function filterTeams(val) {
  state.teamFilter = val;
  renderTeams();
}

function filterIndTeams(val) {
  state.indTeamFilter = val;
  renderIndTeams();
}

// Зачёт владельцев на этап считает сервер — тем же кодом, что раньше работал здесь

function ownersAt() {
  const rounds = roundsOf('owners');
  return state.upTo.owners ?? rounds[rounds.length - 1];
}

// список этапов для селектора берём из зачёта гонок — он уже в сводке сезона
function roundsOfOwners() {
  return state.races.rounds.filter(r => !SPRINT_ROUNDS.has(r));
}

function setOwnersUpTo(val) {
  const rounds = roundsOf('owners'), n = parseFloat(val);
  state.upTo.owners = n === rounds[rounds.length - 1] ? null : n;
  state.ownerPage = 1;
  renderOwners();
}

function setOwnersChase(val) {
  state.chaseView.owners = val;
  renderOwners();
}

async function renderOwners() {
  const at = ownersAt();
  const isChase = isChaseMode('owners', at);
  const wrap = document.getElementById('table-owners');
  const cut = state.slices[sliceKey('owners', at)];
  if (!cut) {
    if (!wrap.innerHTML) wrap.innerHTML = '<div class="loading-state"><div class="spinner"></div> Загрузка…</div>';
    await fetchSlice('owners', at);
    return renderOwners();
  }
  document.getElementById('upto-owners').innerHTML = `<div class="table-upto">
  <label>Зачёт после этапа:
    <select class="chart-select" onchange="setOwnersUpTo(this.value)">
      ${roundsOf('owners').map(r => `<option value="${r}"${r === at ? ' selected' : ''}>${roundFullName(r)}</option>`).join('')}
    </select>
  </label>
  ${at > CHASE_START ? `
  <div class="round-toggle inline">
    <button class="rtog-btn${!isChase ? ' rtog-active' : ''}" onclick="setOwnersChase('regular')">Регулярный сезон</button>
    <button class="rtog-btn${isChase ? ' rtog-active' : ''}" onclick="setOwnersChase('chase')">Чейз</button>
  </div>` : ''}
</div>`;
  const rows = cut.standings.filter(o => hit(state.ownerFilter, o.car, ...o.drivers));

  let html = `<div class="table-scroll"><table class="standings-table" data-sort="auto"><thead><tr>
<th class="r w-40">#</th>
<th>Номер</th>
<th>Пилоты</th>
<th class="r">Очки</th>
<th class="r">Победы</th>
<th class="r" title="Пять лучших финишей">Топ-5</th>
  </tr></thead><tbody>`;

  const page = state.ownerPage || 1;
  const pages = Math.ceil(rows.length / PAGE_SIZE);
  for (const o of rows.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE)) {
    const rc = o.rank <= 3 ? `rank-${o.rank}` : '';
    html += `<tr class="${rc}">
  <td class="r"><span class="pos-badge">${o.rank}</span></td>
  <td><strong>#${o.car}</strong></td>
  <td class="team-text">${o.drivers.sort().join(' · ')}</td>
  <td class="r"><strong>${o.total}</strong></td>
  <td class="r">${o.wins > 0 ? `<strong class="win">${o.wins}</strong>` : '<span class="muted">—</span>'}</td>
  <td class="r muted">${o.top5.join(' · ') || '—'}</td>
</tr>`;
  }
  document.getElementById('table-owners').innerHTML = html + '</tbody></table></div>'
    + paginationHtml(page, pages, `${rows.length} машин`, p => `goOwnerPage(${p})`);
}

// Все машины целиком, без пагинации и поиска на экране
async function exportOwnersXLSX() {
  const at = ownersAt();
  downloadTableXLSX((await fetchSlice('owners', at)).standings, [
    ['#', o => o.rank],
    ['Номер', o => o.car],
    ['Пилоты', o => o.drivers.join(' · ')],
    ['Очки', o => o.total],
    ['Победы', o => o.wins],
    ['Топ-5', o => o.top5.join(' · ')],
  ], 'Зачёт владельцев', `${exportSeriesLabel()} зачёт владельцев.xlsx`);
}

function goOwnerPage(p) {
  state.ownerPage = p;
  renderOwners();
}

function filterOwners(val) {
  state.ownerFilter = val;
  state.ownerPage = 1;
  renderOwners();
}

/* Очки команды за каждый этап (накопительный итог — в тултипе). Сортировка — общий
   обработчик data-sort="auto": он читает отрисованный текст, годится и для этой таблицы. */

// В сводных показываются все команды; у той, что вне зачёта, места нет
const teamPlaceBadge = t => t.rank == null
  ? '<span class="pos-badge" title="Вне командного зачёта: только гостевые пилоты">—</span>'
  : `<span class="pos-badge">${t.rank}</span>`;

function renderTeamPivot() {
  const rounds = state.races.rounds.filter(r => !SPRINT_ROUNDS.has(r));
  const teams = state.teamPivot.filter(t => hit(state.teamPivotFilter, t.team, ...t.drivers));

  let html = `<table class="pivot-table" data-sort="auto"><thead><tr>
    <th class="driver-col">Место · Команда</th>
    ${rounds.map(r => `<th title="${roundFullName(r)}">${roundLabel(r)}</th>`).join('')}
    <th>Итого</th>
  </tr></thead><tbody>`;

  for (const t of teams) {
    html += `<tr class="${t.rank <= 3 ? 'rank-' + t.rank : ''}">
      <td class="driver-cell">${teamPlaceBadge(t)} ${teamLink(t.team)}${coalMark(t.team)}</td>`;
    let pts = 0;
    for (const r of rounds) {
      const got = t.roundPts[r] || 0;
      pts += got;
      const cum = pts - penaltyBy(t, r);   // штраф входит в итог со своего этапа
      html += `<td title="${roundFullName(r)}: ${got} очк. · всего ${cum}">${got || '<span class="pos-none">—</span>'}</td>`;
    }
    html += `<td class="total-cell">${penMark(t)}${t.total}</td></tr>`;
  }
  document.getElementById('pivot-teams').innerHTML = html + '</tbody></table>';
}

function filterTeamPivot(val) {
  state.teamPivotFilter = val;
  renderTeamPivot();
}

// Те же строки и столбцы, но в ячейке — места, которые пошли в зачёт
function renderTeamPosPivot() {
  const rounds = state.races.rounds.filter(r => !SPRINT_ROUNDS.has(r));
  const teams = state.teamPivot.filter(t => hit(state.teamPosFilter, t.team, ...t.drivers));

  let html = `<table class="pivot-table" data-sort="auto"><thead><tr>
    <th class="driver-col">Место · Команда</th>
    ${rounds.map(r => `<th title="${roundFullName(r)}">${roundLabel(r)}</th>`).join('')}
    <th>Итого</th>
  </tr></thead><tbody>`;

  for (const t of teams) {
    html += `<tr class="${t.rank <= 3 ? 'rank-' + t.rank : ''}">
      <td class="driver-cell">${teamPlaceBadge(t)} ${teamLink(t.team)}${coalMark(t.team)}</td>`;
    for (const r of rounds) {
      const best = (t.roundBest[r] || []).filter(x => x.pos != null);
      const maxPos = state.roundMaxPos[r] || 40;
      html += best.length
        ? `<td title="${best.map(x => `${x.driver} P${x.pos} — ${x.pts} очк.`).join('\n')}">`
          + best.map(x => `<span class="pos-cell ${posClass(x.pos, maxPos)}">${x.pos}</span>`).join(' ')
          + '</td>'
        : '<td><span class="pos-cell pos-none">—</span></td>';
    }
    html += `<td class="total-cell">${penMark(t)}${t.total}</td></tr>`;
  }
  document.getElementById('pivot-teams-pos').innerHTML = html + '</tbody></table>';
}

function filterTeamPosPivot(val) {
  state.teamPosFilter = val;
  renderTeamPosPivot();
}

function renderTeamTab() {
  const standings = state.teamStandings;
  const rounds = state.races.rounds;

  renderTeams();

  // Bar chart — top 10
  const top10 = standings.slice(0, 10);
  const barId = 'chart-teams-bar';
  if (state.charts[barId]) state.charts[barId].destroy();
  state.charts[barId] = new Chart(document.getElementById(barId), {
    type: 'bar',
    data: {
      labels: top10.map(t => t.team),
      datasets: [{ data: top10.map(t => t.total), backgroundColor: top10.map((_, i) => COLORS[i % COLORS.length]), borderRadius: 4 }]
    },
    options: {
      indexAxis: 'y', responsive: true, maintainAspectRatio: false,
      plugins: { legend: { display: false }, tooltip: { callbacks: { label: c => ` ${c.raw} pts` } } },
      scales: { x: { grid: { color: '#ffffff0c' }, ticks: { color: '#666' } }, y: { grid: { display: false }, ticks: { color: '#bbb', font: { size: 11 } } } }
    }
  });

  // Line chart — top 5 cumulative
  const lineId = 'chart-teams-line';
  if (state.charts[lineId]) state.charts[lineId].destroy();
  const datasets = standings.slice(0, 5).map((t, i) => {
    let pts = 0;   // штраф входит в кривую со своего этапа, а к концу она сходится с зачётом
    return {
      label: t.team,
      borderColor: COLORS[i], backgroundColor: COLORS[i] + '20',
      data: rounds.map(r => { pts += t.roundPts[r] || 0; return pts - penaltyBy(t, r); }),
      tension: 0.35, pointRadius: 3, fill: false,
    };
  });
  state.charts[lineId] = new Chart(document.getElementById(lineId), {
    type: 'line',
    data: { labels: rounds.map(roundLabel), datasets },
    options: lineChartOptions()
  });
}

// ── entries.js ──
/* Заявки: сводная статистика команд на выбранный срез сезона.

   Лист Entries — матрица «команда × машина × этап» с единицей там, где машина заявлена;
   первая строка — номера этапов, вторая — подписи Team/Car (настоящей шапки у листа нет).
   Из него считается блок FULL TIME PARTICIPATION: там только фулл-тайм машины — заявленные
   подряд с момента заявления и до конца сезона. Остальные блоки считаются по всем прогнозам
   команды: и фулл-тайм, и парт-тайм машины, и гостевые пилоты — всё, что подано от её имени.

   Везде считаются только этапы регулярного сезона: дуэли и The Clash (этап 0) не в счёт. */

function computeEntries(rows) {
  if (rows.length < 3) return null;
  const head = rows[0];
  const [teamKey, carKey] = Object.keys(head);
  const roundCols = Object.entries(head).filter(([, v]) => typeof v === 'number');
  const lastCol = Math.max(...roundCols.map(([, rnd]) => rnd));

  const byTeam = {};
  for (const r of rows.slice(1)) {
    const team = r[teamKey];
    if (!team || team === 'Team') continue;     // строка подписей Team/Car
    const on = roundCols.filter(([col]) => r[col]).map(([, rnd]) => rnd);
    if (!on.length) continue;
    // ponytail: фулл-тайм определяем по самому листу — сплошной ряд до последнего столбца сезона.
    // Если машину снимут с фулл-тайма посреди сезона, её придётся помечать в листе явно
    const last = on[on.length - 1];
    if (last !== lastCol || on.length !== last - on[0] + 1) continue;
    (byTeam[team] ||= {})[String(r[carKey])] = new Set(on);
  }
  return byTeam;
}

// Этап идёт в статистику: дуэль — не этап регулярного сезона, этап 0 (The Clash) вне зачёта
const statRound = (rnd, at) => rnd != null && rnd !== 0 && !SPRINT_ROUNDS.has(rnd) && rnd <= at;

/* Фактически поданные прогнозы по фулл-тайм машинам: строка в квалификации = поданный прогноз
   (в гонку попадают не все). Считаем по номеру машины, иначе в факт попадёт и парт-тайм. */
function factByTeamRound() {
  const m = {};
  for (const r of state.quals.rows) {
    const team = r['Team'], rnd = r['Round'];
    if (!team || rnd == null || rnd === 0 || SPRINT_ROUNDS.has(rnd)) continue;
    if (!state.entries[team]?.[String(r['#'])]?.has(rnd)) continue;
    const t = (m[team] ||= {});
    t[rnd] = (t[rnd] || 0) + 1;
  }
  return m;
}

// План: сколько прогнозов фулл-тайм машины команды должны были подать к этапу at
function planByTeam(team, upToRounds) {
  return Object.values(state.entries[team])
    .reduce((n, rounds) => n + upToRounds.filter(r => rounds.has(r)).length, 0);
}

const ZERO_STATS = {
  entriesTotal: 0, realQuals: 0, qPosSum: 0, qPosN: 0, top10Q: 0,
  starts: 0, rPosSum: 0, rPosN: 0, top10R: 0, wins: 0,
};

/* Пилот может квалифицироваться гостем без машины, а стартовать уже за команду — в листе квалификаций
   у такой строки Team = «Guest entry», а в листе гонок на том же этапе стоит настоящая команда.
   Прогноз при этом подан от её имени, поэтому берём команду из гоночной строки того же этапа. */
function raceTeamByRound() {
  const m = {};
  for (const r of state.races.rows) {
    const team = r['Team'], d = r['Driver'], rnd = r['Round'];
    if (!d || !team || team === '—' || team === 'Guest entry' || rnd == null) continue;
    (m[d] ||= {})[rnd] = team;
  }
  return m;
}

/* Статистика по всем прогнозам команды. Соревновательная квалификация — та, что не по метрике
   (DR1–DR4 заполнены); метричные этапы уже лежат в state.metricQuals.
   DQ (строка есть, места нет) считается поданным прогнозом и стартом, но в средние и топ-10
   не идёт — позиции у неё просто нет. */
function teamStats(at) {
  const stats = {};
  const of = team => (stats[team] ||= { ...ZERO_STATS });
  const raceTeams = raceTeamByRound();

  for (const r of state.quals.rows) {
    const rnd = r['Round'];
    const team = r['Team'] === 'Guest entry' ? raceTeams[r['Driver']]?.[rnd] : r['Team'];
    if (!team || !statRound(rnd, at)) continue;
    const s = of(team);
    s.entriesTotal++;
    if (state.metricQuals.has(rnd)) continue;
    s.realQuals++;
    const pos = r['Pos.'];
    if (pos == null) continue;
    s.qPosSum += pos;
    s.qPosN++;
    if (pos <= 10) s.top10Q++;
  }

  for (const r of state.races.rows) {
    const team = r['Team'], rnd = r['Round'];
    if (!team || !statRound(rnd, at)) continue;
    const s = of(team);
    s.starts++;
    const pos = r['Pos.'];
    if (pos == null) continue;
    s.rPosSum += pos;
    s.rPosN++;
    if (pos <= 10) s.top10R++;
    if (pos === 1) s.wins++;
  }
  return stats;
}

/* Ранг с общими местами: при равенстве все получают наименьший (лучший) ранг, а следующий
   сдвигается на размер группы — 3 победы и три команды по 2 дают ранги 1, 2, 2, 2, 5.
   Команды без значения («—») не ранжируются и на чужие ранги не влияют.
   ponytail: квадратичный перебор, но команд десятки — сортировать ради этого нечего. */
function rankBy(rows, key, best = 'max') {
  const better = (v, x) => best === 'max' ? v > x : v < x;
  for (const r of rows) {
    r[key + 'Rank'] = r[key] == null ? null
      : 1 + rows.filter(o => o[key] != null && better(o[key], r[key])).length;
  }
}

const pctOf = (a, b) => b ? a / b * 100 : null;
const avgOf = (sum, n) => n ? sum / n : null;

/* METRIC SCORE — свёртка рангов команды в одно число, меньше — лучше.
   Базовая метрика: ранг по каждому фактору умножается на его вес, произведения складываются.
   Финальная: базовая корректируется на участие фулл-тайм машин — пропуски штрафуют,
   100% участия оставляет метрику как есть (множитель 1 + (1 − ENTRIES %)).
   Без хотя бы одного ранга или без плановых заявок метрика не считается — в таблице «—». */
const METRIC_WEIGHTS = [
  ['avgQRank', 0.10], ['top10QPctRank', 0.10], ['startsPctRank', 0.15],
  ['avgRRank', 0.20], ['top10RPctRank', 0.20], ['winsRank', 0.10], ['teamPtsRank', 0.15],
];

/* Ценз участия: команда с ENTRIES % ниже 45 в ранжировании не участвует вовсе — ни своих
   рангов, ни метрики, и на ранги остальных она не влияет. */
const METRIC_MIN_ENTRIES = 45;
const isRanked = t => t.pct != null && t.pct >= METRIC_MIN_ENTRIES;

function metricScore(t) {
  if (t.pct == null || METRIC_WEIGHTS.some(([key]) => t[key] == null)) return null;
  const base = METRIC_WEIGHTS.reduce((sum, [key, w]) => sum + t[key] * w, 0);
  return base * (1 + (1 - t.pct / 100));
}

/* Срезы, на которые считается таблица: каждый проведённый этап квалификаций.
   Статистика считается по всем этапам до выбранного. */
function entriesRounds() {
  return roundsOf('quals');
}

function entriesRows(at) {
  const upToRounds = roundsOf('quals').filter(r => r <= at);
  const fact = factByTeamRound();
  const stats = teamStats(at);
  // командный зачёт на тот же срез: дуэли и этап 0 computeTeamStandings отсекает сама
  const teamPts = Object.fromEntries(
    computeTeamStandings(state.races.rows.filter(r => r['Round'] <= at)).map(t => [t.team, t.total]));

  const rows = Object.keys(state.entries)
    .map(team => {
      const s = { ...ZERO_STATS, ...stats[team] };
      const plan = planByTeam(team, upToRounds);
      const made = upToRounds.reduce((n, r) => n + (fact[team]?.[r] || 0), 0);
      return {
        team,
        entriesTotal: s.entriesTotal,
        realQuals: s.realQuals,
        avgQ: avgOf(s.qPosSum, s.qPosN),
        top10Q: s.top10Q,
        top10QPct: pctOf(s.top10Q, s.realQuals),
        starts: s.starts,
        startsPct: pctOf(s.starts, s.entriesTotal),
        avgR: avgOf(s.rPosSum, s.rPosN),
        top10R: s.top10R,
        top10RPct: pctOf(s.top10R, s.starts),
        wins: s.wins,
        teamPts: teamPts[team] ?? 0,
        made, plan, pct: pctOf(made, plan),
      };
    })
    .filter(t => t.plan || t.entriesTotal);     // команда к этому этапу ещё не заявлялась

  // ранги строятся только по прошедшим ценз; остальные остаются вовсе без рангов
  const ranked = rows.filter(isRanked);
  rankBy(ranked, 'avgQ', 'min');
  rankBy(ranked, 'top10QPct');
  rankBy(ranked, 'startsPct');
  rankBy(ranked, 'avgR', 'min');
  rankBy(ranked, 'top10RPct');
  rankBy(ranked, 'wins');
  rankBy(ranked, 'teamPts');
  for (const t of rows) t.metric = metricScore(t);

  // по умолчанию — по метрике, меньше лучше; команды без метрики уходят вниз
  return rows
    .sort((a, b) => (a.metric ?? Infinity) - (b.metric ?? Infinity) || b.teamPts - a.teamPts)
    // ranked — прошла ли команда ценз ENTRIES %: это показывает и таблица, и карточка команды
    .map((t, i) => ({ ...t, rank: i + 1, ranked: isRanked(t) }));
}

/* Столбцы: [заголовок, значение строки, подсказка]. Один список на экран и на выгрузку,
   чтобы Excel не разъезжался с таблицей. */
const numCell = v => v == null ? '—' : String(v);
const avgCell = v => v == null ? '—' : v.toFixed(2);
const pctCell = v => v == null ? '—' : v.toFixed(1) + '%';

const ENTRIES_GROUPS = [['METRIC', 1], ['QUALS', 7], ['RACES', 8], ['WINS', 2], ['TEAMS', 2], ['FULL TIME PARTICIPATION', 3]];

const ENTRIES_COLS = [
  ['METRIC SCORE', t => t.metric == null ? '—' : t.metric.toFixed(3),
    `Свёртка рангов с весами (AVG Q 10%, TOP 10 Q % 10%, STARTS % 15%, AVG R 20%, TOP 10 R % 20%, WINS 10%, TEAMS 15%), скорректированная на участие фулл-тайм машин. Меньше — лучше. Ранги и метрика считаются только у команд с ENTRIES % не ниже ${METRIC_MIN_ENTRIES}`],
  ['ENTRIES TOTAL', t => numCell(t.entriesTotal), 'Общее количество поданных прогнозов от имени пилотов команды, как фулл-тайм, так и парт-тайм'],
  ['REAL QUALS', t => numCell(t.realQuals), 'Прогнозы, участвовавшие в соревновательной квалификации, то есть за вычетом этапов по метрике'],
  ['AVG Q', t => avgCell(t.avgQ), 'Средняя квалификационная позиция для соревновательных прогнозов, вне зависимости от попадания в топ-40'],
  ['AVG Q RANK', t => numCell(t.avgQRank), 'Ранг по средней позиции в соревновательной квалификации: чем лучше средняя — тем выше ранг'],
  ['TOP 10 Q', t => numCell(t.top10Q), 'Попадания в топ-10 соревновательной квалификации'],
  ['TOP 10 Q %', t => pctCell(t.top10QPct), 'Доля попаданий в топ-10 от числа соревновательных прогнозов (REAL QUALS)'],
  ['TOP 10 Q % RANK', t => numCell(t.top10QPctRank), 'Ранг по доле попаданий в топ-10 соревновательной квалификации'],
  ['STARTS', t => numCell(t.starts), 'Проходы на старт гонки: через соревновательную квалификацию и по метрике'],
  ['STARTS %', t => pctCell(t.startsPct), 'Доля проходов на старт от всех поданных прогнозов (ENTRIES TOTAL)'],
  ['STARTS % RANK', t => numCell(t.startsPctRank), 'Ранг по доле проходов на старт'],
  ['AVG R', t => avgCell(t.avgR), 'Средняя финишная позиция в гонке; непопадания на старт не учитываются'],
  ['AVG R RANK', t => numCell(t.avgRRank), 'Ранг по средней финишной позиции: чем лучше средняя — тем выше ранг'],
  ['TOP 10 R', t => numCell(t.top10R), 'Попадания в топ-10 в гонке'],
  ['TOP 10 R %', t => pctCell(t.top10RPct), 'Доля попаданий в топ-10 гонки от числа проходов на старт'],
  ['TOP 10 R % RANK', t => numCell(t.top10RPctRank), 'Ранг по доле попаданий в топ-10 гонки'],
  ['WINS', t => numCell(t.wins), 'Победы в гонках у пилотов команды'],
  ['WINS RANK', t => numCell(t.winsRank), 'Ранг по числу побед'],
  ['TEAM PTS', t => numCell(t.teamPts), 'Очки в командном зачёте: не более двух лучших финишей от команды за гонку, штрафы вычтены'],
  ['TEAMS RANK', t => numCell(t.teamPtsRank), 'Ранг по очкам в командном зачёте'],
  ['ENTRIES FACT', t => numCell(t.made), 'Фактически поданные прогнозы за фулл-тайм машины команды, с учётом пропущенных этапов'],
  ['ENTRIES PLAN', t => numCell(t.plan), 'Плановое число прогнозов за фулл-тайм машины: этапы с момента заявления каждой машины'],
  ['ENTRIES %', t => pctCell(t.pct), 'Доля участия фулл-тайм машин: ENTRIES FACT делённое на ENTRIES PLAN'],
];

// Выделяем только ранги и итоговую метрику — сами значения идут фоном, приглушённо
const colClass = label => label === 'METRIC SCORE' ? 'metric-col'
  : label.endsWith('RANK') ? 'rank-col' : 'val-col';

function renderEntries() {
  // метрику (со всеми контрольными точками) считает сервер, часть metric
  const { rounds, byRound } = state.metric || { rounds: [], byRound: {} };
  const at = state.entriesUpTo ?? rounds[rounds.length - 1];
  const rows = (byRound[at] || []).filter(t => hit(state.entriesFilter, t.team));

  let html = `<div class="table-upto">
  <label>По состоянию на этап:
    <select class="chart-select" onchange="setEntriesUpTo(this.value)">
      ${rounds.map(r => `<option value="${r}"${r === at ? ' selected' : ''}>${roundFullName(r)}</option>`).join('')}
    </select>
  </label>
  <span class="upto-note">FULL TIME PARTICIPATION — только фулл-тайм машины, остальное — по всем прогнозам команды</span>
</div>
<div class="pivot-scroll"><table class="pivot-table entries-table" data-sort="auto">
<thead>
<tr class="grp-row"><th colspan="2"></th>${ENTRIES_GROUPS.map(([g, n]) => `<th colspan="${n}">${g}</th>`).join('')}</tr>
<tr><th class="num-col">#</th><th class="driver-col">Команда</th>
${ENTRIES_COLS.map(([label, , title]) => `<th class="${colClass(label)}" title="${title}">${label}</th>`).join('')}
</tr></thead><tbody>`;

  for (const t of rows) {
    html += `<tr class="${t.rank <= 3 ? 'rank-' + t.rank : ''}">
  <td><span class="pos-badge">${t.rank}</span></td>
  <td class="driver-cell">${teamLink(t.team)}${coalMark(t.team)}</td>
  ${ENTRIES_COLS.map(([label, fn]) => `<td class="${colClass(label)}"${label === 'METRIC SCORE' && !isRanked(t) ? ` title="ENTRIES % ниже ${METRIC_MIN_ENTRIES} — команда вне ранжирования"` : ''}>${fn(t)}</td>`).join('')}
</tr>`;
  }
  document.getElementById('table-entries').innerHTML = html + '</tbody></table></div>'
    + `<div class="pagination"><span class="page-info">${rows.length} команд</span></div>`;
}

function setEntriesUpTo(val) {
  const rounds = (state.metric || { rounds: [] }).rounds;
  const n = parseFloat(val);
  state.entriesUpTo = n === rounds[rounds.length - 1] ? null : n;
  renderEntries();
}

function filterEntries(val) {
  state.entriesFilter = val;
  renderEntries();
}

// Все команды целиком, без поиска на экране
function exportEntriesXLSX() {
  const { rounds, byRound } = state.metric || { rounds: [], byRound: {} };
  const at = state.entriesUpTo ?? rounds[rounds.length - 1];
  downloadTableXLSX(byRound[at] || [], [
    ['#', t => t.rank],
    ['Команда', t => t.team],
    ...ENTRIES_COLS.map(([label, fn]) => [label, fn]),
  ], 'Метрика', `${exportSeriesLabel()} метрика после ${fmtRoundNum(at)} этапа.xlsx`);
}

// ── golub.js ──
/* Зачёт им. Semen GOLUBOCHKIN */

const GOLUB = 'Semen GOLUBOCHKIN';
// по фамилии: в таблице имя пишут и как Semyon, и как Semen
const isGolub = d => d.includes('GOLUBOCHKIN');

function computeGolub(rows) {
  const byRound = {};
  for (const r of rows) {
    const rnd = r['Round'];
    if (rnd == null || r['Pos.'] == null || SPRINT_ROUNDS.has(rnd) || rnd === 0) continue;
    (byRound[rnd] ||= []).push(r);
  }

  const rounds = [];
  const info = {};   // этап → позиция Голубочкина и число участников
  const map = {};
  for (const rnd of Object.keys(byRound).map(Number).sort((a, b) => a - b)) {
    const field = byRound[rnd];
    const gp = field.find(r => isGolub(r['Driver'] || ''))?.['Pos.'];
    if (gp == null) continue;  // этап без него в зачёт не идёт
    // финишировал последним — очков не набрал никто, колонка была бы пустой
    if (!field.some(x => x['Pos.'] > gp && x['Driver'] && !isGolub(x['Driver']) && !isGuestDriver(x['Driver']) && !x.guest)) continue;
    rounds.push(rnd);
    info[rnd] = { gp, n: field.length };
    for (const r of field) {
      const d = r['Driver'], pos = r['Pos.'];
      if (!d || isGolub(d) || isGuestDriver(d) || r.guest) continue;
      const g = map[d] ||= { driver: d, team: teamOf(d), total: 0, cells: {} };
      // считаем участников, а не разницу позиций: в протоколе бывают пропуски в нумерации
      const pts = pos <= gp ? 0
        : field.reduce((n, x) => n + (x['Pos.'] > gp && x['Pos.'] <= pos ? 1 : 0), 0);
      g.cells[rnd] = { pts, gp, pos };
      g.total += pts;
    }
  }
  // ни разу не финишировал ниже — в зачёте не участвует
  const drivers = Object.values(map).filter(g => g.total > 0)
    .sort((a, b) => b.total - a.total)
    .map((g, i) => ({ ...g, rank: i + 1 }));
  return { rounds, info, drivers };
}

function golubClass(pts) {
  if (pts === 0) return 'pos-none';
  if (pts <= 5) return 'pos-gray';
  if (pts <= 10) return 'pos-bronze';
  if (pts <= 20) return 'pos-green';
  return 'pos-purple';
}

function renderGolub(type) {
  const { rounds, info, drivers } = state.golub[type];
  const list = drivers.filter(g => hit(state.golubFilter[type], g.driver, g.team));

  let html = `<table class="pivot-table" data-sort="auto"><thead><tr>
<th class="driver-col">Место · Пилот</th>
${rounds.map(r => `<th title="${roundFullName(r)} · ${GOLUB} P${info[r].gp} из ${info[r].n} участников">${roundLabel(r)}<span class="pivot-qpos">P${info[r].gp}/${info[r].n}</span></th>`).join('')}
<th>Итого</th>
  </tr></thead><tbody>`;

  for (const g of list) {
    html += `<tr class="${g.rank <= 3 ? 'rank-' + g.rank : ''}">
  <td class="driver-cell"><span class="pos-badge">${g.rank}</span> ${g.driver}${coalMark(g.team)}
  <div class="team-drivers">${g.team}</div></td>`;
    for (const r of rounds) {
      const c = g.cells[r];
      html += c == null
        ? '<td><span class="pos-cell pos-none">—</span></td>'
        : `<td title="${GOLUB} P${c.gp} · ${g.driver} P${c.pos}"><span class="pos-cell ${golubClass(c.pts)}">${c.pts}</span></td>`;
    }
    html += `<td class="total-cell">${g.total}</td></tr>`;
  }
  document.getElementById(`golub-${type}`).innerHTML = html + '</tbody></table>';
}

function setGolubView(type) {
  for (const t of ['races', 'quals']) {
    document.getElementById(`golub-card-${t}`).style.display = t === type ? '' : 'none';
    document.querySelector(`.rtog-btn[data-gv="${t}"]`).classList.toggle('rtog-active', t === type);
  }
}

function filterGolub(type, val) {
  state.golubFilter[type] = val;
  renderGolub(type);
}

// ── rounds.js ──
/* Вкладка «По этапам»: результаты и зачёты после этапа */

// Пороги для подсветки «лучшего значения» — общие и для экрана, и для экспорта,
// поэтому считаются по allRows (полному протоколу), а не урезанным поиском rows.
function roundHighlightContext(allRows, cols) {
  const colMax = {}, colMin = {};
  for (const col of cols) {
    const vals = col.maxKey || col.minKey
      ? allRows.map(r => r[col.maxKey || col.minKey]).filter(v => v != null && isFinite(v))
      : [];
    if (col.maxKey) colMax[col.maxKey + col.label] = vals.length ? Math.max(...vals) : null;
    if (col.minKey) colMin[col.minKey + col.label] = vals.length ? Math.min(...vals) : null;
  }

  const groupThresh = {};
  const groupDefs = {};
  for (const col of cols) {
    if (!col.group) continue;
    if (!groupDefs[col.group]) groupDefs[col.group] = { top: col.groupTop || 1, vals: [] };
    for (const r of allRows) {
      const v = r[col.key];
      if (v != null && isFinite(v)) groupDefs[col.group].vals.push(v);
    }
  }
  for (const [grp, { top, vals }] of Object.entries(groupDefs)) {
    const uniq = [...new Set(vals)].sort((a, b) => b - a);
    groupThresh[grp] = uniq.length >= top ? uniq[top - 1] : (uniq[uniq.length - 1] ?? null);
  }

  return { colMax, colMin, groupThresh };
}

function isRoundCellHighlighted(col, r, { colMax, colMin, groupThresh }) {
  if (col.maxKey) {
    const mx = colMax[col.maxKey + col.label];
    return mx != null && r[col.maxKey] != null && r[col.maxKey] === mx;
  }
  if (col.minKey) {
    const mn = colMin[col.minKey + col.label];
    return mn != null && r[col.minKey] != null && r[col.minKey] === mn;
  }
  if (col.group) {
    const thresh = groupThresh[col.group];
    const v = r[col.key];
    return thresh != null && v != null && v >= thresh;
  }
  return false;
}

// allRows — полный протокол этапа: подсветку лучших значений поиск сужать не должен
function renderRoundTable(containerId, rows, cols, allRows = rows) {
  const wrap = document.getElementById(containerId);
  if (!rows.length) { wrap.innerHTML = '<div class="round-empty">Нет данных</div>'; return; }

  const ctx = roundHighlightContext(allRows, cols);

  let html = '<div class="table-scroll"><table class="round-table" data-sort="auto"><thead><tr>';
  for (const { label, cls, title } of cols)
    html += `<th class="${cls || ''}"${title ? ` title="${title}"` : ''}>${label}</th>`;
  html += '</tr></thead><tbody>';

  for (const r of rows) {
    html += '<tr>';
    for (const col of cols) {
      const { key, cls, fmt } = col;
      const v = r[key];
      const display = fmt ? fmt(v, r) : (v == null ? '—' : v);
      const highlight = isRoundCellHighlighted(col, r, ctx);
      const cellCls = [cls || '', highlight ? 'hl' : ''].filter(Boolean).join(' ');
      html += `<td class="${cellCls}">${display}</td>`;
    }
    html += '</tr>';
  }
  html += '</tbody></table></div>';
  wrap.innerHTML = html;
}

/* ── Зачёт владельцев (п. 9.6): очки как у пилотов, но принадлежат номеру машины.
   Гость очков себе не берёт, а машине приносит (#43 набран одними гостями).
   П. 4.9.5 (смена производителя обнуляет очки машины) в данных не подтверждается: все «смены»
   оказались разовыми гостевыми строками и опечатками с потерянным ведущим нулём. ── */

const ROUND_VIEWS = ['race', 'qual', 'duel1', 'duel2', 'st-drivers', 'st-teams', 'st-owners', 'metric-next'];
const ROUND_VIEW_LABEL = {
  race: 'Race', qual: 'Qual', duel1: 'Duel 1', duel2: 'Duel 2',
  'st-drivers': 'Standings', 'st-teams': 'Teams', 'st-owners': 'Owners', 'metric-next': 'Next metric',
};
let roundView = 'race';

// Название трассы без номера этапа: state.roundNames хранит «26 · Daytona»
const trackNameOf = roundNum => (state.roundNames[String(roundNum)] || '').split(' · ')[1] || '';

// «2026 Open - Daytona - Race»
const roundExportName = roundNum => `${exportSeriesLabel()} - ${trackNameOf(roundNum)} - ${ROUND_VIEW_LABEL[roundView]}`;

// Полные данные текущего вида таблицы этапа — для выгрузки в обход поиска на экране
let roundExport = null;

// roundExport.cols — либо готовые пары [заголовок, row => значение] (зачёты после этапа),
// либо «сырые» определения колонок таблицы этапа ({key, label, maxKey, group, …}) —
// вторые нужны как есть для подсветки лучших значений при экспорте в Excel.
const roundColsToPairs = cols => cols.map(c => Array.isArray(c) ? c : [c.label, r => r[c.key] ?? '']);

// Протокол этапа в .xlsx — заливка столбцов по типу метрики (квала, дропы, штрафы),
// как в официальном протоколе; ячейка, подсвеченная на экране как лучшее значение
// (жёлтый текст), заливается жёлтым и в Excel — вместо обычного цвета своего столбца.
const ROUND_HIGHLIGHT_FILL = 'F5E6A8';

async function exportRoundXLSX() {
  if (!roundExport) return;
  const { cols, rows, filename } = roundExport;
  const isRaw = cols.length > 0 && !Array.isArray(cols[0]);
  let pairs = roundColsToPairs(cols);

  // Пустые столбцы (например, DR3/DR4 в квале по метрике, где их просто нет) убираем
  // до записи в лист — сама подсветку лучших значений считаем по полным исходным rows
  const keep = pairs.map(([, fn]) => rows.some(r => !isBlankCell(fn(r))));
  const keptCols = isRaw ? cols.filter((_, i) => keep[i]) : cols;
  pairs = pairs.filter((_, i) => keep[i]);
  const keptRows = dropEmptyRows(pairs, rows);
  const ctx = isRaw ? roundHighlightContext(rows, keptCols) : null;

  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('Round');

  ws.addRow(pairs.map(([label]) => label));
  ws.getRow(1).eachCell(c => {
    c.font = { bold: true, color: { argb: 'FFFFFFFF' } };
    c.fill = solidFill('1A1A1A');
    c.alignment = { horizontal: 'center' };
  });

  for (const r of keptRows) {
    const row = ws.addRow(pairs.map(([, fn]) => fn(r)));
    row.eachCell(cell => cell.alignment = { horizontal: 'center' });
    if (isRaw) keptCols.forEach((col, i) => {
      const cell = row.getCell(i + 1);
      const hex = isRoundCellHighlighted(col, r, ctx) ? ROUND_HIGHLIGHT_FILL
        : col.key === 'M.' ? mfrFillHex(r['M.'])
          : ROUND_COL_FILL[col.key];
      if (hex) cell.fill = solidFill(hex);
    });
  }

  autoSizeColumns(ws);
  downloadXLSX(wb, `${filename}.xlsx`);
}

function setRoundView(view) {
  roundView = view;
  // только свой переключатель: такие же кнопки есть во вкладке GOLUBOCHKIN
  document.querySelectorAll('#round-toggle .rtog-btn').forEach(b => b.classList.toggle('rtog-active', b.dataset.view === view));
  onRoundChange();
}

function renderRoundToggle(isRound1) {
  const btns = isRound1
    ? [['qual', 'Квалификация'], ['duel1', 'Дуэль 1'], ['duel2', 'Дуэль 2'], ['race', 'Гонка']]
    : [['race', 'Гонка'], ['qual', 'Квалификация']];
  btns.push(['st-drivers', 'Личный'], ['st-teams', 'Командный'], ['st-owners', 'Владельцы'], ['metric-next', 'Метрика на след. этап']);
  document.getElementById('round-toggle').innerHTML = btns.map(([v, label]) =>
    `<button class="rtog-btn${roundView === v ? ' rtog-active' : ''}" data-view="${v}" onclick="setRoundView('${v}')">${label}</button>`
  ).join('');
}

/* ── Зачёты по состоянию после этапа ── */
function deltaCell(prevRank, rank) {
  if (prevRank == null) return '<span class="muted" title="Новый в зачёте">•</span>';
  const d = prevRank - rank;
  if (d === 0) return '<span class="muted">—</span>';
  return `<span class="${d > 0 ? 'up' : 'down'}">${d > 0 ? '▲' : '▼'}${Math.abs(d)}</span>`;
}

// Поиск по вкладке: сужает и протокол этапа, и зачёты после него
const roundHit = (...fields) => hit(state.roundFilter, ...fields);

function filterRound(val) {
  state.roundFilter = val;
  onRoundChange();
}

// Зачёт владельцев после этапа n (дуэли — часть своего этапа), после 26 этапа — с Чейзом
function ownersAfter(n) {
  const rows = state.races.rowsWithDuel.filter(r => r['Round'] < n + 1);
  return n > CHASE_START ? computeChaseOwnerStandings(rows) : computeOwnerStandings(rows);
}

// П. 8.8: метрика участников на следующий этап (стартовый порядок при отмене квалификации)
function renderRoundMetric(roundNum) {
  const field = state.roundMaxPos[roundNum] || 40;
  const race = state.races.rowsWithDuel.filter(r => r['Round'] < roundNum + 1);
  const quals = state.quals.rows.filter(r => r['Round'] < roundNum + 1);
  const champ = metricChampRanks(roundNum > CHASE_START ? computeChaseStandings(race) : computeStandings(race), quals);
  const owners = ownersAfter(roundNum);
  const ownerRank = Object.fromEntries(owners.map(o => [o.car, o.rank]));

  // Машина и команда участника — по его последней строке; последний участник под каждым номером
  const last = {}, lastOfCar = {};
  for (const r of [...quals, ...race]) {
    const d = r['Driver'], car = r['#'], rnd = r['Round'];
    if (!d || !car || car === '-' || rnd == null) continue;
    if (!(last[d]?.rnd > rnd)) last[d] = { rnd, car: String(car), team: r['Team'] && r['Team'] !== '—' ? r['Team'] : '—' };
    if (!(lastOfCar[car]?.rnd > rnd)) lastOfCar[car] = { rnd, driver: d };
  }
  const posOf = Object.fromEntries(state.races.rows
    .filter(r => parseFloat(r['Round']) === roundNum && r['Pos.'] != null).map(r => [r['Driver'], r['Pos.']]));

  const full = computeNextMetric(Object.keys(champ).map(driver => {
    const { car = '—', team = '—' } = last[driver] || {};
    const pos = posOf[driver] ?? null;
    const other = lastOfCar[car]?.driver;
    return { driver, team, car, pos, place: pos ?? field + 1, champRank: champ[driver],
      ownerRank: ownerRank[car] ?? owners.length + 1, carNote: other && other !== driver ? other : null };
  }));
  const noteText = m => m.carNote ? `Под этим номером позже выступал ${m.carNote} — мог не подать прогноз под этим номером` : '';

  roundExport = { rows: full, filename: roundExportName(roundNum), cols: [
    ['#', m => full.indexOf(m) + 1], ['Участник', m => m.driver], ['Команда', m => m.team], ['Номер', m => m.car],
    ['Место в гонке', m => m.pos ?? m.place], ['Место в чемпионате', m => m.champRank],
    ['Место машины у владельцев', m => m.ownerRank], ['Метрика', m => m.metric], ['Примечание', noteText],
  ] };
  const esc = s => String(s).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
  const body = full.map((m, i) => [i + 1, m]).filter(([, m]) => roundHit(m.driver, m.team, m.car))
    .map(([place, m]) => `<tr class="${place <= 3 ? 'rank-' + place : ''}">
  <td class="r"><span class="pos-badge">${place}</span></td>
  <td><strong class="driver-link" onclick="openDriver('${m.driver.replace(/'/g, "\\'").replace(/"/g, '&quot;')}')">${m.driver}</strong></td>
  <td class="team-text">${m.team}${coalMark(m.team)}</td>
  <td><strong>#${m.car}</strong>${m.carNote ? ` <span class="hl coal-mark" title="${esc(noteText(m))}">*</span>` : ''}</td>
  <td class="r">${m.pos ?? `<span class="muted" title="Не прошёл квалификацию или не подавал прогноз — место ${m.place}">${m.place}</span>`}</td>
  <td class="r">${m.champRank}</td>
  <td class="r">${m.ownerRank}</td>
  <td class="r"><strong>${m.metric.toFixed(2)}</strong></td>
</tr>`).join('');
  document.getElementById('round-table').innerHTML = `<div class="table-scroll"><table class="standings-table" data-sort="auto"><thead><tr>
  <th class="r w-36">#</th><th>Участник</th><th>Команда</th><th>Номер</th>
  <th class="r" title="Не прошедшие квалификацию и не подававшие прогноз — место ${field + 1}">Место в гонке</th>
  <th class="r" title="Место в личном зачёте после этапа (п. 8.8.2–8.8.3)">Место в чемпионате</th>
  <th class="r" title="Место машины в зачёте владельцев после этапа">Место машины у владельцев</th>
  <th class="r" title="50% места в гонке + 25% места в чемпионате + 25% места машины у владельцев; меньше — лучше">Метрика</th>
</tr></thead><tbody>${body}</tbody></table></div>`;
}

// kind: 'st-drivers' | 'st-teams' | 'st-owners' — зачёт по состоянию после этапа
function renderRoundStandings(kind, roundNum) {
  // Дуэли (1.1/1.2) относятся к своему этапу, поэтому граница — до следующего целого
  const upTo = n => state.races.rowsWithDuel.filter(r => r['Round'] < n + 1);
  const prevRound = Math.max(...state.races.rounds.filter(r => r < roundNum), 0);
  const rowsNow = upTo(roundNum);
  const rowsPrev = prevRound ? upTo(prevRound) : [];

  let head, body;
  if (kind === 'st-teams') {
    const full = computeTeamStandings(rowsNow);
    roundExport = { rows: full, filename: roundExportName(roundNum), cols: [
      ['#', t => t.rank], ['Команда', t => t.team], ['Очки', t => t.total],
      ['Топ-10', t => t.bestPositions.slice(0, 10).join(' · ')],
    ] };
    const prevPos = Object.fromEntries(computeTeamStandings(rowsPrev).map(t => [t.team, t.rank]));
    head = '<th>Команда</th><th class="r">Очки</th><th class="r" title="Десять лучших финишей пилотов команды">Топ-10</th>';
    body = full.filter(t => roundHit(t.team, ...t.drivers))
      .map(t => [t.rank, deltaCell(prevPos[t.team], t.rank),
    `<td><strong>${teamLink(t.team)}</strong>${coalMark(t.team)}</td>
   <td class="r" title="${scorersTooltip(t)}">${penMark(t)}<strong>${t.total}</strong></td>
   <td class="r muted">${t.bestPositions.slice(0, 10).join(' · ') || '—'}</td>`]);
  } else if (kind === 'st-owners') {
    const full = ownersAfter(roundNum);
    roundExport = { rows: full, filename: roundExportName(roundNum), cols: [
      ['#', o => o.rank], ['Номер', o => o.car], ['Пилоты', o => o.drivers.join(' · ')],
      ['Очки', o => o.total], ['Топ-5', o => o.top5.join(' · ')],
    ] };
    const prevPos = Object.fromEntries((prevRound ? ownersAfter(prevRound) : []).map(o => [o.car, o.rank]));
    head = '<th>Номер</th><th>Пилоты</th><th class="r">Очки</th><th class="r" title="Пять лучших финишей">Топ-5</th>';
    body = full.filter(o => roundHit(o.car, ...o.drivers))
      .map(o => [o.rank, deltaCell(prevPos[o.car], o.rank),
    `<td><strong>#${o.car}</strong></td>
   <td class="team-text">${o.drivers.sort().join(' · ')}</td>
   <td class="r"><strong>${o.total}</strong></td>
   <td class="r muted">${o.top5.join(' · ') || '—'}</td>`]);
  } else {
    const full = computeStandings(rowsNow);
    roundExport = { rows: full, filename: roundExportName(roundNum), cols: [
      ['#', s => s.rank], ['Гонщик', s => s.driver], ['Команда', s => s.team],
      ['Авт.', s => s.mfr], ['Очки', s => s.total], ['Победы', s => s.wins],
      ['Топ-5', s => s.bestPositions.slice(0, 5).join(' · ')],
    ] };
    const prevPos = Object.fromEntries(computeStandings(rowsPrev).map(s => [s.driver, s.rank]));
    head = '<th>Гонщик</th><th>Команда</th><th>Авт.</th><th class="r">Очки</th><th class="r">Победы</th>'
      + '<th class="r" title="Пять лучших финишей">Топ-5</th>';
    body = full.filter(s => roundHit(s.driver, s.team))
      .map(s => [s.rank, deltaCell(prevPos[s.driver], s.rank),
    `<td><strong class="driver-link" onclick="openDriver('${s.driver.replace(/'/g, "\\'").replace(/"/g, '&quot;')}')">${s.driver}</strong></td>
   <td class="team-text">${s.team}${coalMark(s.team)}</td>
   <td>${mfrBadge(s.mfr)}</td>
   <td class="r"><strong>${s.total}</strong></td>
   <td class="r">${s.wins > 0 ? `<strong class="win">${s.wins}</strong>` : '<span class="muted">—</span>'}</td>
   <td class="r muted">${s.bestPositions.slice(0, 5).join(' · ') || '—'}</td>`]);
  }

  const html = `<div class="table-scroll"><table class="standings-table" data-sort="auto"><thead><tr>
  <th class="r w-36">#</th>
  <th class="r" title="Изменение позиции к прошлому этапу">±</th>${head}
</tr></thead><tbody>` +
    body.map(([rank, delta, cells]) => `<tr class="${rank <= 3 ? 'rank-' + rank : ''}">
  <td class="r"><span class="pos-badge">${rank}</span></td>
  <td class="r">${delta}</td>${cells}
</tr>`).join('') +
    '</tbody></table></div>';

  document.getElementById('round-table').innerHTML = html;
}

function onRoundChange() {
  const val = document.getElementById('round-select').value;
  const roundNum = parseFloat(val);
  const name = state.roundNames[val] || val;
  const isRound1 = roundNum === 1;

  // Неизвестный вид (например, из старой ссылки) и дуэли вне первого этапа — назад к гонке
  if (!ROUND_VIEWS.includes(roundView)) roundView = 'race';
  if (!isRound1 && (roundView === 'duel1' || roundView === 'duel2')) roundView = 'race';
  renderRoundToggle(isRound1);
  writeHash();

  if (roundView.startsWith('st-')) {
    const titles = { 'st-drivers': 'Личный зачёт', 'st-teams': 'Командный зачёт', 'st-owners': 'Зачёт владельцев' };
    document.getElementById('round-table-title').textContent = `${titles[roundView]} после этапа — ${name}`;
    renderRoundStandings(roundView, roundNum);
    return;
  }
  if (roundView === 'metric-next') {
    document.getElementById('round-table-title').textContent = `Метрика на следующий этап — после этапа ${name}`;
    renderRoundMetric(roundNum);
    return;
  }

  const duelNum = roundView === 'duel1' ? 1.1 : roundView === 'duel2' ? 1.2 : null;

  /* Места по возрастанию; дисквалифицированному (места нет) место в протоколе не положено,
     но показать его надо там, где он был бы по очкам за прогноз: ставим прямо перед лучшим
     из тех, кого он обошёл. Считать «скольких обошёл» нельзя — после DQ в поле остаётся дыра
     (его место никому не отдают), и счёт разъезжается с номерами мест. Никого не обошёл —
     в конец. В квале по метрике очки наоборот: меньше — лучше. */
  const orderField = rows => {
    const metric = rows.every(r => DR_KEYS.every(k => r[k] == null));
    const beats = (a, b) => metric ? (a ?? Infinity) < (b ?? Infinity) : (a ?? -Infinity) > (b ?? -Infinity);
    const key = r => r['Pos.'] ?? Math.min(999, ...rows
      .filter(x => x['Pos.'] != null && beats(r['Points'], x['Points']))
      .map(x => x['Pos.'])) - 0.5;
    return rows.map(r => [key(r), r]).sort((a, b) => a[0] - b[0]).map(([, r]) => r);
  };
  const ofRound = (rows, n) => orderField(rows.filter(r => parseFloat(r['Round']) === n));

  const raceRows = ofRound(state.races.rows, roundNum);
  const duel1Rows = isRound1 ? ofRound(state.quals.rows, 1.1) : [];
  const duel2Rows = isRound1 ? ofRound(state.quals.rows, 1.2) : [];
  const duelRows = duelNum === 1.1 ? duel1Rows : duelNum === 1.2 ? duel2Rows : [];
  const qualRows = ofRound(state.quals.rows, roundNum);

  const hitRow = r => roundHit(r['Driver'], r['Team'], r['#']);
  const raceDrEmpty = raceRows.every(r => DR_KEYS.every(k => r[k] == null));
  const qualDrEmpty = qualRows.every(r => DR_KEYS.every(k => r[k] == null));


  // Цепочка отбора на Дейтоне: квала → любая дуэль → гонка. На обычном этапе
  // дуэльной стадии нет — квала красится по прямому попаданию в гонку, как и раньше.
  const raceDrivers = new Set(raceRows.map(r => r['Driver']));
  const duelDrivers = new Set([...duel1Rows, ...duel2Rows].map(r => r['Driver']));
  const qualPosFmt = (v, r) => {
    if (v == null) return DQ_MARK;
    const made = isRound1 ? duelDrivers.has(r['Driver']) : raceDrivers.has(r['Driver']);
    return `<span class="${made ? 'up' : 'down'}">${v}</span>`;
  };

  const driverQualPos = Object.fromEntries(
    qualRows.map(r => [r['Driver'], r['Pos.']])
  );

  if (roundView === 'race') {
    document.getElementById('round-table-title').textContent = `Гонка — ${name}`;
    const raceCols = [
      { key: 'Pos.', label: 'Поз.', cls: 'r', fmt: v => v == null ? DQ_MARK : v, minKey: 'Pos.' },
      {
        key: 'Driver', label: '±', cls: 'r', fmt: (v, r) => {
          const qp = driverQualPos[r['Driver']];
          const rp = r['Pos.'];
          if (qp == null || rp == null) return '<span class="muted">—</span>';
          // Поле квалы бывает больше поля гонки (эксибишены вроде Клэша) — тогда позиция
          // в квале не может быть дальше последнего реально стартовавшего места
          const effectiveQp = Math.min(qp, raceRows.length);
          const diff = effectiveQp - rp;
          if (diff === 0) return '<span class="muted">0</span>';
          
          return `<span class="${diff > 0 ? 'up' : 'down'}">${diff > 0 ? '+' : ''}${diff}</span>`;
        }
      },
      { key: '#', label: '#', cls: 'r' },
      { key: 'Driver', label: 'Пилот' },
      { key: 'Team', label: 'Команда', fmt: v => `<span class="team-text">${v || '—'}${coalMark(v)}</span>` },
      { key: 'M.', label: 'Авт.', fmt: v => mfrBadge(v) },
      { key: 'QL', label: 'QL', cls: 'r', fmt: v => v ?? '—', maxKey: 'QL' },
      { key: 'DR1', label: 'DR1', cls: 'r', fmt: v => v ?? '—', group: 'dr12', groupTop: 2 },
      { key: 'DR2', label: 'DR2', cls: 'r', fmt: v => v ?? '—', group: 'dr12', groupTop: 2 },
      { key: 'DR3', label: 'DR3', cls: 'r', fmt: v => v ?? '—', maxKey: 'DR3' },
      { key: 'DR4', label: 'DR4', cls: 'r', fmt: v => v ?? '—', maxKey: 'DR4' },
      { key: 'CAU', label: 'CAU', cls: 'r', fmt: v => v ?? '—', maxKey: 'CAU' },
      { key: 'RET', label: 'RET', cls: 'r', fmt: v => v ?? '—', maxKey: 'RET' },
      { key: 'MN', label: 'MN', cls: 'r', fmt: v => v ?? '—', maxKey: 'MN' },
      { key: 'Points', label: 'Очки', cls: 'r', fmt: v => `<strong>${v ?? '—'}</strong>`, ...(raceDrEmpty ? { minKey: 'Points' } : { maxKey: 'Points' }) },
      { key: 'Pos.', label: 'NASCAR', cls: 'r', fmt: (v, r) => `<strong class="nascar-pts">${scorePts(r['Pos.'], roundNum)}</strong>` },
    ];
    roundExport = { rows: raceRows, filename: roundExportName(roundNum), cols: raceCols.filter(c => c.label !== 'NASCAR') };
    renderRoundTable('round-table', raceRows.filter(hitRow), raceCols, raceRows);
  } else if (roundView === 'duel1' || roundView === 'duel2') {
    const duelLabel = roundView === 'duel1' ? 'Дуэль 1' : 'Дуэль 2';
    document.getElementById('round-table-title').textContent = `${duelLabel} — ${name}`;
    const duelPosFmt = (v, r) => {
      if (v == null) return DQ_MARK;
      const made = raceDrivers.has(r['Driver']);
      return `<span class="${made ? 'up' : 'down'}">${v}</span>`;
    };
    const duelDrEmpty = duelRows.every(r => DR_KEYS.every(k => r[k] == null));
    const duelCols = [
      { key: 'Pos.', label: 'Поз.', cls: 'r', fmt: duelPosFmt },
      { key: '#', label: '#', cls: 'r' },
      { key: 'Driver', label: 'Пилот' },
      { key: 'Team', label: 'Команда', fmt: v => `<span class="team-text">${v || '—'}${coalMark(v)}</span>` },
      { key: 'M.', label: 'Авт.', fmt: v => mfrBadge(v) },
      { key: 'DR1', label: 'DR1', cls: 'r', fmt: v => v ?? '—', group: 'dr12', groupTop: 2 },
      { key: 'DR2', label: 'DR2', cls: 'r', fmt: v => v ?? '—', group: 'dr12', groupTop: 2 },
      { key: 'DR3', label: 'DR3', cls: 'r', fmt: v => v ?? '—', maxKey: 'DR3' },
      { key: 'DR4', label: 'DR4', cls: 'r', fmt: v => v ?? '—', maxKey: 'DR4' },
      { key: 'Points', label: 'Очки', cls: 'r', fmt: v => `<strong>${v ?? '—'}</strong>`, ...(duelDrEmpty ? { minKey: 'Points' } : { maxKey: 'Points' }) },
      { key: 'Pos.', label: 'NASCAR', cls: 'r', fmt: (v, r) => `<strong class="nascar-pts">${scorePts(r['Pos.'], duelNum)}</strong>` },
    ];
    roundExport = { rows: duelRows, filename: roundExportName(roundNum), cols: duelCols.filter(c => c.label !== 'NASCAR') };
    renderRoundTable('round-table', duelRows.filter(hitRow), duelCols, duelRows);
  } else {
    document.getElementById('round-table-title').textContent = `Квалификация — ${name}`;
    const qualCols = [
      { key: 'Pos.', label: 'Поз.', cls: 'r', fmt: qualPosFmt },
      { key: '#', label: '#', cls: 'r' },
      { key: 'Driver', label: 'Пилот' },
      { key: 'Team', label: 'Команда', fmt: v => `<span class="team-text">${v || '—'}${coalMark(v)}</span>` },
      { key: 'M.', label: 'Авт.', fmt: v => mfrBadge(v) },
      { key: 'DR1', label: 'DR1', cls: 'r', fmt: v => v ?? '—', group: 'dr12', groupTop: 2 },
      { key: 'DR2', label: 'DR2', cls: 'r', fmt: v => v ?? '—', group: 'dr12', groupTop: 2 },
      { key: 'DR3', label: 'DR3', cls: 'r', fmt: v => v ?? '—', maxKey: 'DR3' },
      { key: 'DR4', label: 'DR4', cls: 'r', fmt: v => v ?? '—', maxKey: 'DR4' },
      { key: 'Points', label: 'Очки', cls: 'r', fmt: v => `<strong>${v ?? '—'}</strong>`, ...(qualDrEmpty ? { minKey: 'Points' } : { maxKey: 'Points' }) },
      { key: 'Pos.', label: 'NASCAR', cls: 'r', fmt: (v, r) => `<strong class="nascar-pts">${scorePts(r['Pos.'], roundNum)}</strong>` },
    ];
    roundExport = { rows: qualRows, filename: roundExportName(roundNum), cols: qualCols.filter(c => c.label !== 'NASCAR') };
    renderRoundTable('round-table', qualRows.filter(hitRow), qualCols, qualRows);
  }
}

function initRoundView() {
  const sel = document.getElementById('round-select');
  // Список этапов для просмотра протокола — по «сырым» строкам, а не state.*.rounds:
  // тот уже без этапа 0 (незачётный), но его протокол смотреть можно и нужно
  const existingRounds = new Set([
    ...uniqueRounds(state.races.rows).map(String),
    ...uniqueRounds(state.quals.rows).map(String),
  ]);
  // календарь приезжает в сводке сезона (state.roundNames), протоколы — по требованию
  const options = Object.keys(state.roundNames)
    .map(Number)
    .filter(n => existingRounds.has(String(n)) && n !== 1.1 && n !== 1.2)
    .sort((a, b) => a - b)
    .map(n => `<option value="${n}">${state.roundNames[String(n)]}</option>`);
  sel.innerHTML = options.join('');
  if (options.length) onRoundChange();
}


  return {
    state, DIVISIONS, SPRINT_ROUNDS, CHASE_START, DR_KEYS,
    scorePts, renumber, uniqueRounds, avgPos, qualEligible, buildPlayoffSet,
    computeTeamOf, computeCarOf, computeStandings, computeChaseStandings,
    computeTeamStandings, computeOwnerStandings, computeChaseOwnerStandings,
    computeGolub, computeEntries, computeGains, buildPivotData,
    entriesRows, entriesRounds, metricChampRanks, computeNextMetric,
    teamStats, factByTeamRound, planByTeam, raceTeamByRound, rankBy,
    isGuestDriver, roundFullName, roundLabel, fmtRoundNum,
  };
}
