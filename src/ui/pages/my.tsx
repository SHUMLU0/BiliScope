import { createRoot } from 'react-dom/client';
import { MyDataPage } from './my-page';

const el = document.getElementById('root');
if (!el) throw new Error('my page root not found');
createRoot(el).render(<MyDataPage />);