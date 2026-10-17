import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import '@fontsource-variable/schibsted-grotesk';
import './styles/index.css';
import { App } from './app/App';

const root = document.getElementById('root');
if (!root) throw new Error('Root element #root is missing from index.html.');

createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
