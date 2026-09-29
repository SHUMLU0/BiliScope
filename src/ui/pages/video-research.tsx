import { createRoot } from 'react-dom/client';
import { VideoResearchPage } from './video-research-page';

const el = document.getElementById('root');
if (!el) throw new Error('video-research page root not found');
createRoot(el).render(<VideoResearchPage />);
