const Database = require('better-sqlite3');
const { v4: uuidv4 } = require('uuid');
const path = require('path');

const db = new Database(path.join(__dirname, 'chats.db'));

db.exec(`
  CREATE TABLE IF NOT EXISTS conversations (
    id TEXT PRIMARY KEY,
    title TEXT NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS messages (
    id TEXT PRIMARY KEY,
    conversation_id TEXT NOT NULL,
    role TEXT NOT NULL,
    content TEXT NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (conversation_id) REFERENCES conversations(id)
  );
`);

function createConversation(title) {
  const id = uuidv4();
  db.prepare(`INSERT INTO conversations (id, title) VALUES (?, ?)`).run(id, title);
  return { id, title, messages: [] };
}

function getConversations() {
  return db.prepare(`SELECT * FROM conversations ORDER BY updated_at DESC`).all();
}

function getMessages(conversationId) {
  return db.prepare(`SELECT * FROM messages WHERE conversation_id = ? ORDER BY created_at ASC`).all(conversationId);
}

function addMessage(conversationId, role, content) {
  const id = uuidv4();
  db.prepare(`INSERT INTO messages (id, conversation_id, role, content) VALUES (?, ?, ?, ?)`).run(id, conversationId, role, content);
  db.prepare(`UPDATE conversations SET updated_at = CURRENT_TIMESTAMP WHERE id = ?`).run(conversationId);
  return { id, conversationId, role, content };
}

function updateConversationTitle(id, title) {
  db.prepare(`UPDATE conversations SET title = ? WHERE id = ?`).run(title, id);
}

function deleteConversation(id) {
  db.prepare(`DELETE FROM messages WHERE conversation_id = ?`).run(id);
  db.prepare(`DELETE FROM conversations WHERE id = ?`).run(id);
}

module.exports = {
  createConversation,
  getConversations,
  getMessages,
  addMessage,
  updateConversationTitle,
  deleteConversation
};