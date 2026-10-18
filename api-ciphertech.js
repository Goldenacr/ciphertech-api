const express = require('express');
const http = require('http');
const { Server } = require("socket.io");
const path = require('path');
const cors = require('cors');
const { MongoClient } = require('mongodb');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: "*", methods: ["GET", "POST"] }
});

const PORT = process.env.PORT || 3002;

app.use(cors());
app.use(express.json());

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

// ======================== MATCH ENGINE (5-Minute Simulation) ========================
const activeMatches = new Map();

function startMatchSimulation(matchId) {
    if (activeMatches.has(matchId)) return;
    
    const matchState = {
        id: matchId,
        minute: 0,
        score: { home: 0, away: 0 },
        events: [],
        isFinished: false
    };
    activeMatches.set(matchId, matchState);

    console.log(`⚽ Starting live simulation for ${matchId}`);

    const interval = setInterval(async () => {
        matchState.minute += 1; // 1 real sec = 1 match minute (5 mins total)

        const r = Math.random();
        let event = null;

        if (r < 0.05) { // Goal
            const isHome = Math.random() > 0.5;
            if (isHome) matchState.score.home++; else matchState.score.away++;
            event = { type: 'GOAL', team: isHome ? 'home' : 'away', minute: matchState.minute, text: 'GOAL!' };
        } else if (r < 0.10) { // Card
            event = { type: 'CARD', team: Math.random() > 0.5 ? 'home' : 'away', minute: matchState.minute, text: 'Yellow Card' };
        } else if (r < 0.15) { // Corner
            event = { type: 'CORNER', team: Math.random() > 0.5 ? 'home' : 'away', minute: matchState.minute };
        }

        if (event) matchState.events.push(event);

        io.emit(`match_update_${matchId}`, matchState);

        if (matchState.minute >= 90) {
            clearInterval(interval);
            matchState.isFinished = true;
            
            const col = matchesCol();
            await col.updateOne(
                { id: matchId },
                { $set: { 
                    status: 'finished', 
                    result: matchState.score, 
                    events: matchState.events,
                    settled: false 
                }}
            );

            io.emit(`match_update_${matchId}`, matchState);
            activeMatches.delete(matchId);
            console.log(`🏁 Match ${matchId} finished. Score: ${matchState.score.home}-${matchState.score.away}`);
        }
    }, 1000);
}

// ======================== MATCHES ========================
app.get('/matches', async (req, res) => {
    try {
        const col = matchesCol();
        if (!col) return res.json({ success: true, matches: {} });
        const matches = await col.find({}).toArray();
        const result = {};
        matches.forEach(m => { result[m.id] = m; delete result[m.id]._id; });
        res.json({ success: true, matches: result });
    } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

app.post('/matches/sync', async (req, res) => {
    try {
        const { matches, botId } = req.body;
        if (!matches) return res.status(400).json({ success: false });
        const col = matchesCol();
        if (!col) return res.json({ success: true });
        for (const [id, match] of Object.entries(matches)) {
            match.botId = botId;
            match.syncedAt = Date.now();
            await col.updateOne({ id }, { $set: match }, { upsert: true });

            // Start live simulation if match just went live
            if (match.status === 'live' && !activeMatches.has(id) && !match.result) {
                startMatchSimulation(id);
            }
        }
        res.json({ success: true });
    } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

// ======================== BETS ========================
app.get('/bets', async (req, res) => {
    try {
        const col = betsCol();
        if (!col) return res.json({ success: true, bets: {} });
        const bets = await col.find({}).toArray();
        const result = {};
        bets.forEach(b => { result[b.id] = b; delete result[b.id]._id; });
        res.json({ success: true, bets: result });
    } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

app.post('/bets/sync', async (req, res) => {
    try {
        const { bets, botId } = req.body;
        if (!bets) return res.status(400).json({ success: false });
        const col = betsCol();
        if (!col) return res.json({ success: true });
        for (const [id, bet] of Object.entries(bets)) {
            bet.botId = botId;
            bet.syncedAt = Date.now();
            await col.updateOne({ id }, { $set: bet }, { upsert: true });
        }
        res.json({ success: true });
    } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

// ======================== STANDINGS ========================
app.get('/standings', async (req, res) => {
    try {
        const col = standingsCol();
        if (!col) return res.json({ success: true, standings: {} });
        const standings = await col.find({}).toArray();
        const result = {};
        standings.forEach(s => { result[s.league] = s.data; delete result[s.league]._id; });
        res.json({ success: true, standings: result });
    } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

app.post('/standings/sync', async (req, res) => {
    try {
        const { league, data } = req.body;
        if (!league) return res.status(400).json({ success: false });
        const col = standingsCol();
        if (col) await col.updateOne({ league }, { $set: { league, data, syncedAt: Date.now() } }, { upsert: true });
        res.json({ success: true });
    } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

// ======================== REVENUE ========================
app.get('/revenue', async (req, res) => {
    try {
        const col = revenueCol();
        if (!col) return res.json({ success: true, revenue: { total: 0 } });
        const rev = await col.findOne({ type: 'ciphertech' }) || { total: 0, thisMonth: 0, thisWeek: 0, totalBets: 0 };
        delete rev._id;
        res.json({ success: true, revenue: rev });
    } catch (e) { res.status(500).json({ success: false, error: e.message }); }
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
    } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

// ======================== HEALTH ========================
app.get('/health', (req, res) => {
    res.json({ status: 'ok', service: 'ciphertech-api', db: !!db, timestamp: Date.now() });
});

// Cleanup
setInterval(async () => {
    try {
        const col = matchesCol();
        if (!col) return;
        const sevenDaysAgo = Date.now() - (7 * 24 * 60 * 60 * 1000);
        await col.deleteMany({ status: 'finished', settled: true, kickoff: { $lt: sevenDaysAgo } });
        console.log('🧹 Cleaned old matches');
    } catch (e) {}
}, 3600000);

server.listen(PORT, () => console.log(`⚽ CipherTech API running on port ${PORT}`));
