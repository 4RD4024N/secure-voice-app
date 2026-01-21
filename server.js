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
    
    rooms[room].users.push({ id: socket.id, name: user });
    console.log('User joined room. currentRoom:', currentRoom, 'username:', username);
    io.to(room).emit('users', rooms[room].users);
    socket.to(room).emit('message', { user: 'system', text: `${user} joined!` });
    
    // Notify other users to initiate WebRTC connections
    socket.to(room).emit('user-joined', { userId: socket.id });
    
    io.emit('room-updated', { roomName: room, userCount: rooms[room].users.length });
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
    io.to(to).emit('ice-candidate', { from: socket.id, candidate });
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
