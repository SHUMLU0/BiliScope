import { createRoot } from 'react-dom/client';
import { PopupApp } from './App';

const el = document.getElementById('root');
if (!el) throw new Error('popup root not found');
createRoot(el).render(<PopupApp />);