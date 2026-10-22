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

// Allow up to 50MB payloads to handle large season syncs
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ limit: '50mb', extended: true }));

const MONGO_URI = 'mongodb+srv://richvybs18:Fuckyou2026%24@cluster0.cq4ddne.mongodb.net/?appName=Cluster0';
const DB_NAME = 'ciphertech';
let db;

// Global Time Offset (persists across restarts via DB)
let BOT_TIME_OFFSET = 0;

async function connectDB() {
    try {
        const client = new MongoClient(MONGO_URI);
        await client.connect();
        db = client.db(DB_NAME);
        console.log('✅ MongoDB Connected - CipherTech API');
        
        // Load the last known time offset from DB
        await loadOffset();
    } catch (e) { console.error('MongoDB connection error:', e.message); }
}

async function loadOffset() {
    try {
        const config = await db.collection('config').findOne({ key: 'timeOffset' });
        if (config) {
            BOT_TIME_OFFSET = config.value;
            console.log(`⏱️ Loaded time offset from DB: ${BOT_TIME_OFFSET}ms`);
        }
    } catch (e) { console.error('Failed to load offset:', e.message); }
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

// Auto-Sweeper
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
        if (user.webPassword && user.webPassword !== password) return res.status(401).json({ success: false, message: 'Incorrect password.' });

        const isOwner = ['233504759307', '233557488116'].includes(cleanPhone) || user.role === 'superowner';
        res.json({ success: true, user: { id: user.id, name: user.name, balance: user.balance, role: isOwner ? 'superowner' : 'player', jid: user.jid, hasPassword: !!user.webPassword } });
    } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

// ======================== ADMIN ACTIONS ========================
app.post('/api/admin/balance', async (req, res) => {
    try {
        const { targetJid, amount } = req.body;
        const aviatorDb = db.client.db('aviator');
        const user = await aviatorDb.collection('players').findOne({ jid: targetJid });
        if (!user) return res.status(404).json({ success: false, message: 'User not found' });
        if (user.balance === 'unlimited') return res.json({ success: true });
        await aviatorDb.collection('players').updateOne({ jid: targetJid }, { $inc: { balance: amount } });
        res.json({ success: true });
    } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

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
        await matchesCol().updateOne({ id: matchId }, { $set: { status: 'live', kickoff: Date.now() } });
        res.json({ success: true });
    } catch (e) { res.status(500).json({ success: false }); }
});

