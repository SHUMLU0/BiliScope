import { createRoot } from 'react-dom/client';
import { AiHistoryPage } from './ai-history-page';

const el = document.getElementById('root');
if (!el) throw new Error('ai-history page root not found');
createRoot(el).render(<AiHistoryPage />);
