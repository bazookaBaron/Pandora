import StrictMode from 'react'
import { StrictMode as SM } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.jsx'

createRoot(document.getElementById('root')).render(
    <SM>
        <App />
    </SM>,
)
