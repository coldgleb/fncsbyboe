/* Эталон расчётов: node db/reference/build.js → db/reference/logic.gen.js

   Это замороженная копия JS-логики сайта на момент переноса правил в PostgreSQL
   (файлы рядом — как они были в js/). Сайт её больше не использует: все таблицы
   считает схема api. Эталон нужен двум проверкам:
     - db/verify.mjs сверяет SQL-функции с ним на всех этапах и дивизионах;
     - test.js проверяет на нём правила регламента (DQ, штрафы, Чейз, метрика).
   Правило меняется — меняется и SQL, и эталон, и сверка снова должна дать ноль. */

const fs = require('fs');
const path = require('path');

const DIR = __dirname;
const SOURCES = ['standings.js', 'drivers.js', 'teams.js', 'entries.js', 'golub.js', 'rounds.js'];
const OUT = path.join(DIR, 'logic.gen.js');

// из core.js — только конфиг и хелперы до загрузки листов, дальше браузерная часть
const core = fs.readFileSync(path.join(DIR, 'core.js'), 'utf8');
const coreHead = core.slice(0, core.indexOf('/* ── Кэш листов в браузере ──'));
const coreTail = core.slice(core.indexOf('/* ── Round view ── */'), core.indexOf('/* ── Сортировка по клику'));
const parts = SOURCES.map(f => `// ── ${f} ──\n${fs.readFileSync(path.join(DIR, f), 'utf8')}`);

const bundle = `// СГЕНЕРИРОВАНО db/reference/build.js из db/reference/*.js — руками не править.

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

${coreHead}
${coreTail}
${parts.join('\n')}

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
`;
fs.writeFileSync(OUT, bundle, 'utf8');
// Браузерная копия: сайт считает зачёты тем же кодом, только без ES-модуля
fs.writeFileSync(path.join(DIR, '../../js/logic.gen.js'),
  bundle.replace('export function makeLogic()', 'function makeLogic()'), 'utf8');
console.log(`${OUT} — ${(bundle.length / 1024).toFixed(0)} КБ`);
