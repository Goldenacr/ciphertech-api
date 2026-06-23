const express = require('express');
const fs = require('fs');
const path = require('path');
const cors = require('cors');
const app = express();
const PORT = process.env.PORT || 3002;

app.use(cors());
app.use(express.json());

const DATA_DIR = path.join(__dirname, 'data');
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

function load(f) { try { if (fs.existsSync(f)) return JSON.parse(fs.readFileSync(f, 'utf8')); } catch (e) {} return {}; }
function save(f, d) { fs.writeFileSync(f, JSON.stringify(d, null, 2)); }

// Matches
app.get('/matches', (req, res) => {
    res.json({ success: true, matches: load(path.join(DATA_DIR, 'matches.json')) });
});
app.post('/matches/sync', (req, res) => {
    const matches = load(path.join(DATA_DIR, 'matches.json'));
    Object.assign(matches, req.body.matches || {});
    save(path.join(DATA_DIR, 'matches.json'), matches);
    res.json({ success: true });
});

// Bets
app.get('/bets', (req, res) => {
    res.json({ success: true, bets: load(path.join(DATA_DIR, 'bets.json')) });
});
app.post('/bets/sync', (req, res) => {
    const bets = load(path.join(DATA_DIR, 'bets.json'));
    Object.assign(bets, req.body.bets || {});
    save(path.join(DATA_DIR, 'bets.json'), bets);
    res.json({ success: true });
});

// Standings
app.get('/standings', (req, res) => {
    res.json({ success: true, standings: load(path.join(DATA_DIR, 'standings.json')) });
});

// Revenue
app.get('/revenue', (req, res) => {
    res.json({ success: true, revenue: load(path.join(DATA_DIR, 'revenue.json')) });
});
app.post('/revenue/update', (req, res) => {
    const rev = load(path.join(DATA_DIR, 'revenue.json'));
    rev.total = (rev.total || 0) + (req.body.amount || 0);
    rev[req.body.type] = (rev[req.body.type] || 0) + (req.body.amount || 0);
    save(path.join(DATA_DIR, 'revenue.json'), rev);
    res.json({ success: true });
});

app.get('/health', (req, res) => {
    res.json({ status: 'ok', service: 'ciphertech-api', timestamp: Date.now() });
});

app.listen(PORT, () => console.log(`⚽ CipherTech API running on port ${PORT}`));