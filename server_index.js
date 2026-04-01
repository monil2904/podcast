// podcast-studio/server/index.js
// Run: node server/index.js
// Requires: npm install express socket.io better-sqlite3 uuid cors multer bcryptjs jsonwebtoken

const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const cors = require('cors');
const multer = require('multer');
const fs = require('fs');
const { v4: uuidv4 } = require('uuid');
const Database = require('better-sqlite3');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: '*', methods: ['GET', 'POST'] },
  maxHttpBufferSize: 1e8 // 100MB
});

// ── CONFIG ────────────────────────────────────────────────
const JWT_SECRET = process.env.JWT_SECRET || 'your-super-secret-key-change-in-production';
const JWT_EXPIRY = '7d';

// Ensure directories exist
const DATA_DIR = path.join(__dirname, '../data');
const UPLOADS_DIR = path.join(__dirname, '../uploads/recordings');
fs.mkdirSync(DATA_DIR, { recursive: true });
fs.mkdirSync(UPLOADS_DIR, { recursive: true });

// ── DATABASE ──────────────────────────────────────────────
const db = new Database(path.join(DATA_DIR, 'studio.db'));
db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    email TEXT UNIQUE NOT NULL,
    password_hash TEXT NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );
  CREATE TABLE IF NOT EXISTS sessions (
    id TEXT PRIMARY KEY,
    user_id TEXT,
    host_name TEXT,
    title TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    status TEXT DEFAULT 'waiting',
    recording_started_at DATETIME,
    recording_ended_at DATETIME,
    FOREIGN KEY(user_id) REFERENCES users(id)
  );
  CREATE TABLE IF NOT EXISTS participants (
    id TEXT PRIMARY KEY,
    session_id TEXT,
    name TEXT,
    joined_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    role TEXT DEFAULT 'guest',
    FOREIGN KEY(session_id) REFERENCES sessions(id)
  );
  CREATE TABLE IF NOT EXISTS recordings (
    id TEXT PRIMARY KEY,
    session_id TEXT,
    participant_id TEXT,
    participant_name TEXT,
    type TEXT,
    filename TEXT,
    filesize INTEGER,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY(session_id) REFERENCES sessions(id)
  );
