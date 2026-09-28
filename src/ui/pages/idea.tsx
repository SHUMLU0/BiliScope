import { createRoot } from 'react-dom/client';
import { IdeaPage } from './idea-page';

const el = document.getElementById('root');
if (!el) throw new Error('idea page root not found');
createRoot(el).render(<IdeaPage />);