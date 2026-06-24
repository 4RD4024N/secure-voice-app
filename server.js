import { Server } from 'socket.io';

const io = new Server(3001, {
  cors: {
    origin: '*',
  },
});

let rooms = {}; // { roomName: { users: [], creator: string, createdAt: Date } }

io.on('connection', (socket) => {
  let currentRoom = null;
  let username = null;

  // Send available rooms list
  socket.on('get-rooms', () => {
    const roomList = Object.keys(rooms).map(name => ({
      name,
      userCount: rooms[name].users.length,
      creator: rooms[name].creator,
      createdAt: rooms[name].createdAt
    }));
    socket.emit('rooms-list', roomList);
  });

  // Create a new room
  socket.on('create-room', ({ roomName, user }) => {
    if (rooms[roomName]) {
      socket.emit('error', { message: 'Room already exists' });
      return;
    }
    rooms[roomName] = {
      users: [],
      creator: user,
      createdAt: new Date().toISOString()
    };
    io.emit('room-created', { roomName, creator: user });
    socket.emit('room-created-success', { roomName });
  });

  // Delete a room
  socket.on('delete-room', ({ roomName, user }) => {
    if (!rooms[roomName]) {
      socket.emit('error', { message: 'Room does not exist' });
      return;
    }
    if (rooms[roomName].creator !== user) {
      socket.emit('error', { message: 'Only the creator can delete this room' });
      return;
    }
    // Notify all users in the room
    io.to(roomName).emit('room-deleted', { roomName });
    delete rooms[roomName];
    io.emit('room-removed', { roomName });
  });

  socket.on('join', ({ room, user }) => {
    console.log('Join event - socket:', socket.id, 'room:', room, 'user:', user);
    currentRoom = room;
    username = user;
    socket.join(room);

    if (!rooms[room]) {
      rooms[room] = {
        users: [],
        creator: user,
        createdAt: new Date().toISOString()
      };
    }

    // Idempotent: only add this socket if it isn't already in the room.
    // Guards against duplicate "join" emits (e.g. React StrictMode / re-renders).
    if (!rooms[room].users.some(u => u.id === socket.id)) {
      rooms[room].users.push({ id: socket.id, name: user });
    }
    console.log('User joined room. currentRoom:', currentRoom, 'username:', username);
    io.to(room).emit('users', rooms[room].users);
    socket.to(room).emit('message', { user: 'system', text: `${user} joined!` });

    // Notify other users to initiate WebRTC connections
    socket.to(room).emit('user-joined', { userId: socket.id });

    // If someone is already sharing screen, notify the new joiner
    if (rooms[room].screenSharer) {
      socket.emit('screen-share-started', rooms[room].screenSharer);
    }

    io.emit('room-updated', { roomName: room, userCount: rooms[room].users.length });
  });

  // Explicit leave (client calls this when the user clicks "Leave Room")
  socket.on('leave', () => {
    cleanupRoom();
  });

  socket.on('message', (msg) => {
    console.log('Message received from socket:', socket.id, 'currentRoom:', currentRoom, 'username:', username, 'message:', msg);
    if (currentRoom && username) {
      io.to(currentRoom).emit('message', { user: username, text: msg });
    } else {
      console.log('ERROR: Cannot send message - currentRoom:', currentRoom, 'username:', username);
    }
  });

  // WebRTC signaling
  socket.on('offer', ({ to, offer }) => {
    console.log('Relaying offer from', socket.id, 'to', to);
    io.to(to).emit('offer', { from: socket.id, offer });
  });

  socket.on('answer', ({ to, answer }) => {
    console.log('Relaying answer from', socket.id, 'to', to);
    io.to(to).emit('answer', { from: socket.id, answer });
  });

  socket.on('ice-candidate', ({ to, candidate }) => {
    console.log(`ICE relay: ${socket.id.slice(0,6)} -> ${to?.slice(0,6)}`);
    io.to(to).emit('ice-candidate', { from: socket.id, candidate });
  });

  // Screen sharing events
  socket.on('screen-share-started', ({ username: sharerName }) => {
    console.log('Screen share started by:', sharerName, 'in room:', currentRoom);
    if (currentRoom) {
      const payload = { userId: socket.id, username: sharerName };
      rooms[currentRoom].screenSharer = payload;
      socket.to(currentRoom).emit('screen-share-started', payload);
    }
  });

  socket.on('screen-share-stopped', () => {
    console.log('Screen share stopped by:', username, 'in room:', currentRoom);
    if (currentRoom) {
      rooms[currentRoom].screenSharer = null;
      io.to(currentRoom).emit('screen-share-stopped', { userId: socket.id });
    }
  });

  function cleanupRoom() {
    if (!currentRoom || !rooms[currentRoom]) return;
    const room = currentRoom;

    rooms[room].users = rooms[room].users.filter(u => u.id !== socket.id);
    socket.leave(room);

    // Tell remaining peers to tear down the WebRTC connection to this socket
    socket.to(room).emit('user-left', { userId: socket.id });
    io.to(room).emit('users', rooms[room].users);
    socket.to(room).emit('message', { user: 'system', text: `${username} left!` });

    // If the leaver was the screen sharer, clear it
    if (rooms[room].screenSharer && rooms[room].screenSharer.userId === socket.id) {
      rooms[room].screenSharer = null;
      socket.to(room).emit('screen-share-stopped', { userId: socket.id });
    }

    // Delete empty rooms
    if (rooms[room].users.length === 0) {
      delete rooms[room];
      io.emit('room-removed', { roomName: room });
    } else {
      io.emit('room-updated', { roomName: room, userCount: rooms[room].users.length });
    }

    currentRoom = null;
  }

  socket.on('disconnect', () => {
    cleanupRoom();
  });
});

console.log('Socket.io server running on port 3001');
