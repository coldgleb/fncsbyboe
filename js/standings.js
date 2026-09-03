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
      driver: d, team: teamOf(d), car: r['#'] || '—', mfr: r['M.'] || '',
      isGuest: isGuestDriver(d),
      total: 0, sheetPts: 0, best: Infinity,
      wins: 0, firstWin: Infinity, posCounts: {}, roundPts: {},
      posSum: 0, finishes: 0, top5: 0, top10: 0, positions: []
    };
    const s = map[d];
    const pts = scorePts(r['Pos.'], r['Round']);
    s.total += pts;
    if (r['Round'] !== 0) s.sheetPts += r['Points'] || 0;
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

  return renumber(Object.values(map).sort(standingsCmp)
    .map(s => ({ ...s, bestPositions: [...s.positions].sort((a, b) => a - b) })));
}

function uniqueRounds(rows) {
  return [...new Set(rows.map(r => r['Round']).filter(x => x != null))].sort((a, b) => a - b);
}

/* ── Командный зачёт: сумма очков двух лучших представителей команды за этап (п. 9.7).
   withGuestOnly — вернуть и команды из одних гостей: в зачёте их нет (место = null),
   но в сводных по этапам они показываются. ── */
function computeTeamStandings(rows, withGuestOnly = false) {
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
    // Штраф с листа Deductions уже сидит в total — по нему и место, и всё, что показывается
    const ded = state.deductions?.[t.team];
    const penalty = ded?.pts || 0;
    return {
      team: t.team, total: total - penalty, penalty, penaltyReason: ded?.reason || '',
      roundPts, roundBest, scorers, drivers: [...t.drivers],
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
      car, total: 0, wins: 0, firstWin: Infinity,
      best: Infinity, posCounts: {}, positions: [], drivers: new Set()
    };
    const o = map[car];
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
    .map((o, i) => ({
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

  const merged = base.map(s => {
    const sd = seeds[s.driver];
    if (!sd) return s;
    const p = postMap[s.driver] || {};
    return { ...s, ...p, driver: s.driver, total: sd.points + (p.total || 0), chaseSeed: sd.seed };
  }).sort(standingsCmp);

  return renumber(merged.map(s => ({ ...s, bestPositions: [...s.positions].sort((a, b) => a - b) })));
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

function avgPos(s) {
  return s.finishes ? (s.posSum / s.finishes).toFixed(1) : '—';
}
