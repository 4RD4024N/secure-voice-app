import React, { useEffect, useRef, useState } from 'react';
import { useSocket } from './SocketContext';

export default function Chat({ currentRoom }) {
  const socket = useSocket();
  const [messages, setMessages] = useState([]);
  const [input, setInput] = useState('');
  const messagesEndRef = useRef(null);

  useEffect(() => {
    if (!currentRoom) return;
    setMessages([]);
    const handleMessage = (msg) => {
      setMessages((prev) => [...prev, msg]);
    };
    socket.on('chat-message', handleMessage);
    // Fetch chat history on join
    socket.once('joinedRoom', (roomId, others, history) => {
      if (Array.isArray(history)) setMessages(history);
    });
    return () => {
      socket.off('chat-message', handleMessage);
    };
  }, [socket, currentRoom]);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  const sendMessage = (e) => {
    e.preventDefault();
    if (!input.trim() || !currentRoom) return;
    socket.emit('chat-message', { roomId: currentRoom, text: input });
    setInput('');
  };

  if (!currentRoom) return null;
  return (
    <div className="chat">
      <h3>Sohbet</h3>
      <div className="chat-messages" style={{ maxHeight: 200, overflowY: 'auto', background: '#222', padding: 8, borderRadius: 8 }}>
        {messages.map((msg, i) => (
          <div key={i} style={{ marginBottom: 4 }}>
            <b>{msg.fromName || msg.fromId}:</b> {msg.text}
          </div>
        ))}
        <div ref={messagesEndRef} />
      </div>
      <form onSubmit={sendMessage} style={{ display: 'flex', marginTop: 8 }}>
        <input
          type="text"
          value={input}
          onChange={e => setInput(e.target.value)}
          placeholder="Mesaj yaz..."
          style={{ flex: 1, marginRight: 4 }}
        />
        <button type="submit">Gönder</button>
      </form>
    </div>
  );
}
