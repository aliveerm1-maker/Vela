// ─────────────────────────────────────────────────────────────────────────────
// Data layer — MongoDB when MONGODB_URI is set, JSON files otherwise (local dev).
// Every function is async so the two backends are interchangeable.
// ─────────────────────────────────────────────────────────────────────────────

const fs = require('fs');
const path = require('path');

const USE_MONGO = !!process.env.MONGODB_URI;
let coll = null; // { users, appts }

// ── JSON fallback (local dev / no database configured) ───────────────────────
const DATA_DIR = path.join(__dirname, 'data');
const USERS_FILE = path.join(DATA_DIR, 'users.json');
const APPTS_FILE = path.join(DATA_DIR, 'appointments.json');
if (!USE_MONGO && !fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

const readJson = (file, fb) => {
  try { return fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : fb; }
  catch { return fb; }
};
const writeJson = (file, data) => fs.writeFileSync(file, JSON.stringify(data, null, 2));
const jUsers = () => readJson(USERS_FILE, {});
const jSaveUsers = (u) => writeJson(USERS_FILE, u);
const jAppts = () => readJson(APPTS_FILE, []);
const jSaveAppts = (a) => writeJson(APPTS_FILE, a);

// Strip Mongo's internal _id from returned documents
const clean = (d) => {
  if (d && d._id !== undefined) { const { _id, ...rest } = d; return rest; }
  return d;
};

// ── Connection ───────────────────────────────────────────────────────────────
async function connect() {
  if (!USE_MONGO) {
    console.log('[db] Using JSON file storage. Set MONGODB_URI to use a real database.');
    return;
  }
  const { MongoClient } = require('mongodb');
  const client = new MongoClient(process.env.MONGODB_URI);
  await client.connect();
  const db = client.db(process.env.MONGODB_DB || 'vela');
  coll = { users: db.collection('users'), appts: db.collection('appointments') };
  await Promise.all([
    coll.users.createIndex({ id: 1 }, { unique: true }),
    coll.appts.createIndex({ id: 1 }, { unique: true }),
    coll.appts.createIndex({ status: 1, created_at: 1 }),
    coll.appts.createIndex({ patient_id: 1 }),
    coll.appts.createIndex({ doctor_id: 1 })
  ]);
  console.log('[db] Connected to MongoDB');
}

// ── Users ────────────────────────────────────────────────────────────────────
async function getUser(id) {
  if (!id) return null;
  if (USE_MONGO) return clean(await coll.users.findOne({ id }));
  return jUsers()[id] || null;
}

async function createUserIfAbsent(user) {
  if (USE_MONGO) {
    const existing = await coll.users.findOne({ id: user.id });
    if (existing) return clean(existing);
    await coll.users.insertOne({ ...user });
    return user;
  }
  const users = jUsers();
  if (!users[user.id]) { users[user.id] = user; jSaveUsers(users); }
  return users[user.id];
}

async function updateUser(id, fields) {
  if (USE_MONGO) {
    await coll.users.updateOne({ id }, { $set: fields });
    return clean(await coll.users.findOne({ id }));
  }
  const users = jUsers();
  if (!users[id]) return null;
  Object.assign(users[id], fields);
  jSaveUsers(users);
  return users[id];
}

// ── Appointments ─────────────────────────────────────────────────────────────
async function createAppt(appt) {
  if (USE_MONGO) { await coll.appts.insertOne({ ...appt }); return appt; }
  const appts = jAppts(); appts.push(appt); jSaveAppts(appts); return appt;
}

async function getApptById(id) {
  if (USE_MONGO) return clean(await coll.appts.findOne({ id }));
  return jAppts().find(a => a.id === id) || null;
}

async function getApptsForUser(userId, role) {
  if (USE_MONGO) {
    const q = role === 'patient' ? { patient_id: userId } : { doctor_id: userId };
    return (await coll.appts.find(q).sort({ created_at: -1 }).toArray()).map(clean);
  }
  const appts = jAppts().filter(a => role === 'patient' ? a.patient_id === userId : a.doctor_id === userId);
  return appts.sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
}

async function getQueue() {
  if (USE_MONGO) {
    return (await coll.appts.find({ status: 'pending' }).sort({ created_at: 1 }).toArray()).map(clean);
  }
  return jAppts().filter(a => a.status === 'pending').sort((a, b) => new Date(a.created_at) - new Date(b.created_at));
}

async function updateAppt(id, fields) {
  if (USE_MONGO) {
    await coll.appts.updateOne({ id }, { $set: fields });
    return clean(await coll.appts.findOne({ id }));
  }
  const appts = jAppts();
  const i = appts.findIndex(a => a.id === id);
  if (i === -1) return null;
  appts[i] = { ...appts[i], ...fields };
  jSaveAppts(appts);
  return appts[i];
}

// Atomically move a pending appointment to active so two doctors can't grab the same one
async function claimAppt(id, doctorFields) {
  if (USE_MONGO) {
    const res = await coll.appts.findOneAndUpdate(
      { id, status: 'pending' },
      { $set: { ...doctorFields, status: 'active' } },
      { returnDocument: 'after' }
    );
    const doc = res && res.value !== undefined ? res.value : res; // v5/v6 compat
    return doc ? clean(doc) : null;
  }
  const appts = jAppts();
  const i = appts.findIndex(a => a.id === id && a.status === 'pending');
  if (i === -1) return null;
  appts[i] = { ...appts[i], ...doctorFields, status: 'active' };
  jSaveAppts(appts);
  return appts[i];
}

async function pushMessage(id, message) {
  if (USE_MONGO) { await coll.appts.updateOne({ id }, { $push: { messages: message } }); return; }
  const appts = jAppts();
  const i = appts.findIndex(a => a.id === id);
  if (i !== -1) { appts[i].messages.push(message); jSaveAppts(appts); }
}

module.exports = {
  connect, USE_MONGO,
  getUser, createUserIfAbsent, updateUser,
  createAppt, getApptById, getApptsForUser, getQueue, updateAppt, claimAppt, pushMessage
};
