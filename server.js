const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const cors = require("cors");

const app = express();
app.use(cors());
app.use(express.static("public"));

const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: "*" },
});

const MAX_USERS_PER_ROOM = 5;
// map socketId -> display name
const socketNames = new Map();

function getRoomsArray() {
  const rooms = [];
  for (const [roomId, room] of io.sockets.adapter.rooms) {
    // filter out socket ids which also appear as rooms
    if (![...room].includes(roomId)) {
      rooms.push({ id: roomId, size: room.size });
    }
  }
  return rooms;
}

// In-memory chat history per room (keeps last N messages)
const roomMessages = new Map();
const MAX_MESSAGES_PER_ROOM = 200;

io.on("connection", (socket) => {
  console.log("Yeni bağlantı: ", socket.id);

  // allow clients to set a display name (max 16 chars)
  socket.on('set-name', (name) => {
    if (!name || typeof name !== 'string') return socket.emit('name-set', { success: false, reason: 'invalid' });
    const trimmed = name.trim();
    if (trimmed.length === 0) return socket.emit('name-set', { success: false, reason: 'empty' });
    if (trimmed.length > 16) return socket.emit('name-set', { success: false, reason: 'too-long' });
    socketNames.set(socket.id, trimmed);
    socket.emit('name-set', { success: true, name: trimmed });
    // notify all rooms the socket is in about the name change
    for (const roomId of socket.rooms) {
      if (roomId === socket.id) continue;
      io.to(roomId).emit('name-changed', { id: socket.id, name: trimmed });
    }
  });

  socket.on("get-rooms", () => {
    socket.emit("room-list", getRoomsArray());
    });

    // Send current user list for a room
    socket.on('get-users', (roomId) => {
      const room = io.sockets.adapter.rooms.get(roomId);
      if (!room) {
        socket.emit('user-list', { roomId, users: {} });
        return;
      }
      const users = {};
      for (const id of room) {
        users[id] = socketNames.get(id) || null;
      }
      socket.emit('user-list', { roomId, users });
  });

  socket.on("create-room", (roomId) => {
    const room = io.sockets.adapter.rooms.get(roomId);
    if (room) {
      socket.emit("roomExists");
    } else {
      socket.join(roomId);
      socket.emit("roomCreated", roomId);
    }
  });

  socket.on("join-room", (roomId) => {
    const room = io.sockets.adapter.rooms.get(roomId);
    if (!room) {
      socket.emit("roomNotFound");
      return;
    }

    // allow a client to leave a room explicitly
    socket.on('leave-room', (roomId) => {
      if (!roomId) return;
      const room = io.sockets.adapter.rooms.get(roomId);
      if (!room) {
        socket.emit('roomNotFound');
        return;
      }
      // make the socket leave
      socket.leave(roomId);
      console.log(`Socket ${socket.id} left room ${roomId} (manual leave)`);
      socket.to(roomId).emit('user-left', socket.id);
      socket.emit('left-room', roomId);
      // broadcast updated room list
      io.emit('room-list', getRoomsArray());
    });

    // allow deletion of a room (removes all sockets from it)
    socket.on('delete-room', (roomId) => {
      if (!roomId) return;
      const room = io.sockets.adapter.rooms.get(roomId);
      if (!room) {
        socket.emit('roomNotFound');
        return;
      }
      console.log(`Room ${roomId} is being deleted by ${socket.id}`);
      // notify all members
      for (const memberId of room) {
        io.to(memberId).emit('room-deleted', roomId);
        const memberSocket = io.sockets.sockets.get(memberId);
        if (memberSocket) memberSocket.leave(roomId);
      }
      // remove stored history
      roomMessages.delete(roomId);
      // broadcast updated room list
      io.emit('room-list', getRoomsArray());
    });
    if (room.size >= MAX_USERS_PER_ROOM) {
      socket.emit("roomFull");
      return;
    }

    socket.join(roomId);

    // Tüm mevcut kullanıcıları yeni katılana bildir
    const others = [...room].filter(id => id !== socket.id);
    const history = roomMessages.get(roomId) || [];
    // build a names mapping for current room members
    const names = {};
    for (const id of room) {
      names[id] = socketNames.get(id) || null;
    }
    // send room id, other members, chat history and known names to the joining socket
    socket.emit("joinedRoom", roomId, others, history, names);

    // Diğerlerine yeni kullanıcı geldiğini bildir (include optional name)
    socket.to(roomId).emit("user-joined", { id: socket.id, name: socketNames.get(socket.id) || null });

    // Tekrarlı listener eklemeyi engelle
    if (!socket.signalListenerAttached) {
      socket.on("signal", ({ to, data }) => {
        io.to(to).emit("signal", { from: socket.id, data });
      });
      socket.signalListenerAttached = true;
    }

    if (!socket.disconnectListenerAttached) {
      socket.on("disconnect", () => {
        // Log the disconnection of the socket
        console.log(`User disconnected: ${socket.id}`);

        // On disconnect, determine which rooms the socket was in (exclude its own socket id)
        const leftRooms = [...socket.rooms].filter(r => r !== socket.id);
        if (leftRooms.length === 0) {
          console.log(`Socket ${socket.id} disconnected (not in any room)`);
        } else {
          leftRooms.forEach(room => {
            console.log(`Socket ${socket.id} left room ${room}`);
            socket.to(room).emit("user-left", socket.id);
            // inform others that the name is gone
            socket.to(room).emit('name-changed', { id: socket.id, name: null });
          });
        }
        // cleanup stored name
        if (socketNames.has(socket.id)) socketNames.delete(socket.id);
      });
      socket.disconnectListenerAttached = true;
    }

    // Chat messages sent by clients for a room
    socket.on('chat-message', ({ roomId, text }) => {
      if (!roomId || !text) return;
      const name = socketNames.get(socket.id) || socket.id;
      const payload = { fromId: socket.id, fromName: name, text, ts: Date.now() };
      console.log(`Chat in ${roomId} from ${socket.id}: ${text}`);
      // store in history
      const arr = roomMessages.get(roomId) || [];
      arr.push(payload);
      if (arr.length > MAX_MESSAGES_PER_ROOM) arr.splice(0, arr.length - MAX_MESSAGES_PER_ROOM);
      roomMessages.set(roomId, arr);
      io.to(roomId).emit('chat-message', payload);
    });
  });
});

server.listen(3000, () => {
  console.log("✅ Signaling server çalışıyor: http://localhost:3000");
});
