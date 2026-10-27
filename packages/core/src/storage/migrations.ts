/**
 * Migrations du schéma. Règles :
 *  - ne JAMAIS modifier une migration publiée (sa somme SHA-256 est vérifiée au démarrage) ;
 *  - ajouter une nouvelle entrée avec la version suivante ;
 *  - chaque migration est appliquée dans une transaction, après une sauvegarde de la base.
 */
export interface Migration {
  version: number;
  name: string;
  sql: string;
}

export const MIGRATIONS: Migration[] = [
  {
    version: 1,
    name: 'initial',
    sql: /* sql */ `
      CREATE TABLE settings (
        key TEXT PRIMARY KEY,
        value_json TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE secrets (
        id TEXT PRIMARY KEY,
        iv BLOB NOT NULL,
        tag BLOB NOT NULL,
        ciphertext BLOB NOT NULL,
        hint TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE projects (
        id INTEGER PRIMARY KEY,
        name TEXT NOT NULL,
        icon TEXT NOT NULL DEFAULT 'folder',
        color TEXT NOT NULL DEFAULT '',
        instructions TEXT NOT NULL DEFAULT '',
        sort_order REAL NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE project_folders (
        id INTEGER PRIMARY KEY,
        project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        path TEXT NOT NULL,
        label TEXT NOT NULL DEFAULT '',
        sort_order REAL NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL,
        UNIQUE (project_id, path)
      );

      CREATE TABLE providers (
        id INTEGER PRIMARY KEY,
        name TEXT NOT NULL,
        kind TEXT NOT NULL,
        preset TEXT NOT NULL,
        base_url TEXT NOT NULL DEFAULT '',
        secret_id TEXT REFERENCES secrets(id) ON DELETE SET NULL,
        options_json TEXT NOT NULL DEFAULT '{}',
        enabled INTEGER NOT NULL DEFAULT 1,
        sort_order REAL NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE provider_models (
        provider_id INTEGER NOT NULL REFERENCES providers(id) ON DELETE CASCADE,
        model_id TEXT NOT NULL,
        label TEXT NOT NULL DEFAULT '',
        enabled INTEGER NOT NULL DEFAULT 1,
        context_window INTEGER,
        max_output_tokens INTEGER,
        source TEXT NOT NULL DEFAULT 'manual',
        capabilities_json TEXT NOT NULL DEFAULT '{}',
        sort_order REAL NOT NULL DEFAULT 0,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (provider_id, model_id)
      );

      CREATE TABLE conversations (
        id INTEGER PRIMARY KEY,
        project_id INTEGER REFERENCES projects(id) ON DELETE CASCADE,
        title TEXT NOT NULL,
        title_source TEXT NOT NULL DEFAULT 'default',
        favorite INTEGER NOT NULL DEFAULT 0,
        pinned INTEGER NOT NULL DEFAULT 0,
        archived INTEGER NOT NULL DEFAULT 0,
        sort_order REAL NOT NULL DEFAULT 0,
        goal TEXT NOT NULL DEFAULT '',
        mode TEXT NOT NULL DEFAULT 'chat',
        agent_mode TEXT NOT NULL DEFAULT 'plan',
        provider_id INTEGER REFERENCES providers(id) ON DELETE SET NULL,
        model TEXT,
        reasoning_level TEXT NOT NULL DEFAULT 'auto',
        draft TEXT NOT NULL DEFAULT '',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        last_message_at TEXT
      );
      CREATE INDEX conversations_project ON conversations(project_id, archived, sort_order);

      CREATE TABLE messages (
        id INTEGER PRIMARY KEY,
        conversation_id INTEGER NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
        seq INTEGER NOT NULL,
        role TEXT NOT NULL,
        status TEXT NOT NULL,
        parts_json TEXT NOT NULL DEFAULT '[]',
        text TEXT NOT NULL DEFAULT '',
        snapshot_json TEXT,
        usage_json TEXT,
        error_json TEXT,
        created_at TEXT NOT NULL,
        completed_at TEXT,
        duration_ms INTEGER,
        first_token_ms INTEGER,
        UNIQUE (conversation_id, seq)
      );

      CREATE VIRTUAL TABLE messages_fts USING fts5(text, content='messages', content_rowid='id', tokenize='unicode61 remove_diacritics 2');
      CREATE TRIGGER messages_ai AFTER INSERT ON messages BEGIN
        INSERT INTO messages_fts(rowid, text) VALUES (new.id, new.text);
      END;
      CREATE TRIGGER messages_ad AFTER DELETE ON messages BEGIN
        INSERT INTO messages_fts(messages_fts, rowid, text) VALUES ('delete', old.id, old.text);
      END;
      CREATE TRIGGER messages_au AFTER UPDATE OF text ON messages BEGIN
        INSERT INTO messages_fts(messages_fts, rowid, text) VALUES ('delete', old.id, old.text);
        INSERT INTO messages_fts(rowid, text) VALUES (new.id, new.text);
      END;

      CREATE TABLE usage (
        id INTEGER PRIMARY KEY,
        kind TEXT NOT NULL,
        conversation_id INTEGER,
        project_id INTEGER,
        provider_id INTEGER,
        provider_name TEXT NOT NULL,
        model TEXT NOT NULL,
        started_at TEXT NOT NULL,
        finished_at TEXT,
        first_token_ms INTEGER,
        input_tokens INTEGER,
        output_tokens INTEGER,
        cached_input_tokens INTEGER,
        reasoning_tokens INTEGER,
        estimated INTEGER NOT NULL DEFAULT 0,
        status TEXT NOT NULL
      );
      CREATE INDEX usage_started ON usage(started_at);
    `,
  },
];

export const SCHEMA_VERSION = MIGRATIONS[MIGRATIONS.length - 1]!.version;
