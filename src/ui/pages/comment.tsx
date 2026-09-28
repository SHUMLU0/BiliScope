import { createRoot } from 'react-dom/client';
import { CommentPage } from './comment-page';

const el = document.getElementById('root');
if (!el) throw new Error('comment page root not found');
createRoot(el).render(<CommentPage />);