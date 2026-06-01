CREATE TABLE IF NOT EXISTS appointments (
  id TEXT PRIMARY KEY,
  created_at TEXT NOT NULL,
  company TEXT NOT NULL,
  contact_name TEXT NOT NULL,
  position TEXT,
  phone TEXT NOT NULL,
  attendees INTEGER NOT NULL,
  note TEXT
);
