const express = require('express');
const http = require('http');
const { Server } = require("socket.io");
const path = require('path');
const cors = require('cors');
const { MongoClient } = require('mongodb');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*", methods: ["GET", "POST"] } });

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
    } catch (e) { console.error('MongoDB connection error:', e.message); }
}
connectDB();

function matchesCol() { return db?.collection('matches'); }
function betsCol() { return db?.collection('bets'); }
function standingsCol() { return db?.collection('standings'); }
function revenueCol() { return db?.collection('revenue'); }

// ======================== MATCH ENGINE ========================
const activeMatches = new Map();
const commentaryLines = {
    goal: ["GOOOOAL! What a strike!", "The net bulges! Incredible finish!", "Clinical! The keeper had no chance."],
    card: ["That's a booking. Late challenge.", "The referee reaches for the yellow card."],
    corner: ["Corner kick incoming.", "The ball is whipped in... cleared!", "Dangerous set-piece here."],
    save: ["What a save! Fantastic reflexes.", "Denied! The keeper stands tall."],
    miss: ["Over the bar! He should have scored.", "Wide! A golden opportunity wasted."],
    general: ["End-to-end stuff here.", "The midfield battle is intense.", "High pressing from both sides."]
};
function getRandomLine(type) {
    const lines = commentaryLines[type] || commentaryLines.general;
    return lines[Math.floor(Math.random() * lines.length)];
}

function startMatchSimulation(matchId, fixedResult = null) {
    if (activeMatches.has(matchId)) return;
    
    const matchState = {
        id: matchId, minute: 0, score: { home: 0, away: 0 }, events: [], commentary: [],
        isFinished: false, ballPos: { top: '50%', left: '50%' }
    };
    activeMatches.set(matchId, matchState);
    console.log(`⚽ Starting simulation for ${matchId}`);

    const interval = setInterval(async () => {
        matchState.minute += 1; 

        const r = Math.random();
        let event = null; let comment = null;
        let newBallPos = { top: `${Math.floor(Math.random() * 40) + 30}%`, left: `${Math.floor(Math.random() * 40) + 30}%` };

        if (r < 0.06) { 
            const isHome = Math.random() > 0.5;
            if (isHome) matchState.score.home++; else matchState.score.away++;
            event = { type: 'GOAL', team: isHome ? 'home' : 'away', minute: matchState.minute };
            comment = { minute: matchState.minute, text: getRandomLine('goal') };
            newBallPos = isHome ? { top: '2%', left: '50%' } : { top: '98%', left: '50%' }; 
        } else if (r < 0.10) { 
            event = { type: 'CARD', team: Math.random() > 0.5 ? 'home' : 'away', minute: matchState.minute };
            comment = { minute: matchState.minute, text: getRandomLine('card') };
        } else if (r < 0.20) { 
            const isHome = Math.random() > 0.5;
            event = { type: 'CORNER', team: isHome ? 'home' : 'away', minute: matchState.minute };
            comment = { minute: matchState.minute, text: getRandomLine('corner') };
            newBallPos = isHome ? { top: '2%', left: Math.random() > 0.5 ? '2%' : '98%' } : { top: '98%', left: Math.random() > 0.5 ? '2%' : '98%' };
        } else if (r < 0.30) { 
            comment = { minute: matchState.minute, text: getRandomLine(Math.random() > 0.5 ? 'save' : 'general') };
        }

        matchState.ballPos = newBallPos;
        if (event) matchState.events.push(event);
        if (comment) matchState.commentary.push(comment);
        io.emit(`match_update_${matchId}`, matchState);

        if (matchState.minute >= 90) {
            clearInterval(interval);
            matchState.isFinished = true;
            if (fixedResult) matchState.score = fixedResult;
            
            const col = matchesCol();
            await col.updateOne({ id: matchId }, { $set: { status: 'finished', result: matchState.score, events: matchState.events, commentary: matchState.commentary, settled: false }});
            io.emit(`match_update_${matchId}`, matchState);
            activeMatches.delete(matchId);
            console.log(`🏁 Match ${matchId} finished.`);
        }
    }, 1000);
}

setInterval(async () => {
    try {
        const col = matchesCol();
        if (!col) return;
        const liveMatches = await col.find({ status: 'live' }).toArray();
        for (const match of liveMatches) {
            if (!activeMatches.has(match.id)) startMatchSimulation(match.id, match.fixed ? match.result : null);
        }
    } catch (e) {}
}, 5000);

