import { createRoot } from 'react-dom/client';
import { DashboardPage } from './dashboard-page';

const el = document.getElementById('root');
if (!el) throw new Error('dashboard page root not found');
createRoot(el).render(<DashboardPage />);
