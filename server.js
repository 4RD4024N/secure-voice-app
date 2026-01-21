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
    
    rooms[room].users.push({ id: socket.id, name: user });
    io.to(room).emit('users', rooms[room].users);
    socket.to(room).emit('message', { user: 'system', text: `${user} joined!` });
    io.emit('room-updated', { roomName: room, userCount: rooms[room].users.length });
  });

  socket.on('message', (msg) => {
    if (currentRoom && username) {
      io.to(currentRoom).emit('message', { user: username, text: msg });
    }
  });

  socket.on('signal', (data) => {
    if (data.to) {
      io.to(data.to).emit('signal', { from: socket.id, signal: data.signal, user: username });
    }
  });

  // Relay voice data to other users in the room
  socket.on('voice-data', (audioBuffer) => {
    if (currentRoom) {
      socket.to(currentRoom).emit('voice-data', {
        userId: socket.id,
        username: username,
        audio: audioBuffer
      });
    }
  });

  socket.on('disconnect', () => {
    if (currentRoom && rooms[currentRoom]) {
      rooms[currentRoom].users = rooms[currentRoom].users.filter(u => u.id !== socket.id);
      io.to(currentRoom).emit('users', rooms[currentRoom].users);
      socket.to(currentRoom).emit('message', { user: 'system', text: `${username} left!` });
      
      // Delete empty rooms that aren't owned by anyone
      if (rooms[currentRoom].users.length === 0) {
        delete rooms[currentRoom];
        io.emit('room-removed', { roomName: currentRoom });
      } else {
        io.emit('room-updated', { roomName: currentRoom, userCount: rooms[currentRoom].users.length });
      }
    }
  });
});

console.log('Socket.io server running on port 3001');
