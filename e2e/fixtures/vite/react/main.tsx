import { useState } from 'react'
import { createRoot } from 'react-dom/client'

function App() {
  const [value, setValue] = useState('')
  return (
    <div>
      <label htmlFor="input">Input</label>
      <input id="input" value={value} onChange={event => setValue(event.target.value)} />
      <span id="rendered">{value}</span>
    </div>
  )
}

createRoot(document.getElementById('app')!).render(<App />)