`);

// ── FILE UPLOAD ───────────────────────────────────────────
const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, UPLOADS_DIR),
  filename: (req, file, cb) => cb(null, `${Date.now()}-${uuidv4()}.webm`)
});
const upload = multer({ storage, limits: { fileSize: 2 * 1024 * 1024 * 1024 } });

// ── MIDDLEWARE ────────────────────────────────────────────
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, '../public')));
app.use('/uploads', express.static(path.join(__dirname, '../uploads')));

// ── AUTH MIDDLEWARE ────────────────────────────────────────
function verifyToken(req, res, next) {
  const authHeader = req.headers.authorization;
  const token = authHeader && authHeader.replace('Bearer ', '');

  if (!token) {
    return res.status(401).json({ error: 'No token provided' });
  }

  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    req.user = decoded;
    next();
  } catch (err) {
    return res.status(401).json({ error: 'Invalid or expired token' });
  }
}

// ── AUTH ROUTES ────────────────────────────────────────────

// SIGNUP
app.post('/api/auth/signup', async (req, res) => {
  try {
    const { name, email, password } = req.body;

    // Validate input
    if (!name || !email || !password) {
      return res.status(400).json({ error: 'Name, email, and password are required' });
    }

    if (password.length < 6) {
      return res.status(400).json({ error: 'Password must be at least 6 characters' });
    }

    // Check if user already exists
    const existing = db.prepare('SELECT id FROM users WHERE email = ?').get(email);
    if (existing) {
      return res.status(409).json({ error: 'Email already registered' });
    }

    // Hash password
    const passwordHash = await bcrypt.hash(password, 10);

    // Create user
    const userId = uuidv4();
    db.prepare('INSERT INTO users (id, name, email, password_hash) VALUES (?, ?, ?, ?)')
      .run(userId, name, email, passwordHash);

    const user = db.prepare('SELECT id, name, email FROM users WHERE id = ?').get(userId);
    const accessToken = jwt.sign({ userId: user.id, email: user.email }, JWT_SECRET, { expiresIn: JWT_EXPIRY });

    res.json({ user, accessToken });
  } catch (err) {
    console.error('Signup error:', err);
    res.status(500).json({ error: 'Sign up failed' });
  }
});

// LOGIN
app.post('/api/auth/login', async (req, res) => {
  try {
    const { email, password } = req.body;

    // Validate input
    if (!email || !password) {
      return res.status(400).json({ error: 'Email and password are required' });
    }

    // Find user
    const user = db.prepare('SELECT * FROM users WHERE email = ?').get(email);
    if (!user) {
      return res.status(401).json({ error: 'Invalid email or password' });
    }

    // Verify password
    const isValid = await bcrypt.compare(password, user.password_hash);
    if (!isValid) {
      return res.status(401).json({ error: 'Invalid email or password' });
    }

    // Generate token
    const accessToken = jwt.sign({ userId: user.id, email: user.email }, JWT_SECRET, { expiresIn: JWT_EXPIRY });

    const userRes = { id: user.id, name: user.name, email: user.email };
    res.json({ user: userRes, accessToken });
  } catch (err) {
    console.error('Login error:', err);
    res.status(500).json({ error: 'Login failed' });
  }
});

// GET CURRENT USER
app.get('/api/auth/me', verifyToken, (req, res) => {
  try {
    const user = db.prepare('SELECT id, name, email FROM users WHERE id = ?').get(req.user.userId);
    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }

    const accessToken = jwt.sign({ userId: user.id, email: user.email }, JWT_SECRET, { expiresIn: JWT_EXPIRY });
    res.json({ user, accessToken });
  } catch (err) {
    console.error('Get user error:', err);
    res.status(500).json({ error: 'Failed to get user' });
  }
});

// LOGOUT (just frontend-side, but provided for completeness)
app.post('/api/auth/logout', verifyToken, (req, res) => {
  res.json({ message: 'Logged out successfully' });
});

// ── REST API ──────────────────────────────────────────────

// Create session
app.post('/api/sessions', verifyToken, (req, res) => {
  const { hostName, title } = req.body;
  if (!hostName) return res.status(400).json({ error: 'Host name required' });
  const id = uuidv4().slice(0, 8).toUpperCase();
  db.prepare('INSERT INTO sessions (id, user_id, host_name, title) VALUES (?, ?, ?, ?)').run(id, req.user.userId, hostName, title || 'Podcast Session');
  res.json({ sessionId: id });
});

// Get session info
app.get('/api/sessions/:id', (req, res) => {
  const session = db.prepare('SELECT * FROM sessions WHERE id = ?').get(req.params.id);
  if (!session) return res.status(404).json({ error: 'Session not found' });
  const participants = db.prepare('SELECT * FROM participants WHERE session_id = ?').all(req.params.id);
  const recordings = db.prepare('SELECT * FROM recordings WHERE session_id = ?').all(req.params.id);
  res.json({ session, participants, recordings });
});

// List all sessions
app.get('/api/sessions', (req, res) => {
  const sessions = db.prepare('SELECT * FROM sessions ORDER BY created_at DESC LIMIT 50').all();
  res.json(sessions);
});

// Upload recording file
app.post('/api/recordings/upload', upload.single('recording'), (req, res) => {
  try {
    const { sessionId, participantId, participantName, type } = req.body;
    const id = uuidv4();
    db.prepare('INSERT INTO recordings (id, session_id, participant_id, participant_name, type, filename, filesize) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(id, sessionId, participantId, participantName, type, req.file.filename, req.file.size);
    res.json({ id, filename: req.file.filename, url: `/uploads/recordings/${req.file.filename}` });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// Get recordings for session
app.get('/api/sessions/:id/recordings', (req, res) => {
  const recordings = db.prepare('SELECT * FROM recordings WHERE session_id = ? ORDER BY created_at ASC').all(req.params.id);
  const mapped = recordings.map(r => ({ ...r, url: `/uploads/recordings/${r.filename}` }));
  res.json(mapped);
});

// ── SOCKET.IO SIGNALING ───────────────────────────────────
const activeSessions = {};

function getOrCreateSession(id) {
  if (!activeSessions[id]) activeSessions[id] = { host: null, participants: {} };
  return activeSessions[id];
}

io.on('connection', (socket) => {
  console.log('+ Connected:', socket.id);

  // HOST JOINS
  socket.on('host:join', ({ sessionId, name }) => {
    const dbSession = db.prepare('SELECT * FROM sessions WHERE id = ?').get(sessionId);
    if (!dbSession) return socket.emit('error', { message: 'Session not found' });

    socket.join(sessionId);
    const sess = getOrCreateSession(sessionId);
    sess.host = socket.id;
    sess.participants[socket.id] = { name, role: 'host', socketId: socket.id, status: 'admitted' };
    socket.sessionId = sessionId;
    socket.participantName = name;
    socket.role = 'host';

    db.prepare('UPDATE sessions SET status = ? WHERE id = ?').run('live', sessionId);
    db.prepare('INSERT OR IGNORE INTO participants (id, session_id, name, role) VALUES (?, ?, ?, ?)').run(socket.id, sessionId, name, 'host');

    socket.emit('session:joined', { role: 'host', participants: sess.participants });
    console.log(`Host "${name}" -> session ${sessionId}`);
  });

  // GUEST JOINS
  socket.on('guest:join', ({ sessionId, name }) => {
    const dbSession = db.prepare('SELECT * FROM sessions WHERE id = ?').get(sessionId);
    if (!dbSession) return socket.emit('error', { message: 'Session not found' });

    const sess = getOrCreateSession(sessionId);
    const count = Object.keys(sess.participants).length;
    if (count >= 4) return socket.emit('error', { message: 'Session full (max 4 participants)' });

    socket.join(sessionId);
    sess.participants[socket.id] = { name, role: 'guest', socketId: socket.id, status: 'waiting' };
    socket.sessionId = sessionId;
    socket.participantName = name;
    socket.role = 'guest';

    db.prepare('INSERT OR IGNORE INTO participants (id, session_id, name, role) VALUES (?, ?, ?, ?)').run(socket.id, sessionId, name, 'guest');

    socket.emit('guest:waiting', { sessionId, name, participantId: socket.id });

    // Notify host
    const hostSocketId = sess.host;
    if (hostSocketId) {
      io.to(hostSocketId).emit('guest:request', { socketId: socket.id, name });
    }

    io.to(sessionId).emit('participants:update', { participants: sess.participants });
    console.log(`Guest "${name}" waiting -> session ${sessionId}`);
  });

  // HOST ADMITS GUEST
  socket.on('host:admit', ({ guestSocketId }) => {
    const sess = activeSessions[socket.sessionId];
    if (!sess) return;

    if (sess.participants[guestSocketId]) {
      sess.participants[guestSocketId].status = 'admitted';
    }

    io.to(guestSocketId).emit('guest:admitted');

    // Tell all admitted participants to create WebRTC offer to new guest
    Object.entries(sess.participants).forEach(([pid, p]) => {
      if (pid !== guestSocketId && p.status === 'admitted') {
        io.to(pid).emit('webrtc:offer-needed', {
          targetId: guestSocketId,
          targetName: sess.participants[guestSocketId]?.name
        });
      }
    });

    io.to(socket.sessionId).emit('participants:update', { participants: sess.participants });
    console.log(`Host admitted guest ${guestSocketId}`);
  });

  // HOST KICKS GUEST
  socket.on('host:kick', ({ guestSocketId }) => {
    const sess = activeSessions[socket.sessionId];
    if (!sess) return;
    io.to(guestSocketId).emit('guest:kicked');
    delete sess.participants[guestSocketId];
    io.to(socket.sessionId).emit('participants:update', { participants: sess.participants });
  });

  // WEBRTC SIGNALING (full mesh)
  socket.on('webrtc:offer', ({ targetId, offer }) => {
    io.to(targetId).emit('webrtc:offer', { fromId: socket.id, fromName: socket.participantName, offer });
  });

  socket.on('webrtc:answer', ({ targetId, answer }) => {
    io.to(targetId).emit('webrtc:answer', { fromId: socket.id, answer });
  });

  socket.on('webrtc:ice', ({ targetId, candidate }) => {
    io.to(targetId).emit('webrtc:ice', { fromId: socket.id, candidate });
  });

  // RECORDING CONTROL (host triggers for all)
  socket.on('recording:start', ({ sessionId }) => {
    db.prepare('UPDATE sessions SET recording_started_at = CURRENT_TIMESTAMP, status = ? WHERE id = ?').run('recording', sessionId);
    io.to(sessionId).emit('recording:start');
    console.log(`Recording STARTED -> session ${sessionId}`);
  });

  socket.on('recording:stop', ({ sessionId }) => {
    db.prepare('UPDATE sessions SET recording_ended_at = CURRENT_TIMESTAMP, status = ? WHERE id = ?').run('completed', sessionId);
    io.to(sessionId).emit('recording:stop');
    console.log(`Recording STOPPED -> session ${sessionId}`);
  });

  // LAYOUT CHANGE
  socket.on('layout:change', ({ layout }) => {
    if (socket.sessionId) io.to(socket.sessionId).emit('layout:change', { layout });
  });

  // HOST MUTES GUEST
  socket.on('host:mute', ({ targetId, muted }) => {
    io.to(targetId).emit('force:mute', { muted });
  });

  // CHAT
  socket.on('chat:message', ({ message }) => {
    if (!socket.sessionId) return;
    io.to(socket.sessionId).emit('chat:message', {
      name: socket.participantName,
      message,
      time: new Date().toISOString(),
      socketId: socket.id
    });
  });

  // DISCONNECT
  socket.on('disconnect', () => {
    const { sessionId, participantName, role } = socket;
    if (sessionId && activeSessions[sessionId]) {
      const sess = activeSessions[sessionId];
      delete sess.participants[socket.id];
      io.to(sessionId).emit('participants:update', { participants: sess.participants });
      io.to(sessionId).emit('participant:left', { socketId: socket.id, name: participantName, role });
      if (role === 'host') {
        io.to(sessionId).emit('host:left');
        db.prepare('UPDATE sessions SET status = ? WHERE id = ?').run('ended', sessionId);
      }
    }
    console.log('- Disconnected:', socket.id, participantName || '');
  });
});

// ── SPA ROUTES ─────────────────────────────────────────────
app.get('/session/:id', (_, res) => res.sendFile(path.join(__dirname, '../public/session.html')));
app.get('/join/:id', (_, res) => res.sendFile(path.join(__dirname, '../public/join.html')));
app.get('/recordings', (_, res) => res.sendFile(path.join(__dirname, '../public/recordings.html')));
app.get('*', (_, res) => res.sendFile(path.join(__dirname, '../public/index.html')));

// ── START ──────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log('\n╔══════════════════════════════════════╗');
  console.log('║   🎙️  PodcastStudio is LIVE!          ║');
  console.log(`║   http://localhost:${PORT}              ║`);
  console.log('╚══════════════════════════════════════╝\n');
});
