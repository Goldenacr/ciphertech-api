const express = require('express');
const path = require('path');
const cors = require('cors');
const { MongoClient } = require('mongodb');
const app = express();
const PORT = process.env.PORT || 3002;

app.use(cors());
app.use(express.json({ limit: '100mb' }));
app.use(express.urlencoded({ limit: '100mb', extended: true }));

const MONGO_URI = 'mongodb+srv://richvybs18:Fuckyou2026%24@cluster0.cq4ddne.mongodb.net/?appName=Cluster0';
const DB_NAME = 'ciphertech';
let db;

async function connectDB() {
    try {
        const client = new MongoClient(MONGO_URI);
        await client.connect();
        db = client.db(DB_NAME);
        console.log('✅ MongoDB Connected - CipherTech API');
    } catch (e) {
        console.error('MongoDB connection error:', e.message);
    }
}
connectDB();

function matchesCol() { return db?.collection('matches'); }
function betsCol() { return db?.collection('bets'); }
function standingsCol() { return db?.collection('standings'); }
function revenueCol() { return db?.collection('revenue'); }

// Matches
app.get('/matches', async (req, res) => {
    try {
        const col = matchesCol();
        if (!col) return res.json({ success: true, matches: {} });
        const matches = await col.find({}).toArray();
        const result = {};
        matches.forEach(m => { result[m.id] = m; delete result[m.id]._id; });
        res.json({ success: true, matches: result });
    } catch (e) { res.status(500).json({ success: false }); }
});

app.post('/matches/sync', async (req, res) => {
    try {
        const { matches, botId } = req.body;
        if (!matches) return res.status(400).json({ success: false });
        const col = matchesCol();
        if (!col) return res.json({ success: true });
        for (const [id, match] of Object.entries(matches)) {
            await col.updateOne({ id }, { $set: { ...match, botId, syncedAt: Date.now() } }, { upsert: true });
        }
        res.json({ success: true });
    } catch (e) { res.status(500).json({ success: false }); }
});

// Bets
app.get('/bets', async (req, res) => {
    try {
        const col = betsCol();
        if (!col) return res.json({ success: true, bets: {} });
        const bets = await col.find({}).toArray();
        const result = {};
        bets.forEach(b => { result[b.id] = b; delete result[b.id]._id; });
        res.json({ success: true, bets: result });
    } catch (e) { res.status(500).json({ success: false }); }
});

app.post('/bets/sync', async (req, res) => {
    try {
        const { bets, botId } = req.body;
        if (!bets) return res.status(400).json({ success: false });
        const col = betsCol();
        if (!col) return res.json({ success: true });
        for (const [id, bet] of Object.entries(bets)) {
            await col.updateOne({ id }, { $set: { ...bet, botId, syncedAt: Date.now() } }, { upsert: true });
        }
        res.json({ success: true });
    } catch (e) { res.status(500).json({ success: false }); }
});

// Standings
app.get('/standings', async (req, res) => {
    try {
        const col = standingsCol();
        if (!col) return res.json({ success: true, standings: {} });
        const standings = await col.find({}).toArray();
        const result = {};
        standings.forEach(s => { result[s.league] = s.data; delete result[s.league]._id; });
        res.json({ success: true, standings: result });
    } catch (e) { res.status(500).json({ success: false }); }
});

app.post('/standings/sync', async (req, res) => {
    try {
        const { league, data } = req.body;
        if (!league) return res.status(400).json({ success: false });
        const col = standingsCol();
        if (col) await col.updateOne({ league }, { $set: { league, data, syncedAt: Date.now() } }, { upsert: true });
        res.json({ success: true });
    } catch (e) { res.status(500).json({ success: false }); }
});

// Revenue
app.get('/revenue', async (req, res) => {
    try {
        const col = revenueCol();
        if (!col) return res.json({ success: true, revenue: { total: 0 } });
        const rev = await col.findOne({ type: 'ciphertech' }) || { total: 0, football: 0, basketball: 0, thisMonth: 0, thisWeek: 0, totalBets: 0 };
        delete rev._id;
        res.json({ success: true, revenue: rev });
    } catch (e) { res.status(500).json({ success: false }); }
});

app.post('/revenue/update', async (req, res) => {
    try {
        const { amount, type } = req.body;
        const col = revenueCol();
        if (!col) return res.json({ success: true });
        const existing = await col.findOne({ type: 'ciphertech' }) || { total: 0, football: 0, basketball: 0, thisMonth: 0, thisWeek: 0, totalBets: 0 };
        existing.total = (existing.total || 0) + (amount || 0);
        existing[type] = (existing[type] || 0) + (amount || 0);
        existing.thisMonth = (existing.thisMonth || 0) + (amount || 0);
        existing.thisWeek = (existing.thisWeek || 0) + (amount || 0);
        existing.totalBets = (existing.totalBets || 0) + 1;
        await col.updateOne({ type: 'ciphertech' }, { $set: existing }, { upsert: true });
        res.json({ success: true });
    } catch (e) { res.status(500).json({ success: false }); }
});

app.get('/health', (req, res) => {
    res.json({ status: 'ok', service: 'ciphertech-api', db: !!db, timestamp: Date.now() });
});

app.listen(PORT, () => console.log(`⚽ CipherTech API running on port ${PORT}`));
