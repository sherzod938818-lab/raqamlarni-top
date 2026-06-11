const WebSocket = require('ws');
const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = process.env.PORT || 3000;

const server = http.createServer((req, res) => {
  fs.readFile(path.join(__dirname, 'index.html'), (err, data) => {
    if (err) { res.writeHead(404); res.end('Not found'); return; }
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end(data);
  });
});

const wss = new WebSocket.Server({ server });
const numRooms = {};
const fruRooms = {};
const minRooms = {};
const playerRoom = new Map();

function sendTo(ws, data) {
  if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(data));
}
function randomId() { return Math.floor(1000 + Math.random() * 9000).toString(); }

function broadcastRooms(roomsObj, type) {
  const list = Object.entries(roomsObj)
    .filter(([, r]) => r.players.length === 1 && !r.isBot)
    .map(([id, r]) => ({ id, name: r.name, host: r.usernames[0] }));
  wss.clients.forEach(c => {
    if (c.readyState === WebSocket.OPEN)
      c.send(JSON.stringify({ type, rooms: list }));
  });
}

function startTimer(roomId, roomsObj, broadcastType, onTimeout) {
  const room = roomsObj[roomId];
  if (!room) return;
  if (room.timer) clearInterval(room.timer);
  room.timeLeft = 30;
  room.players.forEach(p => { if (p) sendTo(p, { type: `${broadcastType}_timer`, timeLeft: 30 }); });
  room.timer = setInterval(() => {
    if (!roomsObj[roomId]) { clearInterval(room.timer); return; }
    room.timeLeft--;
    room.players.forEach(p => { if (p) sendTo(p, { type: `${broadcastType}_timer`, timeLeft: room.timeLeft }); });
    if (room.timeLeft <= 0) {
      clearInterval(room.timer);
      onTimeout(roomId);
    }
  }, 1000);
}

function checkGuess(secret, guess) {
  const result = ['_','_','_','_'];
  for (let i = 0; i < 4; i++)
    if (guess[i] === secret[i]) result[i] = guess[i];
  return result;
}

// ===== BOT LOGIKASI =====
const BOT_WS = null; // Bot uchun null ishlatamiz

function botRandomCells(count, max) {
  const cells = [];
  while (cells.length < count) {
    const c = Math.floor(Math.random() * max);
    if (!cells.includes(c)) cells.push(c);
  }
  return cells;
}

function botThink(ms) { return new Promise(r => setTimeout(r, ms)); }

// NUM BOT
async function numBotPlay(roomId) {
  const room = numRooms[roomId];
  if (!room || !room.isBot) return;

  // Bot son tanlaydi
  const botNumber = String(Math.floor(1000 + Math.random() * 9000));
  room.numbers[1] = botNumber;

  if (room.numbers[0]) {
    room.players[0] && sendTo(room.players[0], { type: 'num_game_start', yourTurn: true, opponentName: '🤖 Bot' });
    startTimer(roomId, numRooms, 'num', (rId) => {
      const r = numRooms[rId];
      if (!r) return;
      r.currentTurn = 1 - r.currentTurn;
      sendTo(r.players[0], { type: 'num_timeout', yourTurn: r.currentTurn === 0 });
      if (r.currentTurn === 1) numBotGuess(rId);
    });
  }
}

async function numBotGuess(roomId) {
  await botThink(1000 + Math.random() * 1000);
  const room = numRooms[roomId];
  if (!room || !room.isBot) return;

  // Bot tasodifiy taxmin qiladi
  const guess = String(Math.floor(1000 + Math.random() * 9000));
  const secret = room.numbers[0];
  const result = checkGuess(secret.split(''), guess.split(''));
  const won = result.join('') === secret;

  sendTo(room.players[0], {
    type: 'num_guess_result',
    guesserIdx: 1,
    guess, result, won,
    yourTurn: won ? false : true
  });

  if (won) {
    if (room.timer) clearInterval(room.timer);
    delete numRooms[roomId];
  } else {
    startTimer(roomId, numRooms, 'num', (rId) => {
      const r = numRooms[rId];
      if (!r) return;
      r.currentTurn = 1 - r.currentTurn;
      sendTo(r.players[0], { type: 'num_timeout', yourTurn: r.currentTurn === 0 });
      if (r.currentTurn === 1) numBotGuess(rId);
    });
  }
}

