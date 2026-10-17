import React from 'react';
import { createRoot } from 'react-dom/client';
import { AuthGate } from './AuthGate';
import './style.css';
createRoot(document.getElementById('root')!).render(<AuthGate/>);
if ('serviceWorker' in navigator && !import.meta.env.DEV) navigator.serviceWorker.register('/sw.js').catch(() => {});
