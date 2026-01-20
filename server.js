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

io.on("connection", (socket) => {
  console.log("Yeni bağlantı: ", socket.id);

  socket.on("get-rooms", () => {
    const rooms = [];
    for (const [roomId, room] of io.sockets.adapter.rooms) {
      if (![...room].includes(roomId)) {
        rooms.push({ id: roomId, size: room.size });
      }
    }
    socket.emit("room-list", rooms);
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
    if (room.size >= MAX_USERS_PER_ROOM) {
      socket.emit("roomFull");
      return;
    }

    socket.join(roomId);

    // Tüm mevcut kullanıcıları yeni katılana bildir
    const others = [...room].filter(id => id !== socket.id);
    socket.emit("joinedRoom", roomId, others);

    // Diğerlerine yeni kullanıcı geldiğini bildir
    socket.to(roomId).emit("user-joined", socket.id);

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
          });
        }
      });
      socket.disconnectListenerAttached = true;
    }
  });
});

server.listen(3000, () => {
  console.log("✅ Signaling server çalışıyor: http://localhost:3000");
});
