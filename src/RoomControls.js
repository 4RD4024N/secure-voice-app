import React, { useState } from 'react';
import { useSocket } from './SocketContext';

export default function RoomControls({ onJoin, onCreate, currentRoom }) {
  const socket = useSocket();
  const [roomId, setRoomId] = useState('');
  const [status, setStatus] = useState('');

  const handleCreate = () => {
    if (!roomId) return setStatus('Oda ID gerekli');
    socket.emit('create-room', roomId);
    socket.once('roomCreated', (id) => {
      setStatus('Oda oluşturuldu: ' + id);
      onCreate && onCreate(id);
    });
    socket.once('roomExists', () => setStatus('Bu oda zaten var!'));
  };

  const handleJoin = () => {
    if (!roomId) return setStatus('Oda ID gerekli');
    socket.emit('join-room', roomId);
    socket.once('joinedRoom', (id) => {
      setStatus('Odaya katıldın: ' + id);
      onJoin && onJoin(id);
    });
    socket.once('roomNotFound', () => setStatus('Oda bulunamadı!'));
  };

  return (
    <div className="room-controls">
      <input
        type="text"
        placeholder="Oda ID"
        value={roomId}
        onChange={e => setRoomId(e.target.value)}
        disabled={!!currentRoom}
      />
      <button onClick={handleCreate} disabled={!!currentRoom}>Oluştur</button>
      <button onClick={handleJoin} disabled={!!currentRoom}>Katıl</button>
      <div className="status">{status}</div>
      {currentRoom && <div className="current-room">Aktif Oda: {currentRoom}</div>}
    </div>
  );
}
