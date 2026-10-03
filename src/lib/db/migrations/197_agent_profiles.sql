CREATE TABLE IF NOT EXISTS agent_profiles (
  id TEXT PRIMARY KEY,
  slug TEXT NOT NULL UNIQUE COLLATE NOCASE,
  data TEXT NOT NULL CHECK(json_valid(data)),
  combo_id TEXT REFERENCES combos(id) ON DELETE SET NULL,
  enabled INTEGER NOT NULL DEFAULT 1 CHECK(enabled IN (0, 1)),
  revision INTEGER NOT NULL DEFAULT 1 CHECK(revision > 0),
  deleted_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_agent_profiles_combo ON agent_profiles(combo_id);
CREATE TABLE IF NOT EXISTS agent_profile_aliases (
  alias TEXT PRIMARY KEY COLLATE NOCASE,
  profile_id TEXT NOT NULL REFERENCES agent_profiles(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_agent_profile_aliases_profile ON agent_profile_aliases(profile_id);
CREATE TRIGGER IF NOT EXISTS agent_alias_collision
BEFORE INSERT ON agent_profile_aliases
WHEN EXISTS (
 SELECT 1 FROM combos WHERE
 lower(id) = lower(NEW.alias) OR lower(name) = lower(NEW.alias) OR
 lower(json_extract(data, '$.name')) = lower(NEW.alias) OR
 lower(trim(substr(json_extract(data, '$.name'), 1, instr(json_extract(data, '$.name'), '[') - 1))) = lower(NEW.alias) OR
 lower(trim(substr(name, 1, instr(name, '[') - 1))) = lower(NEW.alias)
)
BEGIN SELECT RAISE(ABORT, 'Agent alias conflicts with an existing combo'); END;
CREATE TRIGGER IF NOT EXISTS combo_agent_alias_insert
BEFORE INSERT ON combos
WHEN EXISTS (
 SELECT 1 FROM agent_profile_aliases WHERE
 lower(alias) = lower(NEW.id) OR lower(alias) = lower(NEW.name) OR
 lower(alias) = lower(json_extract(NEW.data, '$.name')) OR
 lower(alias) = lower(trim(substr(json_extract(NEW.data, '$.name'), 1, instr(json_extract(NEW.data, '$.name'), '[') - 1))) OR
 lower(alias) = lower(trim(substr(NEW.name, 1, instr(NEW.name, '[') - 1)))
)
BEGIN SELECT RAISE(ABORT, 'Combo conflicts with an existing agent alias'); END;
CREATE TRIGGER IF NOT EXISTS combo_agent_alias_update
BEFORE UPDATE OF id, name, data ON combos
WHEN EXISTS (
 SELECT 1 FROM agent_profile_aliases WHERE
 lower(alias) = lower(NEW.id) OR lower(alias) = lower(NEW.name) OR
 lower(alias) = lower(json_extract(NEW.data, '$.name')) OR
 lower(alias) = lower(trim(substr(json_extract(NEW.data, '$.name'), 1, instr(json_extract(NEW.data, '$.name'), '[') - 1))) OR
 lower(alias) = lower(trim(substr(NEW.name, 1, instr(NEW.name, '[') - 1)))
)
BEGIN SELECT RAISE(ABORT, 'Combo conflicts with an existing agent alias'); END;
