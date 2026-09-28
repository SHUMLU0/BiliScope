import { createRoot } from 'react-dom/client';
import { CreatorPage } from './creator-page';

const el = document.getElementById('root');
if (!el) throw new Error('creator page root not found');
createRoot(el).render(<CreatorPage />);