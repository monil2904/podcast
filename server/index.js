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

// ── FILE UPLOAD (Memory storage for direct upload to Supabase) ────────
const storage = multer.memoryStorage();
const upload = multer({ storage, limits: { fileSize: 2 * 1024 * 1024 * 1024 } }); // 2GB

// ── MIDDLEWARE ────────────────────────────────────────────
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, '../public')));

// ── REST API ──────────────────────────────────────────────

// Auth Middleware
const requireAuth = async (req, res, next) => {
  const token = req.headers.authorization?.split(' ')[1];
  if (!token) return res.status(401).json({ error: 'Unauthorized: No token provided' });
  const { data, error } = await supabase.auth.getUser(token);
  if (error || !data.user) return res.status(401).json({ error: 'Unauthorized: Invalid token' });
  req.user = data.user;
  next();
};

// Login
app.post('/api/login', async (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) return res.status(400).json({ error: 'Email and password required' });
  const { data, error } = await supabase.auth.signInWithPassword({ email, password });
  if (error) return res.status(401).json({ error: error.message });
  res.json({ token: data.session.access_token, user: data.user });
});

// Signup
app.post('/api/signup', async (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) return res.status(400).json({ error: 'Email and password required' });
  const { data, error } = await supabase.auth.signUp({ email, password });
  if (error) return res.status(400).json({ error: error.message });
  // Sometimes signups require email verification, but we'll return session if available
  if (data.session) {
    res.json({ token: data.session.access_token, user: data.user });
  } else {
    res.json({ message: 'Signup successful. Please check your email to verify.', user: data.user });
  }
});

// Create session
app.post('/api/sessions', async (req, res) => {
  const { hostName, title } = req.body;
  if (!hostName) return res.status(400).json({ error: 'Host name required' });
  const id = uuidv4().slice(0, 8).toUpperCase();

  const { error } = await supabase
    .from('sessions')
    .insert([{ id, host_name: hostName, title: title || 'Podcast Session', status: 'waiting' }]);

  if (error) return res.status(500).json({ error: error.message });
  res.json({ sessionId: id });
});

// Get session info
app.get('/api/sessions/:id', async (req, res) => {
  const [sessRes, partRes, recRes] = await Promise.all([
    supabase.from('sessions').select('*').eq('id', req.params.id).single(),
    supabase.from('participants').select('*').eq('session_id', req.params.id),
    supabase.from('recordings').select('*').eq('session_id', req.params.id)
  ]);

  if (!sessRes.data) return res.status(404).json({ error: 'Session not found' });
  res.json({ session: sessRes.data, participants: partRes.data || [], recordings: recRes.data || [] });
});

// List all sessions
app.get('/api/sessions', requireAuth, async (req, res) => {
  const { data, error } = await supabase
    .from('sessions')
    .select('*')
    .order('created_at', { ascending: false })
    .limit(50);
  if (error) return res.status(500).json({ error: error.message });
  res.json(data || []);
});

// Upload recording file
app.post('/api/recordings/upload', upload.single('recording'), async (req, res) => {
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

// Get recordings for session
app.get('/api/sessions/:id/recordings', async (req, res) => {
  const { data, error } = await supabase
    .from('recordings')
    .select('*')
    .eq('session_id', req.params.id)
    .order('created_at', { ascending: true });
  if (error) return res.status(500).json({ error: error.message });
  res.json(data || []);
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
  socket.on('host:join', async ({ sessionId, name }) => {
    socket.join(sessionId);
    const sess = getOrCreateSession(sessionId);
    sess.host = socket.id;
    sess.participants[socket.id] = { name, role: 'host', socketId: socket.id, status: 'admitted' };
    socket.sessionId = sessionId;
    socket.participantName = name;
    socket.role = 'host';

    await supabase.from('sessions').update({ status: 'live' }).eq('id', sessionId);
    await supabase.from('participants').upsert([{ id: socket.id, session_id: sessionId, name, role: 'host' }]);

    socket.emit('session:joined', { role: 'host', participants: sess.participants });
    console.log(`Host "${name}" -> session ${sessionId}`);
  });

  // GUEST JOINS
  socket.on('guest:join', async ({ sessionId, name }) => {
    const sess = getOrCreateSession(sessionId);
    if (Object.keys(sess.participants).length >= 4) return socket.emit('error', { message: 'Session full (max 4)' });

    socket.join(sessionId);
    sess.participants[socket.id] = { name, role: 'guest', socketId: socket.id, status: 'waiting' };
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
