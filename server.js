require('dotenv').config();
const express = require('express');
const session = require('express-session');
const passport = require('passport');
const { Strategy: GoogleStrategy } = require('passport-google-oauth20');
const { GoogleGenerativeAI } = require('@google/generative-ai');
const fetch = require('node-fetch');
const path = require('path');
const crypto = require('crypto');
const db = require('./db');

const app = express();
const PORT = process.env.PORT || 3000;

// ─── Gemini ───────────────────────────────────────────────────────────────────

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY || '');

async function gemini(prompt) {
  const model = genAI.getGenerativeModel({
    model: 'gemini-2.5-pro',
    generationConfig: { temperature: 0 }
  });
  const result = await model.generateContent(prompt);
  return result.response.text();
}

function safeParseJson(text, fallback) {
  try {
    const cleaned = text.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
    return JSON.parse(cleaned);
  } catch { return fallback; }
}

// ─── Daily.co ─────────────────────────────────────────────────────────────────

const DAILY = 'https://api.daily.co/v1';
const dailyHeaders = () => ({
  'Content-Type': 'application/json',
  Authorization: `Bearer ${process.env.DAILY_API_KEY}`
});

async function createRoom(name) {
  const r = await fetch(`${DAILY}/rooms`, {
    method: 'POST',
    headers: dailyHeaders(),
    body: JSON.stringify({
      name,
      properties: { max_participants: 2, enable_chat: false, exp: Math.floor(Date.now() / 1000) + 3600 }
    })
  });
  const data = await r.json();
  if (data.error) throw new Error(data.info || data.error);
  return data;
}

async function createToken(room_name, is_owner) {
  const r = await fetch(`${DAILY}/meeting-tokens`, {
    method: 'POST',
    headers: dailyHeaders(),
    body: JSON.stringify({ properties: { room_name, is_owner, exp: Math.floor(Date.now() / 1000) + 3600 } })
  });
  const data = await r.json();
  if (data.error) throw new Error(data.info || data.error);
  return data;
}

// ─── Passport / Auth ──────────────────────────────────────────────────────────

passport.use(new GoogleStrategy({
  clientID: process.env.GOOGLE_CLIENT_ID || '',
  clientSecret: process.env.GOOGLE_CLIENT_SECRET || '',
  callbackURL: process.env.GOOGLE_CALLBACK_URL || `http://localhost:${PORT}/auth/google/callback`
}, async (_at, _rt, profile, done) => {
  try {
    const user = await db.createUserIfAbsent({
      id: profile.id,
      email: profile.emails?.[0]?.value || '',
      name: profile.displayName || '',
      picture: profile.photos?.[0]?.value || null,
      role: null,
      available: false,
      language: 'en',
      created_at: new Date().toISOString()
    });
    done(null, user);
  } catch (e) { done(e); }
}));

passport.serializeUser((u, done) => done(null, u.id));
passport.deserializeUser(async (id, done) => {
  try { done(null, (await db.getUser(id)) || false); }
  catch (e) { done(e); }
});

// ─── Middleware ───────────────────────────────────────────────────────────────

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(session({
  secret: process.env.SESSION_SECRET || crypto.randomBytes(32).toString('hex'),
  resave: false,
  saveUninitialized: false,
  cookie: { maxAge: 7 * 24 * 60 * 60 * 1000, sameSite: 'lax' }
}));
app.use(passport.initialize());
app.use(passport.session());
app.use(express.static(path.join(__dirname, 'public')));

const requireAuth = (req, res, next) =>
  req.isAuthenticated() ? next() : res.status(401).json({ error: 'Not authenticated' });

const requireRole = (r) => (req, res, next) => {
  if (!req.isAuthenticated()) return res.status(401).json({ error: 'Not authenticated' });
  if (req.user.role !== r) return res.status(403).json({ error: 'Forbidden' });
  next();
};

// ─── Auth Routes ──────────────────────────────────────────────────────────────

app.get('/auth/google', (req, res, next) => {
  if (req.query.intent) req.session.intent = req.query.intent;
  passport.authenticate('google', { scope: ['profile', 'email'] })(req, res, next);
});

app.get('/auth/google/callback',
  passport.authenticate('google', { failureRedirect: '/?error=auth' }),
  async (req, res) => {
    const intent = req.session.intent;
    delete req.session.intent;
    if (!req.user.role && intent && ['patient', 'doctor'].includes(intent)) {
      await db.updateUser(req.user.id, { role: intent });
      req.user.role = intent;
    }
    res.redirect('/');
  }
);

app.post('/auth/role', requireAuth, async (req, res) => {
  const { role } = req.body;
  if (!['patient', 'doctor'].includes(role)) return res.status(400).json({ error: 'Invalid role' });
  await db.updateUser(req.user.id, { role });
  req.user.role = role;
  res.json({ ok: true, role });
});

