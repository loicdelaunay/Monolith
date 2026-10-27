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
  {
    version: 2,
    name: 'conversation-workflow',
    sql: /* sql */ `
      ALTER TABLE conversations ADD COLUMN draft_attachments_json TEXT NOT NULL DEFAULT '[]';
      ALTER TABLE conversations ADD COLUMN forked_from_conversation_id INTEGER;
      ALTER TABLE conversations ADD COLUMN forked_from_message_id INTEGER;
      ALTER TABLE messages ADD COLUMN meta_json TEXT;

      -- Pièces jointes : contenu dans workspace/attachments/<sha256>, métadonnées ici.
      CREATE TABLE attachments (
        id INTEGER PRIMARY KEY,
        sha256 TEXT NOT NULL,
        name TEXT NOT NULL,
        mime TEXT NOT NULL,
        size INTEGER NOT NULL,
        kind TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE INDEX attachments_sha ON attachments(sha256);

      -- File d'attente et instructions transmises pendant une génération.
      CREATE TABLE queued_inputs (
        id INTEGER PRIMARY KEY,
        conversation_id INTEGER NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
        kind TEXT NOT NULL,
        text TEXT NOT NULL,
        attachments_json TEXT NOT NULL DEFAULT '[]',
        sort_order REAL NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE INDEX queued_inputs_conv ON queued_inputs(conversation_id, kind, sort_order);

      CREATE TABLE templates (
        id INTEGER PRIMARY KEY,
        name TEXT NOT NULL,
        content TEXT NOT NULL,
        sort_order REAL NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      -- Compactage : résumé des messages jusqu'à up_to_seq ; l'historique original est conservé.
      CREATE TABLE compactions (
        id INTEGER PRIMARY KEY,
        conversation_id INTEGER NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
        up_to_seq INTEGER NOT NULL,
        summary TEXT NOT NULL,
        model TEXT NOT NULL,
        estimated_tokens_before INTEGER,
        trigger TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE INDEX compactions_conv ON compactions(conversation_id, up_to_seq);
    `,
  },
  {
    version: 3,
    name: 'tools-and-permissions',
    sql: /* sql */ `
      ALTER TABLE conversations ADD COLUMN resources_mode TEXT NOT NULL DEFAULT 'inherit';

      CREATE TABLE conversation_resources (
        id INTEGER PRIMARY KEY,
        conversation_id INTEGER NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
        kind TEXT NOT NULL,
        path TEXT NOT NULL,
        created_at TEXT NOT NULL,
        UNIQUE (conversation_id, kind, path)
      );

      CREATE TABLE permission_rules (
        id INTEGER PRIMARY KEY,
        scope TEXT NOT NULL,
        project_id INTEGER REFERENCES projects(id) ON DELETE CASCADE,
        conversation_id INTEGER REFERENCES conversations(id) ON DELETE CASCADE,
        tool TEXT NOT NULL DEFAULT '*',
        family TEXT NOT NULL DEFAULT '*',
        resource TEXT NOT NULL DEFAULT '',
        decision TEXT NOT NULL,
        origin TEXT NOT NULL DEFAULT 'user',
        created_at TEXT NOT NULL
      );

      -- Historique explicite des décisions d'autorisation.
      CREATE TABLE permission_decisions (
        id INTEGER PRIMARY KEY,
        conversation_id INTEGER,
        tool TEXT NOT NULL,
        target TEXT,
        decision TEXT NOT NULL,
        source TEXT NOT NULL,
        rule_id INTEGER,
        scope TEXT,
        reason TEXT NOT NULL DEFAULT '',
        created_at TEXT NOT NULL
      );
      CREATE INDEX permission_decisions_conv ON permission_decisions(conversation_id, id);

      -- Mode Proposition : changements préparés, appliqués seulement après validation.
      CREATE TABLE file_proposals (
        id INTEGER PRIMARY KEY,
        conversation_id INTEGER NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
        message_id INTEGER NOT NULL,
        call_id TEXT NOT NULL,
        path TEXT NOT NULL,
        status TEXT NOT NULL,
        change_json TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
    `,
  },
  {
    version: 4,
    name: 'memory-rag-mcp',
    sql: /* sql */ `
      -- Mémoire : portée conversation / projet / générale / utilisateur, versions et provenance.
      CREATE TABLE memories (
        id INTEGER PRIMARY KEY,
        scope TEXT NOT NULL,
        project_id INTEGER REFERENCES projects(id) ON DELETE CASCADE,
        conversation_id INTEGER REFERENCES conversations(id) ON DELETE CASCADE,
        title TEXT NOT NULL,
        content TEXT NOT NULL,
        tags TEXT NOT NULL DEFAULT '',
        source TEXT NOT NULL,
        source_conversation_id INTEGER,
        source_message_id INTEGER,
        version INTEGER NOT NULL DEFAULT 1,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX memories_scope ON memories(scope, project_id, conversation_id);
      CREATE VIRTUAL TABLE memories_fts USING fts5(title, content, tags, content='memories', content_rowid='id', tokenize='unicode61 remove_diacritics 2');
      CREATE TRIGGER memories_ai AFTER INSERT ON memories BEGIN
        INSERT INTO memories_fts(rowid, title, content, tags) VALUES (new.id, new.title, new.content, new.tags);
      END;
      CREATE TRIGGER memories_ad AFTER DELETE ON memories BEGIN
        INSERT INTO memories_fts(memories_fts, rowid, title, content, tags) VALUES ('delete', old.id, old.title, old.content, old.tags);
      END;
      CREATE TRIGGER memories_au AFTER UPDATE ON memories BEGIN
        INSERT INTO memories_fts(memories_fts, rowid, title, content, tags) VALUES ('delete', old.id, old.title, old.content, old.tags);
        INSERT INTO memories_fts(rowid, title, content, tags) VALUES (new.id, new.title, new.content, new.tags);
      END;
      CREATE TABLE memory_versions (
        id INTEGER PRIMARY KEY,
        memory_id INTEGER NOT NULL REFERENCES memories(id) ON DELETE CASCADE,
        version INTEGER NOT NULL,
        title TEXT NOT NULL,
        content TEXT NOT NULL,
        tags TEXT NOT NULL,
        source TEXT NOT NULL,
        created_at TEXT NOT NULL
      );

      -- RAG : sources indexées (empreinte pour détecter un index périmé) et fragments.
      CREATE TABLE rag_sources (
        id INTEGER PRIMARY KEY,
        root TEXT NOT NULL,
        path TEXT NOT NULL,
        size INTEGER NOT NULL,
        mtime_ms INTEGER NOT NULL,
        sha256 TEXT NOT NULL,
        embedding_model TEXT,
        indexed_at TEXT NOT NULL,
        UNIQUE (root, path)
      );
      CREATE TABLE rag_chunks (
        id INTEGER PRIMARY KEY,
        source_id INTEGER NOT NULL REFERENCES rag_sources(id) ON DELETE CASCADE,
        ord INTEGER NOT NULL,
        start_line INTEGER NOT NULL,
        end_line INTEGER NOT NULL,
        text TEXT NOT NULL,
        embedding BLOB
      );
      CREATE INDEX rag_chunks_source ON rag_chunks(source_id, ord);
      CREATE VIRTUAL TABLE rag_fts USING fts5(text, content='rag_chunks', content_rowid='id', tokenize='unicode61 remove_diacritics 2');
      CREATE TRIGGER rag_chunks_ai AFTER INSERT ON rag_chunks BEGIN
        INSERT INTO rag_fts(rowid, text) VALUES (new.id, new.text);
      END;
      CREATE TRIGGER rag_chunks_ad AFTER DELETE ON rag_chunks BEGIN
        INSERT INTO rag_fts(rag_fts, rowid, text) VALUES ('delete', old.id, old.text);
      END;

      -- MCP : serveurs (configuration non secrète ; secrets dans la table secrets) et activation par conversation.
      CREATE TABLE mcp_servers (
        id INTEGER PRIMARY KEY,
        name TEXT NOT NULL UNIQUE,
        transport TEXT NOT NULL,
        config_json TEXT NOT NULL,
        enabled INTEGER NOT NULL DEFAULT 1,
        sort_order INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE mcp_conversation (
        conversation_id INTEGER NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
        server_id INTEGER NOT NULL REFERENCES mcp_servers(id) ON DELETE CASCADE,
        enabled INTEGER NOT NULL,
        PRIMARY KEY (conversation_id, server_id)
      );
    `,
  },
  {
    version: 5,
    name: 'subagents',
    sql: /* sql */ `
      -- Sous-agents : conversations enfants (profondeur, rôle, budget).
      ALTER TABLE conversations ADD COLUMN parent_id INTEGER REFERENCES conversations(id) ON DELETE CASCADE;
      ALTER TABLE conversations ADD COLUMN depth INTEGER NOT NULL DEFAULT 0;
      ALTER TABLE conversations ADD COLUMN role TEXT;
      ALTER TABLE conversations ADD COLUMN budget_json TEXT;
      CREATE INDEX conversations_parent ON conversations(parent_id);
    `,
  },
];

export const SCHEMA_VERSION = MIGRATIONS[MIGRATIONS.length - 1]!.version;
