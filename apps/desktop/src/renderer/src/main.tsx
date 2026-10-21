import '@fontsource-variable/inter/wght.css';
import '@fontsource/source-code-pro/400.css';
import '@fontsource/source-code-pro/600.css';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App.js';
import { applyThemePref, guessPlatform, readThemePref } from './theme.js';
import './styles.css';

applyThemePref(readThemePref());
document.documentElement.dataset['platform'] = guessPlatform();

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
