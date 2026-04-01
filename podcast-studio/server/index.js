// podcast-studio/server/index.js
require('dotenv').config();
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const cors = require('cors');
const multer = require('multer');
const { v4: uuidv4 } = require('uuid');
const { createClient } = require('@supabase/supabase-js');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: '*', methods: ['GET', 'POST'] },
  maxHttpBufferSize: 1e8 // 100MB
});

// ── SUPABASE ──────────────────────────────────────────────
const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_KEY;

if (!supabaseUrl || !supabaseKey) {
  console.warn("⚠️ WARNING: SUPABASE_URL and SUPABASE_KEY are not set in environment.");
}

const supabase = createClient(
  supabaseUrl || 'https://mock.supabase.co',
  supabaseKey || 'mock-key'
);

const AUTH_COOKIE_NAME = 'podcast_auth_token';

function parseCookies(cookieHeader = '') {
  return cookieHeader.split(';').reduce((acc, pair) => {
    const idx = pair.indexOf('=');
    if (idx === -1) return acc;
    const key = pair.slice(0, idx).trim();
    const value = decodeURIComponent(pair.slice(idx + 1).trim());
    if (key) acc[key] = value;
    return acc;
  }, {});
}

function getAccessTokenFromRequest(req) {
  const authHeader = req.header('authorization') || '';
  if (authHeader.toLowerCase().startsWith('bearer ')) {
    return authHeader.slice(7).trim();
  }

  const cookies = parseCookies(req.headers.cookie || '');
  return cookies[AUTH_COOKIE_NAME] || null;
}

async function verifyAccessToken(token) {
  if (!token) return null;
  const { data, error } = await supabase.auth.getUser(token);
  if (error || !data?.user) return null;
  return data.user;
}

function getUserDisplayName(user) {
  const fromMeta = user?.user_metadata?.name;
  if (typeof fromMeta === 'string' && fromMeta.trim()) return fromMeta.trim();
  if (typeof user?.email === 'string' && user.email.includes('@')) return user.email.split('@')[0];
  return 'User';
}

function setAuthCookie(res, token) {
  res.setHeader('Set-Cookie', `${AUTH_COOKIE_NAME}=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=604800`);
}

function clearAuthCookie(res) {
  res.setHeader('Set-Cookie', `${AUTH_COOKIE_NAME}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`);
}

// ── FILE UPLOAD (Memory storage for direct upload to Supabase) ────────
const storage = multer.memoryStorage();
const upload = multer({ storage, limits: { fileSize: 2 * 1024 * 1024 * 1024 } }); // 2GB

// ── MIDDLEWARE ────────────────────────────────────────────
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, '../public')));

async function requireAuthUser(req, res, next) {
  const token = getAccessTokenFromRequest(req);
  const user = await verifyAccessToken(token);
  if (!user) return res.status(401).json({ error: 'Login required' });

  req.authUser = user;
  req.authToken = token;
  next();
}

async function requirePageAuth(req, res, next) {
  const token = getAccessTokenFromRequest(req);
  const user = await verifyAccessToken(token);
  if (!user) return res.redirect('/?login=1');

  req.authUser = user;
  req.authToken = token;
  next();
}

// ── REST API ──────────────────────────────────────────────

