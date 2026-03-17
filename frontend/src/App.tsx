import { Navigate, Route, Routes } from 'react-router-dom'

import { Lobby } from './pages/Lobby'
import { Meeting } from './pages/Meeting'

export function App() {
  return (
    <Routes>
      <Route path="/" element={<Lobby />} />
      <Route path="/meeting" element={<Meeting />} />
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  )
}