// FRU BOT
async function fruBotPlay(roomId) {
  await botThink(800);
  const room = fruRooms[roomId];
  if (!room || !room.isBot) return;

  room.hidden[1] = botRandomCells(3, 9);
  room.board[1] = [];

  if (room.hidden[0]) {
    room.players[0] && sendTo(room.players[0], { type: 'fru_game_start', yourTurn: true, opponentName: '🤖 Bot' });
    startTimer(roomId, fruRooms, 'fru', (rId) => {
      const r = fruRooms[rId];
      if (!r) return;
      r.currentTurn = 1 - r.currentTurn;
      sendTo(r.players[0], { type: 'fru_timeout', yourTurn: r.currentTurn === 0 });
      if (r.currentTurn === 1) fruBotMove(rId);
    });
  }
}

async function fruBotMove(roomId) {
  await botThink(800 + Math.random() * 800);
  const room = fruRooms[roomId];
  if (!room || !room.isBot) return;

  // Bot ochilmagan katakchalardan birini tanlaydi
  const opened = room.board[0] || [];
  const available = [...Array(9).keys()].filter(i => !opened.includes(i));
  if (available.length === 0) return;

  const cell = available[Math.floor(Math.random() * available.length)];
  const hit = room.hidden[0].includes(cell);
  if (!room.board[0]) room.board[0] = [];
  if (!room.board[0].includes(cell)) room.board[0].push(cell);
  const won = room.hidden[0].every(c => room.board[0].includes(c));

  sendTo(room.players[0], {
    type: 'fru_cell_result',
    attackerIdx: 1,
    cell, hit, won,
    yourTurn: won ? false : (!hit ? true : false)
  });

  if (won) {
    if (room.timer) clearInterval(room.timer);
    delete fruRooms[roomId];
  } else {
    if (hit) {
      // Bot yana ochadi
      fruBotMove(roomId);
    } else {
      startTimer(roomId, fruRooms, 'fru', (rId) => {
        const r = fruRooms[rId];
        if (!r) return;
        r.currentTurn = 1 - r.currentTurn;
        sendTo(r.players[0], { type: 'fru_timeout', yourTurn: r.currentTurn === 0 });
        if (r.currentTurn === 1) fruBotMove(rId);
      });
    }
  }
}

// MIN BOT
async function minBotPlay(roomId) {
  await botThink(800);
  const room = minRooms[roomId];
  if (!room || !room.isBot) return;

  room.mines[1] = botRandomCells(4, 16);

  if (room.mines[0]) {
    sendTo(room.players[0], { type: 'min_game_start', yourTurn: true, opponentName: '🤖 Bot' });
    startTimer(roomId, minRooms, 'min', (rId) => {
      const r = minRooms[rId];
      if (!r) return;
      r.currentTurn = 1 - r.currentTurn;
      sendTo(r.players[0], { type: 'min_timeout', yourTurn: r.currentTurn === 0 });
      if (r.currentTurn === 1) minBotMove(rId);
    });
  }
}

async function minBotMove(roomId) {
  await botThink(800 + Math.random() * 800);
  const room = minRooms[roomId];
  if (!room || !room.isBot) return;

  const opened = room.opened[0] || [];
  const available = [...Array(16).keys()].filter(i => !opened.includes(i));
  if (available.length === 0) return;

  const cell = available[Math.floor(Math.random() * available.length)];
  const isMine = room.mines[0].includes(cell);
  if (!room.opened[0]) room.opened[0] = [];
  if (!room.opened[0].includes(cell)) room.opened[0].push(cell);
  if (isMine) room.minesFound[1]++;
  const lost = room.minesFound[1] >= 4;

  sendTo(room.players[0], {
    type: 'min_cell_result',
    attackerIdx: 1,
    cell, isMine,
    minesFound: room.minesFound,
    lost, loserIdx: lost ? 1 : -1,
    yourTurn: lost ? false : (isMine ? false : true)
  });

  if (lost) {
    if (room.timer) clearInterval(room.timer);
    delete minRooms[roomId];
  } else {
    if (isMine) {
      minBotMove(roomId);
    } else {
      startTimer(roomId, minRooms, 'min', (rId) => {
        const r = minRooms[rId];
        if (!r) return;
        r.currentTurn = 1 - r.currentTurn;
        sendTo(r.players[0], { type: 'min_timeout', yourTurn: r.currentTurn === 0 });
        if (r.currentTurn === 1) minBotMove(rId);
      });
    }
  }
}

