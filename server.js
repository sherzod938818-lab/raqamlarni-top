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
const rooms = {};
const playerRoom = new Map();

function sendTo(ws, data) {
  if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(data));
}

function generateRoomId() {
  return Math.floor(1000 + Math.random() * 9000).toString();
}

function broadcastRoomList() {
  const list = Object.entries(rooms)
    .filter(([, r]) => r.players.length === 1)
    .map(([id, r]) => ({ id, name: r.name, host: r.usernames[0] }));
  wss.clients.forEach(client => {
    if (client.readyState === WebSocket.OPEN)
      client.send(JSON.stringify({ type: 'room_list', rooms: list }));
  });
}

function checkGuess(secret, guess) {
  const result = ['_','_','_','_'];
  for (let i = 0; i < 4; i++)
    if (guess[i] === secret[i]) result[i] = guess[i];
  return result;
}

wss.on('connection', (ws) => {
  // Yangi ulanuvchiga xonalar ro'yxatini yuborish
  const list = Object.entries(rooms)
    .filter(([, r]) => r.players.length === 1)
    .map(([id, r]) => ({ id, name: r.name, host: r.usernames[0] }));
  sendTo(ws, { type: 'room_list', rooms: list });

  ws.on('message', (message) => {
    let data;
    try { data = JSON.parse(message); } catch { return; }

    if (data.type === 'create_room') {
      const roomId = generateRoomId();
      rooms[roomId] = {
        name: data.name || data.username,
        players: [ws],
        usernames: [data.username],
        numbers: [null, null],
        guesses: [],
        currentTurn: 0
      };
      playerRoom.set(ws, roomId);
      sendTo(ws, { type: 'room_created', roomId, playerIndex: 0 });
      broadcastRoomList();
    }

    else if (data.type === 'join_room') {
      const room = rooms[data.roomId];
      if (!room) return sendTo(ws, { type: 'error', msg: 'Xona topilmadi' });
      if (room.players.length >= 2) return sendTo(ws, { type: 'error', msg: 'Xona to\'liq' });
      room.players.push(ws);
      room.usernames.push(data.username);
      playerRoom.set(ws, data.roomId);
      sendTo(ws, { type: 'room_joined', roomId: data.roomId, playerIndex: 1 });
      sendTo(room.players[0], { type: 'opponent_joined', opponentName: data.username });
      sendTo(ws, { type: 'opponent_joined', opponentName: room.usernames[0] });
      broadcastRoomList();
    }

    else if (data.type === 'set_number') {
      const roomId = playerRoom.get(ws);
      const room = rooms[roomId];
      if (!room) return;
      const idx = room.players.indexOf(ws);
      room.numbers[idx] = data.number;
      sendTo(ws, { type: 'number_set' });
      if (room.numbers[0] && room.numbers[1]) {
        sendTo(room.players[0], { type: 'game_start', yourTurn: true });
        sendTo(room.players[1], { type: 'game_start', yourTurn: false });
      }
    }

    else if (data.type === 'guess') {
      const roomId = playerRoom.get(ws);
      const room = rooms[roomId];
      if (!room) return;
      const attackerIdx = room.players.indexOf(ws);
      const defenderIdx = 1 - attackerIdx;
      const secret = room.numbers[defenderIdx];
      const result = checkGuess(secret.split(''), data.number.split(''));
      const won = result.join('') === secret;
      room.guesses.push({ player: attackerIdx, guess: data.number, result });
      room.players.forEach((p, i) => {
        sendTo(p, {
          type: 'guess_result',
          guesserIdx: attackerIdx,
          guess: data.number,
          result, won,
          yourTurn: won ? false : i === defenderIdx
        });
      });
      if (won) {
        delete rooms[roomId];
        room.players.forEach(p => playerRoom.delete(p));
        broadcastRoomList();
      } else {
        room.currentTurn = defenderIdx;
      }
    }
  });

  ws.on('close', () => {
    const roomId = playerRoom.get(ws);
    if (roomId && rooms[roomId]) {
      const room = rooms[roomId];
      // Faqat xona egasi (0-o'yinchi) chiqsa xona o'chadi
      const leaverIdx = room.players.indexOf(ws);
      room.players.forEach(p => {
        if (p !== ws) sendTo(p, { type: 'opponent_left' });
        playerRoom.delete(p);
      });
      delete rooms[roomId];
      broadcastRoomList();
    }
    playerRoom.delete(ws);
  });
});

server.listen(PORT, () => console.log(`Server started on port ${PORT}`));
