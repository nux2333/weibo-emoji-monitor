'use strict';

/*
 * PostgreSQL compatibility bridge intentionally translates SQLite
 * CURRENT_TIMESTAMP to timestamp text. comment_assistant_history is a small
 * cross-database bookkeeping table, so keep commented_at as TEXT as well.
 * Patch only this table's CREATE statement before index-http initializes it.
 */
try {
  const { DatabaseSync } = require('node:sqlite');
  const originalExec = DatabaseSync?.prototype?.exec;
  if (typeof originalExec === 'function') {
    DatabaseSync.prototype.exec = function commentAssistantCompatibleExec(sql) {
      let compatibleSql = String(sql || '');
      if (/CREATE\s+TABLE\s+IF\s+NOT\s+EXISTS\s+comment_assistant_history/i.test(compatibleSql)) {
        compatibleSql = compatibleSql.replace(
          /commented_at\s+TIMESTAMP\s+NOT\s+NULL\s+DEFAULT\s+CURRENT_TIMESTAMP/i,
          'commented_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP'
        );
      }
      return originalExec.call(this, compatibleSql);
    };
  }
} catch {}

require('./index-http');