// ===== WS CONNECTION =====
wss.on('connection', (ws) => {
  ['num','fru','min'].forEach(g => {
    const rooms = g === 'num' ? numRooms : g === 'fru' ? fruRooms : minRooms;
    const list = Object.entries(rooms)
      .filter(([, r]) => r.players.length === 1 && !r.isBot)
      .map(([id, r]) => ({ id, name: r.name, host: r.usernames[0] }));
    sendTo(ws, { type: `${g}_room_list`, rooms: list });
  });

  ws.on('message', (message) => {
    let data;
    try { data = JSON.parse(message); } catch { return; }

    // ===== RAQAMLARNI TOP =====
    if (data.type === 'num_create_room') {
      const roomId = randomId();
      numRooms[roomId] = {
        name: data.name || data.username, isBot: false,
        players: [ws], usernames: [data.username],
        numbers: [null, null], currentTurn: 0, timer: null, timeLeft: 30
      };
      playerRoom.set(ws, { game: 'num', roomId });
      sendTo(ws, { type: 'num_room_created', roomId, playerIndex: 0 });
      broadcastRooms(numRooms, 'num_room_list');
    }
    else if (data.type === 'num_vs_bot') {
      const roomId = randomId();
      numRooms[roomId] = {
        name: 'Bot', isBot: true,
        players: [ws, null], usernames: [data.username, '🤖 Bot'],
        numbers: [null, null], currentTurn: 0, timer: null, timeLeft: 30
      };
      playerRoom.set(ws, { game: 'num', roomId });
      sendTo(ws, { type: 'num_opponent_joined', opponentName: '🤖 Bot' });
    }
    else if (data.type === 'num_join_room') {
      const room = numRooms[data.roomId];
      if (!room) return sendTo(ws, { type: 'error', msg: 'Xona topilmadi' });
      if (room.players.length >= 2) return sendTo(ws, { type: 'error', msg: 'Xona to\'liq' });
      room.players.push(ws);
      room.usernames.push(data.username);
      playerRoom.set(ws, { game: 'num', roomId: data.roomId });
      sendTo(ws, { type: 'num_room_joined', roomId: data.roomId, playerIndex: 1 });
      room.players.forEach((p, i) => sendTo(p, { type: 'num_opponent_joined', opponentName: room.usernames[1-i] }));
      broadcastRooms(numRooms, 'num_room_list');
    }
    else if (data.type === 'num_set_number') {
      const pr = playerRoom.get(ws);
      const room = pr && numRooms[pr.roomId];
      if (!room) return;
      const idx = room.players.indexOf(ws);
      room.numbers[idx] = data.number;
      sendTo(ws, { type: 'num_number_set' });
      if (room.isBot) {
        numBotPlay(pr.roomId);
      } else if (room.numbers[0] && room.numbers[1]) {
        room.players.forEach((p, i) => sendTo(p, { type: 'num_game_start', yourTurn: i === 0, opponentName: room.usernames[1-i] }));
        startTimer(pr.roomId, numRooms, 'num', (rId) => {
          const r = numRooms[rId];
          if (!r) return;
          r.currentTurn = 1 - r.currentTurn;
          r.players.forEach((p, i) => { if (p) sendTo(p, { type: 'num_timeout', yourTurn: i === r.currentTurn }); });
          if (r.isBot && r.currentTurn === 1) numBotGuess(rId);
        });
      }
    }
    else if (data.type === 'num_guess') {
      const pr = playerRoom.get(ws);
      const room = pr && numRooms[pr.roomId];
      if (!room) return;
      const attackerIdx = room.players.indexOf(ws);
      const defenderIdx = 1 - attackerIdx;
      const secret = room.numbers[defenderIdx];
      const result = checkGuess(secret.split(''), data.number.split(''));
      const won = result.join('') === secret;
      room.players.forEach((p, i) => {
        if (p) sendTo(p, { type: 'num_guess_result', guesserIdx: attackerIdx, guess: data.number, result, won, yourTurn: won ? false : i === defenderIdx });
      });
      if (won) {
        if (room.timer) clearInterval(room.timer);
        delete numRooms[pr.roomId];
        room.players.forEach(p => { if (p) playerRoom.delete(p); });
        broadcastRooms(numRooms, 'num_room_list');
      } else {
        room.currentTurn = defenderIdx;
        startTimer(pr.roomId, numRooms, 'num', (rId) => {
          const r = numRooms[rId];
          if (!r) return;
          r.currentTurn = 1 - r.currentTurn;
          r.players.forEach((p, i) => { if (p) sendTo(p, { type: 'num_timeout', yourTurn: i === r.currentTurn }); });
          if (r.isBot && r.currentTurn === 1) numBotGuess(rId);
        });
        if (room.isBot && defenderIdx === 1) numBotGuess(pr.roomId);
      }
    }
    else if (data.type === 'num_reaction') {
      const pr = playerRoom.get(ws);
      const room = pr && numRooms[pr.roomId];
      if (!room) return;
      const idx = room.players.indexOf(ws);
      room.players.forEach((p, i) => { if (i !== idx && p) sendTo(p, { type: 'num_reaction', emoji: data.emoji }); });
    }

    // ===== TOLMANAK =====
    else if (data.type === 'fru_create_room') {
      const roomId = randomId();
      fruRooms[roomId] = {
        name: data.name || data.username, isBot: false,
        players: [ws], usernames: [data.username],
        hidden: [null, null], board: [null, null], currentTurn: 0, timer: null
      };
      playerRoom.set(ws, { game: 'fru', roomId });
      sendTo(ws, { type: 'fru_room_created', roomId, playerIndex: 0 });
      broadcastRooms(fruRooms, 'fru_room_list');
    }
    else if (data.type === 'fru_vs_bot') {
      const roomId = randomId();
      fruRooms[roomId] = {
        name: 'Bot', isBot: true,
        players: [ws, null], usernames: [data.username, '🤖 Bot'],
        hidden: [null, null], board: [null, null], currentTurn: 0, timer: null
      };
      playerRoom.set(ws, { game: 'fru', roomId });
      sendTo(ws, { type: 'fru_opponent_joined', opponentName: '🤖 Bot' });
    }
    else if (data.type === 'fru_join_room') {
      const room = fruRooms[data.roomId];
      if (!room) return sendTo(ws, { type: 'error', msg: 'Xona topilmadi' });
      if (room.players.length >= 2) return sendTo(ws, { type: 'error', msg: 'Xona to\'liq' });
      room.players.push(ws);
      room.usernames.push(data.username);
      playerRoom.set(ws, { game: 'fru', roomId: data.roomId });
      sendTo(ws, { type: 'fru_room_joined', roomId: data.roomId, playerIndex: 1 });
      room.players.forEach((p, i) => sendTo(p, { type: 'fru_opponent_joined', opponentName: room.usernames[1-i] }));
      broadcastRooms(fruRooms, 'fru_room_list');
    }
    else if (data.type === 'fru_set_hidden') {
      const pr = playerRoom.get(ws);
      const room = pr && fruRooms[pr.roomId];
      if (!room) return;
      const idx = room.players.indexOf(ws);
      room.hidden[idx] = data.cells;
      room.board[idx] = [];
      sendTo(ws, { type: 'fru_hidden_set' });
      if (room.isBot) {
        fruBotPlay(pr.roomId);
      } else if (room.hidden[0] && room.hidden[1]) {
        room.players.forEach((p, i) => sendTo(p, { type: 'fru_game_start', yourTurn: i === 0, opponentName: room.usernames[1-i] }));
        startTimer(pr.roomId, fruRooms, 'fru', (rId) => {
          const r = fruRooms[rId];
          if (!r) return;
          r.currentTurn = 1 - r.currentTurn;
          r.players.forEach((p, i) => { if (p) sendTo(p, { type: 'fru_timeout', yourTurn: i === r.currentTurn }); });
          if (r.isBot && r.currentTurn === 1) fruBotMove(rId);
        });
      }
    }
    else if (data.type === 'fru_open_cell') {
      const pr = playerRoom.get(ws);
      const room = pr && fruRooms[pr.roomId];
      if (!room || room.locked) return;
      room.locked = true;
      const attackerIdx = room.players.indexOf(ws);
      const defenderIdx = 1 - attackerIdx;
      const cell = data.cell;
      const hit = room.hidden[defenderIdx].includes(cell);
      if (!room.board[defenderIdx].includes(cell)) room.board[defenderIdx].push(cell);
      const won = room.hidden[defenderIdx].every(c => room.board[defenderIdx].includes(c));
      room.players.forEach((p, i) => {
        if (p) sendTo(p, { type: 'fru_cell_result', attackerIdx, cell, hit, won, yourTurn: won ? false : (!hit ? i === defenderIdx : i === attackerIdx) });
      });
      room.locked = false;
      if (won) {
        if (room.timer) clearInterval(room.timer);
        delete fruRooms[pr.roomId];
        room.players.forEach(p => { if (p) playerRoom.delete(p); });
        broadcastRooms(fruRooms, 'fru_room_list');
      } else {
        room.currentTurn = hit ? attackerIdx : defenderIdx;
        startTimer(pr.roomId, fruRooms, 'fru', (rId) => {
          const r = fruRooms[rId];
          if (!r) return;
          r.currentTurn = 1 - r.currentTurn;
          r.players.forEach((p, i) => { if (p) sendTo(p, { type: 'fru_timeout', yourTurn: i === r.currentTurn }); });
          if (r.isBot && r.currentTurn === 1) fruBotMove(rId);
        });
        if (room.isBot && !hit) fruBotMove(pr.roomId);
      }
    }
    else if (data.type === 'fru_reaction') {
      const pr = playerRoom.get(ws);
      const room = pr && fruRooms[pr.roomId];
      if (!room) return;
      const idx = room.players.indexOf(ws);
      room.players.forEach((p, i) => { if (i !== idx && p) sendTo(p, { type: 'fru_reaction', emoji: data.emoji }); });
    }

    // ===== MINALAR =====
    else if (data.type === 'min_create_room') {
      const roomId = randomId();
      minRooms[roomId] = {
        name: data.name || data.username, isBot: false,
        players: [ws], usernames: [data.username],
        mines: [null, null], opened: [[], []], minesFound: [0, 0], currentTurn: 0, timer: null
      };
      playerRoom.set(ws, { game: 'min', roomId });
      sendTo(ws, { type: 'min_room_created', roomId, playerIndex: 0 });
      broadcastRooms(minRooms, 'min_room_list');
    }
    else if (data.type === 'min_vs_bot') {
      const roomId = randomId();
      minRooms[roomId] = {
        name: 'Bot', isBot: true,
        players: [ws, null], usernames: [data.username, '🤖 Bot'],
        mines: [null, null], opened: [[], []], minesFound: [0, 0], currentTurn: 0, timer: null
      };
      playerRoom.set(ws, { game: 'min', roomId });
      sendTo(ws, { type: 'min_opponent_joined', opponentName: '🤖 Bot' });
    }
    else if (data.type === 'min_join_room') {
      const room = minRooms[data.roomId];
      if (!room) return sendTo(ws, { type: 'error', msg: 'Xona topilmadi' });
      if (room.players.length >= 2) return sendTo(ws, { type: 'error', msg: 'Xona to\'liq' });
      room.players.push(ws);
      room.usernames.push(data.username);
      playerRoom.set(ws, { game: 'min', roomId: data.roomId });
      sendTo(ws, { type: 'min_room_joined', roomId: data.roomId, playerIndex: 1 });
      room.players.forEach((p, i) => sendTo(p, { type: 'min_opponent_joined', opponentName: room.usernames[1-i] }));
      broadcastRooms(minRooms, 'min_room_list');
    }
    else if (data.type === 'min_set_mines') {
      const pr = playerRoom.get(ws);
      const room = pr && minRooms[pr.roomId];
      if (!room) return;
      const idx = room.players.indexOf(ws);
      room.mines[idx] = data.cells;
      sendTo(ws, { type: 'min_mines_set' });
      if (room.isBot) {
        minBotPlay(pr.roomId);
      } else if (room.mines[0] && room.mines[1]) {
        room.players.forEach((p, i) => sendTo(p, { type: 'min_game_start', yourTurn: i === 0, opponentName: room.usernames[1-i] }));
        startTimer(pr.roomId, minRooms, 'min', (rId) => {
          const r = minRooms[rId];
          if (!r) return;
          r.currentTurn = 1 - r.currentTurn;
          r.players.forEach((p, i) => { if (p) sendTo(p, { type: 'min_timeout', yourTurn: i === r.currentTurn }); });
          if (r.isBot && r.currentTurn === 1) minBotMove(rId);
        });
      }
    }
    else if (data.type === 'min_open_cell') {
      const pr = playerRoom.get(ws);
      const room = pr && minRooms[pr.roomId];
      if (!room || room.locked) return;
      room.locked = true;
      const attackerIdx = room.players.indexOf(ws);
      const defenderIdx = 1 - attackerIdx;
      const cell = data.cell;
      const isMine = room.mines[defenderIdx].includes(cell);
      if (!room.opened[defenderIdx].includes(cell)) room.opened[defenderIdx].push(cell);
      if (isMine) room.minesFound[attackerIdx]++;
      const lost = room.minesFound[attackerIdx] >= 4;
      room.players.forEach((p, i) => {
        if (p) sendTo(p, { type: 'min_cell_result', attackerIdx, cell, isMine, minesFound: room.minesFound, lost, loserIdx: lost ? attackerIdx : -1, yourTurn: lost ? false : (isMine ? i === attackerIdx : i === defenderIdx) });
      });
      room.locked = false;
      if (lost) {
        if (room.timer) clearInterval(room.timer);
        delete minRooms[pr.roomId];
        room.players.forEach(p => { if (p) playerRoom.delete(p); });
        broadcastRooms(minRooms, 'min_room_list');
      } else {
        room.currentTurn = isMine ? attackerIdx : defenderIdx;
        startTimer(pr.roomId, minRooms, 'min', (rId) => {
          const r = minRooms[rId];
          if (!r) return;
          r.currentTurn = 1 - r.currentTurn;
          r.players.forEach((p, i) => { if (p) sendTo(p, { type: 'min_timeout', yourTurn: i === r.currentTurn }); });
          if (r.isBot && r.currentTurn === 1) minBotMove(rId);
        });
        if (room.isBot && !isMine) minBotMove(pr.roomId);
      }
    }
    else if (data.type === 'min_reaction') {
      const pr = playerRoom.get(ws);
      const room = pr && minRooms[pr.roomId];
      if (!room) return;
      const idx = room.players.indexOf(ws);
      room.players.forEach((p, i) => { if (i !== idx && p) sendTo(p, { type: 'min_reaction', emoji: data.emoji }); });
    }
  });

  ws.on('close', () => {
    const pr = playerRoom.get(ws);
    if (pr) {
      const roomsMap = pr.game === 'num' ? numRooms : pr.game === 'fru' ? fruRooms : minRooms;
      const room = roomsMap[pr.roomId];
      if (room) {
        if (room.timer) clearInterval(room.timer);
        room.players.forEach(p => { if (p && p !== ws) sendTo(p, { type: 'opponent_left' }); if (p) playerRoom.delete(p); });
        delete roomsMap[pr.roomId];
        broadcastRooms(roomsMap, `${pr.game}_room_list`);
      }
    }
    playerRoom.delete(ws);
  });
});

server.listen(PORT, () => console.log(`Server started on port ${PORT}`));
