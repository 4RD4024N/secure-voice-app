
import './App.css';
import RoomControls from './RoomControls';
import UserList from './UserList';
import { useState } from 'react';
import Chat from './Chat';
import VoiceChat from './VoiceChat';


function App() {
  const [currentRoom, setCurrentRoom] = useState(null);

  return (
    <div className="min-h-screen bg-gray-900 text-gray-100 flex flex-col items-center justify-center p-4">
      <header className="w-full max-w-2xl mb-6 text-center">
        <h1 className="text-3xl font-bold mb-2">Güvenli Sesli Sohbet <span className="text-blue-400">(React)</span></h1>
        <p className="text-gray-400">Odalar oluşturun, katılın, yazışın ve sesli görüşün!</p>
      </header>
      <main className="w-full max-w-2xl grid grid-cols-1 md:grid-cols-2 gap-6">
        <div className="space-y-4">
          <RoomControls
            currentRoom={currentRoom}
            onJoin={setCurrentRoom}
            onCreate={setCurrentRoom}
          />
          <UserList currentRoom={currentRoom} />
        </div>
        <div className="space-y-4">
          <Chat currentRoom={currentRoom} />
          <VoiceChat currentRoom={currentRoom} />
        </div>
      </main>
    </div>
  );
}

export default App;
