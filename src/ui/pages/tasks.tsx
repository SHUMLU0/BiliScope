import { createRoot } from 'react-dom/client';
import { TaskPage } from './tasks-page';

const el = document.getElementById('root');
if (!el) throw new Error('tasks page root not found');
createRoot(el).render(<TaskPage />);
