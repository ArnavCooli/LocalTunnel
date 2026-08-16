import React from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App.js';
import { TitleBar } from './components.js';
import './styles.css';

createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    {/* Outside <App> so every screen has a drag region — including the loading
        spinner and the setup wizard, which never render the rail. */}
    <TitleBar />
    <App />
  </React.StrictMode>,
);
