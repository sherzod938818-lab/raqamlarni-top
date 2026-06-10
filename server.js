const WebSocket = require('ws');
const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = process.env.PORT || 3000;

const server = http.createServer((req, res) => {
  const filePath = path.join(__dirname, 'index.html');
  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404);
      res.end('Not found');
      return;
    }
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end(data);
  });
});

const wss = new WebSocket.Server({ server });

const rooms = {};
const playerRoom = new Map();

function sendTo(ws, data) {
  if (ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(data));
  }
}

// 🔥 hammaga room list yuborish
function broadcastRooms() {
  const list = Object.keys(rooms).map(id => ({
    id,
    players: rooms[id].usernames,
    count: rooms[id].players.length
  }));

  wss.clients.forEach(client => {
    sendTo(client, { type: 'rooms_list', rooms: list });
  });
}

function generateRoomId() {
  return Math.random().toString(36).substr(2, 8).toUpperCase();
}

function checkGuess(secret, guess) {
  const result = ['_', '_', '_', '_'];
  for (let i = 0; i < 4; i++) {
    if (guess[i] === secret[i]) {
      result[i] = guess[i];
    }
  }
  return result;
}

function removeRoom(roomId) {
  if (!rooms[roomId]) return;

  rooms[roomId].players.forEach(p => {
    playerRoom.delete(p);
  });

  delete rooms[roomId];
  broadcastRooms();
}

wss.on('connection', (ws) => {

  broadcastRooms();

  ws.on('message', (message) => {
    let data;
    try { data = JSON.parse(message); } catch { return; }

    // ================= CREATE ROOM =================
    if (data.type === 'create_room') {
      const roomId = generateRoomId();

      rooms[roomId] = {
        players: [ws],
        usernames: [data.username],
        numbers: [null, null],
        guesses: [],
        currentTurn: 0
      };

      playerRoom.set(ws, roomId);

      sendTo(ws, {
        type: 'room_created',
        roomId,
        playerIndex: 0
      });

      broadcastRooms();
    }

    // ================= JOIN ROOM =================
    else if (data.type === 'join_room') {
      const room = rooms[data.roomId];
      if (!room) return sendTo(ws, { type: 'error', msg: 'Xona topilmadi' });
      if (room.players.length >= 2) return sendTo(ws, { type: 'error', msg: 'Xona to\'liq' });

      room.players.push(ws);
      room.usernames.push(data.username);
      playerRoom.set(ws, data.roomId);

      sendTo(ws, {
        type: 'room_joined',
        roomId: data.roomId,
        playerIndex: 1
      });

      sendTo(room.players[0], {
        type: 'opponent_joined',
        opponentName: data.username
      });

      sendTo(ws, {
        type: 'opponent_joined',
        opponentName: room.usernames[0]
      });

      broadcastRooms();
    }

    // ================= SET NUMBER =================
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

    // ================= GUESS =================
    else if (data.type === 'guess') {
      const roomId = playerRoom.get(ws);
      const room = rooms[roomId];
      if (!room) return;

      const attackerIdx = room.players.indexOf(ws);
      const defenderIdx = 1 - attackerIdx;

      const secret = room.numbers[defenderIdx];
      const result = checkGuess(secret.split(''), data.number.split(''));

      const won = result.join('') === secret;

      room.players.forEach((p, i) => {
        sendTo(p, {
          type: 'guess_result',
          guesserIdx: attackerIdx,
          guess: data.number,
          result,
          won,
          yourTurn: won ? false : i === defenderIdx
        });
      });

      if (won) {
        removeRoom(roomId);
      }
    }
  });

  // ================= DISCONNECT =================
  ws.on('close', () => {
    const roomId = playerRoom.get(ws);
    if (!roomId) return;

    const room = rooms[roomId];
    if (!room) return;

    const isOwner = room.players[0] === ws;

    room.players.forEach(p => {
      if (p !== ws) sendTo(p, { type: 'opponent_left' });
      playerRoom.delete(p);
    });

    // 🔥 owner chiqsa xona yo‘qoladi
    removeRoom(roomId);

    if (isOwner) {
      delete rooms[roomId];
    }

    broadcastRooms();
  });
});

server.listen(PORT, () => {
  console.log(`Server started on port ${PORT}`);
});