app.post('/auth/logout', (req, res) => req.logout(() => res.json({ ok: true })));

// ─── User API ─────────────────────────────────────────────────────────────────

app.get('/api/me', (req, res) => res.json({ user: req.user || null }));

// ─── Patient Routes ───────────────────────────────────────────────────────────

app.post('/api/appointments', requireRole('patient'), async (req, res) => {
  try {
    const { intake_raw, language = 'en' } = req.body;
    if (!intake_raw?.trim()) return res.status(400).json({ error: 'Description is required' });

    const prompt = `You are a medical intake assistant. Analyze the patient description and extract structured information.
Return ONLY a valid JSON object, no markdown, no explanation:
{
  "chief_complaint": "brief summary of main health concern",
  "symptoms": ["symptom 1", "symptom 2"],
  "duration": "how long symptoms have been present",
  "severity": "low|medium|high",
  "urgency_notes": "brief note for the doctor about urgency level",
  "emergency": false,
  "emergency_reason": ""
}

Set "emergency" to true ONLY if the description suggests a life-threatening medical emergency that needs immediate in-person or 911 care. Examples: chest pain or pressure, difficulty breathing or shortness of breath, signs of stroke (face drooping, slurred speech, sudden one-sided weakness/numbness), severe or uncontrolled bleeding, severe allergic reaction or anaphylaxis, loss of consciousness or fainting, seizure, severe head injury, coughing or vomiting blood, thoughts of suicide or self-harm, or symptoms of a heart attack. If emergency is true, set "emergency_reason" to a brief plain-language reason. Otherwise set emergency to false and emergency_reason to "".

Patient description: "${intake_raw.replace(/"/g, "'")}"`;

    const fallback = { chief_complaint: intake_raw.slice(0, 150), symptoms: [], duration: 'unknown', severity: 'medium', urgency_notes: '', emergency: false, emergency_reason: '' };
    const raw = await gemini(prompt).catch(() => null);
    const intake_summary = raw ? safeParseJson(raw, fallback) : fallback;
    if (typeof intake_summary.emergency !== 'boolean') intake_summary.emergency = false;

    const appt = {
      id: crypto.randomUUID(),
      patient_id: req.user.id,
      patient_name: req.user.name,
      patient_picture: req.user.picture || null,
      doctor_id: null,
      doctor_name: null,
      doctor_picture: null,
      status: 'pending',
      language,
      intake_raw,
      intake_summary,
      room_name: null,
      room_url: null,
      doctor_token: null,
      patient_token: null,
      doctor_notes: null,
      post_call_summary: null,
      messages: [],
      created_at: new Date().toISOString(),
      started_at: null,
      completed_at: null
    };

    await db.createAppt(appt);
    res.json({ appointment: appt });
  } catch (e) {
    console.error('Create appointment error:', e);
    res.status(500).json({ error: 'Failed to create appointment' });
  }
});

app.get('/api/appointments', requireAuth, async (req, res) => {
  const mine = await db.getApptsForUser(req.user.id, req.user.role);
  res.json({ appointments: mine });
});

app.get('/api/appointments/:id', requireAuth, async (req, res) => {
  const appt = await db.getApptById(req.params.id);
  if (!appt) return res.status(404).json({ error: 'Not found' });
  if (appt.patient_id !== req.user.id && appt.doctor_id !== req.user.id)
    return res.status(403).json({ error: 'Forbidden' });
  res.json({ appointment: appt });
});

app.get('/api/appointments/:id/poll', requireAuth, async (req, res) => {
  const appt = await db.getApptById(req.params.id);
  if (!appt) return res.status(404).json({ error: 'Not found' });
  if (appt.patient_id !== req.user.id && appt.doctor_id !== req.user.id)
    return res.status(403).json({ error: 'Forbidden' });
  const token = req.user.role === 'patient' ? appt.patient_token : appt.doctor_token;
  res.json({ status: appt.status, room_url: appt.room_url, token });
});

app.patch('/api/appointments/:id/cancel', requireRole('patient'), async (req, res) => {
  const appt = await db.getApptById(req.params.id);
  if (!appt || appt.patient_id !== req.user.id) return res.status(404).json({ error: 'Not found' });
  if (!['pending', 'active'].includes(appt.status))
    return res.status(400).json({ error: 'Cannot cancel this appointment' });
  await db.updateAppt(req.params.id, { status: 'cancelled' });
  res.json({ ok: true });
});

app.get('/api/appointments/:id/messages', requireAuth, async (req, res) => {
  const appt = await db.getApptById(req.params.id);
  if (!appt) return res.status(404).json({ error: 'Not found' });
  if (appt.patient_id !== req.user.id && appt.doctor_id !== req.user.id)
    return res.status(403).json({ error: 'Forbidden' });
  const since = parseInt(req.query.since || '0', 10);
  const messages = appt.messages || [];
  res.json({ messages: messages.slice(since), total: messages.length });
});

