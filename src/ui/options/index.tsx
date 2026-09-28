import { createRoot } from 'react-dom/client';
import { OptionsApp } from './App';

const el = document.getElementById('root');
if (!el) throw new Error('options root not found');
createRoot(el).render(<OptionsApp />);