// ======================== AUTH & USERS ========================
app.post('/api/login', async (req, res) => {
    try {
        const { phone, password } = req.body;
        if (!phone) return res.status(400).json({ success: false, message: 'Phone required' });
        
        const cleanPhone = phone.replace(/\D/g, '');
        const aviatorDb = db.client.db('aviator'); 
        const user = await aviatorDb.collection('players').findOne({ $or: [{ cleanJid: cleanPhone }, { jid: { $regex: cleanPhone } }] });
        
        if (!user) return res.status(404).json({ success: false, message: 'Number not registered.' });

        // Password Logic: If user has a webPassword set, require it.
        if (user.webPassword && user.webPassword !== password) {
            return res.status(401).json({ success: false, message: 'Incorrect password.' });
        }

        const isOwner = ['233504759307', '233557488116'].includes(cleanPhone) || user.role === 'superowner';
        res.json({ success: true, user: { id: user.id, name: user.name, balance: user.balance, role: isOwner ? 'superowner' : 'player', jid: user.jid, hasPassword: !!user.webPassword } });
    } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

// ======================== BETS ========================
app.post('/api/bets/place-multiple', async (req, res) => {
    try {
        const { selections, amount, userJid, type } = req.body;
        if (!selections || selections.length === 0) return res.status(400).json({ success: false, message: 'No selections.' });

        const aviatorDb = db.client.db('aviator');
        const user = await aviatorDb.collection('players').findOne({ jid: userJid });
        if (!user) return res.status(404).json({ success: false, message: 'User not found' });
        
        const totalCost = type === 'multiple' ? amount : (amount * selections.length);
        if (user.balance !== 'unlimited' && user.balance < totalCost) return res.status(400).json({ success: false, message: 'Insufficient funds.' });

        if (user.balance !== 'unlimited') await aviatorDb.collection('players').updateOne({ jid: userJid }, { $inc: { balance: -totalCost } });

        if (type === 'multiple') {
            let totalOdds = 1;
            const matchIds = [];
            selections.forEach(sel => { totalOdds *= sel.odds; matchIds.push(sel.matchId); });
            totalOdds = Math.round(totalOdds * 100) / 100;
            const potentialWin = Math.floor(amount * totalOdds);
            const betId = 'ACC' + Date.now().toString(36).toUpperCase().slice(-4);

            const newBet = { id: betId, type: 'accumulator', selections, user: userJid, userId: user.id, userName: user.name, amount, odds: totalOdds, potentialWin, status: 'active', placedAt: Date.now() };
            await betsCol().insertOne(newBet);
            for (const matchId of matchIds) await matchesCol().updateOne({ id: matchId }, { $push: { bets: betId }, $inc: { pool: amount / selections.length } });
            return res.json({ success: true, message: 'Multiple placed', bet: newBet, newBalance: user.balance - totalCost });
        } else {
            const createdBets = [];
            for (const sel of selections) {
                const betId = 'BID' + Date.now().toString(36).toUpperCase().slice(-4) + Math.floor(Math.random() * 10);
                const potentialWin = Math.floor(amount * sel.odds);
                const newBet = { id: betId, matchId: sel.matchId, user: userJid, userId: user.id, userName: user.name, pick: sel.pick, amount, odds: sel.odds, potentialWin, status: 'active', placedAt: Date.now() };
                await betsCol().insertOne(newBet);
                await matchesCol().updateOne({ id: sel.matchId }, { $push: { bets: betId }, $inc: { pool: amount } });
                createdBets.push(newBet);
            }
            return res.json({ success: true, message: `${createdBets.length} Singles placed`, bets: createdBets, newBalance: user.balance - totalCost });
        }
    } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

// ======================== ADMIN ACTIONS ========================
app.post('/api/admin/setpassword', async (req, res) => {
    try {
        const { targetJid, newPassword } = req.body;
        const aviatorDb = db.client.db('aviator');
        await aviatorDb.collection('players').updateOne({ jid: targetJid }, { $set: { webPassword: newPassword } });
        res.json({ success: true });
    } catch (e) { res.status(500).json({ success: false }); }
});

app.post('/api/admin/forcelive', async (req, res) => {
    try {
        const { matchId } = req.body;
        await matchesCol().updateOne({ id: matchId }, { $set: { status: 'live', kickoff: Date.now() - 1000 } });
        res.json({ success: true });
    } catch (e) { res.status(500).json({ success: false }); }
});

// OTHER ROUTES (Matches, Standings, Sync)
app.get('/matches', async (req, res) => { const matches = await matchesCol().find({}).toArray(); const result = {}; matches.forEach(m => { result[m.id] = m; delete result[m.id]._id; }); res.json({ success: true, matches: result }); });
app.get('/bets', async (req, res) => { const bets = await betsCol().find({}).toArray(); const result = {}; bets.forEach(b => { result[b.id] = b; delete result[b.id]._id; }); res.json({ success: true, bets: result }); });
app.get('/standings', async (req, res) => { const s = await standingsCol().find({}).toArray(); const result = {}; s.forEach(x => { result[x.league] = x.data; delete result[x.league]._id; }); res.json({ success: true, standings: result }); });
app.post('/matches/sync', async (req, res) => { const { matches, standings, botId } = req.body; const col = matchesCol(); for (const [id, match] of Object.entries(matches || {})) { match.botId = botId; await col.updateOne({ id }, { $set: match }, { upsert: true }); if (match.status === 'live' && !activeMatches.has(id)) startMatchSimulation(id, match.fixed ? match.result : null); } if (standings) { for (const [l, d] of Object.entries(standings)) await standingsCol().updateOne({ league: l }, { $set: { league: l, data: d } }, { upsert: true }); } res.json({ success: true }); });
app.get('/health', (req, res) => res.json({ status: 'ok' }));
server.listen(PORT, () => console.log(`⚽ CipherTech API running on port ${PORT}`));
