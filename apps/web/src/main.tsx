import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';

const root = document.getElementById('root');
if (!root) throw new Error('The web entry requires a root element.');

createRoot(root).render(<StrictMode>{null}</StrictMode>);
