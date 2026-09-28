import { createRoot } from 'react-dom/client';
import { HotPage } from './hot-page';

const el = document.getElementById('root');
if (!el) throw new Error('hot page root not found');
createRoot(el).render(<HotPage />);