import {StrictMode} from 'react';
import {createRoot} from 'react-dom/client';
import App from './App.tsx';
import './index.css';

window.global = window;
window.setImmediate = window.setTimeout;
window.global.setImmediate = window.setTimeout;

createRoot(document.getElementById('root')!).render(
  <App />
);
