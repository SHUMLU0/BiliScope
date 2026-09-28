import { createRoot } from 'react-dom/client';
import { RadarPage } from './radar-page';

const el = document.getElementById('root');
if (!el) throw new Error('radar page root not found');
createRoot(el).render(<RadarPage />);