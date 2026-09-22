-- Схема базы Cloudflare D1 "fncsbyboe" (id 7af83f48-9ca9-4760-af85-d64c407a7f6d).
-- Накатывается целиком: npx wrangler d1 execute fncsbyboe --remote --file=cloud/schema.sql
-- Данные заливает cloud/data.sql, который собирает cloud/build-sql.js из Google Sheets.

DROP TABLE IF EXISTS sheets;            -- сырые JSON-дампы листов больше не нужны

DROP TABLE IF EXISTS division_changes;
DROP TABLE IF EXISTS deductions;
DROP TABLE IF EXISTS entries;
DROP TABLE IF EXISTS results;
DROP TABLE IF EXISTS rounds;
DROP TABLE IF EXISTS manufacturers;
DROP TABLE IF EXISTS cars;
DROP TABLE IF EXISTS teams;
DROP TABLE IF EXISTS participants;

-- Участник — человек, а не строка протокола: метка «(i)» (гость в этом дивизионе)
-- живёт в results.is_guest, потому что зависит от дивизиона и этапа
CREATE TABLE participants (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  name         TEXT NOT NULL UNIQUE,
  in_og_squad  INTEGER NOT NULL DEFAULT 0   -- лист OG Squad
);

CREATE TABLE teams (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  name          TEXT NOT NULL UNIQUE,
  is_coalition  INTEGER NOT NULL DEFAULT 0  -- лист Open Coalition Teams
);

-- Списки машин у дивизионов свои: номер «19» в Open и в Star — разные машины
CREATE TABLE cars (
  id        INTEGER PRIMARY KEY AUTOINCREMENT,
  season    INTEGER NOT NULL,
  division  TEXT NOT NULL,                  -- 'open' | 'star'
  number    TEXT NOT NULL,                  -- '06', '0', '44' — ведущий ноль значим
  UNIQUE (season, division, number)
);

CREATE TABLE manufacturers (
  id    INTEGER PRIMARY KEY AUTOINCREMENT,
  name  TEXT NOT NULL UNIQUE                -- Ford, Toyota, Chevrolet
);

-- Календарь. Дуэли идут отдельными записями (этапы 1.1 и 1.2 в листе)
CREATE TABLE rounds (
  season  INTEGER NOT NULL,
  round   INTEGER NOT NULL,                 -- 0..36
  duel    INTEGER,                          -- 1|2 у дуэлей, иначе NULL
  abbr    TEXT,                             -- DAY, ATL… (повторяется у разных этапов)
  name    TEXT,
  PRIMARY KEY (season, round, duel)
);

-- Одна таблица на оба дивизиона и на квалификации с гонками.
-- Колонка листа с проверкой TRUE/FALSE не переносится.
CREATE TABLE results (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  season           INTEGER NOT NULL,
  division         TEXT NOT NULL,           -- 'open' | 'star'
  session          TEXT NOT NULL,           -- 'race' | 'qual'
  round            INTEGER NOT NULL,
  duel             INTEGER,                 -- 1|2 (этапы 1.1 / 1.2), иначе NULL
  pos              INTEGER,                 -- NULL = дисквалификация
  participant_id   INTEGER NOT NULL REFERENCES participants(id),
  is_guest         INTEGER NOT NULL DEFAULT 0,      -- метка «(i)» в этой строке
  team_id          INTEGER REFERENCES teams(id),
  car_id           INTEGER REFERENCES cars(id),     -- NULL для номера «-» у гостей
  manufacturer_id  INTEGER REFERENCES manufacturers(id),
  ql               INTEGER,
  dr1 INTEGER, dr2 INTEGER, dr3 INTEGER, dr4 INTEGER,
  cau INTEGER, ret INTEGER, mn INTEGER,     -- только гонки
  due INTEGER,                              -- только Star
  points           REAL,                    -- дробные у квалификаций по метрике
  UNIQUE (season, division, session, round, duel, participant_id)
);
CREATE INDEX results_round ON results (season, division, session, round);
CREATE INDEX results_participant ON results (participant_id);

-- Заявочный список: строка есть — машина заявлена на этап
CREATE TABLE entries (
  season   INTEGER NOT NULL,
  car_id   INTEGER NOT NULL REFERENCES cars(id),
  team_id  INTEGER NOT NULL REFERENCES teams(id),
  round    INTEGER NOT NULL,
  PRIMARY KEY (season, car_id, round)
);

CREATE TABLE deductions (
  id       INTEGER PRIMARY KEY AUTOINCREMENT,
  season   INTEGER NOT NULL,
  team_id  INTEGER NOT NULL REFERENCES teams(id),
  points   INTEGER NOT NULL,
  reason   TEXT,
  round    INTEGER                          -- NULL = штраф на весь сезон
);

-- Смена дивизиона в течение сезона (лист Changes): в дивизионе «откуда» пилот — гость
CREATE TABLE division_changes (
  season          INTEGER NOT NULL,
  participant_id  INTEGER NOT NULL REFERENCES participants(id),
  from_division   TEXT NOT NULL,
  to_division     TEXT NOT NULL,
  PRIMARY KEY (season, participant_id)
);