app.post('/api/admin/fix', async (req, res) => {
    try {
        const { matchId, market } = req.body;
        let h = 0, a = 0;
        if (market === 'home' || market === '1') h = 2, a = 0;
        else if (market === 'draw' || market === 'X') h = 1, a = 1;
        else if (market === 'away' || market === '2') h = 0, a = 2;
        else if (market === 'btts_yes') h = 2, a = 1;
        else if (market === 'btts_no') h = 2, a = 0;
        else if (market === 'over_0.5') h = 1, a = 0;
        else if (market === 'over_1.5') h = 1, a = 1;
        else if (market === 'over_2.5') h = 2, a = 1;
        else if (market === 'over_3.5') h = 2, a = 2;
        else if (market === 'under_0.5') h = 0, a = 0;
        else if (market === 'under_1.5') h = 1, a = 0;
        else if (market === 'under_2.5') h = 1, a = 1;
        else if (market === 'under_3.5') h = 2, a = 1;
        else if (market === 'ht_home') h = 2, a = 0;
        else if (market === 'ht_draw') h = 1, a = 1;
        else if (market === 'ht_away') h = 0, a = 2;
        else if (market === 'first10_home') h = 1, a = 0;
        else if (market === 'first10_draw') h = 0, a = 0;
        else if (market === 'first10_away') h = 0, a = 1;
        else if (market.startsWith('score_')) {
            const parts = market.replace('score_', '').split('-');
            h = parseInt(parts[0]); a = parseInt(parts[1]);
        } else return res.status(400).json({ success: false, message: 'Invalid market' });

        await matchesCol().updateOne({ id: matchId }, { $set: { fixed: true, result: { home: h, away: a } } });
        res.json({ success: true, score: `${h}-${a}` });
    } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

// ======================== SYNC ROUTES ========================
app.post('/matches/sync', async (req, res) => {
    try {
        const { matches, standings, botId, serverTime } = req.body;
        
        // --- TIME SYNC LOGIC ---
        if (serverTime) {
            BOT_TIME_OFFSET = serverTime - Date.now();
            await db.collection('config').updateOne(
                { key: 'timeOffset' }, 
                { $set: { value: BOT_TIME_OFFSET } }, 
                { upsert: true }
            );
        }

        const col = matchesCol();
        if (!col) return res.json({ success: true });

        for (const [id, match] of Object.entries(matches || {})) {
            // --- SANITIZATION LOGIC ---
            if (match.kickoff) {
                const parsedDate = new Date(match.kickoff);
                if (!isNaN(parsedDate.getTime())) {
                    match.kickoff = Math.floor(parsedDate.getTime()); 
                }
            }

            match.botId = botId;
            match.syncedAt = Date.now();
            await col.updateOne({ id }, { $set: match }, { upsert: true });
            
            if (match.status === 'live' && !activeMatches.has(id)) startMatchSimulation(id, match.fixed ? match.result : null);
        }
        
        if (standings && Object.keys(standings).length > 0) {
            const sCol = standingsCol();
            for (const [league, data] of Object.entries(standings)) {
                await sCol.updateOne({ league }, { $set: { league, data, syncedAt: Date.now() } }, { upsert: true });
            }
        }
        res.json({ success: true });
    } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

app.post('/bets/sync', async (req, res) => {
    try {
        const { bets, botId } = req.body;
        const col = betsCol();
        if (!col) return res.json({ success: true });
        for (const [id, bet] of Object.entries(bets || {})) {
            bet.botId = botId;
            bet.syncedAt = Date.now();
            await col.updateOne({ id }, { $set: bet }, { upsert: true });
        }
        res.json({ success: true });
    } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

// ======================== PLACE BETS ========================
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
            selections.forEach(sel => { totalOdds *= sel.odds; });
            totalOdds = Math.round(totalOdds * 100) / 100;
            const potentialWin = Math.floor(amount * totalOdds);
            const betId = 'ACC' + Date.now().toString(36).toUpperCase().slice(-4);

            const newBet = { id: betId, type: 'accumulator', selections, user: userJid, userId: user.id, userName: user.name, amount, odds: totalOdds, potentialWin, status: 'active', placedAt: Date.now() };
            await betsCol().insertOne(newBet);
            for (const sel of selections) await matchesCol().updateOne({ id: sel.matchId }, { $push: { bets: betId }, $inc: { pool: amount / selections.length } });
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

// ======================== BETS SETTLEMENT ========================
app.post('/api/bets/settle', async (req, res) => {
    try {
        const { matchId } = req.body;
        const match = await matchesCol().findOne({ id: matchId });
        if (!match || !match.result) return res.status(400).json({ success: false });

        const h = match.result.home; const a = match.result.away;
        const totalGoals = h + a;
        const winner = h > a ? 'home' : a > h ? 'away' : 'draw';
        const bets = await betsCol().find({ matchId, status: 'active' }).toArray();
        const aviatorDb = db.client.db('aviator');

        for (const bet of bets) {
            let isWinner = false;
            const p = bet.pick;

            if (p === 'home' || p === 'draw' || p === 'away') isWinner = p === winner;
            else if (p === 'btts_yes') isWinner = h > 0 && a > 0;
            else if (p === 'btts_no') isWinner = !(h > 0 && a > 0);
            else if (p.startsWith('over_')) isWinner = totalGoals > parseFloat(p.split('_')[1]);
            else if (p.startsWith('under_')) isWinner = totalGoals < parseFloat(p.split('_')[1]);
            else if (p.startsWith('handicap_')) {
                const parts = p.split('_'); const team = parts[1]; const val = parseInt(parts[2]);
                const adjH = team === 'home' ? h + val : h;
                const adjA = team === 'away' ? a + val : a;
                isWinner = adjH > adjA ? (team === 'home') : (adjA > adjH ? (team === 'away') : false);
            }
            else if (p === 'ht_home') isWinner = h > a;
            else if (p === 'ht_draw') isWinner = h === a;
            else if (p === 'ht_away') isWinner = a > h;
            else if (p.startsWith('first10_')) isWinner = p.replace('first10_', '') === winner;
            else if (p.startsWith('score_')) isWinner = p.replace('score_', '') === `${h}-${a}`;

            if (isWinner) {
                await betsCol().updateOne({ id: bet.id }, { $set: { status: 'won' } });
                if (bet.user && bet.potentialWin) await aviatorDb.collection('players').updateOne({ jid: bet.user }, { $inc: { balance: bet.potentialWin } });
            } else {
                await betsCol().updateOne({ id: bet.id }, { $set: { status: 'lost' } });
            }
        }
        await matchesCol().updateOne({ id: matchId }, { $set: { settled: true } });
        res.json({ success: true, settled: bets.length });
    } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

// ======================== READ ROUTES ========================
app.get('/matches', async (req, res) => { 
    const matches = await matchesCol().find({}).toArray(); 
    const result = {}; 
    matches.forEach(m => { result[m.id] = m; delete result[m.id]._id; }); 
    res.json({ success: true, matches: result }); 
});
app.get('/bets', async (req, res) => { 
    const bets = await betsCol().find({}).toArray(); 
    const result = {}; 
    bets.forEach(b => { result[b.id] = b; delete result[b.id]._id; }); 
    res.json({ success: true, bets: result }); 
});
app.get('/standings', async (req, res) => { 
    const s = await standingsCol().find({}).toArray(); 
    const result = {}; 
    s.forEach(x => { result[x.league] = x.data; delete result[x.league]._id; }); 
    res.json({ success: true, standings: result }); 
});
app.get('/revenue', async (req, res) => { 
    const rev = await revenueCol().findOne({ type: 'ciphertech' }) || { total: 0 }; 
    delete rev._id; 
    res.json({ success: true, revenue: rev }); 
});

// ======================== CLEANUP & HEALTH ========================
setInterval(async () => {
    try {
        const col = matchesCol();
        if (!col) return;
        const sevenDaysAgo = Date.now() - (7 * 24 * 60 * 60 * 1000);
        await col.deleteMany({ status: 'finished', settled: true, kickoff: { $lt: sevenDaysAgo } });
    } catch (e) {}
}, 3600000);

app.get('/health', (req, res) => {
    res.json({ 
        status: 'ok', 
        db: !!db, 
        timestamp: Date.now() + BOT_TIME_OFFSET
    });
});

server.listen(PORT, () => console.log(`⚽ CipherTech API running on port ${PORT}`));
