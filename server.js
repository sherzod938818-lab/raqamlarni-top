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
  if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(data));
}

function randomId() {
  return Math.floor(1000 + Math.random() * 9000).toString();
}

function broadcastRooms(roomsObj, type) {
  const list = Object.entries(roomsObj)
    .filter(([, r]) => r.players.length === 1)
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
  room.players.forEach(p => sendTo(p, { type: `${broadcastType}_timer`, timeLeft: 30 }));
  room.timer = setInterval(() => {
    if (!roomsObj[roomId]) { clearInterval(room.timer); return; }
    room.timeLeft--;
    room.players.forEach(p => sendTo(p, { type: `${broadcastType}_timer`, timeLeft: room.timeLeft }));
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

wss.on('connection', (ws) => {
  ['num','fru','min'].forEach(g => {
    const rooms = g === 'num' ? numRooms : g === 'fru' ? fruRooms : minRooms;
    const list = Object.entries(rooms)
      .filter(([, r]) => r.players.length === 1)
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
        name: data.name || data.username,
        players: [ws], usernames: [data.username],
        numbers: [null, null], currentTurn: 0, timer: null, timeLeft: 30
      };
      playerRoom.set(ws, { game: 'num', roomId });
      sendTo(ws, { type: 'num_room_created', roomId, playerIndex: 0 });
      broadcastRooms(numRooms, 'num_room_list');
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
      if (room.numbers[0] && room.numbers[1]) {
        room.players.forEach((p, i) => sendTo(p, { type: 'num_game_start', yourTurn: i === 0, opponentName: room.usernames[1-i] }));
        startTimer(pr.roomId, numRooms, 'num', (rId) => {
          const r = numRooms[rId];
          if (!r) return;
          const cur = r.currentTurn;
          r.currentTurn = 1 - cur;
          r.players.forEach((p, i) => sendTo(p, { type: 'num_timeout', yourTurn: i === r.currentTurn }));
          startTimer(rId, numRooms, 'num', arguments.callee);
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
      room.players.forEach((p, i) => sendTo(p, {
        type: 'num_guess_result', guesserIdx: attackerIdx,
        guess: data.number, result, won,
        yourTurn: won ? false : i === defenderIdx
      }));
      if (won) {
        if (room.timer) clearInterval(room.timer);
        delete numRooms[pr.roomId];
        room.players.forEach(p => playerRoom.delete(p));
        broadcastRooms(numRooms, 'num_room_list');
      } else {
        room.currentTurn = defenderIdx;
        startTimer(pr.roomId, numRooms, 'num', (rId) => {
          const r = numRooms[rId];
          if (!r) return;
          r.currentTurn = 1 - r.currentTurn;
          r.players.forEach((p, i) => sendTo(p, { type: 'num_timeout', yourTurn: i === r.currentTurn }));
          startTimer(rId, numRooms, 'num', arguments.callee);
        });
      }
    }
    else if (data.type === 'num_reaction') {
      const pr = playerRoom.get(ws);
      const room = pr && numRooms[pr.roomId];
      if (!room) return;
      const idx = room.players.indexOf(ws);
      room.players.forEach((p, i) => { if (i !== idx) sendTo(p, { type: 'num_reaction', emoji: data.emoji }); });
    }

    // ===== TOLMANAK =====
    else if (data.type === 'fru_create_room') {
      const roomId = randomId();
      fruRooms[roomId] = {
        name: data.name || data.username,
        players: [ws], usernames: [data.username],
        hidden: [null, null], board: [null, null], currentTurn: 0, timer: null
      };
      playerRoom.set(ws, { game: 'fru', roomId });
      sendTo(ws, { type: 'fru_room_created', roomId, playerIndex: 0 });
      broadcastRooms(fruRooms, 'fru_room_list');
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
      if (room.hidden[0] && room.hidden[1]) {
        room.players.forEach((p, i) => sendTo(p, { type: 'fru_game_start', yourTurn: i === 0, opponentName: room.usernames[1-i] }));
        startTimer(pr.roomId, fruRooms, 'fru', (rId) => {
          const r = fruRooms[rId];
          if (!r) return;
          r.currentTurn = 1 - r.currentTurn;
          r.players.forEach((p, i) => sendTo(p, { type: 'fru_timeout', yourTurn: i === r.currentTurn }));
          startTimer(rId, fruRooms, 'fru', arguments.callee);
        });
      }
    }
    else if (data.type === 'fru_open_cell') {
      const pr = playerRoom.get(ws);
      const room = pr && fruRooms[pr.roomId];
      if (!room) return;
      const attackerIdx = room.players.indexOf(ws);
      const defenderIdx = 1 - attackerIdx;
      const cell = data.cell;
      const hit = room.hidden[defenderIdx].includes(cell);
      if (!room.board[defenderIdx].includes(cell)) room.board[defenderIdx].push(cell);
      const won = room.hidden[defenderIdx].every(c => room.board[defenderIdx].includes(c));
      room.players.forEach((p, i) => sendTo(p, {
        type: 'fru_cell_result', attackerIdx, cell, hit, won,
        yourTurn: won ? false : (!hit ? i === defenderIdx : i === attackerIdx)
      }));
      if (won) {
        if (room.timer) clearInterval(room.timer);
        delete fruRooms[pr.roomId];
        room.players.forEach(p => playerRoom.delete(p));
        broadcastRooms(fruRooms, 'fru_room_list');
      } else {
        room.currentTurn = hit ? attackerIdx : defenderIdx;
        startTimer(pr.roomId, fruRooms, 'fru', (rId) => {
          const r = fruRooms[rId];
          if (!r) return;
          r.currentTurn = 1 - r.currentTurn;
          r.players.forEach((p, i) => sendTo(p, { type: 'fru_timeout', yourTurn: i === r.currentTurn }));
          startTimer(rId, fruRooms, 'fru', arguments.callee);
        });
      }
    }
    else if (data.type === 'fru_reaction') {
      const pr = playerRoom.get(ws);
      const room = pr && fruRooms[pr.roomId];
      if (!room) return;
      const idx = room.players.indexOf(ws);
      room.players.forEach((p, i) => { if (i !== idx) sendTo(p, { type: 'fru_reaction', emoji: data.emoji }); });
    }

    // ===== MINALAR =====
    else if (data.type === 'min_create_room') {
      const roomId = randomId();
      minRooms[roomId] = {
        name: data.name || data.username,
        players: [ws], usernames: [data.username],
        mines: [null, null], opened: [[], []], minesFound: [0, 0], currentTurn: 0, timer: null
      };
      playerRoom.set(ws, { game: 'min', roomId });
      sendTo(ws, { type: 'min_room_created', roomId, playerIndex: 0 });
      broadcastRooms(minRooms, 'min_room_list');
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
      if (room.mines[0] && room.mines[1]) {
        room.players.forEach((p, i) => sendTo(p, { type: 'min_game_start', yourTurn: i === 0, opponentName: room.usernames[1-i] }));
        startTimer(pr.roomId, minRooms, 'min', (rId) => {
          const r = minRooms[rId];
          if (!r) return;
          r.currentTurn = 1 - r.currentTurn;
          r.players.forEach((p, i) => sendTo(p, { type: 'min_timeout', yourTurn: i === r.currentTurn }));
          startTimer(rId, minRooms, 'min', arguments.callee);
        });
      }
    }
    else if (data.type === 'min_open_cell') {
      const pr = playerRoom.get(ws);
      const room = pr && minRooms[pr.roomId];
      if (!room) return;
      const attackerIdx = room.players.indexOf(ws);
      const defenderIdx = 1 - attackerIdx;
      const cell = data.cell;
      const isMine = room.mines[defenderIdx].includes(cell);
      if (!room.opened[defenderIdx].includes(cell)) room.opened[defenderIdx].push(cell);
      if (isMine) room.minesFound[attackerIdx]++;
      const lost = room.minesFound[attackerIdx] >= 4;
      room.players.forEach((p, i) => sendTo(p, {
        type: 'min_cell_result', attackerIdx, cell, isMine,
        minesFound: room.minesFound, lost, loserIdx: lost ? attackerIdx : -1,
        yourTurn: lost ? false : (isMine ? i === attackerIdx : i === defenderIdx)
      }));
      if (lost) {
        if (room.timer) clearInterval(room.timer);
        delete minRooms[pr.roomId];
        room.players.forEach(p => playerRoom.delete(p));
        broadcastRooms(minRooms, 'min_room_list');
      } else {
        room.currentTurn = isMine ? attackerIdx : defenderIdx;
        startTimer(pr.roomId, minRooms, 'min', (rId) => {
          const r = minRooms[rId];
          if (!r) return;
          r.currentTurn = 1 - r.currentTurn;
          r.players.forEach((p, i) => sendTo(p, { type: 'min_timeout', yourTurn: i === r.currentTurn }));
          startTimer(rId, minRooms, 'min', arguments.callee);
        });
      }
    }
    else if (data.type === 'min_reaction') {
      const pr = playerRoom.get(ws);
      const room = pr && minRooms[pr.roomId];
      if (!room) return;
      const idx = room.players.indexOf(ws);
      room.players.forEach((p, i) => { if (i !== idx) sendTo(p, { type: 'min_reaction', emoji: data.emoji }); });
    }
  });

  ws.on('close', () => {
    const pr = playerRoom.get(ws);
    if (pr) {
      const roomsMap = pr.game === 'num' ? numRooms : pr.game === 'fru' ? fruRooms : minRooms;
      const bType = `${pr.game}_room_list`;
      const room = roomsMap[pr.roomId];
      if (room) {
        if (room.timer) clearInterval(room.timer);
        room.players.forEach(p => { if (p !== ws) sendTo(p, { type: 'opponent_left' }); playerRoom.delete(p); });
        delete roomsMap[pr.roomId];
        broadcastRooms(roomsMap, bType);
      }
    }
    playerRoom.delete(ws);
  });
});

server.listen(PORT, () => console.log(`Server started on port ${PORT}`));
