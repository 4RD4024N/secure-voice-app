import React, { useEffect, useState } from 'react';
import { useSocket } from './SocketContext';

export default function UserList({ currentRoom }) {
  const socket = useSocket();
  const [users, setUsers] = useState([]);

  useEffect(() => {
    if (!currentRoom) return;
    socket.emit('get-users', currentRoom);
    const handleUserList = ({ users }) => {
      setUsers(Object.entries(users));
    };
    socket.on('user-list', handleUserList);
    socket.on('user-joined', () => socket.emit('get-users', currentRoom));
    socket.on('user-left', () => socket.emit('get-users', currentRoom));
    socket.on('name-changed', () => socket.emit('get-users', currentRoom));
    return () => {
      socket.off('user-list', handleUserList);
      socket.off('user-joined');
      socket.off('user-left');
      socket.off('name-changed');
    };
  }, [socket, currentRoom]);

  if (!currentRoom) return null;
  return (
    <div className="user-list">
      <h3>Kullanıcılar</h3>
      <ul>
        {users.map(([id, name]) => (
          <li key={id}>{name ? `${name} (${id})` : id}</li>
        ))}
      </ul>
    </div>
  );
}