// ─── Doctor Routes ────────────────────────────────────────────────────────────

app.get('/api/queue', requireRole('doctor'), async (req, res) => {
  const queue = await db.getQueue();
  res.json({ queue });
});

app.patch('/api/me/availability', requireRole('doctor'), async (req, res) => {
  const { available } = req.body;
  await db.updateUser(req.user.id, { available: !!available });
  req.user.available = !!available;
  res.json({ available: !!available });
});

app.post('/api/appointments/:id/accept', requireRole('doctor'), async (req, res) => {
  const room_name = `vela-${req.params.id.slice(0, 8)}`;

  // Atomically claim the pending appointment so two doctors can't grab the same one
  const claimed = await db.claimAppt(req.params.id, {
    doctor_id: req.user.id,
    doctor_name: req.user.name,
    doctor_picture: req.user.picture || null,
    room_name,
    started_at: new Date().toISOString()
  });
  if (!claimed) return res.status(404).json({ error: 'Appointment not found or already taken' });

  // Create the video room/tokens, then attach them
  let room_url = null, doctor_token = null, patient_token = null;
  try {
    const room = await createRoom(room_name);
    room_url = room.url;
    const [dt, pt] = await Promise.all([
      createToken(room_name, true),
      createToken(room_name, false)
    ]);
    doctor_token = dt.token;
    patient_token = pt.token;
  } catch (e) {
    console.error('Daily.co error:', e.message);
  }

  const appt = await db.updateAppt(req.params.id, { room_url, doctor_token, patient_token });
  res.json({ appointment: appt });
});

app.post('/api/appointments/:id/complete', requireRole('doctor'), async (req, res) => {
  try {
    const { doctor_notes = '' } = req.body;
    const appt = await db.getApptById(req.params.id);
    if (!appt || appt.doctor_id !== req.user.id) return res.status(404).json({ error: 'Not found' });

    const prompt = `You are a medical assistant helping patients understand their visit.
Write a clear, plain-language visit summary based on the following.

Patient intake:
- Chief complaint: ${appt.intake_summary?.chief_complaint || 'N/A'}
- Symptoms: ${(appt.intake_summary?.symptoms || []).join(', ') || 'N/A'}
- Duration: ${appt.intake_summary?.duration || 'N/A'}

Doctor notes: "${doctor_notes.replace(/"/g, "'") || 'No specific notes recorded'}"

Return ONLY a valid JSON object:
{
  "what_we_discussed": "2-3 sentences summarizing the visit in plain language",
  "next_steps": ["action item 1", "action item 2"],
  "medications": [],
  "follow_up": "Recommended follow-up or 'None recommended'"
}
${appt.language !== 'en' ? `Write entirely in the ${appt.language} language.` : ''}`;

    const raw = await gemini(prompt).catch(() => null);
    const post_call_summary = raw
      ? safeParseJson(raw, {
          what_we_discussed: doctor_notes || 'Visit completed successfully.',
          next_steps: [],
          medications: [],
          follow_up: 'None recommended'
        })
      : {
          what_we_discussed: doctor_notes || 'Visit completed successfully.',
          next_steps: [],
          medications: [],
          follow_up: 'None recommended'
        };

    const updated = await db.updateAppt(req.params.id, {
      status: 'completed', doctor_notes, post_call_summary, completed_at: new Date().toISOString()
    });
    res.json({ appointment: updated });
  } catch (e) {
    console.error('Complete appointment error:', e);
    res.status(500).json({ error: 'Failed to complete appointment' });
  }
});

// ─── AI Routes ────────────────────────────────────────────────────────────────

app.post('/api/translate', requireAuth, async (req, res) => {
  try {
    const { text, source_language, target_language, appointment_id } = req.body;
    if (!text?.trim()) return res.status(400).json({ error: 'Text required' });

    const translated = await gemini(
      `Translate the following from ${source_language} to ${target_language}. Return ONLY the translated text.\n\n"${text.replace(/"/g, "'")}"`
    );

    if (appointment_id) {
      await db.pushMessage(appointment_id, {
        id: crypto.randomUUID(),
        sender: req.user.role,
        original_text: text,
        original_language: source_language,
        translated_text: translated.trim(),
        translated_language: target_language,
        timestamp: new Date().toISOString()
      });
    }

    res.json({ translated: translated.trim() });
  } catch (e) {
    console.error('Translation error:', e);
    res.status(500).json({ error: 'Translation failed' });
  }
});

// ─── Catch-all SPA ───────────────────────────────────────────────────────────

app.get('*', (_req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

// ─── Start ────────────────────────────────────────────────────────────────────

db.connect()
  .then(() => app.listen(PORT, () => console.log(`Vela running on http://localhost:${PORT}`)))
  .catch((e) => { console.error('Failed to start — database connection error:', e.message); process.exit(1); });
