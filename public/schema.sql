-- Схема БД проекта (PostgreSQL). Сервер выполняет этот файл при каждом старте — он безопасен для повторного запуска.

-- Пользователи и баланс
CREATE TABLE IF NOT EXISTS users (
  id         BIGINT PRIMARY KEY,                 -- Telegram ID
  name       TEXT NOT NULL DEFAULT '',
  photo      TEXT NOT NULL DEFAULT '',
  stars      NUMERIC(14,2) NOT NULL DEFAULT 0 CHECK (stars >= 0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS users_stars_idx ON users (stars DESC) WHERE stars > 0;  -- таблица лидеров

-- Задания, которые добавляет админ
CREATE TABLE IF NOT EXISTS tasks (
  id         TEXT PRIMARY KEY,
  pos        BIGSERIAL,                          -- порядок показа
  title      TEXT NOT NULL,
  url        TEXT NOT NULL,
  reward     NUMERIC(10,2) NOT NULL CHECK (reward > 0),
  icon       TEXT NOT NULL DEFAULT '',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Прогресс пользователя по своим заданиям: нажал «Начать» (started_at) / выполнил (done_at)
CREATE TABLE IF NOT EXISTS user_tasks (
  user_id    BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  task_id    TEXT   NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  started_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  done_at    TIMESTAMPTZ,
  PRIMARY KEY (user_id, task_id)
);

-- Партнёрские офферы Tgrass: pending — показали, done — награда выдана
CREATE TABLE IF NOT EXISTS tgrass_offers (
  user_id  BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  offer_id TEXT   NOT NULL,
  status   TEXT   NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','done')),
  done_at  TIMESTAMPTZ,
  PRIMARY KEY (user_id, offer_id)
);

-- Журнал всех изменений баланса (для разбора споров и будущих игр: ставки, выигрыши, кейсы)
CREATE TABLE IF NOT EXISTS stars_log (
  id         BIGSERIAL PRIMARY KEY,
  user_id    BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  delta      NUMERIC(14,2) NOT NULL,
  reason     TEXT NOT NULL,                      -- 'task', 'tgrass', 'bet', 'win', 'case' ...
  ref        TEXT,                               -- id задания/игры/кейса
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS stars_log_user_idx ON stars_log (user_id, created_at DESC);

-- Служебные значения (например, конец недельного цикла лидеров)
CREATE TABLE IF NOT EXISTS meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