app.post('/api/auth/login', async (req, res) => {
  try {
    const email = String(req.body?.email || '').trim().toLowerCase();
    const password = String(req.body?.password || '');

    if (!email || !password) {
      return res.status(400).json({ error: 'Email and password are required' });
    }

    const { data, error } = await supabase.auth.signInWithPassword({ email, password });
    if (error || !data?.session || !data?.user) {
      return res.status(401).json({ error: error?.message || 'Invalid credentials' });
    }

    setAuthCookie(res, data.session.access_token);
    res.json({
      accessToken: data.session.access_token,
      user: {
        id: data.user.id,
        email: data.user.email,
        name: getUserDisplayName(data.user)
      }
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/auth/signup', async (req, res) => {
  try {
    const name = String(req.body?.name || '').trim();
    const email = String(req.body?.email || '').trim().toLowerCase();
    const password = String(req.body?.password || '');

    if (!name || !email || !password) {
      return res.status(400).json({ error: 'Name, email and password are required' });
    }

    const { data, error } = await supabase.auth.signUp({
      email,
      password,
      options: { data: { name } }
    });

    if (error) return res.status(400).json({ error: error.message });

    if (data?.session?.access_token) {
      setAuthCookie(res, data.session.access_token);
    }

    res.status(201).json({
      accessToken: data?.session?.access_token || null,
      user: data?.user
        ? {
            id: data.user.id,
            email: data.user.email,
            name: getUserDisplayName(data.user)
          }
        : null,
      needsEmailConfirmation: !data?.session
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/auth/logout', (_req, res) => {
  clearAuthCookie(res);
  res.json({ ok: true });
});

app.get('/api/auth/me', requireAuthUser, (req, res) => {
  res.json({
    user: {
      id: req.authUser.id,
      email: req.authUser.email,
      name: getUserDisplayName(req.authUser)
    },
    accessToken: req.authToken
  });
});

// Create session
app.post('/api/sessions', requireAuthUser, async (req, res) => {
  const { title } = req.body;
  const hostName = getUserDisplayName(req.authUser);
  const id = uuidv4().slice(0, 8).toUpperCase();

  const { error } = await supabase
    .from('sessions')
    .insert([{ id, host_name: hostName, title: title || 'Podcast Session', status: 'waiting' }]);

  if (error) return res.status(500).json({ error: error.message });
  res.json({ sessionId: id });
});

// Get session info
app.get('/api/sessions/:id', requireAuthUser, async (req, res) => {
  const userId = req.authUser.id;
  const [sessRes, partRes, recRes] = await Promise.all([
    supabase.from('sessions').select('*').eq('id', req.params.id).single(),
    supabase.from('participants').select('*').eq('session_id', req.params.id),
    supabase.from('recordings').select('*').eq('session_id', req.params.id).eq('participant_id', userId)
  ]);

  if (!sessRes.data) return res.status(404).json({ error: 'Session not found' });
  res.json({ session: sessRes.data, participants: partRes.data || [], recordings: recRes.data || [] });
});

// List only sessions belonging to logged-in user
app.get('/api/sessions', requireAuthUser, async (req, res) => {
  const userName = getUserDisplayName(req.authUser);
  const userId = req.authUser.id;

  const [sessionsRes, recordingsRes] = await Promise.all([
    supabase
      .from('sessions')
      .select('*')
      .order('created_at', { ascending: false })
      .limit(200),
    supabase
      .from('recordings')
      .select('session_id')
      .eq('participant_id', userId)
  ]);

  if (sessionsRes.error) return res.status(500).json({ error: sessionsRes.error.message });
  if (recordingsRes.error) return res.status(500).json({ error: recordingsRes.error.message });

  const ownedSessionIds = new Set((recordingsRes.data || []).map((r) => r.session_id));
  const filteredSessions = (sessionsRes.data || []).filter((s) => s.host_name === userName || ownedSessionIds.has(s.id));

  res.json(filteredSessions);
});

// Upload recording file
app.post('/api/recordings/upload', requireAuthUser, upload.single('recording'), async (req, res) => {
  try {
    const { sessionId, participantId, participantName, type } = req.body;
    const file = req.file;
    if (!file) return res.status(400).json({ error: 'No recording file uploaded' });

    const id = uuidv4();
    const filename = `${Date.now()}-${uuidv4()}.webm`;
    const filePath = `sessions/${sessionId}/${filename}`;

    // Upload to Supabase Storage in 'recordings' bucket
    const { data: uploadData, error: uploadError } = await supabase.storage
      .from('recordings')
      .upload(filePath, file.buffer, {
        contentType: 'video/webm'
      });

    if (uploadError) throw uploadError;

    // Get public URL
    const { data: publicUrlData } = supabase.storage
      .from('recordings')
      .getPublicUrl(filePath);

    const publicUrl = publicUrlData.publicUrl;

    // Database record
    const { error: dbError } = await supabase
      .from('recordings')
      .insert([{
        id, session_id: sessionId, participant_id: participantId,
        participant_name: participantName, type, filename: filePath,
        filesize: file.size, url: publicUrl
      }]);

    if (dbError) throw dbError;

    res.json({ id, filename, url: publicUrl });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// Get recordings for session (logged-in user's own recordings only)
app.get('/api/sessions/:id/recordings', requireAuthUser, async (req, res) => {
  const userName = getUserDisplayName(req.authUser);
  const userId = req.authUser.id;

  const { data, error } = await supabase
    .from('sessions')
    .select('*')
    .eq('id', req.params.id)
    .single();

  if (error || !data) return res.status(404).json({ error: 'Session not found' });

  const hasSessionAccess = data.host_name === userName;
  if (!hasSessionAccess) {
    const { data: ownedRecording } = await supabase
      .from('recordings')
      .select('id')
      .eq('session_id', req.params.id)
      .eq('participant_id', userId)
      .limit(1)
      .maybeSingle();

    if (!ownedRecording) {
      return res.status(403).json({ error: 'Access denied for this session' });
    }
  }

  const { data: recordings, error: recordingsError } = await supabase
    .from('recordings')
    .select('*')
    .eq('session_id', req.params.id)
    .eq('participant_id', userId)
    .order('created_at', { ascending: true });

  if (recordingsError) return res.status(500).json({ error: recordingsError.message });
  res.json(recordings || []);
});

// ── SOCKET.IO SIGNALING ───────────────────────────────────
const activeSessions = {};

function getOrCreateSession(id) {
  if (!activeSessions[id]) activeSessions[id] = { host: null, participants: {} };
  return activeSessions[id];
}

io.use(async (socket, next) => {
  const token = socket.handshake?.auth?.token;
  const user = await verifyAccessToken(token);
  if (!user) return next(new Error('unauthorized'));

  socket.authUser = user;
  next();
});

io.on('connection', (socket) => {
  console.log('+ Connected:', socket.id);

  // HOST JOINS
  socket.on('host:join', async ({ sessionId }) => {
    socket.join(sessionId);
    const sess = getOrCreateSession(sessionId);
    const name = getUserDisplayName(socket.authUser);
    sess.host = socket.id;
    sess.participants[socket.id] = {
      name,
      role: 'host',
      socketId: socket.id,
      status: 'admitted',
      userId: socket.authUser.id
    };
    socket.sessionId = sessionId;
    socket.participantName = name;
    socket.role = 'host';

    await supabase.from('sessions').update({ status: 'live' }).eq('id', sessionId);
    await supabase.from('participants').upsert([{ id: socket.id, session_id: sessionId, name, role: 'host' }]);

    socket.emit('session:joined', { role: 'host', participants: sess.participants });
    console.log(`Host "${name}" -> session ${sessionId}`);
  });

  // GUEST JOINS
  socket.on('guest:join', async ({ sessionId }) => {
    const sess = getOrCreateSession(sessionId);
    if (Object.keys(sess.participants).length >= 4) return socket.emit('error', { message: 'Session full (max 4)' });

    const name = getUserDisplayName(socket.authUser);

    socket.join(sessionId);
    sess.participants[socket.id] = {
      name,
      role: 'guest',
      socketId: socket.id,
      status: 'waiting',
      userId: socket.authUser.id
    };
    socket.sessionId = sessionId;
    socket.participantName = name;
    socket.role = 'guest';

    await supabase.from('participants').upsert([{ id: socket.id, session_id: sessionId, name, role: 'guest' }]);

    socket.emit('guest:waiting', { sessionId, name, participantId: socket.id });

    if (sess.host) io.to(sess.host).emit('guest:request', { socketId: socket.id, name });
    io.to(sessionId).emit('participants:update', { participants: sess.participants });
    console.log(`Guest "${name}" waiting -> session ${sessionId}`);
  });

  // HOST ADMITS GUEST
  socket.on('host:admit', ({ guestSocketId }) => {
    const sess = activeSessions[socket.sessionId];
    if (!sess || !sess.participants[guestSocketId]) return;

    sess.participants[guestSocketId].status = 'admitted';
    io.to(guestSocketId).emit('guest:admitted');

    Object.entries(sess.participants).forEach(([pid, p]) => {
      if (pid !== guestSocketId && p.status === 'admitted') {
        io.to(pid).emit('webrtc:offer-needed', {
          targetId: guestSocketId,
          targetName: sess.participants[guestSocketId].name
        });
      }
    });

    io.to(socket.sessionId).emit('participants:update', { participants: sess.participants });
  });

  // RECORDING CONTROL
  socket.on('recording:start', async ({ sessionId }) => {
    await supabase.from('sessions').update({ recording_started_at: new Date().toISOString(), status: 'recording' }).eq('id', sessionId);
    io.to(sessionId).emit('recording:start');
    console.log(`Recording STARTED -> session ${sessionId}`);
  });

  socket.on('recording:stop', async ({ sessionId }) => {
    await supabase.from('sessions').update({ recording_ended_at: new Date().toISOString(), status: 'completed' }).eq('id', sessionId);
    io.to(sessionId).emit('recording:stop');
    console.log(`Recording STOPPED -> session ${sessionId}`);
  });

  // HOST KICKS GUEST
  socket.on('host:kick', ({ guestSocketId }) => {
    const sess = activeSessions[socket.sessionId];
    if (!sess) return;
    io.to(guestSocketId).emit('guest:kicked');
    delete sess.participants[guestSocketId];
    io.to(socket.sessionId).emit('participants:update', { participants: sess.participants });
  });

  // WEBRTC SIGNALING & UI CHANGES
  socket.on('layout:change', ({ layout }) => io.to(socket.sessionId).emit('layout:change', { layout }));
  socket.on('host:mute', ({ targetId, muted }) => io.to(targetId).emit('force:mute', { muted }));
  socket.on('chat:message', ({ message }) => {
    if (socket.sessionId) io.to(socket.sessionId).emit('chat:message', {
      name: socket.participantName,
      message,
      time: new Date().toISOString(),
      socketId: socket.id
    });
  });

  socket.on('webrtc:offer', ({ targetId, offer }) => io.to(targetId).emit('webrtc:offer', { fromId: socket.id, fromName: socket.participantName, offer }));
  socket.on('webrtc:answer', ({ targetId, answer }) => io.to(targetId).emit('webrtc:answer', { fromId: socket.id, answer }));
  socket.on('webrtc:ice', ({ targetId, candidate }) => io.to(targetId).emit('webrtc:ice', { fromId: socket.id, candidate }));

  // DISCONNECT
  socket.on('disconnect', async () => {
    const { sessionId, participantName, role, id } = socket;
    if (sessionId && activeSessions[sessionId]) {
      const sess = activeSessions[sessionId];
      delete sess.participants[id];
      io.to(sessionId).emit('participants:update', { participants: sess.participants });
      io.to(sessionId).emit('participant:left', { socketId: id, name: participantName });

      if (role === 'host') {
        io.to(sessionId).emit('host:left');
        await supabase.from('sessions').update({ status: 'ended' }).eq('id', sessionId);
      }
    }
    console.log('- Disconnected:', socket.id);
  });
});

// ── SPA ROUTES ─────────────────────────────────────────────
app.get('/session/:id', requirePageAuth, (_req, res) => res.sendFile(path.join(__dirname, '../public/session.html')));
app.get('/join/:id', requirePageAuth, (_req, res) => res.sendFile(path.join(__dirname, '../public/join.html')));
app.get('/recordings', requirePageAuth, (_req, res) => res.sendFile(path.join(__dirname, '../public/recordings.html')));
app.get('*', (_, res) => res.sendFile(path.join(__dirname, '../public/index.html')));

// ── START ──────────────────────────────────────────────────
const envPort = Number.parseInt(process.env.PORT, 10);
const basePort = Number.isNaN(envPort) ? 3000 : envPort;
const MAX_PORT_RETRIES = 10;
let currentPort = basePort;
let retryCount = 0;

function startServer(port) {
  currentPort = port;
  server.listen(currentPort);
}

server.on('listening', () => {
  console.log('\n╔══════════════════════════════════════╗');
  console.log('║   🎙️  PodcastStudio is LIVE!          ║');
  console.log(`║   http://localhost:${currentPort}              ║`);
  console.log('╚══════════════════════════════════════╝\n');
});

server.on('error', (err) => {
  if (err.code !== 'EADDRINUSE') throw err;

  if (!Number.isNaN(envPort)) {
    console.error(`Port ${currentPort} is already in use. Change PORT in .env or stop the other process.`);
    process.exit(1);
  }

  if (retryCount >= MAX_PORT_RETRIES) {
    console.error(`Could not find a free port after ${MAX_PORT_RETRIES + 1} attempts (starting at ${basePort}).`);
    process.exit(1);
  }

  retryCount += 1;
  const nextPort = currentPort + 1;
  console.warn(`Port ${currentPort} is in use. Retrying on ${nextPort}...`);
  startServer(nextPort);
});

startServer(basePort);
